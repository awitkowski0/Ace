/** Which interpreter runs `python -m debugpy.adapter`, and the explicit "Install debugpy" flow. */
import { pyApi, runner, type Interp, type ProbeInfo } from "../api";
import { pyStore } from "../interpreter";
import { confirmDialog } from "../../shell/dialogs";
import { showBalloon } from "./notify";

const probes = new Map<string, Promise<ProbeInfo | null>>();
const key = (host: string, py: string) => `${host}\u0000${py}`;

/** Probe (cached) an interpreter; the selected one is answered from pyStore without spawning anything. */
export function probeOf(host: string, python: string): Promise<ProbeInfo | null> {
  const st = pyStore.get();
  if (st.current?.path === python && st.current.host === host && st.probe) return Promise.resolve(st.probe);
  const k = key(host, python);
  let p = probes.get(k);
  if (!p) probes.set(k, (p = pyApi.probe(host, python).catch(() => null)));
  return p;
}
export const forgetProbe = (host: string, python: string) => { probes.delete(key(host, python)); };

export interface AdapterChoice {
  /** interpreter that runs the adapter */
  python: string;
  interp: Interp | null;
  /** the debuggee's own interpreter has debugpy */
  own: boolean;
}

/** Prefer the debuggee interpreter's own debugpy; else the first discovered interpreter on the same host that has it. */
export async function chooseAdapter(host: string, debuggee: string): Promise<AdapterChoice | null> {
  const own = await probeOf(host, debuggee);
  const all = pyStore.get().interpreters;
  if (own?.modules.debugpy) return { python: debuggee, interp: all.find((i) => i.path === debuggee) ?? null, own: true };
  const cands = all.filter((i) => i.host === host && i.path !== debuggee);
  // project envs first, then the rest in discovery order
  cands.sort((a, b) => Number(b.project) - Number(a.project));
  for (const c of cands.slice(0, 8)) {
    const p = await probeOf(host, c.path);
    if (p?.modules.debugpy) return { python: c.path, interp: c, own: false };
  }
  return null;
}

const envName = (host: string, py: string) => {
  const i = pyStore.get().interpreters.find((x) => x.path === py && x.host === host);
  return i?.name ?? py;
};

/** IntelliJ-style notification with an explicit install button. Never installs without the click + the confirm dialog. */
export function offerInstallDebugpy(host: string, python: string, retry: () => void) {
  const name = envName(host, python);
  showBalloon({
    kind: "warn",
    title: "Debugger: debugpy is not installed",
    text: `The Python debugger package 'debugpy' was not found in ${name} or in any other interpreter on ${host === "local" ? "this machine" : host}.`,
    actions: [{ label: `Install debugpy into ${name}`, run: () => void installDebugpy(host, python, retry) }],
  });
}

async function installDebugpy(host: string, python: string, retry: () => void) {
  const name = envName(host, python);
  const uv = pyStore.get().tools.uv;
  const argv = uv ? [uv, "pip", "install", "--python", python, "debugpy"] : [python, "-m", "pip", "install", "debugpy"];
  const ok = await confirmDialog({ title: "Install debugpy", message: `Install the 'debugpy' package into ${name}?\n\n${argv.join(" ")}`, okLabel: "Install" });
  if (!ok) return;
  showBalloon({ kind: "info", title: "Installing debugpy…", text: name });
  const r = await runner.exec({ host, cwd: "~", argv }, undefined, 240000).catch((e) => ({ code: -1, stdout: "", stderr: String(e), timedOut: false }));
  if (r.code === 0) {
    forgetProbe(host, python);
    const st = pyStore.get();
    if (st.current?.path === python && st.probe) pyStore.set({ probe: { ...st.probe, modules: { ...st.probe.modules, debugpy: true } } });
    showBalloon({ kind: "info", title: "debugpy installed", text: name });
    retry();
  } else {
    showBalloon({ kind: "error", title: "Could not install debugpy", text: (r.stderr || r.stdout || "unknown error").trim().split("\n").slice(-6).join("\n") });
  }
}
