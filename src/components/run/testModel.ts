/** Test results tree built from the `\x1e##ace:{json}` events of ace_pytest.py / ace_unittest.py (docs/PYTHON.md). Pure, unit-tested. */

export type Outcome = "pending" | "running" | "passed" | "failed" | "error" | "skipped" | "xfailed" | "xpassed";
export interface Counts { total: number; pending: number; running: number; passed: number; failed: number; error: number; skipped: number; duration: number }
export interface TestNode {
  key: string; // unique path key
  id: string; // pytest node id (leaves), file/class prefix for containers
  name: string;
  kind: "root" | "module" | "class" | "test";
  parent: TestNode | null;
  children: TestNode[];
  /** leaf state (containers derive theirs from `counts`) */
  outcome: Outcome;
  duration: number;
  message: string;
  longrepr: string;
  output: string;
  file: string;
  line: number;
  counts: Counts;
}

const zero = (): Counts => ({ total: 0, pending: 0, running: 0, passed: 0, failed: 0, error: 0, skipped: 0, duration: 0 });
const bucket = (o: Outcome): keyof Counts => (o === "xpassed" ? "passed" : o === "xfailed" ? "skipped" : (o as keyof Counts));

/** `a/b.py::Cls::test_x[p::q]` -> ["a/b.py","Cls","test_x[p::q]"] (:: inside brackets does not split). */
export function splitNodeId(id: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < id.length; i++) {
    const c = id[i];
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && c === ":" && id[i + 1] === ":") { out.push(cur); cur = ""; i++; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function nodeOutcome(n: TestNode): Outcome {
  if (!n.children.length) return n.outcome;
  const c = n.counts;
  if (c.failed) return "failed";
  if (c.error) return "error";
  if (c.running || c.pending) return c.running || c.passed || c.skipped ? "running" : "pending";
  if (c.passed) return "passed";
  return "skipped";
}

export class TestModel {
  root: TestNode = this.mk("", "", "root", null);
  private byKey = new Map<string, TestNode>();
  private leaves = new Map<string, TestNode>();
  done = false;
  exitStatus: number | null = null;
  startedAt = Date.now();
  rev = 0;
  private subs = new Set<() => void>();
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  private touch() { this.rev++; this.subs.forEach((f) => f()); }

  private mk(key: string, name: string, kind: TestNode["kind"], parent: TestNode | null): TestNode {
    return { key, id: key, name, kind, parent, children: [], outcome: "pending", duration: 0, message: "", longrepr: "", output: "", file: "", line: 0, counts: zero() };
  }

  private container(key: string, name: string, kind: "module" | "class", parent: TestNode): TestNode {
    let n = this.byKey.get(key);
    if (!n) {
      n = this.mk(key, name, kind, parent);
      parent.children.push(n);
      this.byKey.set(key, n);
    }
    return n;
  }

  /** The leaf for a test id, creating module/class containers on the way. */
  leaf(id: string, name?: string): TestNode {
    let n = this.leaves.get(id);
    if (n) return n;
    const parts = splitNodeId(id);
    let parent = this.root;
    let key = "";
    for (let i = 0; i < parts.length - 1; i++) {
      key = key ? `${key}::${parts[i]}` : parts[i];
      parent = this.container(key, parts[i], i === 0 ? "module" : "class", parent);
    }
    n = this.mk(id, name ?? parts[parts.length - 1], "test", parent);
    parent.children.push(n);
    this.leaves.set(id, n);
    this.byKey.set(id, n);
    this.bump(n, null, "pending", 0);
    return n;
  }

  private bump(leaf: TestNode, from: Outcome | null, to: Outcome, dDur: number) {
    for (let a: TestNode | null = leaf.parent; a; a = a.parent) {
      if (from === null) a.counts.total++;
      else a.counts[bucket(from)]--;
      a.counts[bucket(to)]++;
      a.counts.duration += dDur;
    }
  }

  private setOutcome(n: TestNode, to: Outcome, dur = 0) {
    const d = dur - n.duration;
    if (n.outcome !== to || d) this.bump(n, n.outcome, to, d);
    n.outcome = to;
    n.duration = dur;
  }

  apply(ev: Record<string, unknown>) {
    const k = ev.k;
    if (k === "collected") {
      for (const it of (ev.items as { id: string; name?: string; file?: string; line?: number }[]) ?? []) {
        const n = this.leaf(it.id, undefined);
        if (it.file) n.file = it.file;
        if (it.line) n.line = it.line;
      }
    } else if (k === "start") {
      const n = this.leaf(String(ev.id));
      this.setOutcome(n, "running");
    } else if (k === "result") {
      const n = this.leaf(String(ev.id));
      this.setOutcome(n, (ev.outcome as Outcome) ?? "passed", Number(ev.duration) || 0);
      n.message = String(ev.message ?? "");
      n.longrepr = String(ev.longrepr ?? "");
      n.output = String(ev.output ?? "");
      if (ev.line) n.line = Number(ev.line);
      // the collected item carries the absolute path; a result only has the rootdir-relative one
      if (ev.file && !n.file) n.file = String(ev.file);
    } else if (k === "collect_error") {
      const id = `${String(ev.id)}::(collection error)`;
      const n = this.leaf(id, "Collection error");
      n.file = String(ev.id);
      n.longrepr = String(ev.longrepr ?? "");
      n.message = n.longrepr.split("\n").filter(Boolean).pop() ?? "collection error";
      this.setOutcome(n, "error");
    } else if (k === "done") {
      this.done = true;
      this.exitStatus = Number(ev.exitstatus);
    } else return;
    this.touch();
  }

  /** The process ended: anything still running/pending will never report. */
  finish() {
    for (const n of this.leaves.values()) if (n.outcome === "running") this.setOutcome(n, "error");
    this.done = true;
    this.touch();
  }

  get total() { return this.root.counts.total; }
  allLeaves() { return [...this.leaves.values()]; }
  failedIds(): string[] {
    return this.allLeaves().filter((n) => (n.outcome === "failed" || n.outcome === "error") && !n.id.endsWith("::(collection error)")).map((n) => n.id);
  }
  find(id: string) { return this.byKey.get(id) ?? null; }

  /** "Tests passed: 3 of 5, 1 failed, 1 skipped" */
  statusText(): string {
    const c = this.root.counts;
    if (!c.total) return this.done ? "No tests were found" : "Collecting tests…";
    const parts = [`Tests passed: ${c.passed} of ${c.total}`];
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.error) parts.push(`${c.error} ${c.error === 1 ? "error" : "errors"}`);
    if (c.skipped) parts.push(`${c.skipped} skipped`);
    return parts.join(", ");
  }
  /** finished fraction 0..1 for the progress bar */
  progress() {
    const c = this.root.counts;
    return c.total ? (c.passed + c.failed + c.error + c.skipped) / c.total : this.done ? 1 : 0;
  }
}

export interface ViewOpts { showPassed: boolean; showSkipped: boolean; alpha: boolean; collapsed: ReadonlySet<string> }
export interface Row { node: TestNode; depth: number; expanded: boolean }

const visible = (n: TestNode, o: ViewOpts): boolean => {
  if (!n.children.length) {
    const oc = n.outcome;
    if (oc === "passed" || oc === "xpassed") return o.showPassed;
    if (oc === "skipped" || oc === "xfailed") return o.showSkipped;
    return true;
  }
  return n.children.some((c) => visible(c, o));
};

/** Flatten the tree for rendering (collapsed set, filters, alphabetical sort). */
export function flatten(model: TestModel, o: ViewOpts): Row[] {
  const out: Row[] = [];
  const walk = (n: TestNode, depth: number) => {
    if (!visible(n, o)) return;
    const hasKids = n.children.length > 0;
    const expanded = hasKids && !o.collapsed.has(n.key);
    out.push({ node: n, depth, expanded });
    if (expanded) {
      const kids = o.alpha ? [...n.children].sort((a, b) => a.name.localeCompare(b.name)) : n.children;
      for (const c of kids) walk(c, depth + 1);
    }
  };
  walk(model.root, 0);
  return out;
}

export const fmtDuration = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(2)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
