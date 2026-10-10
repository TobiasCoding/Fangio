// Test environment: fresh fake IndexedDB + fake chrome per test, and helpers to
// load the background as a fresh module graph (= a new service worker instance).

import { IDBFactory } from 'fake-indexeddb';
import { vi } from 'vitest';
import type { TabRecord } from '../../src/shared/types';
import { installFakeChrome, type FakeChrome } from './fakeChrome';

export type Bg = typeof import('../../src/background/index');
export type DbMod = typeof import('../../src/core/db');

export interface Worker {
  bg: Bg;
  db: DbMod;
  core: {
    closeOp: typeof import('../../src/core/closeOp');
    reopenOp: typeof import('../../src/core/reopenOp');
    tracker: typeof import('../../src/core/tracker');
    actions: typeof import('../../src/core/actions');
    resume: typeof import('../../src/core/resume');
    session: typeof import('../../src/core/session');
    runtime: typeof import('../../src/core/runtime');
  };
  /** Sends a UI request through runtime.onMessage and returns the Envelope. */
  send: (msg: unknown) => Promise<any>;
  /** Like send but unwraps { ok, data } and throws on ok:false. */
  call: (msg: unknown) => Promise<any>;
}

let current: Worker | null = null;

/** New empty browser profile (fresh IndexedDB + fake chrome). */
export function freshBrowser(): FakeChrome {
  current = null;
  (globalThis as any).indexedDB = new IDBFactory();
  return installFakeChrome();
}

/** Starts a NEW worker instance (fresh module graph) on the current fake chrome. Awaits init. */
export async function startWorker(fc: FakeChrome, opts: { awaitReady?: boolean } = {}): Promise<Worker> {
  if (current) {
    current.bg.__killForTests();
    current.core.runtime.rt.killed = true;
  }
  fc.clearListeners();
  vi.resetModules();
  const bg: Bg = await import('../../src/background/index');
  const w: Worker = {
    bg,
    db: await import('../../src/core/db'),
    core: {
      closeOp: await import('../../src/core/closeOp'),
      reopenOp: await import('../../src/core/reopenOp'),
      tracker: await import('../../src/core/tracker'),
      actions: await import('../../src/core/actions'),
      resume: await import('../../src/core/resume'),
      session: await import('../../src/core/session'),
      runtime: await import('../../src/core/runtime'),
    },
    send: (msg) => fc.sendMessage(msg),
    call: async (msg) => {
      const env = await fc.sendMessage(msg);
      if (!env || !env.ok) throw new Error(env?.error ?? 'no response');
      return env.data;
    },
  };
  current = w;
  if (opts.awaitReady !== false) await bg.ready();
  return w;
}

export async function idle(w: Worker): Promise<void> {
  await w.bg.whenIdle();
}

export function byUrl(records: TabRecord[]): Map<string, TabRecord[]> {
  const m = new Map<string, TabRecord[]>();
  for (const r of records) m.set(r.url, [...(m.get(r.url) ?? []), r]);
  return m;
}

export function never(): Promise<never> {
  return new Promise(() => {});
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
