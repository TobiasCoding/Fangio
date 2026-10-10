// Minimal observable store + Preact hook (no external state library).

import { useEffect, useReducer, useRef } from 'preact/hooks';

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  const notify = () => {
    for (const f of [...subs]) f();
  };
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      notify();
    },
    update(fn) {
      this.set(fn(value));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** Re-renders the component whenever the store changes. */
export function useStore<T>(store: Store<T>): T {
  const value = store.get();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const rendered = useRef(value);
  rendered.current = value;
  useEffect(() => {
    const unsub = store.subscribe(() => force(0));
    // The store may have changed between render and subscription (effects run after paint).
    if (store.get() !== rendered.current) force(0);
    return unsub;
  }, [store]);
  return value;
}

/** Returns a debounced version of fn plus flush/cancel. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };
  const d = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  d.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  d.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  d.pending = () => timer !== null;
  return d;
}
