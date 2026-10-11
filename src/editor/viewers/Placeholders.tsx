import { useEffect, useState } from "react";
import { fs } from "../../lib/ipc";
import { openAsText, type Doc } from "../store";
import { formatSize } from "./registry";
import { useBytes } from "./io";

export function Message({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="vw-msg" data-viewer="message">
      <div className="vw-msg-title">{title}</div>
      {detail && <div className="vw-msg-detail">{detail}</div>}
      {children}
    </div>
  );
}

const hexLine = (b: Uint8Array, off: number) => {
  const hex: string[] = [], asc: string[] = [];
  for (let i = 0; i < 16; i++) {
    if (i < b.length) { hex.push(b[i].toString(16).padStart(2, "0")); asc.push(b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : "."); }
    else hex.push("  ");
  }
  return `${off.toString(16).padStart(8, "0")}  ${hex.slice(0, 8).join(" ")}  ${hex.slice(8).join(" ")}  |${asc.join("")}|`;
};
export function hexDump(b: Uint8Array, max = 512) {
  const lines: string[] = [];
  for (let o = 0; o < Math.min(b.length, max); o += 16) lines.push(hexLine(b.subarray(o, o + 16), o));
  return lines.join("\n");
}

/** IntelliJ "File type not supported / binary": size, magic, hex preview of the head. Never garbage text in Monaco. */
export function BinaryViewer({ doc }: { doc: Doc }) {
  const [head, setHead] = useState<Uint8Array>();
  const [size, setSize] = useState<number | undefined>(doc.size);
  useEffect(() => {
    fs.readBytes(doc.loc, 0, 512).then((b) => setHead(new Uint8Array(b)), () => {});
    fs.stat(doc.loc).then((s) => setSize(s.size), () => {});
  }, [doc.key, doc.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Message title="File type is not supported" detail={`${doc.name} is a binary file${size !== undefined ? ` (${formatSize(size)})` : ""}. Ace has no editor for it.`}>
      <div className="vw-actions">
        <button onClick={() => void navigator.clipboard?.writeText(doc.loc.path)}>Copy Path</button>
        <button onClick={() => void openAsText(doc.key).catch(() => {})}>Open as Text anyway</button>
      </div>
      {head && <pre className="vw-hex" data-testid="hex">{hexDump(head)}</pre>}
    </Message>
  );
}

export function TooLargeViewer({ doc }: { doc: Doc }) {
  return (
    <Message title="The file is too large to open in the editor" detail={`${doc.name} is ${doc.size !== undefined ? formatSize(doc.size) : "very large"}. Opening it as text could freeze the IDE.`}>
      <div className="vw-actions">
        <button onClick={() => void openAsText(doc.key).catch(() => {})}>Open Anyway</button>
        <button onClick={() => void navigator.clipboard?.writeText(doc.loc.path)}>Copy Path</button>
      </div>
    </Message>
  );
}
export { useBytes };
