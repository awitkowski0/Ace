import { useEffect, useMemo, useState } from "react";
import { fs } from "../../lib/ipc";
import type { Doc } from "../store";
import { ImageView, type ViewerProps } from "./ImageViewer";
import { siblingOf } from "./io";
import { Message } from "./Placeholders";

/** `foo.png.mcmeta` preview: the sibling png animated by the (live) mcmeta text. */
export default function McmetaPreview({ doc, groupId }: ViewerProps & { text: string }) {
  const pngName = doc.name.replace(/\.mcmeta$/i, "");
  const [data, setData] = useState<ArrayBuffer>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    fs.readBytes(siblingOf(doc.loc, pngName)).then(setData, (e) => setErr(String(e)));
  }, [doc.key, pngName]); // eslint-disable-line react-hooks/exhaustive-deps
  const png = useMemo<Doc>(() => ({ ...doc, key: doc.key + "#png", name: pngName, loc: siblingOf(doc.loc, pngName), viewer: "image", dual: undefined }), [doc, pngName]);
  if (err) return <Message title={`Cannot load ${pngName}`} detail={err} />;
  if (!data) return <div className="vw-empty">Loading…</div>;
  return <ImageView doc={png} groupId={groupId} data={data} />;
}
