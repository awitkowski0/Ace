import { createStore } from "../../lib/store";
import type { Location } from "../../lib/ipc";
import type { TextMatch, TextOpts } from "./api";

export interface FindSession {
  root: Location | null;
  opts: TextOpts | null;
  matches: TextMatch[];
  done: boolean;
  truncated: boolean;
  elapsedMs: number;
  title: string;
}
export const findStore = createStore<FindSession>({ root: null, opts: null, matches: [], done: true, truncated: false, elapsedMs: 0, title: "" });
