import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { UserError } from "./types";

/** Resolve symlinks of the longest existing prefix (the file itself may not exist yet). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(cur.slice(up.length + 1));
    cur = up;
  }
  const real = existsSync(cur) ? realpathSync(cur) : cur;
  return rest.length ? join(real, ...rest) : real;
}

export function parseRoots(argv: string[], env: NodeJS.ProcessEnv, cwd: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) out.push(argv[++i]);
    else if (argv[i].startsWith("--root=")) out.push(argv[i].slice(7));
  }
  if (env.ACE_MCP_ROOTS) out.push(...env.ACE_MCP_ROOTS.split(":").filter(Boolean));
  if (!out.length) out.push(cwd);
  return [...new Set(out.map((r) => realish(resolve(cwd, r))))];
}

export const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Absolute real path of `file`, or throws if it lies outside every allowed root. Relative paths resolve against the first root. */
export function allow(roots: string[], file: string): string {
  if (typeof file !== "string" || !file) throw new UserError("file is required");
  const abs = realish(isAbsolute(file) ? resolve(file) : resolve(roots[0], file));
  if (!roots.some((r) => inside(abs, r))) throw new UserError(`Refusing ${file}: outside the allowed roots (${roots.join(", ")}). Start the server with --root <dir> or ACE_MCP_ROOTS.`);
  return abs;
}
