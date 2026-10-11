import { useEffect, useRef, useState } from "react";
import { fs, dirname } from "../../lib/ipc";
import { openExternal } from "../../lib/external";
import { monaco } from "../monacoSetup";
import { getEditor, onEditorRegistered } from "../editorRegistry";
import { openFile } from "../store";
import { registerController } from "./controllers";
import { isExternal, renderMarkdown, resolveRelative, slug } from "./markdown";
import { mimeOf } from "./io";
import { extOf } from "./registry";
import type { ViewerProps } from "./ImageViewer";

const LANG_ALIAS: Record<string, string> = { js: "javascript", ts: "typescript", sh: "shell", bash: "shell", zsh: "shell", py: "python", gd: "gdscript", rs: "rust", yml: "yaml", kt: "kotlin", tsx: "typescript", jsx: "javascript", glsl: "glsl", gdshader: "glsl", fsh: "glsl", vsh: "glsl", toml: "ini", tscn: "ini", tres: "ini", mcmeta: "json" };

export default function MarkdownPreview({ doc, groupId, text, sync }: ViewerProps & { text: string; sync: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  const urls = useRef<string[]>([]);

  useEffect(() => {
    let dead = false;
    renderMarkdown(text).then((h) => !dead && setHtml(h), (e) => !dead && setErr(String(e)));
    return () => { dead = true; };
  }, [text]);

  // after each render: heading ids, syntax highlighting (Monaco tokenizer, Nord colors), relative images
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || html === null) return;
    body.innerHTML = html;
    const seen = new Map<string, number>();
    body.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
      const s = slug(h.textContent ?? "");
      const n = seen.get(s) ?? 0;
      seen.set(s, n + 1);
      h.id = n ? `${s}-${n}` : s;
    });
    body.querySelectorAll("a[href]").forEach((a) => {
      const h = a.getAttribute("href") ?? "";
      if (isExternal(h)) { a.setAttribute("title", h); }
    });
    let dead = false;
    const langs = monaco.languages.getLanguages();
    const known = (l: string) => { const x = LANG_ALIAS[l] ?? l; return langs.some((g) => g.id === x || g.aliases?.some((al) => al.toLowerCase() === x)) ? (langs.find((g) => g.id === x || g.aliases?.some((al) => al.toLowerCase() === x))!.id) : null; };
    body.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
      const m = /language-([\w+-]+)/.exec(code.className);
      const lang = m && known(m[1].toLowerCase());
      if (!lang) return;
      monaco.editor.colorize(code.textContent ?? "", lang, { tabSize: 4 }).then((h) => { if (!dead) { code.innerHTML = h; code.classList.add("colorized"); } }, () => {});
    });
    const dir = dirname(doc.loc.path);
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
    body.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (isExternal(src) && !src.startsWith("file:")) return;
      const path = resolveRelative(dir, decodeURI(src.split(/[?#]/)[0]));
      img.removeAttribute("src");
      fs.readBytes({ host: doc.loc.host, path }).then((b) => {
        if (dead) return;
        const u = URL.createObjectURL(new Blob([b], { type: mimeOf(extOf(path)) }));
        urls.current.push(u);
        img.src = u;
        img.dataset.resolved = path;
      }, () => { img.alt = `${img.alt || "image"} (not found: ${path})`; img.classList.add("md-broken"); });
    });
    return () => { dead = true; };
  }, [html, doc.loc.host, doc.loc.path]);
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const el = bodyRef.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
      el?.scrollIntoView({ block: "start" });
    } else if (isExternal(href)) void openExternal(href);
    else {
      const [p, frag] = href.split("#");
      const path = resolveRelative(dirname(doc.loc.path), decodeURI(p));
      void fs.stat({ host: doc.loc.host, path }).then((s) => { if (s.isFile) void openFile({ host: doc.loc.host, path }); else void frag; });
    }
  };

  // ---- scroll sync with the Monaco editor of this group ----
  const lock = useRef<{ who: "editor" | "preview" | null; t: number }>({ who: null, t: 0 });
  useEffect(() => {
    if (!sync) return;
    const pv = ref.current;
    if (!pv) return;
    const anchors = () => {
      const base = pv.getBoundingClientRect().top - pv.scrollTop;
      return [...pv.querySelectorAll<HTMLElement>("[data-line]")].map((el) => ({ line: +el.dataset.line!, top: el.getBoundingClientRect().top - base }));
    };
    const LH = 20;
    const editorTopLine = (ed: ReturnType<typeof getEditor>) => {
      const r = ed!.getVisibleRanges()[0];
      if (!r) return 1;
      const l = r.startLineNumber;
      return l + (ed!.getScrollTop() - ed!.getTopForLineNumber(l)) / LH;
    };
    const lineToY = (L: number, a: { line: number; top: number }[]) => {
      if (!a.length) return 0;
      let i = a.length - 1;
      while (i > 0 && a[i].line > L) i--;
      const n = a[i + 1];
      const t = n ? Math.min(1, Math.max(0, (L - a[i].line) / Math.max(1, n.line - a[i].line))) : 0;
      return a[i].top + (n ? t * (n.top - a[i].top) : 0);
    };
    const yToLine = (y: number, a: { line: number; top: number }[]) => {
      if (!a.length) return 1;
      let i = a.length - 1;
      while (i > 0 && a[i].top > y) i--;
      const n = a[i + 1];
      const t = n ? Math.min(1, Math.max(0, (y - a[i].top) / Math.max(1, n.top - a[i].top))) : 0;
      return a[i].line + (n ? t * (n.line - a[i].line) : 0);
    };
    const take = (who: "editor" | "preview") => {
      const now = performance.now();
      if (lock.current.who && lock.current.who !== who && now - lock.current.t < 120) return false;
      lock.current = { who, t: now };
      return true;
    };
    const subs: (() => void)[] = [];
    const attach = (ed: NonNullable<ReturnType<typeof getEditor>>) => {
      const d = ed.onDidScrollChange((e) => {
        if (!e.scrollTopChanged) return;
        if (!take("editor")) return;
        pv.scrollTop = lineToY(editorTopLine(ed), anchors());
      });
      subs.push(() => d.dispose());
    };
    const un = onEditorRegistered((ed) => { if (getEditor(groupId) === ed) attach(ed); });
    const onPv = () => {
      const ed = getEditor(groupId);
      if (!ed || !take("preview")) return;
      const L = yToLine(pv.scrollTop, anchors());
      const l = Math.floor(L);
      ed.setScrollTop(ed.getTopForLineNumber(Math.max(1, l)) + (L - l) * LH);
    };
    pv.addEventListener("scroll", onPv, { passive: true });
    return () => { un(); subs.forEach((f) => f()); pv.removeEventListener("scroll", onPv); };
  }, [sync, groupId, doc.loc.path, doc.loc.host]);

  useEffect(() => registerController(groupId, {
    snapshot: () => {
      const pv = ref.current;
      const ed = getEditor(groupId);
      return {
        kind: "markdown", blocks: pv?.querySelectorAll("[data-line]").length ?? 0, previewScrollTop: pv?.scrollTop ?? 0, previewScrollHeight: pv?.scrollHeight ?? 0,
        editorScrollTop: ed?.getScrollTop() ?? null, editorScrollHeight: ed?.getScrollHeight() ?? null, sync,
        images: [...(pv?.querySelectorAll<HTMLImageElement>("img") ?? [])].map((i) => ({ resolved: i.dataset.resolved ?? null, ok: i.complete && i.naturalWidth > 0 })),
        tables: pv?.querySelectorAll("table").length ?? 0, tasks: pv?.querySelectorAll("input[type=checkbox]").length ?? 0,
        colorized: pv?.querySelectorAll("code.colorized").length ?? 0, scripts: pv?.querySelectorAll("script,iframe,[onerror],[onclick]").length ?? 0,
      };
    },
    ...( { scrollEditor: (top: number) => getEditor(groupId)?.setScrollTop(top), scrollPreview: (top: number) => { if (ref.current) ref.current.scrollTop = top; } } as object),
  }), [groupId, sync]);

  return (
    <div className="md-preview" ref={ref} data-viewer="markdown" onClick={onClick}>
      {err ? <div className="vw-msg-detail">{err}</div> : <div className="md-body markdown-body" ref={bodyRef} />}
    </div>
  );
}
