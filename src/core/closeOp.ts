// Safe close pipeline (archive / trash):
//   journal -> save record with pendingClose (strict, awaited) -> revalidate ->
//   chrome.tabs.remove in batches -> final state + action log entry.
// A tab is only ever closed after its record (with the exact URL) is committed.

import { CLOSE_BATCH_SIZE, WRITE_BATCH_SIZE } from '../shared/constants';
import type { BulkResult } from '../shared/messages';
import type { ActionEntry, OpJournal, RecordPatch, TabRecord } from '../shared/types';
import { getRecordsByIds, getRecordsByState, getSettings, putAction, putOp, putRecords, testHooks } from './db';
import { dbLock } from './mutex';
import { applyTabData, errorText, idleMinutesOf, isBoundIn, maxDefined, newAction, originOf, stateSnapshot, windowOrdinals } from './records';
import { blockReasons, describeBlocks, type RuleMode } from './rules';
import { broadcast, markBusy, recordsChanged, rt, unmarkBusy } from './runtime';
import { getSession } from './session';
import { flushNow, onTabCreated, queryAllTabs, queryGroups } from './tracker';
import { isTrackableUrl, tabUrl } from './url';

export interface CloseItem {
  recordId: string;
  /** Per-record reason (stored in lastReason). Defaults to the op reason. */
  reason?: string;
  /** Auto mode: the tab must still be idle at least this long right before closing. */
  minIdleMinutes?: number;
}

export interface CloseOptions {
  items: CloseItem[];
  targetState: 'archived' | 'trash';
  /** auto = every protection applies; manual/import = only protected (unless force) and unsafe pages. */
  mode: RuleMode;
  force?: boolean;
  reason: string;
  ruleId?: string;
  /** Write the action log entry (default true). */
  log?: boolean;
}

export const STATE_LABEL = { archived: 'archivada', trash: 'en la papelera', open: 'abierta' } as const;

async function checkpoint(name: string): Promise<void> {
  const h = testHooks.checkpoint;
  if (h) await h(name);
}

export function emptyResult(): BulkResult {
  return { ok: true, done: [], skipped: [], failed: [] };
}

function finalizeResult(r: BulkResult, requested: number): BulkResult {
  r.ok = r.failed.length === 0 && (r.done.length > 0 || requested === 0);
  return r;
}

interface Candidate {
  item: CloseItem;
  tabId: number;
  before: RecordPatch;
}

/** Modifies a record to its final closed state. */
function applyClosed(r: TabRecord, target: 'archived' | 'trash', reason: string, now: number): void {
  r.state = target;
  if (target === 'archived') r.archivedAt = now;
  else r.trashedAt = now;
  r.live = null;
  r.pendingClose = null;
  r.lastReason = reason;
  delete r.implicitCloseAt;
}

/** Clears our pendingClose markers (the tabs stay open). */
async function clearPending(opId: string, recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) return;
  await dbLock.run(async () => {
    const recs = await getRecordsByIds(recordIds);
    const list = [...recs.values()].filter((r) => r.pendingClose?.opId === opId);
    for (const r of list) r.pendingClose = null;
    await putRecords(list);
  });
}

export async function runCloseOp(opts: CloseOptions): Promise<BulkResult> {
  const result = emptyResult();
  const seen = new Set<string>();
  const items = opts.items.filter((i) => typeof i.recordId === 'string' && !seen.has(i.recordId) && seen.add(i.recordId));
  if (items.length === 0) return finalizeResult(result, 0);

  const session = await getSession();
  const sid = session.sessionId;
  const settings = await getSettings();
  const extId = chrome.runtime?.id;
  const target = opts.targetState;
  const kind = target === 'archived' ? 'archive' : 'trash';
  const opId = crypto.randomUUID();
  const actionId = crypto.randomUUID();
  const blockMode: RuleMode = opts.mode === 'auto' ? 'auto' : 'manual';
  const reasonOf = (it: CloseItem) => it.reason ?? opts.reason;

  const candidates: Candidate[] = [];
  const inPlace: { item: CloseItem; before: RecordPatch }[] = [];
  const unprotected: string[] = [];
  const busyIds: string[] = [];
  const held = new Set<string>();
  const release = (id: string) => {
    if (held.delete(id)) unmarkBusy([id]);
  };

  // ---- Phase A: classify (locked, so two ops never claim the same record)
  await dbLock.run(async () => {
    const now = Date.now();
    const recs = await getRecordsByIds(items.map((i) => i.recordId));
    const tabById = new Map((await queryAllTabs()).map((t) => [t.id!, t]));
    for (const item of items) {
      const rec = recs.get(item.recordId);
      if (!rec) {
        result.failed.push({ recordId: item.recordId, error: 'Registro inexistente' });
        continue;
      }
      if (rt.busyRecords.has(rec.id) || rec.pendingClose) {
        result.skipped.push({ recordId: rec.id, reason: 'Hay otra operación en curso sobre este registro' });
        continue;
      }
      if (rec.state === target) {
        result.skipped.push({ recordId: rec.id, reason: `Ya está ${STATE_LABEL[target]}` });
        continue;
      }
      const forcing = rec.protected && opts.force === true && opts.mode !== 'auto';
      if (rec.protected && !forcing) {
        result.skipped.push({ recordId: rec.id, reason: 'Protegida (requiere confirmación explícita)' });
        continue;
      }
      const before: RecordPatch = stateSnapshot(rec);
      if (forcing) before.protected = true;
      const tab = rec.live && isBoundIn(rec, sid) ? tabById.get(rec.live.tabId) : undefined;
      if (tab) {
        const view = forcing ? { ...rec, protected: false } : rec;
        const blocks = blockReasons(tab, view, settings, now, blockMode, { extensionId: extId });
        if (blocks.length > 0) {
          result.skipped.push({ recordId: rec.id, tabId: tab.id!, reason: `No se cierra: ${describeBlocks(blocks)}` });
          continue;
        }
        if (opts.mode === 'auto' && item.minIdleMinutes !== undefined && idleMinutesOf(rec, tab, now) < item.minIdleMinutes) {
          result.skipped.push({ recordId: rec.id, tabId: tab.id!, reason: 'Se consultó recientemente' });
          continue;
        }
        candidates.push({ item, tabId: tab.id!, before });
      } else {
        if (opts.mode === 'auto') {
          result.skipped.push({ recordId: rec.id, reason: 'Sin pestaña abierta' });
          continue;
        }
        inPlace.push({ item, before });
      }
      if (forcing) unprotected.push(rec.id);
      busyIds.push(rec.id);
    }
    markBusy(busyIds);
    for (const id of busyIds) held.add(id);
    rt.runningOpIds.add(opId);
  });

  const closedTabIds: number[] = [];
  try {
    // Forced action on protected records: unprotect first and log it.
    if (unprotected.length > 0) {
      await dbLock.run(async () => {
        const recs = await getRecordsByIds(unprotected);
        const list = [...recs.values()];
        for (const r of list) r.protected = false;
        await putRecords(list);
        await putAction(
          newAction('update', {
            reason: 'Desprotegida para cerrarla (acción forzada y confirmada)',
            recordIds: list.map((r) => r.id),
            before: Object.fromEntries(list.map((r) => [r.id, { protected: true }])),
            undoable: true,
          }),
        );
      });
    }

    let saved: Candidate[] = [];
    let op: OpJournal | null = null;
    if (candidates.length > 0) {
      // ---- Phase 1: journal
      op = {
        id: opId,
        kind: 'close',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        auto: opts.mode === 'auto',
        reason: opts.reason,
        targetState: target,
        sessionId: sid,
        items: candidates.map((c) => ({ recordId: c.item.recordId, tabId: c.tabId, status: 'pending' as const })),
        finished: false,
        actionId,
      };
      if (opts.ruleId) op.ruleId = opts.ruleId;
      try {
        await putOp(op);
      } catch (e) {
        for (const c of candidates) result.failed.push({ recordId: c.item.recordId, tabId: c.tabId, error: `No se pudo escribir el diario: ${errorText(e)}` });
        candidates.length = 0;
        op = null;
      }
    }
    if (op) {
      await checkpoint('close:afterJournal');
      // ---- Phase 2: save records with pendingClose (strict durability, awaited per batch)
      saved = await saveWithPendingClose(op, candidates, sid, target, reasonOf, result);
      try {
        await putOp(op);
      } catch {
        /* resume derives status from the records themselves */
      }
      await checkpoint('close:afterSave');
      // ---- Phase 3: revalidate right before closing
      const toClose = await revalidate(op, saved, settings, blockMode, extId, result);
      // Items that will not be closed are released right away (the tracker may handle them again).
      const closing = new Set(toClose.map((c) => c.item.recordId));
      for (const c of candidates) if (!closing.has(c.item.recordId)) release(c.item.recordId);
      // ---- Phase 4: close in batches
      const { closed, gone, failed } = await closeTabs(toClose.map((c) => c.tabId));
      for (const id of [...closed, ...gone]) closedTabIds.push(id);
      const failedIds = toClose.filter((c) => failed.has(c.tabId));
      for (const c of failedIds) result.failed.push({ recordId: c.item.recordId, tabId: c.tabId, error: failed.get(c.tabId)! });
      await clearPending(opId, failedIds.map((c) => c.item.recordId));
      for (const c of failedIds) release(c.item.recordId);
      saved = toClose.filter((c) => !failed.has(c.tabId));
      await checkpoint('close:afterRemove');
    }

    // ---- Phase 5: final state + action log
    await finalize(opts, op, saved, inPlace, reasonOf, result, actionId, kind);
  } finally {
    unmarkBusy([...held]);
    held.clear();
    rt.runningOpIds.delete(opId);
    // Keep "ours" a little longer: onRemoved may be delivered after tabs.remove resolves.
    setTimeout(() => {
      for (const id of closedTabIds) rt.closingTabIds.delete(id);
    }, 10000);
  }
  return finalizeResult(result, items.length);
}

function setItem(op: OpJournal, recordId: string, status: OpJournal['items'][number]['status'], error?: string): void {
  const it = op.items.find((i) => i.recordId === recordId);
  if (!it) return;
  it.status = status;
  if (error) it.error = error;
}

async function saveWithPendingClose(
  op: OpJournal,
  candidates: Candidate[],
  sid: string,
  target: 'archived' | 'trash',
  reasonOf: (it: CloseItem) => string,
  result: BulkResult,
): Promise<Candidate[]> {
  return dbLock.run(async () => {
    const now = Date.now();
    const tabs = await queryAllTabs();
    const tabById = new Map(tabs.map((t) => [t.id!, t]));
    const ordinals = windowOrdinals(tabs);
    const groups = await queryGroups();
    const recs = await getRecordsByIds(candidates.map((c) => c.item.recordId));
    const ready: { c: Candidate; rec: TabRecord }[] = [];
    for (const c of candidates) {
      const rec = recs.get(c.item.recordId);
      const tab = tabById.get(c.tabId);
      if (!rec || rec.state !== 'open' || rec.pendingClose || rec.live?.tabId !== c.tabId || rec.live.sessionId !== sid) {
        result.skipped.push({ recordId: c.item.recordId, tabId: c.tabId, reason: 'El registro cambió antes de guardarse' });
        setItem(op, c.item.recordId, 'skipped');
        continue;
      }
      const w = structuredClone(rec);
      let expectedUrl = rec.url;
      if (tab) {
        const url = tabUrl(tab);
        if (!isTrackableUrl(url)) {
          result.skipped.push({ recordId: rec.id, tabId: c.tabId, reason: 'La pestaña muestra una URL no rastreable' });
          setItem(op, rec.id, 'skipped');
          continue;
        }
        applyTabData(w, tab, { updateUrl: true });
        w.origin = originOf(tab, ordinals, groups);
        const la = maxDefined(w.lastAccessedAt, tab.lastAccessed);
        if (la !== undefined) w.lastAccessedAt = la;
        expectedUrl = url;
      }
      w.pendingClose = { opId: op.id, tabId: c.tabId, sessionId: sid, expectedUrl, targetState: target, reason: reasonOf(c.item), at: now };
      ready.push({ c, rec: w });
    }
    const saved: Candidate[] = [];
    for (let i = 0; i < ready.length; i += WRITE_BATCH_SIZE) {
      const batch = ready.slice(i, i + WRITE_BATCH_SIZE);
      try {
        await putRecords(batch.map((b) => b.rec));
        for (const b of batch) {
          saved.push(b.c);
          setItem(op, b.rec.id, 'saved');
        }
      } catch (e) {
        // The transaction did not commit: the record is unchanged and the tab is NOT touched.
        for (const b of batch) {
          const msg = `No se pudo guardar (la pestaña queda abierta): ${errorText(e)}`;
          result.failed.push({ recordId: b.rec.id, tabId: b.c.tabId, error: msg });
          setItem(op, b.rec.id, 'failed', msg);
        }
      }
    }
    return saved;
  });
}

async function revalidate(
  op: OpJournal,
  saved: Candidate[],
  settings: Awaited<ReturnType<typeof getSettings>>,
  mode: RuleMode,
  extId: string | undefined,
  result: BulkResult,
): Promise<Candidate[]> {
  if (saved.length === 0) return [];
  const now = Date.now();
  const tabById = new Map((await queryAllTabs()).map((t) => [t.id!, t]));
  const recs = await getRecordsByIds(saved.map((c) => c.item.recordId));
  const ok: Candidate[] = [];
  const clear: string[] = [];
  const skip = (c: Candidate, reason: string, clearIt = true) => {
    result.skipped.push({ recordId: c.item.recordId, tabId: c.tabId, reason });
    setItem(op, c.item.recordId, 'skipped');
    if (clearIt) clear.push(c.item.recordId);
  };
  for (const c of saved) {
    const rec = recs.get(c.item.recordId);
    const pc = rec?.pendingClose;
    if (!rec || !pc || pc.opId !== op.id) {
      skip(c, 'El registro cambió durante la operación', false);
      continue;
    }
    const tab = tabById.get(c.tabId);
    if (!tab) {
      ok.push(c); // already gone: the record is saved, finish it
      continue;
    }
    if (tabUrl(tab) !== pc.expectedUrl) {
      skip(c, 'La pestaña cambió de URL antes de cerrarse');
      continue;
    }
    const blocks = blockReasons(tab, rec, settings, now, mode, { extensionId: extId, ignoreOpId: op.id });
    if (blocks.length > 0) {
      skip(c, `No se cierra: ${describeBlocks(blocks)}`);
      continue;
    }
    if (mode === 'auto' && c.item.minIdleMinutes !== undefined && idleMinutesOf(rec, tab, now) < c.item.minIdleMinutes) {
      skip(c, 'Se consultó recientemente');
      continue;
    }
    ok.push(c);
  }
  await clearPending(op.id, clear);
  return ok;
}

/** chrome.tabs.remove in batches; never leaves the browser without a normal-window tab. */
export async function closeTabs(ids: number[]): Promise<{ closed: number[]; gone: number[]; failed: Map<number, string> }> {
  const closed: number[] = [];
  const gone: number[] = [];
  const failed = new Map<number, string>();
  for (let i = 0; i < ids.length; i += CLOSE_BATCH_SIZE) {
    const batch = ids.slice(i, i + CLOSE_BATCH_SIZE);
    const [all, normal] = await Promise.all([chrome.tabs.query({}), chrome.tabs.query({ windowType: 'normal' })]);
    const present = new Set(all.map((t) => t.id));
    const existing = batch.filter((id) => present.has(id));
    for (const id of batch) if (!present.has(id)) gone.push(id);
    if (existing.length === 0) continue;
    const set = new Set(existing);
    if (normal.length > 0 && normal.every((t) => set.has(t.id!))) {
      try {
        await chrome.tabs.create({ windowId: normal[0]!.windowId, active: true });
      } catch (e) {
        for (const id of existing) failed.set(id, `No se puede dejar el navegador sin pestañas: ${errorText(e)}`);
        continue;
      }
    }
    for (const id of existing) rt.closingTabIds.add(id);
    try {
      await chrome.tabs.remove(existing);
      closed.push(...existing);
    } catch {
      // Partial behavior is undocumented: re-query, finalize what is gone, retry the rest one by one.
      const still = new Set((await chrome.tabs.query({})).map((t) => t.id));
      for (const id of existing) {
        if (!still.has(id)) {
          closed.push(id);
          continue;
        }
        try {
          await chrome.tabs.remove(id);
          closed.push(id);
        } catch (e) {
          let exists = true;
          try {
            await chrome.tabs.get(id);
          } catch {
            exists = false;
          }
          if (exists) {
            failed.set(id, `No se pudo cerrar la pestaña: ${errorText(e)}`);
            rt.closingTabIds.delete(id);
          } else closed.push(id);
        }
      }
    }
  }
  return { closed, gone, failed };
}

async function finalize(
  opts: CloseOptions,
  op: OpJournal | null,
  saved: Candidate[],
  inPlace: { item: CloseItem; before: RecordPatch }[],
  reasonOf: (it: CloseItem) => string,
  result: BulkResult,
  actionId: string,
  kind: 'archive' | 'trash',
): Promise<void> {
  const target = opts.targetState;
  await dbLock.run(async () => {
    const now = Date.now();
    const recs = await getRecordsByIds([...saved.map((c) => c.item.recordId), ...inPlace.map((p) => p.item.recordId)]);
    const entries: { rec: TabRecord; before: RecordPatch; closedTab: boolean }[] = [];
    for (const c of saved) {
      const rec = recs.get(c.item.recordId);
      if (!rec || rec.pendingClose?.opId !== op?.id) {
        result.skipped.push({ recordId: c.item.recordId, tabId: c.tabId, reason: 'El registro cambió durante la operación' });
        if (op) setItem(op, c.item.recordId, 'skipped');
        continue;
      }
      applyClosed(rec, target, reasonOf(c.item), now);
      entries.push({ rec, before: c.before, closedTab: true });
    }
    for (const p of inPlace) {
      const rec = recs.get(p.item.recordId);
      if (!rec || rec.state === target || rec.pendingClose) {
        result.skipped.push({ recordId: p.item.recordId, reason: 'El registro cambió durante la operación' });
        continue;
      }
      applyClosed(rec, target, reasonOf(p.item), now);
      entries.push({ rec, before: p.before, closedTab: false });
    }
    const before: Record<string, RecordPatch> = {};
    for (let i = 0; i < entries.length; i += WRITE_BATCH_SIZE) {
      const batch = entries.slice(i, i + WRITE_BATCH_SIZE);
      try {
        await putRecords(batch.map((e) => e.rec));
        for (const e of batch) {
          result.done.push(e.rec.id);
          before[e.rec.id] = e.before;
          if (op && e.closedTab) setItem(op, e.rec.id, 'done');
        }
      } catch (err) {
        for (const e of batch) {
          // Closed tabs keep their pendingClose marker: resumeOps completes them later.
          const msg = e.closedTab
            ? `Pestaña cerrada; el guardado final quedó pendiente y se completará automáticamente (${errorText(err)})`
            : `No se pudo guardar: ${errorText(err)}`;
          result.failed.push({ recordId: e.rec.id, error: msg });
        }
      }
    }
    const pendingFinal = op ? op.items.some((i) => i.status === 'saved') : false;
    if (opts.log !== false && result.done.length > 0) {
      const action: ActionEntry = {
        id: actionId,
        at: now,
        kind,
        auto: opts.mode === 'auto',
        reason: opts.reason,
        recordIds: [...result.done],
        before,
        undoable: true,
      };
      if (opts.ruleId) action.ruleId = opts.ruleId;
      if (result.skipped.length > 0) action.skipped = [...result.skipped];
      if (result.failed.length > 0) action.failed = [...result.failed];
      try {
        await putAction(action);
        result.actionId = actionId;
      } catch {
        /* the records are already final; a missing log entry is not data loss */
      }
    }
    if (op) {
      op.finished = !pendingFinal;
      try {
        await putOp(op);
      } catch {
        /* resume will re-derive */
      }
    }
  });
  recordsChanged(result.done);
  broadcast({ type: 'actions' });
  broadcast({ type: 'status' });
}

/** Manual archive of a browser tab (popup button / keyboard command). */
export async function archiveTab(tabId: number, force = false, reason = 'Archivada manualmente'): Promise<BulkResult> {
  const refused = (r: string): BulkResult => ({ ok: false, done: [], skipped: [{ tabId, reason: r }], failed: [] });
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return refused('La pestaña no existe');
  }
  if (tab.incognito) return refused('Las pestañas de incógnito se ignoran');
  if (!isTrackableUrl(tabUrl(tab))) return refused('Esta página no se puede archivar (URL no rastreable)');
  onTabCreated(tab);
  await flushNow();
  const sid = (await getSession()).sessionId;
  const rec = (await getRecordsByState('open')).find((r) => r.live?.sessionId === sid && r.live.tabId === tabId);
  if (!rec) return refused('La pestaña todavía no tiene referencia guardada');
  return runCloseOp({ items: [{ recordId: rec.id }], targetState: 'archived', mode: 'manual', force, reason });
}
