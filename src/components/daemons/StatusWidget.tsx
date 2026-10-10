import { useEffect, useState } from "react";
import { onWindowActive, windowActive } from "../../lib/activity";
import { CpuIcon } from "../shell/icons";
import { toggleToolWindow } from "../../lib/layout";
import { projectStore } from "../../lib/project";
import { useStore } from "../../lib/store";
import { getSession, termStore } from "../terminal/sessions";
import { daemonsApi, fmtBytes } from "./api";

type Sum = { gradleCount: number; rss: number };

/** Remote hosts with an active project or terminal session. */
function useRemoteHosts(): string[] {
  const { root } = useStore(projectStore);
  const { tabs } = useStore(termStore);
  const hosts = new Set<string>();
  if (root && root.host !== "local") hosts.add(root.host);
  for (const id of tabs) {
    const h = getSession(id)?.host;
    if (h && h !== "local") hosts.add(h);
  }
  return [...hosts].sort();
}

/** "Gradle: N · 1.2 GB" (local) plus "mc: N · 2 GB" for each remote host with an active project/session.
 *  Refreshes every 30s, only while the window is visible. */
export function DaemonsStatusWidget() {
  const remote = useRemoteHosts();
  const key = remote.join(",");
  const [local, setLocal] = useState<Sum | null>(null);
  const [rem, setRem] = useState<Record<string, Sum>>({});
  useEffect(() => {
    let dead = false;
    const tick = () => {
      if (!windowActive()) return;
      daemonsApi.summary().then((r) => !dead && setLocal(r)).catch(() => {});
      for (const h of remote) daemonsApi.summary(h).then((r) => !dead && setRem((m) => ({ ...m, [h]: r }))).catch(() => {});
    };
    tick();
    const t = setInterval(tick, 30000);
    const off = onWindowActive(tick);
    return () => { dead = true; clearInterval(t); off(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const part = (label: string, s: Sum | null | undefined) => `${label}: ${s ? `${s.gradleCount} · ${fmtBytes(s.rss)}` : "—"}`;
  const text = [part("Gradle", local), ...remote.map((h) => part(h, rem[h]))].join("  ");
  return (
    <span className="sb-item" title="Processes & Daemons (⌘⇧D)" onClick={() => toggleToolWindow("processes")}>
      <CpuIcon />
      <span>{text}</span>
    </span>
  );
}
