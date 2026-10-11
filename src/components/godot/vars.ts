/** Formatting of decoded Godot Variants (see src-tauri/src/godot/variant.rs for the JSON shape) for the Debug window. Pure. */
export const TYPE_NAMES = [
  "Nil", "bool", "int", "float", "String", "Vector2", "Vector2i", "Rect2", "Rect2i", "Vector3", "Vector3i", "Transform2D", "Vector4", "Vector4i",
  "Plane", "Quaternion", "AABB", "Basis", "Transform3D", "Projection", "Color", "StringName", "NodePath", "RID", "Object", "Callable", "Signal",
  "Dictionary", "Array", "PackedByteArray", "PackedInt32Array", "PackedInt64Array", "PackedFloat32Array", "PackedFloat64Array",
  "PackedStringArray", "PackedVector2Array", "PackedVector3Array", "PackedColorArray", "PackedVector4Array",
];

type J = unknown;
const isTag = (v: J): v is { $: string; v?: J; n?: number; id?: string; class?: string; props?: [string, J][] } => !!v && typeof v === "object" && !Array.isArray(v) && "$" in (v as object);

export interface Described {
  value: string;
  type: string;
  /** child entries (name + raw value) for arrays, dictionaries, vectors, packed arrays */
  kids?: { name: string; v: J }[];
  /** objects: the instance id to inspect lazily */
  objId?: string;
}

const fmtNum = (n: number, float: boolean) => {
  if (!float) return String(n);
  if (Number.isInteger(n)) return n.toFixed(1);
  return String(Math.round(n * 1e6) / 1e6);
};
const short = (s: string, max = 120) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const quote = (s: string) => JSON.stringify(s);

/** One-line text of a value (nested containers abbreviated). */
export function text(v: J, float = false): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return fmtNum(v, float);
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) return short(`[${v.map((x) => text(x)).join(", ")}]`);
  if (isTag(v)) {
    switch (v.$) {
      case "Dictionary": return short(`{ ${((v.v as [J, J][]) ?? []).map(([k, x]) => `${text(k)}: ${text(x)}`).join(", ")} }`);
      case "Object": return v.id ? `<Object#${v.id}>` : `<${v.class}>`;
      case "NodePath": return `^"${v.v}"`;
      case "StringName": return `&"${v.v}"`;
      case "RID": return `RID(${v.v})`;
      case "int": return String(v.v);
      case "float": return String(v.v);
      case "Error": return `<${v.v}>`;
      case "Callable": case "Signal": return `<${v.$}>`;
      case "PackedByteArray": return `PackedByteArray (${v.n})`;
      default:
        if (v.$.startsWith("Packed")) return short(`${v.$} (${v.n}) [${((v.v as J[]) ?? []).slice(0, 12).map((x) => text(x, true)).join(", ")}${(v.n ?? 0) > 12 ? ", …" : ""}]`);
        if (Array.isArray(v.v)) return `${v.$ === "Vector2" || v.$ === "Vector3" || v.$ === "Vector4" || v.$ === "Vector2i" || v.$ === "Vector3i" || v.$ === "Vector4i" ? "" : v.$}(${(v.v as J[]).map((x) => text(x, !v.$.endsWith("i"))).join(", ")})`.replace(/^\(/, "(");
        return `${v.$}`;
    }
  }
  return String(v);
}

const COMPONENTS: Record<string, string[]> = {
  Vector2: ["x", "y"], Vector2i: ["x", "y"], Vector3: ["x", "y", "z"], Vector3i: ["x", "y", "z"], Vector4: ["x", "y", "z", "w"], Vector4i: ["x", "y", "z", "w"],
  Color: ["r", "g", "b", "a"], Quaternion: ["x", "y", "z", "w"], Rect2: ["position.x", "position.y", "size.x", "size.y"], Plane: ["x", "y", "z", "d"],
};

export function describe(v: J, typeId?: number): Described {
  const float = typeId === 3;
  let type = typeId != null && TYPE_NAMES[typeId] ? TYPE_NAMES[typeId] : "";
  if (v === null || v === undefined) return { value: "null", type: type || "Nil" };
  if (typeof v === "boolean") return { value: String(v), type: type || "bool" };
  if (typeof v === "number") return { value: fmtNum(v, float), type: type || (Number.isInteger(v) ? "int" : "float") };
  if (typeof v === "string") return { value: quote(v), type: type || "String" };
  if (Array.isArray(v)) return { value: text(v), type: "Array", kids: v.map((x, i) => ({ name: `[${i}]`, v: x })) };
  if (isTag(v)) {
    type = v.$ === "Object" ? (type && type !== "Object" ? type : "Object") : v.$;
    if (v.$ === "Dictionary") {
      const pairs = (v.v as [J, J][]) ?? [];
      return { value: text(v), type: `Dictionary (${pairs.length})`, kids: pairs.map(([k, x]) => ({ name: typeof k === "string" ? quote(k) : text(k), v: x })) };
    }
    if (v.$ === "Object") return { value: v.id ? `<Object#${v.id}>` : `<${v.class}>`, type, objId: v.id };
    if (v.$.startsWith("Packed") && Array.isArray(v.v)) return { value: text(v), type: `${v.$} (${v.n})`, kids: (v.v as J[]).map((x, i) => ({ name: `[${i}]`, v: x })) };
    const comps = COMPONENTS[v.$];
    if (comps && Array.isArray(v.v)) return { value: text(v), type: v.$, kids: comps.map((c, i) => ({ name: c, v: (v.v as J[])[i] })) };
    return { value: text(v), type: v.$ };
  }
  return { value: String(v), type };
}

/** Engine-provided properties from `scene:inspect_objects` -> [name, value]. Member variables of the script come first. */
export function inspectProps(entry: unknown): { name: string; v: J; type: number }[] {
  const props = Array.isArray(entry) ? entry[2] : null;
  if (!Array.isArray(props)) return [];
  const out: { name: string; v: J; type: number; member: boolean }[] = [];
  for (const p of props as J[][]) {
    const [name, type, , , usage, value] = p as [string, number, number, string, number, J];
    if (typeof name !== "string" || (usage & 4096) === 0 && (usage & 6) === 0) continue; // categories / groups carry no value
    if (type === 0) continue;
    const member = name.startsWith("Members/");
    out.push({ name: member ? name.slice(8) : name, v: value, type, member });
  }
  return out.sort((a, b) => Number(b.member) - Number(a.member)).map(({ member: _m, ...r }) => r);
}
