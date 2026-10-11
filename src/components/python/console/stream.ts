/** Splits the console process output into plain text and `\x1e##ace:{json}` control events (docs/PYTHON.md). */
export const MARK = "\x1e##ace:";

export type StreamItem = { t: "text"; err: boolean; d: string } | { t: "ev"; ev: { k: string; id?: number; [x: string]: unknown } };

export class Splitter {
  private buf = "";
  push(seg: { s: "out" | "err"; d: string }): StreamItem[] {
    if (seg.s === "err") return seg.d ? [{ t: "text", err: true, d: seg.d }] : [];
    this.buf += seg.d;
    const out: StreamItem[] = [];
    const text = (d: string) => { if (d) out.push({ t: "text", err: false, d }); };
    for (;;) {
      const i = this.buf.indexOf("\x1e");
      if (i < 0) { text(this.buf); this.buf = ""; break; }
      text(this.buf.slice(0, i));
      this.buf = this.buf.slice(i);
      const nl = this.buf.indexOf("\n");
      if (nl < 0) {
        if ((MARK.startsWith(this.buf) || this.buf.startsWith(MARK)) && this.buf.length < 4_000_000) break; // wait for the rest of the line
        text(this.buf[0]);
        this.buf = this.buf.slice(1);
        continue;
      }
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.startsWith(MARK)) {
        try { out.push({ t: "ev", ev: JSON.parse(line.slice(MARK.length)) }); continue; } catch { /* fall through: show as text */ }
      }
      text(line + "\n");
    }
    return out;
  }
  flush(): StreamItem[] {
    const d = this.buf;
    this.buf = "";
    return d ? [{ t: "text", err: false, d }] : [];
  }
}
