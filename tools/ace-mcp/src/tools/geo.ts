import { z } from "zod";
import { commit, openDoc } from "../files";
import { addBone, addCube, deleteBone, deleteCube, renameBone, reparentBone, setBone, setCube, type Doc, type NumVec3 } from "../core";
import { UserError, type ToolDef } from "../types";

const v3 = z.array(z.number()).length(3);
const dry = z.boolean().optional().describe("true = show the diff, write nothing");
const geoIndex = z.number().int().min(0).optional().describe("index in minecraft:geometry (default 0)");

function geoTool(name: string, description: string, shape: z.ZodRawShape, run: (doc: Doc, a: any) => { doc: Doc; label: string }): ToolDef {
  return {
    name, description, shape: { file: z.string(), ...shape, geometry: geoIndex, dry_run: dry },
    async handler(a, ctx) {
      const o = await openDoc(ctx, a.file, ["geo"]);
      try {
        const r = run(o.doc, a);
        return await commit(ctx, o, r.doc, { label: r.label, dry_run: a.dry_run });
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UserError(`${name} failed: ${(e as Error).message}`);
      }
    },
  };
}

export const geoTools: ToolDef[] = [
  geoTool("add_bone", "Add a bone (Bedrock coords: Y up, 1/16 block units, absolute pivots).", { name: z.string(), parent: z.string().optional(), pivot: v3.optional(), rotation: v3.optional() },
    (d, a) => ({ doc: addBone(d, { name: a.name, parent: a.parent, pivot: a.pivot as NumVec3 | undefined, rotation: a.rotation as NumVec3 | undefined, geometry: a.geometry }), label: `add bone ${a.name}` })),
  geoTool("set_bone", "Change a bone's pivot / rotation (null removes) / inflate (null removes) / mirror (null removes).", { bone: z.string(), pivot: v3.optional(), rotation: v3.nullable().optional(), inflate: z.number().nullable().optional(), mirror: z.boolean().nullable().optional() },
    (d, a) => {
      const patch: Record<string, unknown> = {};
      for (const k of ["pivot", "rotation", "inflate", "mirror"]) if (a[k] !== undefined) patch[k] = a[k];
      return { doc: setBone(d, { bone: a.bone, patch, geometry: a.geometry }), label: `set bone ${a.bone}` };
    }),
  geoTool("rename_bone", "Rename a bone (children's parent references follow; animations that key the old name are NOT renamed).", { from: z.string(), to: z.string() },
    (d, a) => ({ doc: renameBone(d, { from: a.from, to: a.to, geometry: a.geometry }), label: `rename bone ${a.from} → ${a.to}` })),
  geoTool("reparent_bone", "Move a bone under another parent (parent null = root). Cycles are rejected.", { name: z.string(), parent: z.string().nullable() },
    (d, a) => ({ doc: reparentBone(d, { name: a.name, parent: a.parent, geometry: a.geometry }), label: `reparent ${a.name} → ${a.parent ?? "root"}` })),
  geoTool("delete_bone", "Delete a bone. cascade=true also deletes its descendants; otherwise children are re-parented to the deleted bone's parent.", { name: z.string(), cascade: z.boolean().optional() },
    (d, a) => ({ doc: deleteBone(d, { name: a.name, cascade: a.cascade, geometry: a.geometry }), label: `delete bone ${a.name}` })),
  geoTool("add_cube", "Add a cube to a bone. origin = min corner, size, optional pivot/rotation/inflate/mirror and box uv [u, v].", {
    bone: z.string(), origin: v3, size: v3, pivot: v3.optional(), rotation: v3.optional(), inflate: z.number().optional(), mirror: z.boolean().optional(), uv: z.array(z.number()).length(2).optional(),
  }, (d, a) => ({
    doc: addCube(d, { bone: a.bone, cube: { origin: a.origin, size: a.size, pivot: a.pivot, rotation: a.rotation, inflate: a.inflate, mirror: a.mirror, uv: a.uv ? { kind: "box", uv: a.uv } : undefined } as never, geometry: a.geometry }),
    label: `add cube to ${a.bone}`,
  })),
  geoTool("set_cube", "Patch a cube (index from describe_model bone=…): origin, size, pivot/rotation (null removes), inflate (null removes), mirror, box uv [u,v].", {
    bone: z.string(), index: z.number().int().min(0), origin: v3.optional(), size: v3.optional(), pivot: v3.nullable().optional(), rotation: v3.nullable().optional(), inflate: z.number().nullable().optional(), mirror: z.boolean().nullable().optional(), uv: z.array(z.number()).length(2).nullable().optional(),
  }, (d, a) => {
    const patch: Record<string, unknown> = {};
    for (const k of ["origin", "size", "pivot", "rotation", "inflate", "mirror"]) if (a[k] !== undefined) patch[k] = a[k];
    if (a.uv !== undefined) patch.uv = a.uv === null ? null : { kind: "box", uv: a.uv };
    return { doc: setCube(d, { bone: a.bone, index: a.index, patch, geometry: a.geometry }), label: `set cube ${a.bone}[${a.index}]` };
  }),
  geoTool("delete_cube", "Delete one cube of a bone by index.", { bone: z.string(), index: z.number().int().min(0) },
    (d, a) => ({ doc: deleteCube(d, { bone: a.bone, index: a.index, geometry: a.geometry }), label: `delete cube ${a.bone}[${a.index}]` })),
];
