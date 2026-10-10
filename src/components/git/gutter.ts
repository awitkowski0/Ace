/** Editor gutter change markers (HEAD vs working tree) and "Annotate with Git Blame" via Monaco decorations. */
import type { editor } from "monaco-editor";
import { activeEditor } from "../../editor/editorRegistry";
import { editorStore, activeDocKey } from "../../editor/store";
import { absLoc, git, gitStore, relPath, log, type BlameRange } from "./api";
import { diffHunks } from "./lineDiff";

// HEAD text cache (per repo file); cleared whenever git status changes.
const headCache = new Map<string, Promise<string | null>>();
const headText = (root: Parameters<typeof git.show>[0], path: string) => {
  const k = `${root.host}:${root.path}|${path}`;
  let p = headCache.get(k);
  if (!p) headCache.set(k, (p = git.show(root, "HEAD", path).catch(() => null)));
  return p;
};
let modelSub: { dispose(): void } | null = null;
let modelTimer: ReturnType<typeof setTimeout> | undefined;

const dec = new WeakMap<editor.ITextModel, string[]>();
const blameDec = new WeakMap<editor.ITextModel, string[]>();
let blameOn = false;
let gen = 0;

function current() {
  const key = activeDocKey();
  const doc = key ? editorStore.get().docs[key] : undefined;
  const ed = activeEditor();
  const model = ed?.getModel();
  if (!doc || !ed || !model || model.uri.path !== doc.loc.path) return null;
  return { doc, ed, model };
}

async function updateGutter(retries = 3) {
  const my = ++gen;
  const c = current();
  if (!c) {
    if (retries > 0 && activeDocKey()) setTimeout(() => my === gen && updateGutter(retries - 1), 200);
    return;
  }
  const { root, status } = gitStore.get();
  const rel = relPath(c.doc.loc);
  const ch = rel && status ? status.changes.find((x) => x.path === rel) : undefined;
  let ranges: { kind: string; start: number; end: number }[] = [];
  // Diff HEAD against the *buffer* (unsaved edits included), in the frontend.
  if (root && rel && status?.isRepo && (ch || c.doc.dirty)) {
    if (ch && ["untracked", "added"].includes(ch.kind)) ranges = [{ kind: "added", start: 1, end: c.model.getLineCount() }];
    else if (!ch || ch.kind !== "deleted") {
      const head = await headText(root, ch?.orig ?? rel);
      if (my !== gen) return;
      ranges = head == null ? [{ kind: "added", start: 1, end: c.model.getLineCount() }] : diffHunks(head, c.model.getValue());
    }
  }
  if (my !== gen) return;
  const max = c.model.getLineCount();
  const next = ranges.map((r) => {
    const s = Math.min(Math.max(r.start, 1), max), e = Math.min(Math.max(r.end, s), max);
    return {
      range: { startLineNumber: s, startColumn: 1, endLineNumber: e, endColumn: 1 },
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `git-gutter git-gutter-${r.kind}`,
        overviewRuler: { color: r.kind === "added" ? "#a3be8c" : r.kind === "modified" ? "#81a1c1" : "#bf616a", position: 4 },
      },
    };
  });
  dec.set(c.model, c.model.deltaDecorations(dec.get(c.model) ?? [], next));
  if (modelSubModel !== c.model) {
    modelSub?.dispose();
    modelSubModel = c.model;
    modelSub = c.model.onDidChangeContent(() => {
      clearTimeout(modelTimer);
      modelTimer = setTimeout(() => updateGutter(0), 250);
    });
  }
}
let modelSubModel: editor.ITextModel | null = null;

const fmt = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
async function updateBlame() {
  const c = current();
  if (!c) return;
  const old = blameDec.get(c.model) ?? [];
  const root = gitStore.get().root;
  const rel = relPath(c.doc.loc);
  if (!blameOn || !root || !rel) {
    blameDec.set(c.model, c.model.deltaDecorations(old, []));
    return;
  }
  let ranges: BlameRange[] = [];
  try { ranges = await git.blame(root, rel); } catch (e) { log(String(e), "err"); blameOn = false; return; }
  const max = c.model.getLineCount();
  const W = 26;
  const next = ranges.filter((r) => r.start <= max).flatMap((r) =>
    Array.from({ length: Math.min(r.count, max - r.start + 1) }, (_, i) => {
      const text = i === 0 ? `${r.author.slice(0, 14).padEnd(14)} ${fmt(r.time)}`.padEnd(W) : "";
      return {
        range: { startLineNumber: r.start + i, startColumn: 1, endLineNumber: r.start + i, endColumn: 1 },
        options: {
          before: { content: (text || " ").padEnd(W, " ").replace(/ /g, " "), inlineClassName: "git-blame-inline", inlineClassNameAffectsLetterSpacing: true },
          hoverMessage: i === 0 ? { value: `**${r.author}** ${fmt(r.time)}\n\n${r.summary}\n\n\`${r.hash.slice(0, 10)}\`` } : undefined,
        },
      };
    }),
  );
  c.model.deltaDecorations(old, []);
  blameDec.set(c.model, c.model.deltaDecorations([], next));
}

export function toggleBlame() {
  blameOn = !blameOn;
  updateBlame();
}

export function installGutter() {
  let lastKey: string | null = null;
  editorStore.subscribe(() => {
    const k = activeDocKey();
    if (k !== lastKey) {
      lastKey = k;
      updateGutter();
      if (blameOn) updateBlame();
    }
  });
  let lastStatus = gitStore.get().status;
  gitStore.subscribe(() => {
    const s = gitStore.get().status;
    if (s !== lastStatus) {
      lastStatus = s;
      headCache.clear();
      updateGutter();
      if (blameOn) updateBlame();
    }
  });
}
export { absLoc };
