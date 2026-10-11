import { invoke, type Location } from "../../lib/ipc";

export interface GradleDiscovery { json: string; elapsedMs: number; offline: boolean }
export const gradleApi = {
  fingerprint: (root: Location, dirs: string[]) => invoke<string>("gradle_fingerprint", { root, dirs }),
  discover: (root: Location) => invoke<GradleDiscovery>("gradle_discover", { root }),
  cancel: (root: Location) => invoke<void>("gradle_cancel", { root }),
  softStop: (id: string) => invoke<void>("gradle_soft_stop", { id }),
};
