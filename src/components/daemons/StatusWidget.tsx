import { useEffect, useState } from "react";
import { CpuIcon } from "../shell/icons";
import { toggleToolWindow } from "../../lib/layout";
import { daemonsApi, fmtBytes } from "./api";

/** "Gradle: N · 1.2 GB" (all gradle + kotlin JVM daemons, local). Refreshes every 30s, only while the window is visible. */
export function DaemonsStatusWidget() {
  const [s, setS] = useState<{ gradleCount: number; rss: number } | null>(null);
  useEffect(() => {
    let dead = false;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      daemonsApi.summary().then((r) => !dead && setS(r)).catch(() => {});
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return (
    <span className="sb-item" title="Processes & Daemons (⌘⇧D)" onClick={() => toggleToolWindow("processes")}>
      <CpuIcon />
      <span>{s ? `Gradle: ${s.gradleCount} · ${fmtBytes(s.rss)}` : "Gradle: —"}</span>
    </span>
  );
}
