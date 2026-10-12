/**
 * Tiny Molang evaluator for keyframe components: numbers, `+ - * /`, parentheses, unary minus/plus,
 * `math.*` (sin/cos/tan/asin/acos/atan/atan2 work in DEGREES like Bedrock; abs, clamp, lerp, min, max,
 * floor, ceil, round, trunc, sqrt, pow, mod, exp, ln, pi, random→0.5), `query.anim_time`,
 * `query.life_time` and `variable.*` / `v.*` from the environment. Unknown names evaluate to 0.
 * Anything that fails to parse evaluates to 0.
 */

export interface MolangEnv {
  /** Seconds into the animation. */
  anim_time?: number;
  /** Seconds since the entity spawned (defaults to anim_time). */
  life_time?: number;
  /** variable.foo values keyed by `foo`. */
  vars?: Record<string, number>;
}

type Fn = (env: MolangEnv) => number;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (x) => Math.sin(x * D2R),
  cos: (x) => Math.cos(x * D2R),
  tan: (x) => Math.tan(x * D2R),
  asin: (x) => Math.asin(x) * R2D,
  acos: (x) => Math.acos(x) * R2D,
  atan: (x) => Math.atan(x) * R2D,
  atan2: (y, x) => Math.atan2(y, x) * R2D,
  abs: Math.abs,
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
  lerp: (a, b, t) => a + (b - a) * t,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  trunc: Math.trunc,
  sqrt: Math.sqrt,
  pow: Math.pow,
  mod: (a, b) => a % b,
  exp: Math.exp,
  ln: Math.log,
  random: () => 0.5,
};

const cache = new Map<string, Fn>();

export function compileMolang(src: string): Fn {
  let f = cache.get(src);
  if (!f) {
    try {
      f = parse(src);
    } catch {
      f = () => 0;
    }
    if (cache.size > 2000) cache.clear();
    cache.set(src, f);
  }
  return f;
}

export function evalMolang(src: string | number, env: MolangEnv = {}): number {
  if (typeof src === "number") return src;
  const v = compileMolang(src)(env);
  return Number.isFinite(v) ? v : 0;
}

function parse(src: string): Fn {
  const s = src.trim().toLowerCase().replace(/;+\s*$/, "").replace(/^return\s+/, "");
  let i = 0;
  const ws = () => {
    while (i < s.length && s[i] <= " ") i++;
  };
  const expr = (): Fn => {
    let l = term();
    for (;;) {
      ws();
      const c = s[i];
      if (c === "+" || c === "-") {
        i++;
        const a = l;
        const b = term();
        l = c === "+" ? (e) => a(e) + b(e) : (e) => a(e) - b(e);
      } else return l;
    }
  };
  const term = (): Fn => {
    let l = unary();
    for (;;) {
      ws();
      const c = s[i];
      if (c === "*" || c === "/") {
        i++;
        const a = l;
        const b = unary();
        l = c === "*" ? (e) => a(e) * b(e) : (e) => {
          const d = b(e);
          return d === 0 ? 0 : a(e) / d; // Molang: x/0 = 0
        };
      } else return l;
    }
  };
  const unary = (): Fn => {
    ws();
    if (s[i] === "-") {
      i++;
      const a = unary();
      return (e) => -a(e);
    }
    if (s[i] === "+") {
      i++;
      return unary();
    }
    return atom();
  };
  const atom = (): Fn => {
    ws();
    if (s[i] === "(") {
      i++;
      const a = expr();
      ws();
      if (s[i++] !== ")") throw new Error("expected )");
      return a;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      const v = parseFloat(num[0]);
      return () => v;
    }
    const id = /^[a-z_][a-z0-9_.]*/.exec(s.slice(i));
    if (!id) throw new Error("unexpected " + s[i]);
    i += id[0].length;
    const name = id[0].replace(/^(m\.)/, "math.").replace(/^q\./, "query.").replace(/^v\./, "variable.");
    ws();
    if (s[i] === "(") {
      i++;
      const args: Fn[] = [];
      ws();
      if (s[i] === ")") i++;
      else
        for (;;) {
          args.push(expr());
          ws();
          const c = s[i++];
          if (c === ")") break;
          if (c !== ",") throw new Error("expected , or )");
        }
      const fn = name.startsWith("math.") ? FUNCS[name.slice(5)] : undefined;
      if (!fn) return () => 0;
      return (e) => fn(...args.map((a) => a(e)));
    }
    switch (name) {
      case "math.pi":
        return () => Math.PI;
      case "query.anim_time":
        return (e) => e.anim_time ?? 0;
      case "query.life_time":
        return (e) => e.life_time ?? e.anim_time ?? 0;
      case "true":
        return () => 1;
      case "false":
        return () => 0;
    }
    if (name.startsWith("variable.")) {
      const k = name.slice(9);
      return (e) => e.vars?.[k] ?? 0;
    }
    return () => 0;
  };
  const f = expr();
  ws();
  if (i < s.length) throw new Error("trailing input");
  return f;
}
