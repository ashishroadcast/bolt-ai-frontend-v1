import { useState } from "react";

/**
 * Backs `usePersistentState` below. Module-level, not component state: it
 * has to outlive the component that wrote it, because the whole point is
 * surviving the unmount `<Outlet/>` performs on every tab switch (task
 * brief: "[the last outcome] currently vanishes after you navigate away").
 * A full page reload still loses it — this console holds its auth token
 * in memory only (`auth/session.ts`) and logs a reload out entirely, so a
 * cache that outlived that would be reachable with no session behind it —
 * matching that same "in-memory, this session only" boundary rather than
 * reaching for `sessionStorage` to outlive it.
 */
const store = new Map<string, unknown>();

/**
 * `useState`, but keyed and backed by `store` above so the value survives
 * this component unmounting and remounting under the same key — e.g.
 * `LearningTab`'s compile/tune/promote cards, which `<Outlet/>` unmounts on
 * every tab switch and remounts on return.
 *
 * Resyncing when `key` itself changes (switching the phase dropdown, for
 * one caller) happens during render rather than in a `useEffect` — a
 * `useEffect` would commit the *previous* key's value for one frame before
 * correcting itself; this is the same "adjust state while rendering"
 * pattern React's own docs use for resetting state when a prop changes,
 * and it stays a pure read of `(key, store)` with no side effect.
 */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({
    key,
    value: store.has(key) ? (store.get(key) as T) : initial,
  }));

  if (state.key !== key) {
    setState({ key, value: store.has(key) ? (store.get(key) as T) : initial });
  }

  function update(value: T) {
    store.set(key, value);
    setState({ key, value });
  }

  return [state.value, update];
}

/** Test-only: clears every persisted key so one test's compile/tune/
 * promote outcome can never leak into the next. Never called from app
 * code — there is no "forget everything" affordance in the product. */
export function __resetPersistentStateForTests(): void {
  store.clear();
}
