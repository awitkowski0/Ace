/**
 * Pure state machine for IntelliJ's modifier gestures: double-⇧ (Search Everywhere) and double-⌥ + arrow (clone caret).
 *
 * Rules (mirroring IntelliJ's ModifierKeyDoubleClickHandler):
 *  - a "tap" is a modifier keydown (not auto-repeat) followed by its keyup with NO other key / modifier / mouse press between
 *  - a double fires on the second keydown of the same modifier when the previous clean tap's keydown was <= windowMs earlier
 *  - key repeat never counts; any other key, other modifier, mouse press, or window blur resets the gesture
 */
export type Mod = "shift" | "alt" | "control" | "meta";
export const DOUBLE_TAP_MS = 300;

export class ModifierGesture {
  private cur: { name: Mod; t: number; clean: boolean } | null = null;
  private armed: { name: Mod; t: number } | null = null;
  private held = new Set<Mod>();
  /** Modifier whose second press is currently held down after a double (enables "double-⌥ then ↓"). */
  public doubleHeld: Mod | null = null;

  constructor(private windowMs = DOUBLE_TAP_MS) {}

  /** Modifier keydown. Returns the modifier when this press completes a double tap. */
  modDown(name: Mod, repeat: boolean, t: number): Mod | null {
    if (repeat) return null;
    const othersHeld = [...this.held].some((m) => m !== name);
    this.held.add(name);
    if (this.cur && this.cur.name !== name) this.cur.clean = false;
    if (othersHeld) {
      this.cur = { name, t, clean: false };
      this.armed = null;
      return null;
    }
    if (this.armed && this.armed.name === name && t - this.armed.t <= this.windowMs) {
      this.armed = null;
      this.cur = { name, t, clean: false };
      this.doubleHeld = name;
      return name;
    }
    this.armed = null;
    this.cur = { name, t, clean: true };
    return null;
  }

  modUp(name: Mod, _t: number) {
    this.held.delete(name);
    if (this.doubleHeld === name) this.doubleHeld = null;
    if (this.cur && this.cur.name === name && this.cur.clean) this.armed = { name, t: this.cur.t };
    else this.armed = null;
    this.cur = null;
  }

  /** Any non-modifier keydown / mouse press. */
  otherInput() {
    if (this.cur) this.cur.clean = false;
    this.armed = null;
  }

  reset() {
    this.cur = null;
    this.armed = null;
    this.held.clear();
    this.doubleHeld = null;
  }
}
