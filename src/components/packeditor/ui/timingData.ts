/** The csv sheets an ability's timing lives in, read from every resource root of the project. */
import { fs, type Location } from "../../../lib/ipc";
import { parseCsv } from "../core/csv";
import { csvKind, packDefaultsCsv, type CsvIn } from "../core/timing";
import { readText } from "./resolve";

const at = (host: string, path: string): Location => ({ host, path });

export interface TimingFiles {
  /** every ability_defaults csv (both kinds) of every root, nearest root first */
  files: CsvIn[];
  /** the defaults-kind csvs of the ability's own namespace folder in its own root */
  ownDefaults: string[];
}

/** Every `data/<ns>/ability_defaults/**.csv` (two levels: the folder itself and `tuning/`) of the roots. `own` is the ability's root + namespace. */
export async function loadTimingFiles(host: string, roots: string[], own: { root: string; ns: string } | null): Promise<TimingFiles> {
  const paths: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const es = await fs.listDir(at(host, dir)).catch(() => []);
    for (const e of es) {
      if (e.isDir) { if (depth > 0 && !e.name.startsWith(".")) await walk(e.path, depth - 1); } else if (e.name.endsWith(".csv")) paths.push(e.path);
    }
  };
  for (const r of roots) {
    const nss = (await fs.listDir(at(host, `${r}/data`)).catch(() => [])).filter((e) => e.isDir);
    for (const ns of nss) await walk(`${r}/data/${ns.name}/ability_defaults`, 2);
  }
  const files: CsvIn[] = [];
  for (let i = 0; i < paths.length; i += 32) {
    const part = paths.slice(i, i + 32);
    const texts = await Promise.all(part.map((p) => readText(host, p)));
    part.forEach((p, j) => { if (texts[j] !== null) files.push({ path: p, text: texts[j]! }); });
  }
  const dir = own ? `${own.root}/data/${own.ns}/ability_defaults` : "";
  const ownDefaults = files.filter((f) => own && f.path.replace(/\\/g, "/").startsWith(dir + "/") && !f.path.slice(dir.length + 1).includes("/") && csvKind(parseCsv(f.text)) === "defaults").map((f) => f.path);
  return { files, ownDefaults };
}

/** The csv a new timing row for an ability of `ns` in resource root `root` goes to. */
export function newRowTarget(t: TimingFiles, root: string, ns: string): string {
  return packDefaultsCsv(t.ownDefaults, `${root}/data/${ns}/ability_defaults`, root);
}
