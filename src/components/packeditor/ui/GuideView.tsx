/**
 * A guide book entry or category (assets/<ns>/guide/<book>/<lang>/…): its pages in order with a page preview in the book's
 * markup, and every field the page type takes (GuideSchema), so a page can be written, retyped, reordered or added here.
 */
import { useMemo, useState } from "react";
import { packRoot } from "../core/kinds";
import { CATEGORY_FIELDS, ENTRY_FIELDS, PAGE_TYPES, guideKind, pageType, parseMarkup, type GuideField } from "../core/guide";
import { setJson } from "../core/suit";
import { useAsync } from "./data";
import { Docks, ParseError, type ViewProps } from "./PackView";
import { resourceRoots, tr, translations } from "./resolve";
import { BoolField, Empty, EnumField, NumberField, Section, SceneTree, TextField, type TreeNode } from "./widgets";

type Page = Record<string, unknown>;
const asPage = (p: unknown): Page => (typeof p === "string" ? { type: "text", text: p } : p && typeof p === "object" ? (p as Page) : {});

export default function GuideView({ host, path, text, edit }: ViewProps) {
  const kind = guideKind(path) ?? "entry";
  const { raw, error } = useMemo(() => { try { return { raw: JSON.parse(text) as Record<string, unknown>, error: null }; } catch (e) { return { raw: null, error: e }; } }, [text]);
  const pr = packRoot(path);
  const [roots] = useAsync(() => resourceRoots(host, path), [host, path], [] as string[]);
  const [lang] = useAsync(() => (roots.length && pr ? translations(host, roots, pr.ns) : Promise.resolve({} as Record<string, string>)), [roots], {} as Record<string, string>);
  const [sel, setSel] = useState<number | null>(kind === "entry" ? 0 : null);
  if (error || !raw) return <ParseError error={error} />;

  const pages = Array.isArray(raw.pages) ? (raw.pages as unknown[]) : [];
  const set = (p: Array<string | number>, v: unknown, live = false) => edit((cur) => setJson(cur, p, v), live);
  const setPageField = (i: number, k: string, v: unknown) => {
    const pg = pages[i];
    if (typeof pg === "string") {
      if (k === "text" && typeof v === "string") return set(["pages", i], v);
      return set(["pages", i], { ...asPage(pg), [k]: v });
    }
    set(["pages", i, k], v === "" ? undefined : v);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= pages.length) return;
    const next = [...pages];
    [next[i], next[j]] = [next[j], next[i]];
    set(["pages"], next);
    setSel(j);
  };

  const nodes: TreeNode[] = [{
    id: "root", label: tr(lang, raw.name) || (raw.name as string) || path.split("/").pop()!, icon: kind === "entry" ? "i-entry" : "i-folder", hint: kind,
    children: pages.map((p, i) => { const pg = asPage(p); return { id: String(i), label: `${i + 1}. ${pg.type ?? "text"}`, icon: "i-page", hint: String(pg.title ?? "").slice(0, 24) || undefined }; }),
  }];

  const cur = sel !== null && sel < pages.length ? asPage(pages[sel]) : null;
  const pt = cur ? pageType(cur.type ?? "text") : undefined;

  const inspector = (() => {
    if (!cur) return (
      <Section title={kind === "entry" ? "Entry" : "Category"}>
        {(kind === "entry" ? ENTRY_FIELDS : CATEGORY_FIELDS).map((f) => <FieldEditor key={f.name} f={f} value={raw[f.name]} onChange={(v) => set([f.name], v === "" ? undefined : v)} />)}
        {kind === "entry" && <div className="pe-btns"><button className="pe-btn" onClick={() => { set(["pages", pages.length], { type: "text", title: "", text: "" }); setSel(pages.length); }}>+ Page</button></div>}
      </Section>
    );
    return (
      <>
        <Section title={`Page ${sel! + 1}`} right={<span className="pe-mini">
          <button className="pe-link" onClick={() => move(sel!, -1)} disabled={sel === 0}>↑</button>
          <button className="pe-link" onClick={() => move(sel!, 1)} disabled={sel === pages.length - 1}>↓</button>
          <button className="pe-link" onClick={() => { set(["pages", sel!], undefined); setSel(Math.max(0, sel! - 1)); }}>Delete</button>
        </span>}>
          <EnumField label="Type" value={String(cur.type ?? "text")} options={PAGE_TYPES.map((t) => t.name)} onChange={(v) => setPageField(sel!, "type", v)} testId="pe-page-type" />
          {pt && <div className="pe-note">{pt.doc}{pt.dynamic ? " Filled in from the game's data." : ""}</div>}
          {(pt?.fields ?? []).map((f) => <FieldEditor key={f.name} f={f} value={cur[f.name]} onChange={(v) => setPageField(sel!, f.name, v)} />)}
        </Section>
        <div className="pe-btns"><button className="pe-btn" onClick={() => { set(["pages", sel! + 1], { type: "text", title: "", text: "" }); setSel(sel! + 1); }}>+ Page after</button></div>
      </>
    );
  })();

  const view = (
    <div className="pe-stage book">
      <div className="pe-book" data-testid="pe-guide">
        <div className="pe-book-h">{tr(lang, raw.name) || String(raw.name ?? "")}</div>
        {cur ? <PageBody p={cur} lang={lang} /> : <div className="pe-book-p dim">{kind === "entry" ? `${pages.length} page${pages.length === 1 ? "" : "s"}` : String(raw.description ?? "")}</div>}
        {pages.length > 1 && (
          <div className="pe-book-nav">
            <button onClick={() => setSel(Math.max(0, (sel ?? 0) - 1))} disabled={!sel}>‹</button>
            <span>{(sel ?? 0) + 1} / {pages.length}</span>
            <button onClick={() => setSel(Math.min(pages.length - 1, (sel ?? -1) + 1))} disabled={sel === pages.length - 1}>›</button>
          </div>
        )}
      </div>
    </div>
  );
  return <Docks id="guide" tree={<SceneTree nodes={nodes} selected={sel === null ? "root" : String(sel)} onSelect={(id) => setSel(id === "root" ? null : Number(id))} testId="pe-tree" />} view={view} inspector={inspector} />;
}

function FieldEditor({ f, value, onChange }: { f: GuideField; value: unknown; onChange: (v: unknown) => void }) {
  const label = f.name + (f.required ? " *" : "");
  if (f.kind === "bool") return <BoolField label={label} value={value as boolean | undefined} doc={f.doc} onChange={onChange} />;
  if (f.kind === "int") return <NumberField label={label} value={value as number | undefined} step={1} doc={f.doc} onChange={(v) => onChange(v)} />;
  if (f.kind === "markup") return <TextField label={label} value={value as string | undefined} doc={f.doc} multiline onChange={onChange} testId={`pe-field-${f.name}`} />;
  if (f.kind === "markups" || f.kind === "ids" || f.kind === "texts") {
    const list = Array.isArray(value) ? (value as unknown[]).map(String) : typeof value === "string" ? [value] : [];
    return <TextField label={label} value={list.join("\n")} doc={f.doc + " One per line."} multiline mono={f.kind !== "markups"}
      onChange={(v) => onChange(v.split("\n").map((s) => s.trim()).filter(Boolean))} />;
  }
  if (f.kind === "objects") return <div className="pe-row"><div className="pe-row-l" title={f.doc}>{label}</div><div className="pe-row-r pe-ro">{Array.isArray(value) ? `${value.length} rows (edit in code)` : "(none)"}</div></div>;
  if (f.name === "requires") return <EnumField label={label} value={value as string | undefined} options={["op"]} allowEmpty="(everyone)" doc={f.doc} onChange={onChange} />;
  return <TextField label={label} value={value as string | undefined} doc={f.doc} mono={f.kind !== "text"} onChange={onChange} />;
}

function Markup({ s }: { s: string | undefined }) {
  return (
    <>
      {parseMarkup(s).map((r, i) => r.text === "\n" ? <br key={i} /> : (
        <span key={i} className={(r.bold ? "b " : "") + (r.italic ? "i " : "") + (r.link ? "lnk" : "")} title={r.link ?? undefined}
          style={r.color >= 0 ? { color: "#" + r.color.toString(16).padStart(6, "0") } : undefined}>{r.text}</span>
      ))}
    </>
  );
}

function PageBody({ p, lang }: { p: Page; lang: Record<string, string> }) {
  const t = String(p.type ?? "text");
  const chip = (s: string) => <div className="pe-book-chip">{s}</div>;
  return (
    <div className="pe-book-p">
      {typeof p.title === "string" && p.title && <div className="pe-book-t"><Markup s={p.title} /></div>}
      {t === "spotlight" && chip(`item · ${String(p.item ?? "")}`)}
      {t === "crafting" && chip(`recipe · ${String(p.recipe ?? "")}${p.recipe2 ? " + " + String(p.recipe2) : ""}`)}
      {t === "image" && chip(`image · ${(Array.isArray(p.images) ? p.images : []).join(", ")}`)}
      {t === "figure" && chip(`${p.suit ? "suit · " + String(p.suit) : "entity · " + String(p.entity ?? "")}`)}
      {t === "structure" && chip(`structure · ${String(p.structure ?? "")}`)}
      {t === "links" && <ul className="pe-book-links">{(Array.isArray(p.entries) ? p.entries : []).map((e) => <li key={String(e)}>{String(e)}</li>)}</ul>}
      {["suit_recipe", "suit_stats", "suit_abilities", "ore", "ability_data", "ability_keybinds", "ability_animation_api", "ability_items"].includes(t) && chip(`${t.replace(/_/g, " ")}${p.suit ? " · " + String(p.suit) : ""} (filled in by the game)`)}
      {t === "passive_description" && <div className="pe-book-x"><Markup s={p.description as string} /></div>}
      {typeof p.text === "string" && <div className="pe-book-x"><Markup s={p.text} /></div>}
      {typeof p.name === "string" && t === "figure" && <div className="pe-book-cap">{tr(lang, p.name)}</div>}
    </div>
  );
}

export { Empty };
