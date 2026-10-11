import { useEffect, useRef, useState } from "react";
import "./theme.css";
import { PopupShell, closePopup, openPopup, type PopupProps } from "../components/shell/popups";
import { useStore } from "../lib/store";
import { SCHEMES, previewScheme, schemeById, schemeStore, setScheme } from "./index";
import { parseTok } from "./build";
import type { Scheme, Syn } from "./types";

const c = (s: Scheme, k: keyof Syn) => ({ color: "#" + parseTok(s.syn[k]).fg, fontStyle: parseTok(s.syn[k]).style.includes("italic") ? "italic" : "normal" });

function Chips({ s }: { s: Scheme }) {
  return <span className="scheme-chips">{(["keyword", "control", "type", "fnDecl", "call", "field", "string", "number"] as const).map((k) => <i key={k} style={{ background: "#" + parseTok(s.syn[k]).fg }} />)}</span>;
}

/** A tiny Java-like sample painted with the scheme's roles (what Settings shows instead of a live editor). */
function Sample({ s }: { s: Scheme }) {
  const S = (k: keyof Syn, t: string) => <span style={c(s, k)}>{t}</span>;
  const bg = "#" + s.ui.bg, fg = "#" + s.ui.fg;
  return (
    <div className="scheme-code" style={{ background: bg, color: fg }}>
      {S("docComment", "/** ")}{S("docTag", "@see")}{S("docComment", " Registry */")}{"\n"}
      {S("annotation", "@Mixin")}{S("punct", "(")}{S("type", "Player")}{S("punct", ".class)")}{"\n"}
      {S("keyword", "public class ")}{S("type", "Spawner")}{S("keyword", " extends ")}{S("type", "Base")}{" {\n"}
      {"  "}{S("keyword", "static final int ")}{S("constant", "MAX")}{" = "}{S("number", "16")}{";\n"}
      {"  "}{S("keyword", "private ")}{S("type", "String ")}{S("field", "name")}{";\n\n"}
      {"  "}{S("keyword", "void ")}{S("fnDecl", "spawn")}{"("}{S("type", "Level ")}{S("param", "level")}{") {\n"}
      {"    "}{S("control", "if ")}{"("}{S("param", "level")}{S("operator", " != ")}{S("keyword", "null")}{") {\n"}
      {"      "}{S("self", "this")}{"."}{S("field", "name")}{S("operator", " = ")}{S("string", "\"zombie")}{S("escape", "\\n")}{S("string", "\"")}{";\n"}
      {"      "}{S("call", "log")}{"("}{S("constant", "MAX")}{");  "}{S("comment", "// vivid?")}{"\n"}
      {"    }\n  }\n}"}
    </div>
  );
}

export function SettingsPopup({ onClose }: PopupProps) {
  const { saved } = useStore(schemeStore);
  const [page, setPage] = useState<"appearance" | "terminal">("appearance");
  const [sel, setSel] = useState(saved);
  const revert = () => { previewScheme(null); onClose(); };
  const pick = (id: string) => { setSel(id); previewScheme(id === schemeStore.get().saved ? null : id); };
  const ok = () => { setScheme(sel); onClose(); };
  const s = schemeById(sel);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (page !== "appearance") return;
      const i = SCHEMES.findIndex((x) => x.id === sel);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick(SCHEMES[(i + (e.key === "ArrowDown" ? 1 : SCHEMES.length - 1)) % SCHEMES.length].id); }
      else if (e.key === "Enter") { e.preventDefault(); ok(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  useEffect(() => { listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  return (
    <PopupShell onClose={revert} width={820} height={540}>
      <div className="set-wrap" data-settings>
        <div className="set-nav">
          <div className="set-nav-h">Appearance &amp; Behavior</div>
          <div className={"set-nav-item" + (page === "appearance" ? " on" : "")} onClick={() => setPage("appearance")}>Appearance</div>
          <div className="set-nav-h">Editor</div>
          <div className={"set-nav-item"} onClick={() => setPage("appearance")}>Color Scheme</div>
          <div className="set-nav-h">Tools</div>
          <div className={"set-nav-item" + (page === "terminal" ? " on" : "")} onClick={() => setPage("terminal")}>Terminal</div>
        </div>
        {page === "appearance" ? (
          <div className="set-page">
            <div className="set-crumb">Appearance &amp; Behavior &#8250; Appearance</div>
            <div className="set-title">Theme</div>
            <div className="set-body">
              <div className="scheme-list" ref={listRef}>
                {SCHEMES.map((x) => (
                  <div key={x.id} data-id={x.id} className={"scheme-row" + (x.id === sel ? " sel" : "")} onClick={() => pick(x.id)} onDoubleClick={ok}>
                    <span className="scheme-name">{x.name}{x.id === saved && <span className="cur">current</span>}</span>
                    <Chips s={x} />
                  </div>
                ))}
              </div>
              <div className="scheme-preview">
                <div className="scheme-blurb">{s.blurb}. The theme drives the UI, editor colours, semantic highlighting and the default terminal palette.</div>
                <Sample s={s} />
              </div>
            </div>
            <div className="set-foot">
              <button onClick={revert}>Cancel</button>
              <button className="primary" data-ok onClick={ok}>OK</button>
            </div>
          </div>
        ) : (
          <div className="set-page">
            <div className="set-crumb">Tools &#8250; Terminal</div>
            <div className="set-title">Terminal</div>
            <div className="set-term">
              <div className="scheme-blurb">The terminal follows the IDE theme unless a Ghostty theme is chosen in its own settings.</div>
              <button onClick={() => { closePopup(); setTimeout(() => openPopup("TerminalSettings"), 0); }}>Open Terminal Settings…</button>
            </div>
          </div>
        )}
      </div>
    </PopupShell>
  );
}

/** Quick Switch Scheme (⌃`): arrows preview live, Enter keeps, Esc restores. */
export function SchemePopup({ onClose }: PopupProps) {
  const start = useRef(schemeStore.get().saved);
  const [sel, setSel] = useState(Math.max(0, SCHEMES.findIndex((x) => x.id === start.current)));
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const move = (i: number) => { const n = (i + SCHEMES.length) % SCHEMES.length; setSel(n); previewScheme(SCHEMES[n].id === start.current ? null : SCHEMES[n].id); };
  const commit = (i: number) => { done.current = true; setScheme(SCHEMES[i].id); onClose(); };
  const cancel = () => { done.current = true; previewScheme(null); onClose(); };
  useEffect(() => { ref.current?.focus(); return () => { if (!done.current) previewScheme(null); }; }, []);
  return (
    <PopupShell onClose={cancel} width={340}>
      <div className="qs" ref={ref} tabIndex={-1} data-qs
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(sel + 1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); move(sel - 1); }
          else if (e.key === "Enter") { e.preventDefault(); commit(sel); }
          else if (/^[0-9]$/.test(e.key)) { const i = e.key === "0" ? 9 : +e.key - 1; if (i < SCHEMES.length) { e.preventDefault(); commit(i); } }
        }}>
        <div className="qs-title">Switch Theme</div>
        {SCHEMES.map((x, i) => (
          <div key={x.id} data-id={x.id} className={"popup-row qs-row" + (i === sel ? " selected" : "")} onMouseMove={() => i !== sel && move(i)} onClick={() => commit(i)}>
            <span className="num">{i === 9 ? 0 : i + 1 <= 9 ? i + 1 : ""}</span>
            <span>{x.name}</span>
            {x.id === start.current && <span className="chk">&#10003;</span>}
          </div>
        ))}
        <div className="qs-hint">&#8593;&#8595; preview &middot; &#8629; apply &middot; Esc cancel</div>
      </div>
    </PopupShell>
  );
}
