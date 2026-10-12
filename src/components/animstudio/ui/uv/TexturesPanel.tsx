/**
 * Textures panel (Blockbench Edit mode, left sidebar bottom): thumbnails, name and size, visibility, the active texture (the one the
 * UV editor shows), add (file picker / drag-drop png), remove. .bbmodel: real `textures[]` + per-face assignment ("Apply to selected
 * faces / all faces"). Geo: preview layers (variants discovered next to the default texture, stackable); the game renders ONE texture.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { showContextMenu } from "../../../shell/contextMenu";
import { promptDialog } from "../../../shell/dialogs";
import { layerName } from "../../core";
import { useStudio, useStudioPick } from "../state";
import { Section, IconBtn } from "../widgets";
import { EyeIcon, ImageI, PlusIcon, TrashIcon } from "../icons";
import { loadImage } from "../resolve";
import { opAddTextureBytes, opAddTexturePath, opApplyTexture, opMoveLayer, opRemoveTexture, opSetActiveTexture, opSetLayerBlend, opSoloTexture, opToggleTextureVisible, textureRows, type TexRow } from "../texops";

function Thumb({ host, row }: { host: string; row: TexRow }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let dead = false;
    setImg(null);
    if (row.src) { const i = new Image(); i.onload = () => { if (!dead) setImg(i); }; i.src = row.src; }
    else if (row.path) void loadImage(host, row.path).then((i) => { if (!dead) setImg(i); });
    return () => { dead = true; };
  }, [host, row.src, row.path]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    c.width = 32; c.height = 32;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 32, 32);
    if (img) {
      const sc = Math.min(32 / img.naturalWidth, 32 / img.naturalHeight);
      const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
      g.drawImage(img, (32 - w) / 2, (32 - h) / 2, w, h);
    }
  }, [img]);
  return <canvas ref={cv} className="as-texthumb" width={32} height={32} />;
}

export const IMAGE_PNG = ["png"];

export function TexturesPanel({ host }: { host: string }) {
  const api = useStudio();
  const s = useStudioPick("doc", "texActive", "geoTex", "path", "uvFaces", "cube", "bones");
  const rows = useMemo(() => textureRows(api), [api, s.doc, s.geoTex]); // eslint-disable-line react-hooks/exhaustive-deps
  const isBb = s.doc?.kind === "bbmodel";
  const isGeo = s.doc?.kind === "geo";
  const root = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const active = Math.min(s.texActive, Math.max(0, rows.length - 1));

  const pick = async () => {
    if (host !== "local") {
      const p = await promptDialog({ title: "Texture file (png path on the host)", initial: s.path.replace(/[^/]*$/, ""), okLabel: "Add" });
      if (p?.trim()) await opAddTexturePath(api, host, p.trim());
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ multiple: true, filters: [{ name: "PNG", extensions: IMAGE_PNG }], defaultPath: s.path.replace(/[^/]*$/, "") });
    for (const p of Array.isArray(r) ? r : r ? [r] : []) await opAddTexturePath(api, host, p);
  };

  // drag-drop of png files: HTML5 (bytes) and Tauri file drops (paths)
  useEffect(() => {
    let un: (() => void) | undefined, dead = false;
    try {
      void getCurrentWebviewWindow().onDragDropEvent((ev) => {
        const p = ev.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        const r = root.current?.getBoundingClientRect();
        if (!r || r.width === 0 || !p.position) return;
        const dpr = window.devicePixelRatio || 1;
        const x = p.position.x / dpr, y = p.position.y / dpr;
        const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        if (p.type === "over") setOver(inside);
        else if (p.type === "drop") { setOver(false); if (inside) for (const path of p.paths ?? []) void opAddTexturePath(api, host, path); }
        else setOver(false);
      }).then((f) => { if (dead) f(); else un = f; }, () => {});
    } catch { /* not inside Tauri */ }
    return () => { dead = true; un?.(); };
  }, [api, host]);
  const onDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.png$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    setOver(false);
    for (const f of files) {
      const withPath = (f as File & { path?: string }).path;
      if (withPath) await opAddTexturePath(api, host, withPath);
      else if (isBb) opAddTextureBytes(api, f.name, new Uint8Array(await f.arrayBuffer()));
    }
  };

  const menu = (e: React.MouseEvent, r: TexRow) => {
    e.preventDefault();
    e.stopPropagation();
    opSetActiveTexture(api, r.index);
    const layer = s.geoTex.layers[r.index];
    showContextMenu(e.clientX, e.clientY, [
      { label: "Apply to Selected Faces", run: () => opApplyTexture(api, r.index, "faces"), disabled: !isBb || (!s.cube && !s.bones.length) },
      { label: "Apply to All Faces of Selection", run: () => opApplyTexture(api, r.index, "all"), disabled: !isBb || (!s.cube && !s.bones.length) },
      { label: "Show Only This Texture", run: () => opSoloTexture(api, r.index), disabled: !isGeo },
      { label: layer?.blend === "add" ? "Blend: Normal" : "Blend: Add (emissive overlay)", run: () => opSetLayerBlend(api, r.index, layer?.blend === "add" ? "normal" : "add"), disabled: !isGeo },
      { label: "Move Up", run: () => opMoveLayer(api, r.index, -1), disabled: !isGeo || r.index === 0 },
      { label: "Move Down", run: () => opMoveLayer(api, r.index, 1), disabled: !isGeo || r.index >= rows.length - 1 },
      { separator: true, label: "" },
      { label: "Remove", run: () => opRemoveTexture(api, r.index) },
    ]);
  };

  return (
    <Section
      title="Textures"
      right={
        <>
          <IconBtn id="tex-add" title={isGeo ? "Add a preview texture (png)" : "Import a texture (png)"} disabled={!s.doc} onClick={() => void pick()}><PlusIcon /></IconBtn>
          <IconBtn id="tex-remove" title="Remove the active texture" disabled={!rows.length} onClick={() => opRemoveTexture(api, active)}><TrashIcon /></IconBtn>
        </>
      }
    >
      <div className={"as-textures" + (over ? " over" : "")} ref={root} data-testid="as-textures" onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        {!rows.length && <div className="as-empty">{s.doc ? "No textures. Drop a png here or use +." : "No model"}</div>}
        {rows.map((r) => (
          <div key={r.index} className={"as-texrow" + (r.index === active ? " sel" : "") + (r.visible ? "" : " off")} data-tex={r.index} onClick={() => opSetActiveTexture(api, r.index)} onContextMenu={(e) => menu(e, r)}
            title={r.path ?? r.name} onDoubleClick={() => isBb && void 0}>
            <Thumb host={host} row={r} />
            <div className="as-texmeta">
              <span className="as-texname">{isGeo ? layerName(s.geoTex.layers[r.index]) : r.name}</span>
              <span className="as-texsub">
                {isGeo ? (r.index === 0 ? "base" : "layer") + (s.geoTex.layers[r.index]?.blend === "add" ? " · add" : "") : r.width ? `${r.width} × ${r.height}` : ""}
              </span>
            </div>
            <span className="as-tog on" data-act="tex-eye" title={r.visible ? "Hide texture" : "Show texture"} onClick={(e) => { e.stopPropagation(); opToggleTextureVisible(api, r.index); }}><EyeIcon off={!r.visible} /></span>
          </div>
        ))}
        {isGeo && <div className="as-note" data-testid="tex-geo-note"><ImageI /> Bedrock geometry renders one texture in game. These textures are preview layers (kept in Ace, not in the file).</div>}
        {isBb && rows.length > 1 && <div className="as-note">Right-click a texture to apply it to the selected faces.</div>}
      </div>
    </Section>
  );
}
