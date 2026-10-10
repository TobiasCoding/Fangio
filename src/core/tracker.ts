// Tab event tracking. Listeners (registered synchronously in background/index.ts)
// only enqueue; a debounced flush applies everything in ONE locked read-modify-write
// pass using the shared rebind logic of planReconcile(). Also hosts the full
// reconcile() and the install snapshot, which reuse the same plan + apply code.

import { EVENT_FLUSH_MS } from '../shared/constants';
import type { ActionEntry, RecordPatch, RecordSource, TabRecord } from '../shared/types';
import { getAllRecords, getRecordsByState, getRecordsByUrls, putActions, putRecords, setKv } from './db';
import { dbLock } from './mutex';
import { emptyPlan, planReconcile, WINDOW_CLOSED_REASON, type ReconcilePlan } from './reconcile';
import { newAction, stateSnapshot, type GroupInfo } from './records';
import { activeOpIds, broadcast, busySet, notifyTabLoad, recordsChanged, rt } from './runtime';
import { getSession } from './session';
import { tabUrl } from './url';

export const USER_CLOSED_REASON = 'Cerrada por el usuario';
const FAST_FLUSH_MS = 250;

interface Queue {
  touched: Set<number>;
  removed: { tabId: number; windowClosing: boolean; ours: boolean }[];
  activated: Map<number, number>;
  audible: Map<number, number>;
  replaced: { added: number; removed: number }[];
}
const freshQueue = (): Queue => ({ touched: new Set(), removed: [], activated: new Map(), audible: new Map(), replaced: [] });

let queue: Queue = freshQueue();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDue = Infinity;
let chain: Promise<unknown> = Promise.resolve();
let readyFn: () => Promise<unknown> = () => Promise.resolve();

/** Background passes its ready() function: flushes wait for init (and keep the queue if init failed). */
export function setTrackerReady(fn: () => Promise<unknown>): void {
  readyFn = fn;
}

function schedule(delay: number): void {
  if (rt.killed) return;
  const due = Date.now() + delay;
  if (timer && timerDue <= due) return;
  if (timer) clearTimeout(timer);
  timerDue = due;
  timer = setTimeout(() => {
    timer = null;
    timerDue = Infinity;
    void flushNow().catch(() => {});
  }, delay);
}

function hasWork(q: Queue): boolean {
  return q.touched.size > 0 || q.removed.length > 0 || q.activated.size > 0 || q.audible.size > 0 || q.replaced.length > 0;
}

// ------------------------------------------------------------------ event entry points (synchronous)

export function onTabCreated(tab: chrome.tabs.Tab): void {
  if (typeof tab.id !== 'number' || tab.incognito) return;
  queue.touched.add(tab.id);
  schedule(FAST_FLUSH_MS);
}

export function onTabUpdated(tabId: number, info: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab): void {
  if (info.status === 'complete') notifyTabLoad(tabId, 'complete');
  if (tab?.incognito) return;
  if (info.audible !== undefined) {
    queue.audible.set(tabId, Date.now());
    schedule(EVENT_FLUSH_MS);
  }
  if (info.url !== undefined || (info.status === 'complete' && tab && !tab.url)) {
    queue.touched.add(tabId);
    schedule(FAST_FLUSH_MS);
  } else if (info.title !== undefined || info.favIconUrl !== undefined || info.status === 'complete') {
    queue.touched.add(tabId);
    schedule(EVENT_FLUSH_MS);
  }
}

export function onTabActivated(info: { tabId: number; windowId: number }): void {
  queue.activated.set(info.tabId, Date.now());
  schedule(EVENT_FLUSH_MS);
}

export function onTabRemoved(tabId: number, info: { windowId: number; isWindowClosing: boolean }): void {
  notifyTabLoad(tabId, 'removed');
  // "ours" is captured at event time: the op may finish before the flush runs.
  queue.removed.push({ tabId, windowClosing: !!info.isWindowClosing, ours: rt.closingTabIds.has(tabId) });
  queue.touched.delete(tabId);
  schedule(FAST_FLUSH_MS);
}

export function onTabReplaced(addedTabId: number, removedTabId: number): void {
  queue.replaced.push({ added: addedTabId, removed: removedTabId });
  queue.touched.add(addedTabId);
  schedule(FAST_FLUSH_MS);
}

export function onTabMoved(tabId: number): void {
  queue.touched.add(tabId);
  schedule(EVENT_FLUSH_MS);
}

/** Applies every queued event now (also used by the popup / commands before reading). */
export function flushNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    timerDue = Infinity;
  }
  const run = chain.then(async () => {
    try {
      await readyFn();
    } catch {
      return; // init failed: keep the queue for the next attempt
    }
    if (rt.killed || !hasWork(queue)) return;
    const q = queue;
    queue = freshQueue();
    try {
      await dbLock.run(() => processQueue(q));
    } catch (e) {
      // Losing a flush is not fatal: reconcile re-syncs. Keep removals for a retry.
      console.warn('[fangio] flush failed', e);
    }
  });
  chain = run.catch(() => {});
  return run;
}

export function __resetTrackerForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  timerDue = Infinity;
  queue = freshQueue();
  chain = Promise.resolve();
  readyFn = () => Promise.resolve();
}

// ------------------------------------------------------------------ shared apply helpers

export async function queryGroups(): Promise<Map<number, GroupInfo>> {
  const out = new Map<number, GroupInfo>();
  try {
    if (!chrome.tabGroups?.query) return out;
    for (const g of await chrome.tabGroups.query({})) {
      const info: GroupInfo = {};
      if (g.title) info.title = g.title;
      if (g.color) info.color = g.color;
      out.set(g.id, info);
    }
  } catch {
    /* tabGroups unavailable: origin without group */
  }
  return out;
}

/** All non-incognito tabs. */
export async function queryAllTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => !t.incognito && typeof t.id === 'number');
}

/** Action log entries for a plan (rebinds, window-closed, completed orphans, install snapshot). */
export function planActions(plan: ReconcilePlan, createSource?: RecordSource): ActionEntry[] {
  const out: ActionEntry[] = [];
  const toBefore = (list: { recordId: string; before: RecordPatch }[]) =>
    Object.fromEntries(list.map((x) => [x.recordId, x.before]));
  if (plan.rebinds.length > 0) {
    out.push(
      newAction('rebind', {
        auto: true,
        reason: 'La pestaña volvió a abrirse y se re-vinculó a su referencia',
        recordIds: plan.rebinds.map((x) => x.recordId),
        before: toBefore(plan.rebinds),
        undoable: false,
      }),
    );
  }
  if (plan.windowClosed.length > 0) {
    out.push(
      newAction('window-closed', {
        auto: true,
        reason: WINDOW_CLOSED_REASON,
        recordIds: plan.windowClosed.map((x) => x.recordId),
        before: toBefore(plan.windowClosed),
        undoable: true,
      }),
    );
  }
  for (const target of ['archived', 'trash'] as const) {
    const list = plan.orphanCompleted.filter((x) => x.targetState === target);
    if (list.length === 0) continue;
    out.push(
      newAction(target === 'archived' ? 'archive' : 'trash', {
        auto: false,
        reason: `${list[0]!.reason} (cierre interrumpido completado)`,
        recordIds: list.map((x) => x.recordId),
        before: toBefore(list),
        undoable: true,
      }),
    );
  }
  if (createSource === 'install-snapshot' && plan.created.length > 0) {
    out.push(
      newAction('install-snapshot', {
        auto: true,
        reason: `Instalación: se guardaron ${plan.created.length} pestañas abiertas`,
        recordIds: plan.created,
        undoable: false,
      }),
    );
  }
  return out;
}

async function writePlan(plan: ReconcilePlan, extra: TabRecord[], actions: ActionEntry[]): Promise<string[]> {
  const all = new Map<string, TabRecord>();
  for (const r of extra) all.set(r.id, r);
  for (const [id, r] of plan.changed) all.set(id, r);
  const list = [...all.values()];
  await putRecords(list);
  if (actions.length > 0) await putActions(actions);
  if (list.length > 0) recordsChanged(list.map((r) => r.id));
  if (actions.length > 0) broadcast({ type: 'actions' });
  return list.map((r) => r.id);
}

// ------------------------------------------------------------------ flush

async function processQueue(q: Queue): Promise<void> {
  const session = await getSession();
  const now = Date.now();
  const sid = session.sessionId;
  const open = await getRecordsByState('open');
  const work = new Map(open.map((r) => [r.id, r]));
  const changed = new Map<string, TabRecord>();
  const byTab = new Map<number, TabRecord>();
  for (const r of open) if (r.live && r.live.sessionId === sid && !byTab.has(r.live.tabId)) byTab.set(r.live.tabId, r);
  const busy = busySet();
  const tabs = await queryAllTabs();
  const tabById = new Map(tabs.map((t) => [t.id!, t]));

  for (const { added, removed } of q.replaced) {
    const r = byTab.get(removed);
    if (!r || !r.live) continue;
    r.live = { ...r.live, tabId: added };
    byTab.delete(removed);
    byTab.set(added, r);
    changed.set(r.id, r);
  }

  const userClosed: { recordId: string; before: RecordPatch }[] = [];
  for (const ev of q.removed) {
    if (ev.ours || ev.windowClosing || rt.closingTabIds.has(ev.tabId)) continue;
    if (tabById.has(ev.tabId)) continue;
    const r = byTab.get(ev.tabId);
    if (!r || r.state !== 'open' || r.pendingClose || busy.has(r.id)) continue;
    userClosed.push({ recordId: r.id, before: stateSnapshot(r) });
    r.state = 'trash';
    r.trashedAt = now;
    r.implicitCloseAt = now;
    r.live = null;
    r.lastReason = USER_CLOSED_REASON;
    byTab.delete(ev.tabId);
    changed.set(r.id, r);
  }

  for (const [tabId, at] of q.activated) {
    const r = byTab.get(tabId);
    if (r && (r.lastAccessedAt ?? 0) < at) {
      r.lastAccessedAt = at;
      changed.set(r.id, r);
    }
  }
  for (const [tabId, at] of q.audible) {
    const r = byTab.get(tabId);
    if (r) {
      r.lastAudibleAt = at;
      changed.set(r.id, r);
    }
  }

  let plan: ReconcilePlan | null = null;
  const touched = new Set([...q.touched].filter((id) => tabById.has(id)));
  if (touched.size > 0) {
    const urls = [...touched].map((id) => tabUrl(tabById.get(id))).filter(Boolean);
    const extraRecs = (await getRecordsByUrls(urls)).filter((r) => !work.has(r.id));
    const candidates = [...work.values(), ...extraRecs];
    plan = planReconcile({
      tabs,
      records: candidates,
      sessionId: sid,
      now,
      startupAt: session.startupAt,
      groups: await queryGroups(),
      onlyTabIds: touched,
      skipTabIds: rt.expectedTabIds,
      skipUrls: new Set(rt.expectedOpenUrls.keys()),
      busyRecordIds: busy,
      activeOpIds: activeOpIds(),
      createSource: 'tracked',
      extensionId: chrome.runtime?.id,
    });
  }

  const actions = plan ? planActions(plan) : [];
  if (userClosed.length > 0) {
    actions.unshift(
      newAction('user-closed', {
        auto: false,
        reason: USER_CLOSED_REASON,
        recordIds: userClosed.map((x) => x.recordId),
        before: Object.fromEntries(userClosed.map((x) => [x.recordId, x.before])),
        undoable: true,
      }),
    );
  }
  // The plan cloned from the (already mutated) working objects, so its copies supersede them.
  const extra = [...changed.values()].filter((r) => !plan?.changed.has(r.id));
  if (extra.length === 0 && (!plan || plan.changed.size === 0) && actions.length === 0) return;
  await writePlan(plan ?? emptyPlan(), extra, actions);
}

// ------------------------------------------------------------------ full reconcile / install snapshot

export interface ReconcileSummary {
  created: number;
  bound: number;
  updated: number;
  windowClosed: number;
  orphanAborted: number;
  orphanCompleted: number;
  deferred: number;
  summary: string;
}

/**
 * Full pass over every tab and record (never deletes, never trashes):
 * bind/update, create records for untracked tabs, archive open records without a
 * tab after the startup grace, resolve orphan pendingClose markers.
 */
export async function reconcile(opts: { createSource?: RecordSource; fromInit?: boolean } = {}): Promise<ReconcileSummary> {
  const createSource = opts.createSource ?? 'tracked';
  // Apply queued events first so they are not re-interpreted by the full pass.
  // (Not from init: flushes wait for init and would deadlock; queued events are applied right after.)
  if (!opts.fromInit) await flushNow();
  return dbLock.run(async () => {
    const session = await getSession();
    const now = Date.now();
    const [tabs, records, groups] = await Promise.all([queryAllTabs(), getAllRecords(), queryGroups()]);
    const plan = planReconcile({
      tabs,
      records,
      sessionId: session.sessionId,
      now,
      startupAt: session.startupAt,
      groups,
      skipTabIds: rt.expectedTabIds,
      skipUrls: new Set(rt.expectedOpenUrls.keys()),
      busyRecordIds: busySet(),
      activeOpIds: activeOpIds(),
      archiveMissing: true,
      resolveOrphans: true,
      createSource,
      extensionId: chrome.runtime?.id,
    });
    await writePlan(plan, [], planActions(plan, createSource));
    await setKv('lastReconcileAt', now);
    const updated = plan.changed.size - plan.created.length - plan.bound.length - plan.windowClosed.length;
    const s: ReconcileSummary = {
      created: plan.created.length,
      bound: plan.bound.length,
      updated: Math.max(0, updated),
      windowClosed: plan.windowClosed.length,
      orphanAborted: plan.orphanAborted.length,
      orphanCompleted: plan.orphanCompleted.length,
      deferred: plan.deferred,
      summary: '',
    };
    const parts = [
      `${tabs.length} pestañas revisadas`,
      s.created ? `${s.created} nuevas` : '',
      s.bound ? `${s.bound} re-vinculadas` : '',
      s.windowClosed ? `${s.windowClosed} archivadas (ventana cerrada)` : '',
      s.orphanCompleted ? `${s.orphanCompleted} cierres completados` : '',
      s.orphanAborted ? `${s.orphanAborted} cierres cancelados` : '',
      s.deferred ? `${s.deferred} en espera (arranque reciente)` : '',
    ].filter(Boolean);
    s.summary = parts.join(', ');
    return s;
  });
}
