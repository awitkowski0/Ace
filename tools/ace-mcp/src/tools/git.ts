// Asset-dev git flows, a port of the pure parts of src/components/profiles/gitops.ts onto the git CLI.
// Rules: never a bare `git stash` / `git stash pop` — local changes go into a TAGGED stash that is re-applied and dropped BY COMMIT ID.
import { execFile } from "node:child_process";
import { relative } from "node:path";
import { z } from "zod";
import { allow } from "../paths";
import { classifyAsset, suggestMessage } from "../core";
import { UserError, text, type Ctx, type ToolDef } from "../types";

export interface GitRes { code: number; out: string; err: string }

export function git(root: string, args: string[], opts: { timeout?: number } = {}): Promise<GitRes> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: opts.timeout ?? 60_000, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" } }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : 1) : 0;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
}
const must = async (root: string, args: string[], timeout?: number) => {
  const r = await git(root, args, { timeout });
  if (r.code !== 0) throw new UserError(`git ${args[0]} failed: ${friendly(r.err || r.out)}`);
  return r.out;
};

export const friendly = (t: string): string => {
  if (/Could not resolve host|unable to access|Connection (refused|timed out)|Network is unreachable|Could not read from remote|Permission denied|Authentication failed/i.test(t))
    return "Couldn't reach the server. Check the internet connection and that git/GitHub sign-in works, then try again.";
  return t.trim().split("\n").slice(-3).join(" ").slice(0, 300) || "Something went wrong.";
};

const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);
export const stashTag = () => `ace-autostash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function stashPush(root: string, message: string): Promise<string | null> {
  await must(root, ["stash", "push", "--include-untracked", "-m", message]);
  const sha = (await git(root, ["rev-parse", "-q", "--verify", "refs/stash"])).out.trim();
  if (!isSha(sha)) return null;
  const subject = (await git(root, ["log", "-1", "--format=%s", sha])).out.trimEnd();
  return subject.endsWith(message) ? sha : null;
}
export async function stashApply(root: string, sha: string): Promise<boolean> {
  if (!isSha(sha)) throw new UserError("not a commit id");
  let r = await git(root, ["stash", "apply", "--index", sha]);
  if (r.code !== 0) r = await git(root, ["stash", "apply", sha]);
  return r.code === 0;
}
export async function stashDrop(root: string, sha: string): Promise<boolean> {
  if (!isSha(sha)) throw new UserError("not a commit id");
  const list = (await git(root, ["stash", "list", "--format=%H"])).out.split("\n").map((l) => l.trim());
  const i = list.indexOf(sha);
  if (i < 0) return false;
  await must(root, ["stash", "drop", `stash@{${i}}`]);
  return true;
}

export interface RepoStatus {
  top: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  conflicts: string[];
  changes: Array<{ path: string; xy: string; asset: boolean }>;
  rebasing: boolean;
  merging: boolean;
}

async function repoRoot(ctx: Ctx, dir?: string): Promise<string> {
  const d = dir ? allow(ctx.roots, dir) : ctx.roots[0];
  const r = await git(d, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new UserError(`${d} is not inside a git repository`);
  return r.out.trim();
}

export async function status(top: string): Promise<RepoStatus> {
  const s = await must(top, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]);
  const parts = s.split("\0").filter(Boolean);
  const head = parts.shift() ?? "";
  const m = /^## (?:No commits yet on )?([^\s.]+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
  const branch = m && !head.includes("HEAD (no branch)") ? m[1] : null;
  const upstream = m?.[2] ?? null;
  const ab = m?.[3] ?? "";
  const ahead = Number(/ahead (\d+)/.exec(ab)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(ab)?.[1] ?? 0);
  const changes: RepoStatus["changes"] = [];
  const conflicts: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // skip the "from" path
    if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy)) conflicts.push(path);
    changes.push({ path, xy, asset: !!classifyAsset(path) });
  }
  const has = async (r: string) => (await git(top, ["rev-parse", "-q", "--verify", r])).out.trim().length > 0;
  const gd = (await git(top, ["rev-parse", "--git-dir"])).out.trim();
  const { existsSync } = await import("node:fs");
  const gdir = gd.startsWith("/") ? gd : `${top}/${gd}`;
  return { top, branch, upstream, ahead, behind, conflicts, changes, rebasing: existsSync(`${gdir}/rebase-merge`) || existsSync(`${gdir}/rebase-apply`), merging: await has("MERGE_HEAD") };
}

const rootArg = z.string().optional().describe("Directory inside the repository (default: first allowed root)");

export const assetStatus: ToolDef = {
  name: "asset_status",
  readOnly: true,
  description: "Git state for asset work: branch, upstream, ahead/behind, and the changed files split into ASSETS (models, animations, textures, poses, lang, sounds — what Save to Git commits) and CODE/other (never committed by this flow). Does not fetch; run get_latest to check for newer remote work.",
  shape: { root: rootArg },
  async handler(a, ctx) {
    const top = await repoRoot(ctx, a.root);
    const s = await status(top);
    const assets = s.changes.filter((c) => c.asset);
    const other = s.changes.filter((c) => !c.asset);
    const lines = [`repo ${top}`, `branch ${s.branch ?? "(detached)"}${s.upstream ? ` → ${s.upstream} (ahead ${s.ahead}, behind ${s.behind})` : " (no upstream: not shared yet)"}`];
    if (s.rebasing || s.merging) lines.push("WARNING: a rebase/merge is in progress — resolve it in Ace before anything else.");
    if (s.conflicts.length) lines.push(`CONFLICTS: ${s.conflicts.join(", ")}`);
    lines.push(`${assets.length} changed asset file(s)${assets.length ? ":" : ""}`, ...assets.slice(0, 60).map((c) => `  ${c.xy.trim() || "?"} ${c.path}`));
    if (assets.length > 60) lines.push(`  … ${assets.length - 60} more`);
    lines.push(`${other.length} other changed file(s) (not part of Save to Git)${other.length ? ":" : ""}`, ...other.slice(0, 15).map((c) => `  ${c.xy.trim() || "?"} ${c.path}`));
    if (other.length > 15) lines.push(`  … ${other.length - 15} more`);
    if (assets.length) lines.push(`suggested message: ${suggestMessage(assets.map((c) => ({ path: c.path, kind: c.xy.includes("D") ? "deleted" : c.xy.includes("?") || c.xy.includes("A") ? "added" : "modified" })))}`);
    return text(lines.join("\n"));
  },
};

export const getLatest: ToolDef = {
  name: "get_latest",
  description: "Fetch and update the current branch (fast-forward; if you also have unshared commits, rebase them on top). Local changes are set aside in a uniquely tagged stash first and put back afterwards by commit id — never a bare stash/pop. On a conflict nothing is forced: the rebase is aborted, your changes are restored, and you are told to resolve it in Ace. Works the working tree but publishes nothing.",
  shape: { root: rootArg },
  async handler(a, ctx) {
    const top = await repoRoot(ctx, a.root);
    let s = await status(top);
    if (s.rebasing || s.merging || s.conflicts.length) return text("A rebase/merge/conflict is in progress. Resolve it in Ace (Changes) first; nothing was changed.");
    if (!s.branch) return text("Not on a branch (detached HEAD). Switch to a branch first.");
    if (!s.upstream) return text(`Branch ${s.branch} hasn't been shared yet, so there is nothing newer to get.`);
    const f = await git(top, ["fetch", "--prune"], { timeout: 180_000 });
    if (f.code !== 0) return text(friendly(f.err));
    s = await status(top);
    if (s.behind === 0) return text("Already up to date.");
    const behind = s.behind;
    let sha: string | null = null;
    if (s.changes.length) {
      sha = await stashPush(top, stashTag());
      if (!sha) return text("Couldn't set the local changes aside safely, so nothing was changed.");
    }
    const restore = async (): Promise<string> => {
      if (!sha) return "";
      if (!(await stashApply(top, sha))) return ` Local changes are saved but couldn't be re-applied automatically (conflict). Saved copy: stash commit ${sha.slice(0, 8)} — run \`git stash apply ${sha}\` or resolve in Ace.`;
      await stashDrop(top, sha);
      return "";
    };
    let p = await git(top, ["pull", "--ff-only"], { timeout: 180_000 });
    if (p.code !== 0 && s.ahead > 0) {
      p = await git(top, ["pull", "--rebase"], { timeout: 180_000 });
      if (p.code !== 0) await git(top, ["rebase", "--abort"]);
    }
    if (p.code !== 0) return text(`Couldn't get the latest version: ${friendly(p.err || p.out)}${await restore()}`);
    const note = await restore();
    return text(`Updated: got ${behind} commit(s).${note}`);
  },
};

export const switchBranch: ToolDef = {
  name: "switch_branch",
  description: "Switch to another branch (a remote-only branch is checked out as a local tracking branch), or create one with create=true (suggested name: assets/<you>/<topic>). Uncommitted changes are carried along via a tagged stash re-applied by commit id.",
  shape: { root: rootArg, branch: z.string().min(1), create: z.boolean().optional() },
  async handler(a, ctx) {
    const top = await repoRoot(ctx, a.root);
    const s = await status(top);
    if (s.rebasing || s.merging || s.conflicts.length) return text("A rebase/merge/conflict is in progress; resolve it in Ace first.");
    if (!/^[\w][\w./-]*$/.test(a.branch) || a.branch.includes("..")) throw new UserError("Invalid branch name");
    if (a.create) {
      await must(top, ["checkout", "-b", a.branch]);
      return text(`Created and switched to ${a.branch}. Uncommitted changes came along.`);
    }
    let sha: string | null = null;
    if (s.changes.length) {
      sha = await stashPush(top, stashTag());
      if (!sha) return text("Couldn't set the local changes aside safely; nothing was changed.");
    }
    const hasLocal = (await git(top, ["rev-parse", "-q", "--verify", `refs/heads/${a.branch}`])).out.trim() !== "";
    const co = hasLocal ? await git(top, ["checkout", a.branch]) : await git(top, ["checkout", "--track", `origin/${a.branch.replace(/^origin\//, "")}`]);
    if (co.code !== 0) {
      if (sha && (await stashApply(top, sha))) await stashDrop(top, sha);
      return text(`Couldn't switch to ${a.branch}: ${friendly(co.err)}`);
    }
    let note = "";
    if (sha) {
      if (await stashApply(top, sha)) await stashDrop(top, sha);
      else note = ` Local changes couldn't be re-applied cleanly; saved as stash commit ${sha.slice(0, 8)} (git stash apply ${sha}).`;
    }
    return text(`Now on ${a.branch}.${note}`);
  },
};

export const saveAssetsToGit: ToolDef = {
  name: "save_assets_to_git",
  description: "PUBLISHING: commit the given asset files (and optionally push). Only asset files are accepted — code files are refused. Requires confirm=true; set it ONLY after the user has explicitly agreed to this commit message, this file list and (if push) pushing. Without confirm it returns a preview and changes nothing. Commits exactly the listed paths (other staged changes stay untouched).",
  shape: {
    root: rootArg, message: z.string().min(3).describe("Commit message (required)"), files: z.array(z.string()).min(1).describe("Paths of changed asset files (absolute or relative to the repo)"),
    push: z.boolean().optional().describe("also push the branch (sets upstream when missing)"), confirm: z.boolean().optional().describe("must be true to actually commit/push"),
  },
  async handler(a, ctx) {
    const top = await repoRoot(ctx, a.root);
    const s = await status(top);
    if (s.rebasing || s.merging || s.conflicts.length) return text("A rebase/merge/conflict is in progress; resolve it in Ace first. Nothing committed.");
    const rels: string[] = [];
    const refused: string[] = [];
    for (const f of a.files as string[]) {
      const abs = allow(ctx.roots, f.startsWith("/") ? f : `${top}/${f}`);
      const rel = relative(top, abs);
      if (rel.startsWith("..")) throw new UserError(`${f} is outside the repository`);
      if (!classifyAsset(rel)) refused.push(rel);
      else rels.push(rel);
    }
    if (refused.length) return { content: [{ type: "text", text: `Refusing non-asset file(s): ${refused.join(", ")}. This flow only commits models, animations, textures, poses, lang and sounds.` }], isError: true };
    const changed = new Set(s.changes.map((c) => c.path));
    const noChange = rels.filter((r) => !changed.has(r));
    if (noChange.length) return { content: [{ type: "text", text: `No uncommitted change in: ${noChange.join(", ")}` }], isError: true };
    const branch = s.branch;
    if (!branch) return { content: [{ type: "text", text: "Not on a branch (detached HEAD)." }], isError: true };
    const plan = `${rels.length} file(s) on ${branch}${a.push ? ` then push${s.upstream ? ` to ${s.upstream}` : " (-u origin " + branch + ")"}` : ""}:\n${rels.map((r) => "  " + r).join("\n")}\nmessage: ${a.message}`;
    if (s.behind > 0 && a.push) return text(`${plan}\n\nThe branch is ${s.behind} commit(s) behind its remote — run get_latest first, otherwise the push will be rejected. Nothing committed.`);
    if (!a.confirm) return text(`PREVIEW — nothing committed. Ask the user to confirm, then call again with confirm=true.\nWould commit ${plan}`);
    await must(top, ["add", "-A", "--", ...rels]);
    await must(top, ["commit", "-m", a.message, "--only", "--", ...rels]);
    let msg = `Committed ${rels.length} file(s) on ${branch}.`;
    if (a.push) {
      const p = s.upstream ? await git(top, ["push"], { timeout: 180_000 }) : await git(top, ["push", "-u", "origin", branch], { timeout: 180_000 });
      if (p.code === 0) msg += " Pushed.";
      else if (/rejected|non-fast-forward|fetch first|behind/i.test(p.err)) msg += " Saved locally, but someone else pushed first: run get_latest, then push again.";
      else msg += ` Saved locally, but the push failed: ${friendly(p.err)}`;
    }
    return text(msg);
  },
};

export const runGame: ToolDef = {
  name: "run_game",
  live: true,
  description: "Start the project's game run task through Ace's Run Game button (needs Ace running). Returns the run state (building/running/…).",
  shape: {},
  async handler(_a, ctx) {
    if (!(await ctx.bridge.available(true))) return { content: [{ type: "text", text: "Ace isn't running — start the game from Ace's Run Game button." }], isError: true };
    const r = await ctx.bridge.call<{ state: string; task?: string | null }>("run_game", {}, 60_000);
    return text(`Run Game: ${r.state}${r.task ? ` (${r.task})` : ""}`);
  },
};

export const gitTools: ToolDef[] = [assetStatus, getLatest, saveAssetsToGit, switchBranch, runGame];
