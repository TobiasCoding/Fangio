// In-memory runtime state of the service worker (lost when the worker dies;
// everything here is an optimization or a guard backed by persisted data).

import { CHANGES_CHANNEL, type ChangeEvent } from '../shared/messages';

export const rt = {
  /** Tab ids being closed by one of our close ops (onRemoved must not treat them as user-closed). */
  closingTabIds: new Set<number>(),
  /** URL -> count of tabs about to be created by a reopen op (tracker must not create records for them). */
  expectedOpenUrls: new Map<string, number>(),
  /** Tab ids created by a reopen op that are not bound yet. */
  expectedTabIds: new Set<number>(),
  /** Ops running in this worker instance. */
  runningOpIds: new Set<string>(),
  /** Unfinished ops that resume could not resolve yet (startup grace). Their pendingClose is left alone. */
  deferredOpIds: new Set<string>(),
  /** Record id -> refcount of running ops touching it. */
  busyRecords: new Map<string, number>(),
  /** Set by tests to simulate a dead worker: timers and handlers become no-ops. */
  killed: false,
};

export function addExpectedUrl(url: string): void {
  rt.expectedOpenUrls.set(url, (rt.expectedOpenUrls.get(url) ?? 0) + 1);
}
export function removeExpectedUrl(url: string): void {
  const n = (rt.expectedOpenUrls.get(url) ?? 0) - 1;
  if (n > 0) rt.expectedOpenUrls.set(url, n);
  else rt.expectedOpenUrls.delete(url);
}

export function markBusy(ids: Iterable<string>): void {
  for (const id of ids) rt.busyRecords.set(id, (rt.busyRecords.get(id) ?? 0) + 1);
}
export function unmarkBusy(ids: Iterable<string>): void {
  for (const id of ids) {
    const n = (rt.busyRecords.get(id) ?? 0) - 1;
    if (n > 0) rt.busyRecords.set(id, n);
    else rt.busyRecords.delete(id);
  }
}
export function busySet(): Set<string> {
  return new Set(rt.busyRecords.keys());
}
export function activeOpIds(): Set<string> {
  return new Set([...rt.runningOpIds, ...rt.deferredOpIds]);
}

// ------------------------------------------------------------------ tab load waiters

type LoadOutcome = 'complete' | 'removed' | 'timeout';
const loadWaiters = new Map<number, Set<(o: LoadOutcome) => void>>();

export function notifyTabLoad(tabId: number, outcome: 'complete' | 'removed'): void {
  const set = loadWaiters.get(tabId);
  if (!set) return;
  loadWaiters.delete(tabId);
  for (const fn of set) fn(outcome);
}

/** Resolves when notifyTabLoad(tabId) is called or after timeoutMs. */
export function waitForTabLoad(tabId: number, timeoutMs: number): Promise<LoadOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: LoadOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = loadWaiters.get(tabId);
      set?.delete(finish);
      if (set && set.size === 0) loadWaiters.delete(tabId);
      resolve(o);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    let set = loadWaiters.get(tabId);
    if (!set) loadWaiters.set(tabId, (set = new Set()));
    set.add(finish);
  });
}

// ------------------------------------------------------------------ change notifications

let channel: BroadcastChannel | null = null;
const listeners = new Set<(ev: ChangeEvent) => void>();

/** Local subscribers (badge updater, tests). */
export function onLocalChange(fn: (ev: ChangeEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notifies UI pages (BroadcastChannel) and local subscribers. Never throws. */
export function broadcast(ev: ChangeEvent): void {
  try {
    if (!channel && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(CHANGES_CHANNEL);
    channel?.postMessage(ev);
  } catch {
    /* ignore */
  }
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      /* ignore */
    }
  }
}

export function recordsChanged(ids?: string[]): void {
  broadcast(ids && ids.length <= 50 ? { type: 'records', ids } : { type: 'records' });
}

export function __resetRuntimeForTests(): void {
  rt.closingTabIds.clear();
  rt.expectedOpenUrls.clear();
  rt.expectedTabIds.clear();
  rt.runningOpIds.clear();
  rt.deferredOpIds.clear();
  rt.busyRecords.clear();
  rt.killed = false;
  loadWaiters.clear();
  listeners.clear();
  try {
    channel?.close();
  } catch {
    /* ignore */
  }
  channel = null;
}
