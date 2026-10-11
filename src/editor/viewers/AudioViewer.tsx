import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/ipc";
import { registerController } from "./controllers";
import { useBytes } from "./io";
import { extOf, formatSize } from "./registry";
import { Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

interface Info { sampleRate: number; channels: number; frames?: number; bits?: number }
interface Decoded { buf: AudioBuffer; decoder: "webkit" | "rust (symphonia)"; info: Info | null }

/** Native decode first (WebKit); on failure, transcode to PCM WAV in Rust. The real sample rate comes from the container header
 * (decodeAudioData resamples to the context rate, so the buffer alone can't tell). */
async function decode(data: ArrayBuffer, doc: ViewerProps["doc"]): Promise<Decoded> {
  const ext = extOf(doc.name);
  const info = await invoke<Info>("audio_info", new Uint8Array(data), { headers: { ext } }).catch(() => null);
  const rate = Math.min(96000, Math.max(8000, info?.sampleRate ?? 44100));
  try {
    if ((window as unknown as { __aceAudioForceRust?: boolean }).__aceAudioForceRust) throw new Error("forced"); // QA: exercise the Rust path
    const ctx = new OfflineAudioContext(1, 1, rate);
    return { buf: await ctx.decodeAudioData(data.slice(0)), decoder: "webkit", info };
  } catch {
    const wav = await invoke<ArrayBuffer>("audio_decode_wav", new Uint8Array(data), { headers: { ext } });
    return { buf: await new OfflineAudioContext(1, 1, rate).decodeAudioData(wav), decoder: "rust (symphonia)", info };
  }
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

export default function AudioViewer({ doc, groupId }: ViewerProps) {
  const { data, error } = useBytes(doc);
  const [dec, setDec] = useState<Decoded>();
  const [err, setErr] = useState<string>();
  const ctxRef = useRef<AudioContext>();
  const ctx = () => (ctxRef.current ??= new AudioContext(dec ? { sampleRate: dec.buf.sampleRate } : undefined));

  useEffect(() => {
    if (!data) return;
    let dead = false;
    setDec(undefined); setErr(undefined);
    decode(data, doc).then((d) => !dead && setDec(d), (e) => !dead && setErr(String(e)));
    return () => { dead = true; };
  }, [data, doc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { ctxRef.current?.close().catch(() => {}); }, []);

  if (error || err) return <Message title="Cannot play audio" detail={error ?? err} />;
  if (!dec) return <div className="vw-empty">Decoding…</div>;
  return <Player doc={doc} groupId={groupId} dec={dec} size={data!.byteLength} getCtx={ctx} />;
}

function Player({ doc, groupId, dec, size, getCtx }: { doc: ViewerProps["doc"]; groupId: string; dec: Decoded; size: number; getCtx: () => AudioContext }) {
  const { buf } = dec;
  const cv = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [pos, setPos] = useState(0);
  const [drawn, setDrawn] = useState(0);
  const st = useRef({ src: null as AudioBufferSourceNode | null, startedAt: 0, offset: 0, playing: false, loop: false });
  st.current.loop = loop;

  const position = () => {
    const s = st.current;
    if (!s.playing) return s.offset;
    const t = getCtx().currentTime - s.startedAt;
    return s.loop ? t % buf.duration : Math.min(t, buf.duration);
  };
  const stopSrc = () => {
    const s = st.current;
    if (s.src) { s.src.onended = null; try { s.src.stop(); } catch { /* not started */ } s.src.disconnect(); s.src = null; }
  };
  const play = useCallback(async (from?: number) => {
    const c = getCtx();
    await c.resume();
    const s = st.current;
    stopSrc();
    let off = from ?? s.offset;
    if (off >= buf.duration - 0.01) off = 0;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = s.loop;
    src.connect(c.destination);
    src.onended = () => { if (st.current.src === src && !st.current.loop) { st.current.playing = false; st.current.offset = 0; st.current.src = null; setPlaying(false); setPos(0); } };
    src.start(0, off);
    s.src = src; s.startedAt = c.currentTime - off; s.offset = off; s.playing = true;
    setPlaying(true);
  }, [buf]); // eslint-disable-line react-hooks/exhaustive-deps
  const pause = useCallback(() => {
    const s = st.current;
    s.offset = position();
    s.playing = false;
    stopSrc();
    setPlaying(false);
    setPos(s.offset);
  }, [buf]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = useCallback(() => (st.current.playing ? pause() : void play()), [play, pause]);
  const seek = useCallback((t: number) => {
    t = Math.max(0, Math.min(buf.duration, t));
    if (st.current.playing) void play(t);
    else { st.current.offset = t; setPos(t); }
  }, [play, buf]);
  useEffect(() => { if (st.current.src) st.current.src.loop = loop; }, [loop]);
  useEffect(() => () => { stopSrc(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // playhead animation only while playing
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { setPos(position()); raf = requestAnimationFrame(tick); };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // waveform: min/max peaks per pixel column, one lane per channel (max 2 shown)
  const draw = useCallback(() => {
    const c = cv.current, w = wrap.current;
    if (!c || !w) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(50, w.clientWidth), H = 180;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue("--bg-input").trim() || "#2b303b";
    g.fillRect(0, 0, W, H);
    const lanes = Math.min(2, buf.numberOfChannels);
    const laneH = H / lanes;
    g.fillStyle = css.getPropertyValue("--accent").trim() || "#88c0d0";
    for (let ch = 0; ch < lanes; ch++) {
      const d = buf.getChannelData(ch);
      const per = d.length / W;
      const mid = laneH * ch + laneH / 2;
      for (let x = 0; x < W; x++) {
        let mn = 0, mx = 0;
        const a = Math.floor(x * per), b = Math.min(d.length, Math.max(a + 1, Math.floor((x + 1) * per)));
        const step = Math.max(1, Math.floor((b - a) / 256));
        for (let i = a; i < b; i += step) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const y1 = mid - mx * (laneH / 2 - 2), y2 = mid - mn * (laneH / 2 - 2);
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
      g.fillStyle = "rgba(255,255,255,.08)";
      g.fillRect(0, mid, W, 1);
      g.fillStyle = css.getPropertyValue("--accent").trim() || "#88c0d0";
    }
    // count painted columns (QA)
    const img = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    const bg = [img[0], img[1], img[2]];
    for (let i = 0; i < img.length; i += 4 * 7) if (img[i] !== bg[0] || img[i + 1] !== bg[1] || img[i + 2] !== bg[2]) n++;
    setDrawn(n);
  }, [buf]);
  useEffect(() => {
    draw();
    const w = wrap.current;
    if (!w) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = window.setTimeout(draw, 80); });
    ro.observe(w);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [draw]);

  const scrub = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * buf.duration);
  };

  useEffect(() => registerController(groupId, {
    playPause: toggle,
    snapshot: () => ({
      kind: "audio", duration: buf.duration, sampleRate: dec.info?.sampleRate ?? buf.sampleRate, bits: dec.info?.bits ?? null, bufferRate: buf.sampleRate, channels: dec.info?.channels || buf.numberOfChannels, length: buf.length, decoder: dec.decoder,
      playing: st.current.playing, position: position(), loop: st.current.loop, waveformPixels: drawn,
    }),
    ...( { seek, setLoop } as object),
  }), [groupId, toggle, buf, dec, drawn, seek]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="av" tabIndex={0} data-viewer="audio" onKeyDown={(e) => { if (e.key === " ") { e.preventDefault(); toggle(); } }}>
      <div className="av-bar">
        <button className="av-play" title="Play / Pause (Space)" onClick={toggle}>{playing ? "Pause" : "Play"}</button>
        <button className={loop ? "on" : ""} title="Loop" onClick={() => setLoop(!loop)}>Loop</button>
        <span className="av-time" data-testid="time">{fmt(pos)} / {fmt(buf.duration)}</span>
      </div>
      <div className="av-wave" ref={wrap} onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); scrub(e); }} onPointerMove={(e) => e.buttons === 1 && scrub(e)}>
        <canvas ref={cv} />
        <div className="av-head" style={{ left: `${(pos / buf.duration) * 100}%` }} />
      </div>
      <div className="av-info">
        <span>{extOf(doc.name).toUpperCase()}</span>
        <span>{dec.info?.sampleRate ?? buf.sampleRate} Hz</span>{dec.info?.bits ? <span>{dec.info.bits}-bit</span> : null}
        <span>{buf.numberOfChannels === 1 ? "mono" : buf.numberOfChannels === 2 ? "stereo" : `${buf.numberOfChannels} channels`}</span>
        <span>{fmt(buf.duration)} ({buf.length.toLocaleString()} frames)</span>
        <span>{formatSize(size)}</span>
        <span className="iv-dim">decoded by {dec.decoder}</span>
      </div>
    </div>
  );
}
