/** IntelliJ keystroke syntax -> realistic KeyboardEvent sequences. */
const MODS: Record<string, { key: string; code: string; keyCode: number; flag: "shiftKey" | "ctrlKey" | "altKey" | "metaKey" }> = {
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, flag: "shiftKey" },
  control: { key: "Control", code: "ControlLeft", keyCode: 17, flag: "ctrlKey" },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, flag: "altKey" },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91, flag: "metaKey" },
};
const ALIAS: Record<string, string> = { shift: "shift", control: "control", ctrl: "control", alt: "alt", option: "alt", opt: "alt", meta: "meta", cmd: "meta", command: "meta" };
const MOD_ORDER = ["control", "alt", "shift", "meta"];

interface KeyInfo { key: string; code: string; keyCode: number }
const NAMED: Record<string, KeyInfo> = {
  ESCAPE: { key: "Escape", code: "Escape", keyCode: 27 }, ESC: { key: "Escape", code: "Escape", keyCode: 27 },
  ENTER: { key: "Enter", code: "Enter", keyCode: 13 }, RETURN: { key: "Enter", code: "Enter", keyCode: 13 },
  TAB: { key: "Tab", code: "Tab", keyCode: 9 }, SPACE: { key: " ", code: "Space", keyCode: 32 },
  BACK_SPACE: { key: "Backspace", code: "Backspace", keyCode: 8 }, BACKSPACE: { key: "Backspace", code: "Backspace", keyCode: 8 },
  DELETE: { key: "Delete", code: "Delete", keyCode: 46 }, INSERT: { key: "Insert", code: "Insert", keyCode: 45 },
  LEFT: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, UP: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  RIGHT: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }, DOWN: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  HOME: { key: "Home", code: "Home", keyCode: 36 }, END: { key: "End", code: "End", keyCode: 35 },
  PAGE_UP: { key: "PageUp", code: "PageUp", keyCode: 33 }, PAGE_DOWN: { key: "PageDown", code: "PageDown", keyCode: 34 },
  SLASH: { key: "/", code: "Slash", keyCode: 191 }, BACK_SLASH: { key: "\\", code: "Backslash", keyCode: 220 },
  OPEN_BRACKET: { key: "[", code: "BracketLeft", keyCode: 219 }, CLOSE_BRACKET: { key: "]", code: "BracketRight", keyCode: 221 },
  COMMA: { key: ",", code: "Comma", keyCode: 188 }, PERIOD: { key: ".", code: "Period", keyCode: 190 },
  MINUS: { key: "-", code: "Minus", keyCode: 189 }, EQUALS: { key: "=", code: "Equal", keyCode: 187 },
  SEMICOLON: { key: ";", code: "Semicolon", keyCode: 186 }, QUOTE: { key: "'", code: "Quote", keyCode: 222 },
  BACK_QUOTE: { key: "`", code: "Backquote", keyCode: 192 },
};

function keyInfo(tok: string): KeyInfo {
  const u = tok.toUpperCase();
  if (NAMED[u]) return NAMED[u];
  if (/^F\d{1,2}$/.test(u)) return { key: u, code: u, keyCode: 111 + Number(u.slice(1)) };
  if (/^[A-Z]$/.test(u)) return { key: tok.length === 1 ? tok : u.toLowerCase(), code: `Key${u}`, keyCode: u.charCodeAt(0) };
  if (/^\d$/.test(u)) return { key: u, code: `Digit${u}`, keyCode: u.charCodeAt(0) };
  throw new Error(`qa.key: unknown key '${tok}'`);
}

export type Step = { type: "stroke"; mods: string[]; key: KeyInfo } | { type: "tap"; mod: string; times: number };

/** "meta shift O" | "shift shift" | "control TAB" | "meta K meta C" (chord) | "Shift" (modifier-only tap). */
export function parseSteps(spec: string): Step[] {
  const toks = spec.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) throw new Error("qa.key: empty keystroke");
  const low = toks.map((t) => ALIAS[t.toLowerCase()]);
  if (low.every((m) => m && m === low[0])) return [{ type: "tap", mod: low[0], times: toks.length }];
  const steps: Step[] = [];
  let mods: string[] = [];
  toks.forEach((t, i) => {
    if (low[i]) mods.push(low[i]);
    else {
      steps.push({ type: "stroke", mods: MOD_ORDER.filter((m) => mods.includes(m)), key: keyInfo(t) });
      mods = [];
    }
  });
  if (mods.length) throw new Error(`qa.key: dangling modifiers in '${spec}'`);
  return steps;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fire(type: "keydown" | "keyup", k: KeyInfo, held: Set<string>, target: EventTarget, repeat = false) {
  const init: KeyboardEventInit = {
    key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true, composed: true, repeat,
    shiftKey: held.has("shift"), ctrlKey: held.has("control"), altKey: held.has("alt"), metaKey: held.has("meta"),
  } as KeyboardEventInit;
  const ev = new KeyboardEvent(type, init);
  // WebKit ignores keyCode/which in the init dict in some versions: force them (Monaco reads keyCode).
  for (const p of ["keyCode", "which"] as const) {
    if ((ev as any)[p] !== k.keyCode) Object.defineProperty(ev, p, { get: () => k.keyCode });
  }
  target.dispatchEvent(ev);
  return ev;
}

const target = () => (document.activeElement as EventTarget | null) ?? document.body;

/** Dispatch a keystroke on document.activeElement. Returns true if the final keydown was default-prevented (handled). */
export async function key(spec: string, gapMs = 12): Promise<boolean> {
  let handled = false;
  for (const step of parseSteps(spec)) {
    if (step.type === "tap") {
      for (let i = 0; i < step.times; i++) {
        const m = MODS[step.mod];
        const held = new Set<string>([step.mod]);
        fire("keydown", m, held, target());
        await sleep(gapMs);
        fire("keyup", m, new Set(), target());
        if (i < step.times - 1) await sleep(40);
      }
      continue;
    }
    const held = new Set<string>();
    for (const m of step.mods) {
      held.add(m);
      fire("keydown", MODS[m], held, target());
    }
    const down = fire("keydown", step.key, held, target());
    handled = down.defaultPrevented;
    await sleep(gapMs);
    fire("keyup", step.key, held, target());
    for (const m of [...step.mods].reverse()) {
      held.delete(m);
      fire("keyup", MODS[m], held, target());
    }
    await sleep(gapMs);
  }
  return handled;
}

/** Modifier-only tap, e.g. tap("Shift"). */
export const tap = (mod: string, times = 1) => key(Array(times).fill(mod).join(" "));
