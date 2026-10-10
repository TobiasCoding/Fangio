// Reopen archived / trashed records into tabs, binding each new tab to the SAME
// record id. Journaled per item (pending -> creating -> done) so an interrupted
// run never creates two tabs for one item. Concurrency = settings.reopenConcurrency;
// a slot is released when the tab finishes loading or REOPEN_LOAD_TIMEOUT_MS passes.

import { REOPEN_LOAD_TIMEOUT_MS } from '../shared/constants';
import type { BulkResult } from '../shared/messages';
import type { OpJournal, RecordPatch, Settings, TabRecord } from '../shared/types';
import { getRecordsByIds, getSettings, putAction, putOp, putRecords, testHooks } from './db';
import { dbLock, Mutex } from './mutex';
import { errorText, isBoundIn, newAction, stateSnapshot } from './records';
import {
  addExpectedUrl,
  broadcast,
  markBusy,
  notifyTabLoad,
  recordsChanged,
  removeExpectedUrl,
  rt,
  unmarkBusy,
  waitForTabLoad,
} from './runtime';
import { getSession } from './session';
import { queryAllTabs } from './tracker';

export interface ReopenOptions {
  recordIds: string[];
  /** Activate the (first) reopened tab. */
  active?: boolean;
  windowId?: number;
  /** Write a 'reopen' action entry (default true; undo writes its own entry). */
  log?: boolean;
  reason?: string;
}

async function checkpoint(name: string): Promise<void> {
  const h = testHooks.checkpoint;
  if (h) await h(name);
}

/** Target window: the requested one if it still exists, else the last focused normal window, else a new one. */
export async function resolveWindow(windowId?: number): Promise<number> {
  if (typeof windowId === 'number') {
    try {
      const w = await chrome.windows.get(windowId);
      if (w && w.type === 'normal' && !w.incognito) return w.id!;
    } catch {
      /* gone */
    }
  }
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w && typeof w.id === 'number' && !w.incognito) return w.id;
  } catch {
    /* none */
  }
  const w = await chrome.windows.create({ focused: true });
  return w!.id!;
}

export async function reopenRecords(opts: ReopenOptions): Promise<BulkResult> {
  const result: BulkResult = { ok: true, done: [], skipped: [], failed: [] };
  const ids = [...new Set(opts.recordIds.filter((x) => typeof x === 'string' && x))];
  if (ids.length === 0) return result;
  const session = await getSession();
  const sid = session.sessionId;
  const toOpen: TabRecord[] = [];
  const focus: TabRecord[] = [];
  const opId = crypto.randomUUID();
  const held = new Set<string>();
  const release = (id: string) => {
    if (held.delete(id)) unmarkBusy([id]);
  };

  await dbLock.run(async () => {
    const recs = await getRecordsByIds(ids);
    const tabIds = new Set((await queryAllTabs()).map((t) => t.id!));
    for (const id of ids) {
      const rec = recs.get(id);
      if (!rec) {
        result.failed.push({ recordId: id, error: 'Registro inexistente' });
        continue;
      }
      if (rt.busyRecords.has(id) || rec.pendingClose) {
        result.skipped.push({ recordId: id, reason: 'Hay otra operación en curso sobre este registro' });
        continue;
      }
      if (isBoundIn(rec, sid) && tabIds.has(rec.live!.tabId)) focus.push(rec);
      else toOpen.push(rec);
    }
    markBusy(toOpen.map((r) => r.id));
    for (const r of toOpen) held.add(r.id);
    rt.runningOpIds.add(opId);
  });

  try {
    // Already open with a live tab: focus it instead of creating another.
    for (const rec of focus) result.done.push(rec.id);
    if (focus.length > 0 && ids.length === 1) {
      try {
        await chrome.tabs.update(focus[0]!.live!.tabId, { active: true });
        await chrome.windows.update(focus[0]!.live!.windowId, { focused: true });
      } catch {
        /* best effort */
      }
    }
    if (toOpen.length > 0) {
      let windowId: number;
      try {
        windowId = await resolveWindow(opts.windowId);
      } catch (e) {
        for (const r of toOpen) result.failed.push({ recordId: r.id, error: `No hay ventana disponible: ${errorText(e)}` });
        return finish(result);
      }
      const op: OpJournal = {
        id: opId,
        kind: 'reopen',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        auto: false,
        reason: opts.reason ?? 'Reabierta',
        windowId,
        sessionId: sid,
        items: toOpen.map((r) => ({ recordId: r.id, status: 'pending' as const })),
        finished: false,
        actionId: crypto.randomUUID(),
      };
      try {
        await putOp(op);
      } catch (e) {
        for (const r of toOpen) result.failed.push({ recordId: r.id, error: `No se pudo escribir el diario: ${errorText(e)}` });
        return finish(result);
      }
      const r2 = await executeReopenOp(op, { active: !!opts.active, log: opts.log !== false, release });
      result.done.push(...r2.done);
      result.skipped.push(...r2.skipped);
      result.failed.push(...r2.failed);
      if (r2.actionId) result.actionId = r2.actionId;
    }
  } finally {
    unmarkBusy([...held]);
    held.clear();
    rt.runningOpIds.delete(opId);
  }
  return finish(result);
}

function finish(r: BulkResult): BulkResult {
  r.ok = r.failed.length === 0 && r.done.length > 0;
  return r;
}

/** Binds a freshly created tab to the record (same id). Returns false if the record changed meanwhile. */
export async function bindTabToRecord(
  recordId: string,
  tab: chrome.tabs.Tab,
  sid: string,
  before?: Record<string, RecordPatch>,
): Promise<boolean> {
  return dbLock.run(async () => {
    const rec = (await getRecordsByIds([recordId])).get(recordId);
    if (!rec || rec.pendingClose) return false;
    if (isBoundIn(rec, sid) && rec.live!.tabId !== tab.id) {
      // Already bound to another live tab in this session (e.g. rebound meanwhile).
      try {
        await chrome.tabs.get(rec.live!.tabId);
        return false;
      } catch {
        /* that tab is gone: take over */
      }
    }
    const now = Date.now();
    if (before) before[recordId] = stateSnapshot(rec);
    rec.state = 'open';
    rec.live = { tabId: tab.id!, windowId: tab.windowId, sessionId: sid, boundAt: now };
    rec.reopenCount = (rec.reopenCount || 0) + 1;
    rec.reopenedAt = now;
    rec.lastAccessedAt = now; // so automation does not re-archive it right away
    rec.lastReason = 'Reabierta';
    delete rec.implicitCloseAt;
    await putRecords([rec]);
    return true;
  });
}

async function rebindTabId(recordId: string, oldId: number, newId: number): Promise<void> {
  await dbLock.run(async () => {
    const rec = (await getRecordsByIds([recordId])).get(recordId);
    if (!rec?.live || rec.live.tabId !== oldId) return;
    rec.live = { ...rec.live, tabId: newId };
    await putRecords([rec]);
  });
}

/** Puts the tab into a group titled like its origin group in the target window (best effort). */
async function regroup(tabId: number, windowId: number, title: string, color?: string): Promise<void> {
  try {
    if (!chrome.tabGroups?.query || !chrome.tabs.group) return;
    const groups = await chrome.tabGroups.query({ windowId });
    const g = groups.find((x) => x.title === title);
    if (g) {
      await chrome.tabs.group({ groupId: g.id, tabIds: [tabId] });
      return;
    }
    // groupId and createProperties cannot be combined.
    const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(gid, color ? { title, color: color as chrome.tabGroups.Color } : { title });
  } catch {
    /* ignore */
  }
}

/**
 * Runs the items of a reopen journal that still need a tab: 'pending' and
 * 'creating' without tabId (resume first binds those whose tab already exists).
 */
export async function executeReopenOp(
  op: OpJournal,
  o: { active: boolean; log: boolean; release?: (recordId: string) => void },
): Promise<BulkResult> {
  const result: BulkResult = { ok: true, done: [], skipped: [], failed: [] };
  const settings: Settings = await getSettings();
  const sid = (await getSession()).sessionId;
  const work = op.items.filter((i) => i.status === 'pending' || (i.status === 'creating' && i.tabId === undefined));
  const recs = await getRecordsByIds(work.map((i) => i.recordId));
  const concurrency = Math.max(1, settings.reopenConcurrency);
  const bulk = work.length > concurrency;
  const groupLock = new Mutex();
  const opLock = new Mutex();
  const before: Record<string, RecordPatch> = {};
  const persist = () => opLock.run(() => putOp(op)).catch(() => {});
  let next = 0;
  let first = true;

  const processOne = async (item: OpJournal['items'][number], rec: TabRecord, isFirst: boolean) => {
    item.status = 'creating';
    await persist();
    await checkpoint('reopen:afterCreating');
    addExpectedUrl(rec.url);
    let tab: chrome.tabs.Tab;
    try {
      const props: chrome.tabs.CreateProperties = { url: rec.url, active: o.active && isFirst };
      if (typeof op.windowId === 'number') props.windowId = op.windowId;
      tab = await chrome.tabs.create(props);
    } catch (e) {
      removeExpectedUrl(rec.url);
      item.status = 'failed';
      item.error = `No se pudo abrir: ${errorText(e)}`;
      result.failed.push({ recordId: rec.id, error: item.error });
      await persist();
      return;
    }
    const tabId = tab.id!;
    rt.expectedTabIds.add(tabId);
    const loaded = waitForTabLoad(tabId, REOPEN_LOAD_TIMEOUT_MS);
    await checkpoint('reopen:afterCreateBeforePersist');
    item.tabId = tabId;
    await persist();
    await checkpoint('reopen:afterCreate');
    let bound = false;
    try {
      bound = await bindTabToRecord(rec.id, tab, sid, before);
    } finally {
      removeExpectedUrl(rec.url);
      rt.expectedTabIds.delete(tabId);
    }
    if (!bound) {
      item.status = 'failed';
      item.error = 'El registro cambió durante la reapertura';
      result.failed.push({ recordId: rec.id, tabId, error: item.error });
      await persist();
      notifyTabLoad(tabId, 'complete');
      return;
    }
    item.status = 'done';
    result.done.push(rec.id);
    await persist();
    o.release?.(rec.id); // bound: the tracker may handle user events on it from now on
    recordsChanged([rec.id]);
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    if (cur && cur.status !== 'complete') await loaded;
    else notifyTabLoad(tabId, 'complete');
    if (settings.restoreGroups && rec.origin?.groupTitle && typeof op.windowId === 'number') {
      const title = rec.origin.groupTitle;
      await groupLock.run(() => regroup(tabId, cur?.windowId ?? op.windowId!, title, rec.origin.groupColor));
    }
    if (bulk && settings.discardAfterBulkReopen && !(o.active && isFirst)) {
      try {
        const d = await chrome.tabs.discard(tabId);
        if (d && typeof d.id === 'number' && d.id !== tabId) await rebindTabId(rec.id, tabId, d.id);
      } catch {
        /* active or already discarded: ignore */
      }
    }
  };

  const worker = async () => {
    while (next < work.length) {
      const item = work[next++]!;
      const isFirst = first;
      first = false;
      const rec = recs.get(item.recordId);
      if (!rec) {
        item.status = 'failed';
        item.error = 'Registro inexistente';
        result.failed.push({ recordId: item.recordId, error: item.error });
        continue;
      }
      try {
        await processOne(item, rec, isFirst);
      } catch (e) {
        item.status = 'failed';
        item.error = errorText(e);
        result.failed.push({ recordId: rec.id, error: item.error });
      } finally {
        o.release?.(rec.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));

  op.finished = true;
  await persist();
  if (o.log && result.done.length > 0) {
    try {
      await putAction(
        newAction('reopen', {
          id: op.actionId ?? crypto.randomUUID(),
          reason: op.reason,
          recordIds: [...result.done],
          before,
          undoable: false,
          ...(result.failed.length ? { failed: [...result.failed] } : {}),
        }),
      );
      result.actionId = op.actionId;
    } catch {
      /* not data loss */
    }
  }
  broadcast({ type: 'records' });
  broadcast({ type: 'actions' });
  broadcast({ type: 'status' });
  result.ok = result.failed.length === 0;
  return result;
}
