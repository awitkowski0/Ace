/** Pure helpers for the Packages window: command lines, parsing, error classification. */
export interface Pkg { name: string; version: string }
export type OpKind = "install" | "upgrade" | "uninstall";

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** shell-style display of an argv (what the confirmation dialog shows) */
export const commandLine = (argv: string[]) => argv.map(q).join(" ");

export const listArgv = (python: string, uv: string | null) =>
  uv ? [uv, "pip", "list", "--python", python, "--format", "json"] : [python, "-m", "pip", "list", "--format=json", "--disable-pip-version-check"];

export function opArgv(kind: OpKind, python: string, uv: string | null, name: string, version?: string | null): string[] {
  const spec = kind !== "uninstall" && version ? `${name}==${version}` : name;
  if (uv) {
    if (kind === "uninstall") return [uv, "pip", "uninstall", "--python", python, name];
    return [uv, "pip", "install", "--python", python, ...(kind === "upgrade" ? ["--upgrade"] : []), spec];
  }
  if (kind === "uninstall") return [python, "-m", "pip", "uninstall", "-y", name];
  return [python, "-m", "pip", "install", ...(kind === "upgrade" ? ["--upgrade"] : []), spec];
}

export function parseList(stdout: string): Pkg[] {
  const start = stdout.indexOf("[");
  const arr = JSON.parse(start > 0 ? stdout.slice(start) : stdout) as { name: string; version: string }[];
  return arr.map((p) => ({ name: p.name, version: p.version })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export const isExternallyManaged = (out: string) => /externally[- ]managed/i.test(out);

/** PEP 440-ish descending comparison for the version dropdown (good enough for display order). */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string) => v.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : x));
  const x = seg(a), y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], r = y[i];
    if (p === r) continue;
    if (p === undefined) return typeof r === "number" ? -1 : 1; // 1.0 < 1.0.1 but 1.0 > 1.0rc1
    if (r === undefined) return typeof p === "number" ? 1 : -1;
    if (typeof p === "number" && typeof r === "number") return p - r;
    if (typeof p === "number") return 1;
    if (typeof r === "number") return -1;
    return p < r ? -1 : 1;
  }
  return 0;
}
export const isPrerelease = (v: string) => /[a-z]/i.test(v);

/** Normalised project-name compare (PEP 503). */
export const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");
