// Dashboard data layer: in-memory mirror of IndexedDB records + status/settings,
// kept fresh through BroadcastChannel change events.

import type { Settings, StatusInfo, TabRecord } from '../../shared/types';
import { getAllRecords, getRecord, getSettings } from '../../core/db';
import { errMsg, onChanges, send } from '../common/api';
import { createStore } from '../common/store';

export interface RecordsState {
  loaded: boolean;
  list: TabRecord[];
  byId: Map<string, TabRecord>;
  error: string | null;
}

export const recordsStore = createStore<RecordsState>({ loaded: false, list: [], byId: new Map(), error: null });
export const statusStore = createStore<StatusInfo | null>(null);
export const settingsStore = createStore<Settings | null>(null);
/** Incremented whenever the action log changes (views re-query). */
export const actionsVersion = createStore(0);

/** Above this many changed ids a full reload is cheaper than per-id reads. */
const PATCH_LIMIT = 300;

let pendingAll = false;
const pendingIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();

function setList(list: TabRecord[]) {
  recordsStore.set({ loaded: true, list, byId: new Map(list.map((r) => [r.id, r])), error: null });
}

export async function reloadAllRecords(): Promise<void> {
  try {
    setList(await getAllRecords());
  } catch (e) {
    recordsStore.set({ ...recordsStore.get(), loaded: true, error: errMsg(e) });
  }
}

async function patchRecords(ids: string[]): Promise<void> {
  const fetched = await Promise.all(ids.map((id) => getRecord(id).catch(() => undefined)));
  const cur = recordsStore.get();
  const byId = new Map(cur.byId);
  ids.forEach((id, i) => {
    const r = fetched[i];
    if (r) byId.set(id, r);
    else byId.delete(id);
  });
  recordsStore.set({ loaded: true, list: [...byId.values()], byId, error: null });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const all = pendingAll || pendingIds.size > PATCH_LIMIT;
    const ids = [...pendingIds];
    pendingAll = false;
    pendingIds.clear();
    running = running.then(() => (all ? reloadAllRecords() : patchRecords(ids))).catch(() => {});
  }, 100);
}

/** Request a refresh of some records (or all when ids is undefined). Coalesced. */
export function invalidateRecords(ids?: string[]): void {
  if (!ids) pendingAll = true;
  else for (const id of ids) pendingIds.add(id);
  scheduleFlush();
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshStatus(delay = 250): void {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusTimer = null;
    send({ type: 'getStatus' })
      .then((s) => statusStore.set(s))
      .catch(() => {});
  }, delay);
}

export async function refreshSettings(): Promise<Settings | null> {
  try {
    const s = await getSettings();
    settingsStore.set(s);
    return s;
  } catch {
    return settingsStore.get();
  }
}

let started = false;
/** Loads everything once and subscribes to change events. */
export function initData(): void {
  if (started) return;
  started = true;
  void reloadAllRecords();
  void refreshSettings();
  refreshStatus(0);
  onChanges((ev) => {
    switch (ev.type) {
      case 'records':
        invalidateRecords(ev.ids);
        refreshStatus();
        break;
      case 'settings':
        void refreshSettings();
        refreshStatus();
        break;
      case 'actions':
        actionsVersion.update((v) => v + 1);
        break;
      case 'ops':
      case 'status':
        refreshStatus();
        break;
    }
  });
  // Safety net: if the page was hidden and events were missed, resync on focus.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 60_000) {
      invalidateRecords();
      refreshStatus();
    }
  });
}

/** Readable title for a record id (for result dialogs and the log). */
export function titleOf(id: string): string | undefined {
  const r = recordsStore.get().byId.get(id);
  return r ? r.title || r.url : undefined;
}
