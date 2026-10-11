/** Python language server wiring (no monaco): which basedpyright/pyright to start for the selected interpreter, restarts, install flow. */
import { setLaunchResolver, SERVER_FOR_LANGUAGE, type Launch } from "../../../editor/lsp/servers";
import { setServerStatus, statusStore } from "../../../editor/lsp/state";
import { lsp } from "../../../editor/lsp/api";
import { projectStore } from "../../../lib/project";
import { choiceDialog, confirmDialog, type ChoiceButton } from "../../shell/dialogs";
import { ensurePython, onInterpreterChange, pyStore } from "../interpreter";
import { pyApi, runner } from "../api";
import { installPlan, pythonSettings, shellLine } from "./tools";

const STATUS_ID = SERVER_FOR_LANGUAGE.python; // "basedpyright"
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

/** key of the interpreter + executable the running sessions were launched with */
let launchedKey: string | null = null;
export const lastLaunch: { value: Launch | null } = { value: null };

async function resolve(): Promise<Launch | null> {
  await ensurePython().catch(() => {});
  const st = pyStore.get();
  const based = st.tools["basedpyright-langserver"];
  const bin = based ?? st.tools["pyright-langserver"];
  if (!bin) {
    launchedKey = null;
    const installing = statusStore.get().servers[STATUS_ID]?.state === "waiting";
    if (!installing) {
      setServerStatus(STATUS_ID, {
        state: "unavailable", hint: "Install basedpyright", actionLabel: "Install basedpyright…",
        action: () => { void installBasedpyright(); },
      });
    }
    return null;
  }
  const cur = st.current;
  const pathPrepend = [...new Set([dirOf(bin), ...(cur?.envRoot ? [dirOf(cur.path)] : [])])];
  const input = { pythonPath: cur?.path ?? null };
  launchedKey = `${cur?.path ?? ""}|${bin}`;
  const l: Launch = { serverId: based ? "basedpyright" : "pyright", bin, pathPrepend, settings: (section) => pythonSettings(section, input) };
  lastLaunch.value = l;
  return l;
}

let wired = false;
export function wireServer() {
  if (wired) return;
  wired = true;
  setLaunchResolver("python", resolve);
  // Interpreter switched (or the tools of the new one are known): restart sessions so completion / go-to-definition resolve into its site-packages.
  onInterpreterChange((i) => {
    const st = pyStore.get();
    const bin = st.tools["basedpyright-langserver"] ?? st.tools["pyright-langserver"];
    const key = `${i?.path ?? ""}|${bin ?? ""}`;
    // restart when the interpreter / executable changed, or when a server became available where there was none (hint showing)
    if (key !== launchedKey && (launchedKey !== null || bin)) void lsp.restartLanguage("python");
  });
}

// ---------------------------------------------------------------------------------------------------- install (never automatic)
export interface InstallChoice { primary: string[] | null; alt: string[] | null; text: string }
export function installChoice(): InstallChoice {
  const st = pyStore.get();
  const { primary, alt } = installPlan(st.tools, st.current?.path ?? null);
  const lines = [
    "Ace uses basedpyright for Python code insight (completion, navigation, rename, diagnostics). It was not found.",
    "",
    primary ? `Install it as a tool:\n    ${shellLine(primary)}` : "Neither uv nor pipx was found for a tool install.",
    alt ? `\nOr install it into the project interpreter:\n    ${shellLine(alt)}` : "",
    "\nNothing is installed unless you click one of the install buttons.",
  ];
  return { primary, alt, text: lines.join("\n") };
}

let installing = false;
export async function installBasedpyright(): Promise<boolean> {
  if (installing) return false;
  const c = installChoice();
  const buttons: ChoiceButton[] = [{ label: "Cancel", value: null }];
  if (c.alt) buttons.push({ label: "Install into Project Interpreter", value: "alt" });
  if (c.primary) buttons.push({ label: "Install", value: "primary", primary: true });
  const r = await choiceDialog({ title: "Install basedpyright", message: c.text, buttons });
  const argv = r.value === "primary" ? c.primary : r.value === "alt" ? c.alt : null;
  if (!argv) return false;
  return runInstall(argv);
}

/** Runs the confirmed command (progress in the status bar), then re-detects tools and restarts the server. */
export async function runInstall(argv: string[]): Promise<boolean> {
  const root = projectStore.get().root;
  const st = pyStore.get();
  if (!root || installing) return false;
  installing = true;
  setServerStatus(STATUS_ID, { state: "waiting", hint: "Installing basedpyright…" });
  try {
    const out = await runner.exec({ host: root.host, cwd: root.path, argv }, undefined, 10 * 60 * 1000);
    if (out.code !== 0) throw new Error((out.stderr || out.stdout || `exit code ${out.code}`).trim().split("\n").slice(-8).join("\n"));
    const tools = await pyApi.tools(root.host, st.current?.path);
    pyStore.set({ tools, rev: pyStore.get().rev + 1 });
    setServerStatus(STATUS_ID, { state: "idle" });
    void lsp.restartLanguage("python");
    return true;
  } catch (e) {
    setServerStatus(STATUS_ID, { state: "idle" });
    void lsp.restartLanguage("python"); // republishes the install hint
    void confirmDialog({ title: "Installing basedpyright failed", message: `${shellLine(argv)}\n\n${String((e as Error).message ?? e)}`, okLabel: "OK" });
    return false;
  } finally {
    installing = false;
  }
}
