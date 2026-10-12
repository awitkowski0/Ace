/** Styles for the timeline/tools half of the Studio (class prefix `as-`). Injected once. */
const CSS = `
.as-tl { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg-editor); color:var(--fg); font-size:12px; }
.as-tb { display:flex; align-items:center; gap:2px; height:26px; padding:0 6px; flex:none; border-bottom:1px solid var(--border); background:var(--bg-chrome); overflow:hidden; min-width:0; container-type:inline-size; container-name:astb; contain:strict; }
.as-tb > * { flex:none; }
.as-tb > .grow { flex:1 1 0; min-width:0; }
.as-time { flex:none; }
/* narrow dock: drop the text labels (icons + tooltips stay) so nothing overlaps */
@container astb (max-width: 520px) { .as-sel, .as-state { display:none; } }
.as-tb .sep { width:1px; height:16px; background:var(--border); margin:0 4px; }
.as-btn { height:20px; min-width:22px; padding:0 5px; border-radius:4px; display:inline-flex; align-items:center; justify-content:center; gap:4px; color:var(--fg-dim); white-space:nowrap; }
.as-btn:hover:not(:disabled) { background:var(--bg-hover); color:var(--fg); }
.as-btn.on { background:var(--bg-selected); color:var(--accent); }
.as-btn:disabled { opacity:.4; }
.as-btn.primary { background:var(--accent-bg); color:#fff; }
.as-btn.primary:hover:not(:disabled) { background:#6a8fba; color:#fff; }
.as-btn svg { width:14px; height:14px; flex:none; }
.as-tab { white-space:nowrap; height:28px; padding:0 10px; color:var(--fg-dim); border-bottom:2px solid transparent; display:inline-flex; align-items:center; }
.as-tab.on { color:var(--fg); border-bottom-color:var(--accent); }
.as-tab:hover { color:var(--fg); }
.as-time { font-family:var(--font-mono); font-size:11px; color:var(--fg-dim); min-width:92px; text-align:center; font-variant-numeric:tabular-nums; }
.as-state { height:18px; padding:0 7px; margin-left:4px; border-radius:9px; background:var(--bg-input); color:var(--fg-dim); font-size:11px; display:inline-flex; align-items:center; gap:4px; }
.as-state:hover { color:var(--fg); }
.as-state .rec { width:6px; height:6px; border-radius:50%; background:var(--nord11); }
.as-pchip { height:18px; padding:0 7px; margin-right:4px; border-radius:9px; background:var(--bg-input); display:inline-flex; align-items:center; gap:7px; font-size:11px; color:var(--fg-dim); }
.as-pchip:hover, .as-pchip.on { background:var(--bg-selected); color:var(--fg); }
.as-pchip .cnt { display:inline-flex; align-items:center; gap:4px; }
.as-pchip .dot { width:6px; height:6px; border-radius:50%; }
.as-pchip .dot.error { background:var(--nord11); } .as-pchip .dot.warning { background:var(--nord13); } .as-pchip .dot.info { background:var(--nord9); }
.as-sel { height:22px; background:var(--bg-input); border:1px solid var(--border); border-radius:4px; color:var(--fg); font-size:12px; padding:0 4px; }
.as-sel:focus, .as-in:focus { border-color:var(--accent-bg); }
.as-in { height:22px; background:var(--bg-input); border:1px solid var(--border); border-radius:4px; color:var(--fg); font-size:12px; padding:0 6px; min-width:0; }
.as-in.num { font-family:var(--font-mono); text-align:right; }
.as-in.mixed::placeholder { color:var(--fg-faint); }
.as-canvas-wrap { position:relative; flex:1; min-height:0; overflow:hidden; }
.as-canvas-wrap canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.as-tip { position:absolute; z-index:5; pointer-events:none; background:var(--bg-popup); border:1px solid var(--border); border-radius:5px; padding:3px 7px; font-size:12px; color:var(--fg); box-shadow:0 4px 14px rgba(0,0,0,.4); max-width:300px; }
.as-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; height:100%; color:var(--fg-dim); text-align:center; padding:12px; }

/* animations panel */
.as-panel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg-chrome); color:var(--fg); font-size:13px; }
.as-ph { height:26px; display:flex; align-items:center; gap:2px; padding:0 6px; flex:none; border-bottom:1px solid var(--border); }
.as-ph .title { font-weight:600; font-size:12px; color:var(--fg-dim); flex:1; }
.as-search { margin:6px; flex:none; }
.as-list { flex:1; min-height:0; overflow:auto; }
.as-arow { min-height:24px; padding:2px 8px; display:flex; flex-direction:column; justify-content:center; gap:2px; border-left:2px solid transparent; }
.as-arow .pdot { width:6px; height:6px; border-radius:50%; flex:none; } .as-arow .pdot.err { background:var(--nord11); } .as-arow .pdot.warn { background:var(--nord13); }
.as-arow .as-hint { flex:none; font-variant-numeric:tabular-nums; opacity:.8; }
.as-arow:not(.sel) .as-hint { opacity:.55; }
.as-arow:hover { background:var(--bg-hover); }
.as-arow.sel { background:var(--bg-selected); border-left-color:var(--accent); }
.as-arow .nm { display:flex; align-items:center; gap:6px; min-width:0; }
.as-arow .nm span.t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.as-arow .nm span.t i { font-style:normal; color:var(--fg-faint); }
.as-badges { display:flex; flex-wrap:wrap; gap:3px; padding-bottom:2px; }
.as-badge { font-size:10px; line-height:14px; padding:0 5px; border-radius:7px; background:var(--bg-input); color:var(--fg-faint); white-space:nowrap; }
.as-badge.role { background:rgba(129,161,193,.22); color:var(--nord9); }
.as-badge.pb { background:rgba(163,190,140,.2); color:var(--nord14); }
.as-badge.state { background:rgba(180,142,173,.2); color:var(--nord15); }
.as-badge.mir { background:rgba(136,192,208,.2); color:var(--nord8); }
.as-badge.pose { background:rgba(235,203,139,.2); color:var(--nord13); }
.as-stride { display:flex; align-items:center; gap:6px; padding:0 6px; }
.as-stride input[type=range] { width:90px; }
.as-kind { font-size:9px; line-height:13px; padding:0 4px; margin-left:4px; border-radius:6px; flex:none; letter-spacing:.2px; }
.as-kind.drawn, .as-badge.kind.drawn { background:rgba(129,161,193,.22); color:var(--nord9); }
.as-kind.pose, .as-badge.kind.pose { background:rgba(235,203,139,.22); color:var(--nord13); }
.as-kind.stride, .as-badge.kind.stride { background:rgba(163,190,140,.22); color:var(--nord14); }
.as-badge.err { background:rgba(191,97,106,.28); color:var(--nord11); }
.as-badge.warn { background:rgba(235,203,139,.22); color:var(--nord13); }
.as-pf { flex:none; border-top:1px solid var(--border); padding:5px 8px; display:grid; grid-template-columns:auto 1fr; gap:4px 8px; align-items:center; }
.as-lcol { height:100%; min-height:0; display:flex; flex-direction:column; background:var(--bg-chrome); }
.as-lcol.scroll { overflow-y:auto; }
.as-lcol .as-panel { height:auto; flex:1; }
.as-pf label { color:var(--fg-dim); font-size:12px; }

/* inspector */
.as-insp { padding:8px; display:flex; flex-direction:column; gap:8px; font-size:12px; color:var(--fg); overflow:auto; height:100%; background:var(--bg-chrome); }
.as-insp h4 { margin:0; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--fg-dim); }
.as-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; align-items:center; }
.as-row { display:flex; align-items:center; gap:6px; }
.as-row > label { width:64px; color:var(--fg-dim); flex:none; }
.as-seg { display:inline-flex; border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.as-seg button { height:22px; padding:0 8px; color:var(--fg-dim); }
.as-seg button.on { background:var(--accent-bg); color:#fff; }
.as-seg button:hover:not(.on) { background:var(--bg-hover); color:var(--fg); }
.as-dd { position:relative; flex:1; min-width:0; }
.as-dd > button { width:100%; height:24px; display:flex; align-items:center; gap:6px; padding:0 6px; background:var(--bg-input); border:1px solid var(--border); border-radius:4px; text-align:left; }
.as-dd > button span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.as-dd-pop { position:fixed; z-index:200; width:230px; max-height:300px; overflow:auto; background:var(--bg-popup); border:1px solid var(--border); border-radius:8px; padding:4px; box-shadow:0 8px 28px rgba(0,0,0,.5); }
.as-dd-item { height:26px; display:flex; align-items:center; gap:8px; padding:0 6px; border-radius:4px; }
.as-dd-item:hover, .as-dd-item.on { background:var(--bg-selected); }
.as-dd-item svg { flex:none; }
.as-dd-item span { flex:1; }

/* breakdown + noise */
.as-float { position:absolute; right:12px; bottom:12px; z-index:30; width:320px; background:var(--bg-popup); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.5); color:var(--fg); font-size:12px; }
.as-float > .hd { height:28px; display:flex; align-items:center; padding:0 6px 0 10px; border-bottom:1px solid var(--border); font-weight:600; }
.as-float > .hd span { flex:1; }
.as-float > .bd { padding:10px; display:flex; flex-direction:column; gap:8px; }
.as-float > .ft { display:flex; justify-content:flex-end; gap:6px; padding:8px 10px; border-top:1px solid var(--border); }
.as-modal-bg { position:fixed; inset:0; z-index:150; display:flex; align-items:flex-start; justify-content:center; padding-top:12vh; background:rgba(20,24,32,.45); }
.as-modal { width:440px; max-height:78vh; display:flex; flex-direction:column; background:var(--bg-popup); border:1px solid var(--border); border-radius:10px; box-shadow:0 14px 48px rgba(0,0,0,.6); color:var(--fg); font-size:13px; }
.as-modal > .hd { padding:12px 14px 6px; font-size:15px; font-weight:600; }
.as-modal > .bd { padding:6px 14px 10px; overflow:auto; display:flex; flex-direction:column; gap:8px; }
.as-modal > .ft { display:flex; justify-content:flex-end; gap:8px; padding:10px 14px; border-top:1px solid var(--border); }
.as-modal .as-btn { height:26px; padding:0 12px; border:1px solid var(--border); }
.as-modal .as-btn.primary { border-color:transparent; }
.as-lbl { width:92px; color:var(--fg-dim); flex:none; }
.as-slider { flex:1; accent-color:var(--accent-bg); min-width:0; }
.as-pct { font-family:var(--font-mono); min-width:48px; text-align:right; }
.as-chk { white-space:nowrap; display:inline-flex; align-items:center; gap:5px; color:var(--fg); }
.as-chk input { accent-color:var(--accent-bg); margin:0; }
.as-hint { color:var(--fg-faint); font-size:11px; }
.as-axf { position:relative; display:flex; align-items:center; min-width:0; }
.as-scrub { position:absolute; right:5px; top:50%; transform:translateY(-50%); font-size:9px; font-weight:700; opacity:.55; cursor:ew-resize; user-select:none; padding:2px 3px; z-index:1; }
.as-scrub:hover { opacity:1; background:var(--bg-hover, rgba(255,255,255,.08)); border-radius:3px; }
.as-axf .as-in { padding-right:18px; }
.as-multihint { margin-top:3px; line-height:1.35; }
.as-sub { font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--fg-dim); margin-top:2px; }

/* problems strip */
.as-prob { display:flex; flex-direction:column; background:var(--bg-chrome); border-bottom:1px solid var(--border); font-size:12px; color:var(--fg); min-height:0; }
.as-prob .bar { height:20px; display:flex; align-items:center; gap:10px; padding:0 8px; flex:none; }
.as-prob .cnt { display:inline-flex; align-items:center; gap:4px; }
.as-prob .dot { width:8px; height:8px; border-radius:50%; flex:none; }
.as-prob .dot.error { background:var(--nord11); } .as-prob .dot.warning { background:var(--nord13); } .as-prob .dot.info { background:var(--nord9); }
.as-prob .lst { max-height:170px; overflow:auto; border-top:1px solid var(--border); }
.as-prob .it { min-height:24px; display:flex; align-items:center; gap:8px; padding:2px 8px; }
.as-prob .it:hover { background:var(--bg-hover); }
.as-prob .it .msg { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.as-prob .it .loc { color:var(--fg-faint); font-size:11px; white-space:nowrap; }
.as-prob .fix { height:20px; padding:0 8px; border-radius:4px; background:var(--bg-input); border:1px solid var(--border); color:var(--accent); white-space:nowrap; }
.as-prob .fix:hover { background:var(--bg-selected); }
`;
export function ensureStyles(): void {
  if (typeof document === "undefined" || document.getElementById("as-timeline-css")) return;
  const el = document.createElement("style");
  el.id = "as-timeline-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}
