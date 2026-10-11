import { useEffect, useState } from "react";
import { registerController } from "./controllers";
import { useBytes } from "./io";
import { extOf, formatSize } from "./registry";
import { Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

let seq = 0;
const SIZES = [12, 14, 18, 24, 36, 48, 72];
export default function FontViewer({ doc, groupId }: ViewerProps) {
  const { data, error } = useBytes(doc);
  const [family, setFamily] = useState<string>();
  const [err, setErr] = useState<string>();
  const [text, setText] = useState("The quick brown fox jumps over the lazy dog");
  useEffect(() => {
    if (!data) return;
    const fam = `ace-font-${++seq}`;
    const ff = new FontFace(fam, data.slice(0));
    let dead = false;
    ff.load().then(() => { if (dead) return; document.fonts.add(ff); setFamily(fam); }, (e) => !dead && setErr(String(e?.message ?? e)));
    return () => { dead = true; document.fonts.delete(ff); };
  }, [data]);
  useEffect(() => registerController(groupId, { snapshot: () => ({ kind: "font", family, loaded: !!family && document.fonts.check(`16px ${family}`) }) }), [groupId, family]);
  if (error || err) return <Message title="Cannot load font" detail={error ?? err} />;
  const f = family ? { fontFamily: `"${family}"` } : undefined;
  return (
    <div className="fv" data-viewer="font">
      <div className="iv-bar"><span>{doc.name}</span><span className="grow" /><span className="iv-dim">{extOf(doc.name).toUpperCase()} · {formatSize(data?.byteLength ?? 0)}</span></div>
      <div className="fv-body">
        <input className="fv-sample" value={text} onChange={(e) => setText(e.target.value)} style={f} spellCheck={false} />
        <div className="fv-glyphs" style={f}>ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 !?@#$%&amp;*()[]{}&lt;&gt;/\|+-=_.,;:'"</div>
        {SIZES.map((s) => <div key={s} className="fv-line"><span className="fv-size">{s}</span><span style={{ ...f, fontSize: s }}>{text}</span></div>)}
      </div>
    </div>
  );
}
