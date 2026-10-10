import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

/** Tiny immutable store. `set` shallow-merges. Use `useStore(store)` in components. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Subscribe-able list used by registries. */
export function createRegistry<T extends { id: string }>() {
  let items: T[] = [];
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((f) => f());
  return {
    register(item: T) {
      const i = items.findIndex((x) => x.id === item.id);
      items = i >= 0 ? items.map((x, j) => (j === i ? item : x)) : [...items, item];
      notify();
    },
    unregister(id: string) {
      items = items.filter((x) => x.id !== id);
      notify();
    },
    list: () => items,
    get: (id: string) => items.find((x) => x.id === id),
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
export function useRegistry<T extends { id: string }>(r: ReturnType<typeof createRegistry<T>>): T[] {
  return useSyncExternalStore(r.subscribe, r.list);
}
