/** File-list operations shared by the Project and Asset trees: clipboard (Finder interop), paste/duplicate, paths, reveal, trash. */
import { basename, dirname, fs, invoke, joinPath, type Location } from "../../lib/ipc";
import { confirmDialog } from "../shell/dialogs";
import type { MenuItem } from "../shell/contextMenu";
import { fileManagerName } from "../../lib/platform";
import { isWithin } from "../../lib/paths";
export { isWithin };

export interface Sel { path: string; isDir: boolean }
export interface FileEnv {
  host: string;
  root: string;
  /** reload these directories in the view, expand `expand`, then select `select` */
  refresh: (dirs: string[], select?: string[]) => Promise<void> | void;
}

// ---- pure helpers (fileOps.test.ts) ----

/** `x.ext` -> `x copy.ext`, `x copy 2.ext`, ... first name not in `taken` (Finder style). Dirs and dotfiles keep the whole name as the stem. */
export function copyName(name: string, taken: ReadonlySet<string>, isDir = false): string {
  const dot = name.lastIndexOf(".");
  const hasExt = !isDir && dot > 0;
  const stem = (hasExt ? name.slice(0, dot) : name).replace(/ copy(?: \d+)?$/, "");
  const ext = hasExt ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const c = `${stem} copy${n > 1 ? " " + n : ""}${ext}`;
    if (!taken.has(c)) return c;
  }
}
/** `name` if free, else a Finder-style copy name */
export const freeName = (name: string, taken: ReadonlySet<string>, isDir = false) => (taken.has(name) ? copyName(name, taken, isDir) : name);

/** drop paths that live inside another path of the list (copying/deleting a folder already covers them) */
export const topLevel = (paths: string[]) => paths.filter((p) => !paths.some((q) => q !== p && isWithin(q, p)));
/** where a paste lands: the dir itself, or the parent of a file */
export const pasteTarget = (sel: Sel | undefined, root: string) => (!sel ? root : sel.isDir ? sel.path : dirname(sel.path));
export const relPath = (root: string, path: string) => (path === root ? "." : isWithin(root, path) ? path.slice(root.replace(/\/$/, "").length + 1) : path);
export const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// ---- clipboard ----

interface Clip { host: string; paths: string[]; cut: boolean }
let clip: Clip | null = null;
export const internalClip = () => clip;
export const clearClip = () => { clip = null; };

const fail = (e: unknown) => confirmDialog({ title: "Error", message: String(e) });

export function makeFileOps(env: FileEnv) {
  const { host } = env;
  const local = host === "local" || host === "";
  const loc = (path: string): Location => ({ host, path });

  const setClip = async (sel: Sel[], cut: boolean) => {
    const paths = topLevel(sel.map((s) => s.path));
    if (!paths.length) return;
    clip = { host, paths, cut };
    if (local) await invoke("files_clipboard_write", { paths }).catch(() => {});
  };
  const copy = (sel: Sel[]) => setClip(sel, false);
  const cut = (sel: Sel[]) => setClip(sel, true);

  /** what a paste would insert: the Finder pasteboard (local) if it changed since our own copy, else Ace's clipboard */
  const incoming = async (): Promise<Clip | null> => {
    if (local) {
      const sys = await invoke<string[]>("files_clipboard_read").catch(() => [] as string[]);
      if (clip && clip.host === host && (!sys.length || sameSet(sys, clip.paths))) return clip;
      if (sys.length) return { host, paths: sys, cut: false };
    }
    return clip;
  };
  const hasClip = () => !!clip;

  const taken = async (dir: string) => new Set((await fs.listDir(loc(dir))).map((e) => e.name));

  /** move/copy `c.paths` into `dir`; never overwrites (name collisions get a Finder-style copy name) */
  const transfer = async (c: Clip, dir: string) => {
    try {
      if (c.host !== host) return void (await confirmDialog({ title: "Paste", message: `Can't paste between ${c.host === "local" ? "this Mac" : c.host} and ${local ? "this Mac" : host}.`, okLabel: "OK" }));
      const srcs = topLevel(c.paths);
      const stats = await Promise.all(srcs.map((s) => fs.stat(loc(s))));
      for (const [i, s] of srcs.entries())
        if (stats[i].isDir && isWithin(s, dir)) return void (await fail(`Cannot ${c.cut ? "move" : "copy"} "${basename(s)}" into itself or one of its subfolders.`));
      const names = await taken(dir);
      const out: string[] = [];
      const dirs = new Set([dir]);
      for (const [i, s] of srcs.entries()) {
        if (!stats[i].exists) continue;
        if (c.cut) {
          if (dirname(s) === dir) { out.push(s); continue; }
          dirs.add(dirname(s));
        }
        const name = freeName(basename(s), names, stats[i].isDir);
        names.add(name);
        const to = joinPath(dir, name);
        if (c.cut) await fs.rename(loc(s), loc(to));
        else await fs.copy(loc(s), loc(to));
        out.push(to);
      }
      if (c.cut && clip === c) clip = null;
      await env.refresh([...dirs], out);
    } catch (e) {
      await fail(e);
    }
  };
  const paste = async (sel: Sel | undefined) => {
    const c = await incoming();
    if (c?.paths.length) await transfer(c, pasteTarget(sel, env.root));
  };
  /** drag-and-drop: move (or copy with ⌥) onto a directory */
  const drop = (paths: string[], dir: string, copy: boolean) => transfer({ host, paths, cut: !copy }, dir);

  /** Finder-style "x copy.ext" next to each item */
  const duplicate = async (sel: Sel[]) => {
    try {
      const out: string[] = [];
      const dirs = new Set<string>();
      const cache = new Map<string, Set<string>>();
      for (const s of sel) {
        const d = dirname(s.path);
        if (!cache.has(d)) cache.set(d, await taken(d));
        const names = cache.get(d)!;
        const name = copyName(basename(s.path), names, s.isDir);
        names.add(name);
        await fs.copy(loc(s.path), loc(joinPath(d, name)));
        out.push(joinPath(d, name));
        dirs.add(d);
      }
      await env.refresh([...dirs], out);
    } catch (e) {
      await fail(e);
    }
  };

  const copyText = (t: string) => navigator.clipboard.writeText(t).catch(() => {});
  const copyAbsolute = (sel: Sel[]) => copyText(sel.map((s) => s.path).join("\n"));
  const copyRelative = (sel: Sel[]) => copyText(sel.map((s) => relPath(env.root, s.path)).join("\n"));
  const copyNames = (sel: Sel[]) => copyText(sel.map((s) => basename(s.path)).join("\n"));

  const reveal = (sel: Sel[]) => invoke("files_reveal", { paths: sel.map((s) => s.path) }).catch(fail);
  const openDefault = (sel: Sel[]) => Promise.all(sel.map((s) => invoke("files_open", { path: s.path }))).catch(fail);
  const terminalAt = async (sel: Sel | undefined) => (await import("../terminal/api")).openTerminal({ host, cwd: pasteTarget(sel, env.root) });

  /** confirm + delete (Trash when local); returns the removed paths' parents so the caller can refresh */
  const remove = async (sel: Sel[]): Promise<boolean> => {
    const items = sel.filter((s) => s.path !== env.root);
    if (!items.length) return false;
    const what = items.length === 1 ? `${items[0].isDir ? "directory" : "file"} "${basename(items[0].path)}"` : `${items.length} items`;
    if (!(await confirmDialog({ title: local ? "Move to Trash" : "Delete", message: `${local ? "Move" : "Delete"} ${what}${local ? " to the Trash" : ""}?`, okLabel: local ? "Move to Trash" : "Delete" }))) return false;
    try {
      const paths = topLevel(items.map((s) => s.path));
      if (local) await fs.trash(paths);
      else for (const p of paths) await fs.delete(loc(p));
      await env.refresh([...new Set(paths.map(dirname))]);
      return true;
    } catch (e) {
      await fail(e);
      return false;
    }
  };

  return { local, copy, cut, paste, drop, duplicate, hasClip, copyAbsolute, copyRelative, copyNames, reveal, openDefault, terminalAt, remove };
}
export type FileOps = ReturnType<typeof makeFileOps>;

const sep: MenuItem = { separator: true, label: "" };
/** Cut/Copy/Paste/Duplicate block (IntelliJ order) */
export const clipboardItems = (o: FileOps, sel: Sel[], target: Sel | undefined, opts: { cut?: boolean } = {}): MenuItem[] => [
  ...(opts.cut === false ? [] : [{ label: "Cut", shortcut: "⌘X", disabled: !sel.length, run: () => void o.cut(sel) }]),
  { label: "Copy", shortcut: "⌘C", disabled: !sel.length, run: () => void o.copy(sel) },
  { label: "Paste", shortcut: "⌘V", run: () => void o.paste(target) },
  { label: "Duplicate", shortcut: "⌘D", disabled: !sel.length, run: () => void o.duplicate(sel) },
];
export const pathItems = (o: FileOps, sel: Sel[]): MenuItem[] => [
  { label: "Copy Absolute Path", disabled: !sel.length, shortcut: "⇧⌘C", run: () => void o.copyAbsolute(sel) },
  { label: "Copy Path From Project Root", disabled: !sel.length, shortcut: "⌥⇧⌘C", run: () => void o.copyRelative(sel) },
  { label: "Copy File Name", disabled: !sel.length, run: () => void o.copyNames(sel) },
];
/** Finder interop (local only items are disabled for remote hosts) */
export const systemItems = (o: FileOps, sel: Sel[], target: Sel | undefined): MenuItem[] => [
  { label: `Reveal in ${fileManagerName}`, shortcut: "⌥⇧R", disabled: !o.local || !sel.length, run: () => void o.reveal(sel) },
  { label: "Open in Terminal", run: () => void o.terminalAt(target) },
  { label: "Open With Default App", disabled: !o.local || !sel.length, run: () => void o.openDefault(sel) },
];
