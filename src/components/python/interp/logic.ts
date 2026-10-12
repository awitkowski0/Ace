/** Pure helpers of the interpreter UI (no React / no IPC): labels, grouping, terminal activation. Unit-tested in logic.test.ts. */
import { homeShorten } from "../../../lib/paths";
import type { Interp } from "../api";

export const KIND_LABEL: Record<Interp["kind"], string> = {
  venv: "Virtualenv", uv: "uv", poetry: "Poetry", pipenv: "Pipenv", conda: "Conda", pyenv: "pyenv", system: "System Interpreter",
};
const KIND_ORDER: Interp["kind"][] = ["venv", "uv", "poetry", "pipenv", "conda", "pyenv", "system"];

/** "/Users/me/proj/.venv/bin/python" -> "~/proj/.venv/bin/python" */
export function shortPath(p: string, home?: string | null): string {
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return homeShorten(p);
}

/** Status-bar text (PyCharm New UI wording). */
export function widgetText(st: { loading: boolean; current: Interp | null }): string {
  if (st.current) return st.current.name;
  return st.loading ? "Detecting interpreter…" : "<No interpreter>";
}

export interface PopupGroup { label: string; items: Interp[] }
/** Project interpreters first, then the others grouped by kind. The current interpreter stays in its group (it is marked with a check). */
export function groupInterpreters(list: Interp[]): PopupGroup[] {
  const groups: PopupGroup[] = [];
  const proj = list.filter((i) => i.project);
  if (proj.length) groups.push({ label: "Project interpreters", items: proj });
  for (const k of KIND_ORDER) {
    const items = list.filter((i) => !i.project && i.kind === k);
    if (items.length) groups.push({ label: KIND_LABEL[k], items });
  }
  return groups;
}

/** `<venv>/bin/activate` for interpreters that live in a virtualenv (venv, uv, poetry, pipenv). Conda envs are not sourced. */
export function activateScript(i: Interp | null): string | null {
  if (!i || i.host !== "local" || !i.envRoot || i.kind === "conda" || i.kind === "pyenv" || i.kind === "system") return null;
  if (!i.path.startsWith(i.envRoot + "/")) return null;
  return `${i.envRoot.replace(/\/+$/, "")}/bin/activate`;
}

/** Is `cwd` the project root or inside it? ("~" forms never match.) */
export function insideProject(cwd: string, root: string): boolean {
  const r = root.replace(/\/+$/, "");
  return cwd === r || cwd.startsWith(r + "/");
}

/** Default location of a new virtualenv inside the project. */
export const defaultVenvDir = (root: string) => `${root.replace(/\/+$/, "")}/.venv`;

/** Name shown for a freshly created env: "Python 3.12 (proj)" is derived from the env dir's parent by interpreterFromPath. */
export function pythonLabel(version: string, project: string): string {
  const [a, b] = version.split(".");
  return `Python ${a}.${b} (${project})`;
}
