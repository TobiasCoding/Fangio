// Resumes operations interrupted by the death of the service worker.
// Close ops:
//   - item without our pendingClose on the record -> skipped (or done if already final)
//   - pendingClose and the tab is still there (same URL) -> ABORT (clear marker, stay open)
//   - pendingClose and the tab is gone -> complete to targetState
//   - other session and a tab with that URL exists -> abort (rebind will bind it)
//   - other session, no such tab, inside startup grace -> defer
// Reopen ops:
//   - 'creating' with a tab that exists -> bind; 'creating' without tab -> bind an
//     unbound tab with the same URL, else create it (once); 'pending' -> continue in the
//     same session, skipped after a browser restart.

import { STARTUP_GRACE_MS } from '../shared/constants';
import type { ActionEntry, OpJournal, RecordPatch, TabRecord } from '../shared/types';
import { getAction, getOps, getRecordsByIds, getRecordsByState, putAction, putOp, putRecords } from './db';
import { dbLock } from './mutex';
import { newAction } from './records';
import { bindTabToRecord, executeReopenOp } from './reopenOp';
import { broadcast, markBusy, recordsChanged, rt, unmarkBusy } from './runtime';
import { getSession, type SessionInfo } from './session';
import { queryAllTabs } from './tracker';
import { tabUrl } from './url';

export interface ResumeSummary {
  closeOps: number;
  reopenOps: number;
  aborted: number;
  completed: number;
  deferred: number;
  /** Background continuation of reopen ops (not awaited by init). */
  continuation: Promise<void> | null;
}

const FINAL = new Set(['done', 'skipped', 'failed']);

export async function resumeOps(): Promise<ResumeSummary> {
  const summary: ResumeSummary = { closeOps: 0, reopenOps: 0, aborted: 0, completed: 0, deferred: 0, continuation: null };
  const session = await getSession();
  const ops = (await getOps({ unfinishedOnly: true })).filter((o) => !rt.runningOpIds.has(o.id));
  const continuations: (() => Promise<void>)[] = [];
  for (const op of ops) {
    try {
      if (op.kind === 'close') {
        summary.closeOps++;
        await dbLock.run(() => resumeClose(op, session, summary));
      } else {
        summary.reopenOps++;
        const cont = await resumeReopen(op, session, summary);
        if (cont) continuations.push(cont);
      }
    } catch (e) {
      console.warn('[fangio] resume failed for op', op.id, e);
    }
  }
  if (continuations.length > 0) {
    summary.continuation = (async () => {
      for (const c of continuations) await c().catch(() => {});
    })();
  }
  if (summary.aborted || summary.completed) {
    recordsChanged();
    broadcast({ type: 'actions' });
  }
  return summary;
}

async function resumeClose(op: OpJournal, session: SessionInfo, summary: ResumeSummary): Promise<void> {
  const sid = session.sessionId;
  const now = Date.now();
  const inGrace = now - session.startupAt < STARTUP_GRACE_MS;
  const tabs = await queryAllTabs();
  const tabById = new Map(tabs.map((t) => [t.id!, t]));
  const recs = await getRecordsByIds(op.items.map((i) => i.recordId));
  const toWrite: TabRecord[] = [];
  const before: Record<string, RecordPatch> = {};
  const completed: string[] = [];
  let deferred = false;
  const target = op.targetState ?? 'archived';
  for (const item of op.items) {
    if (FINAL.has(item.status)) continue;
    const rec = recs.get(item.recordId);
    if (!rec) {
      item.status = 'failed';
      item.error = 'Registro inexistente';
      continue;
    }
    const pc = rec.pendingClose;
    if (!pc || pc.opId !== op.id) {
      // Nothing of ours on the record: either never saved (tab untouched) or already final.
      item.status = rec.state === target && item.status === 'saved' ? 'done' : 'skipped';
      continue;
    }
    const sameSession = pc.sessionId === sid;
    const tab = tabById.get(pc.tabId);
    const tabStill = !!tab && (sameSession || tabUrl(tab) === pc.expectedUrl);
    const urlElsewhere = !sameSession && tabs.some((t) => tabUrl(t) === pc.expectedUrl);
    if (tabStill || urlElsewhere) {
      // Never close blindly after an interruption: abort, the tab stays open.
      rec.pendingClose = null;
      toWrite.push(rec);
      item.status = 'skipped';
      item.error = 'Interrumpida: la pestaña sigue abierta';
      summary.aborted++;
      continue;
    }
    if (!sameSession && inGrace) {
      deferred = true;
      summary.deferred++;
      continue;
    }
    before[rec.id] = { state: 'open', lastReason: rec.lastReason, archivedAt: rec.archivedAt, trashedAt: rec.trashedAt };
    rec.state = pc.targetState;
    if (pc.targetState === 'archived') rec.archivedAt = now;
    else rec.trashedAt = now;
    rec.live = null;
    rec.pendingClose = null;
    rec.lastReason = pc.reason;
    delete rec.implicitCloseAt;
    toWrite.push(rec);
    item.status = 'done';
    completed.push(rec.id);
    summary.completed++;
  }
  await putRecords(toWrite);
  if (completed.length > 0) {
    const existing = op.actionId ? await getAction(op.actionId) : undefined;
    const entry: ActionEntry = newAction(target === 'archived' ? 'archive' : 'trash', {
      auto: op.auto,
      reason: `${op.reason} (completada tras una interrupción)`,
      recordIds: completed,
      before,
      undoable: true,
    });
    if (op.actionId && !existing) entry.id = op.actionId;
    if (op.ruleId) entry.ruleId = op.ruleId;
    await putAction(entry);
  }
  if (deferred) rt.deferredOpIds.add(op.id);
  else rt.deferredOpIds.delete(op.id);
  op.finished = !deferred;
  await putOp(op);
}

async function resumeReopen(
  op: OpJournal,
  session: SessionInfo,
  summary: ResumeSummary,
): Promise<(() => Promise<void>) | null> {
  const sid = session.sessionId;
  const sameSession = op.sessionId === sid;
  const inGrace = Date.now() - session.startupAt < STARTUP_GRACE_MS;
  const tabs = await queryAllTabs();
  const tabById = new Map(tabs.map((t) => [t.id!, t]));
  const boundTabIds = new Set(
    (await getRecordsByState('open')).filter((r) => r.live && r.live.sessionId === sid).map((r) => r.live!.tabId),
  );
  const recs = await getRecordsByIds(op.items.map((i) => i.recordId));
  const used = new Set<number>();
  const unboundWithUrl = (url: string) =>
    tabs.find((t) => !boundTabIds.has(t.id!) && !used.has(t.id!) && tabUrl(t) === url);
  let deferred = false;
  const done: string[] = [];

  for (const item of op.items) {
    if (FINAL.has(item.status)) continue;
    const rec = recs.get(item.recordId);
    if (!rec) {
      item.status = 'failed';
      item.error = 'Registro inexistente';
      continue;
    }
    if (item.status === 'pending') {
      if (!sameSession) {
        item.status = 'skipped';
        item.error = 'Reapertura interrumpida por un reinicio del navegador';
      }
      continue; // same session: the continuation creates it
    }
    // status 'creating'
    let tab: chrome.tabs.Tab | undefined;
    if (sameSession && typeof item.tabId === 'number') {
      tab = tabById.get(item.tabId);
      if (tab && boundTabIds.has(tab.id!) && !(!!rec.live && rec.live.tabId === tab.id && rec.live.sessionId === sid)) tab = undefined;
    }
    if (!tab) tab = unboundWithUrl(rec.url);
    if (rec.state === 'open' && rec.live?.sessionId === sid && tabById.has(rec.live.tabId)) {
      item.status = 'done'; // already bound to a live tab
      done.push(rec.id);
      continue;
    }
    if (tab) {
      used.add(tab.id!);
      const ok = await bindTabToRecord(rec.id, tab, sid);
      item.tabId = tab.id!;
      item.status = ok ? 'done' : 'failed';
      if (ok) done.push(rec.id);
      else item.error = 'El registro cambió durante la reapertura';
      continue;
    }
    if (sameSession && typeof item.tabId === 'number') {
      // Our tab was created and has been closed since: never create a second one.
      item.status = 'skipped';
      item.error = 'La pestaña reabierta se cerró antes de vincularse';
      continue;
    }
    if (!sameSession && inGrace) {
      deferred = true;
      summary.deferred++;
      continue;
    }
    delete item.tabId; // create it in the continuation
  }

  const needsCreate = op.items.filter((i) => i.status === 'pending' || (i.status === 'creating' && i.tabId === undefined));
  if (deferred) {
    rt.deferredOpIds.add(op.id);
    await putOp(op);
    return null;
  }
  rt.deferredOpIds.delete(op.id);
  if (needsCreate.length === 0) {
    op.finished = true;
    await putOp(op);
    if (done.length > 0) {
      await putAction(newAction('reopen', { reason: `${op.reason} (completada tras una interrupción)`, recordIds: done, undoable: false }));
    }
    return null;
  }
  await putOp(op);
  // Claim now so tracker / reconcile leave these records alone until the continuation runs.
  const held = new Set(needsCreate.map((i) => i.recordId));
  markBusy(held);
  rt.runningOpIds.add(op.id);
  const release = (id: string) => {
    if (held.delete(id)) unmarkBusy([id]);
  };
  return async () => {
    try {
      await executeReopenOp(op, { active: false, log: true, release });
    } finally {
      unmarkBusy([...held]);
      held.clear();
      rt.runningOpIds.delete(op.id);
    }
  };
}
