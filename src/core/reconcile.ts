// Reconciliation between browser tabs and records. planReconcile() is pure; the
// tracker (event flush) and the full reconcile() share it, so the rebind order
// is implemented exactly once:
//   1. open record with the same live.tabId and the same URL (extension reload)
//   2. record with pendingClose for the same URL (interrupted close; tab survived)
//   3. open record without a valid binding and the same exact URL (nearest origin)
//   4. record implicitly closed within REBIND_WINDOW_MS with the same URL (Ctrl+Shift+T)
//   4b. during the startup grace only: record closed by one of our ops shortly before this
//       session started (the browser restored a tab we had just closed: crash/kill)
//   5. otherwise a new record

import { REBIND_WINDOW_MS, RESTORED_AFTER_CLOSE_WINDOW_MS, STARTUP_GRACE_MS } from '../shared/constants';
import type { RecordPatch, RecordSource, TabRecord } from '../shared/types';
import { applyTabData, newRecordFromTab, originOf, stateSnapshot, windowOrdinals, type GroupMap } from './records';
import { isExtensionPage, isTrackableUrl, tabUrl } from './url';

export const WINDOW_CLOSED_REASON = 'No encontrada (ventana cerrada o sesión no restaurada)';

export interface ReconcileInput {
  tabs: readonly chrome.tabs.Tab[];
  /** Candidate records: at least every 'open' record plus implicitly closed ones with the URLs of unbound tabs. */
  records: readonly TabRecord[];
  sessionId: string;
  now: number;
  startupAt: number;
  groups?: GroupMap | undefined;
  /** Limit binding / creation / field updates to these tabs (tracker flush). Undefined = all tabs. */
  onlyTabIds?: ReadonlySet<number> | undefined;
  /** Tabs a reopen op is about to bind: never bound or created here. */
  skipTabIds?: ReadonlySet<number> | undefined;
  skipUrls?: ReadonlySet<string> | undefined;
  /** Records touched by running ops: left alone. */
  busyRecordIds?: ReadonlySet<string> | undefined;
  /** Ops still running or awaiting resume: their pendingClose markers are left alone. */
  activeOpIds?: ReadonlySet<string> | undefined;
  /** Archive (window-closed) open records without a tab once the startup grace is over. */
  archiveMissing?: boolean;
  /** Finish or abort pendingClose markers whose op is not active. */
  resolveOrphans?: boolean;
  /** Source of new records; undefined = never create. */
  createSource?: RecordSource | undefined;
  extensionId?: string | undefined;
}

export interface ReconcilePlan {
  /** New versions of every modified or created record. */
  changed: Map<string, TabRecord>;
  created: string[];
  bound: { recordId: string; tabId: number; rule: 1 | 2 | 3 | 4 }[];
  /** Rule 4 rebinds (logged as 'rebind'). */
  rebinds: { recordId: string; before: RecordPatch }[];
  /** Open records without tab -> archived (logged as 'window-closed'). */
  windowClosed: { recordId: string; before: RecordPatch }[];
  /** pendingClose cleared because the tab still exists. */
  orphanAborted: string[];
  /** pendingClose completed because the tab is gone. */
  orphanCompleted: { recordId: string; before: RecordPatch; targetState: 'archived' | 'trash'; reason: string }[];
  /** Open records without tab kept because of the startup grace. */
  deferred: number;
  /** Unbound tabs skipped on purpose (expected opens, URL with an active pendingClose). */
  skippedTabs: number;
}

function nearestScore(rec: TabRecord, ord: number | undefined, index: number): number {
  const o = rec.origin ?? {};
  const dw = o.windowOrdinal !== undefined && ord !== undefined ? Math.abs(o.windowOrdinal - ord) : 50;
  const di = o.index !== undefined ? Math.abs(o.index - index) : 5000;
  return dw * 100000 + di;
}

export function emptyPlan(): ReconcilePlan {
  return {
    changed: new Map(),
    created: [],
    bound: [],
    rebinds: [],
    windowClosed: [],
    orphanAborted: [],
    orphanCompleted: [],
    deferred: 0,
    skippedTabs: 0,
  };
}

export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const { sessionId, now } = input;
  const plan = emptyPlan();
  const busy = input.busyRecordIds ?? new Set<string>();
  const activeOps = input.activeOpIds ?? new Set<string>();
  const inScope = (tabId: number) => !input.onlyTabIds || input.onlyTabIds.has(tabId);

  const tabs = input.tabs.filter((t) => typeof t.id === 'number' && !t.incognito);
  const tabById = new Map(tabs.map((t) => [t.id!, t]));
  const ordinals = windowOrdinals(tabs);

  // Working copies (clone on first edit).
  const cur = new Map<string, TabRecord>();
  for (const r of input.records) if (!cur.has(r.id)) cur.set(r.id, r);
  const edit = (id: string): TabRecord => {
    let r = plan.changed.get(id);
    if (!r) {
      r = structuredClone(cur.get(id)!);
      plan.changed.set(id, r);
      cur.set(id, r);
    }
    return r;
  };
  const isActivePending = (r: TabRecord) => !!r.pendingClose && activeOps.has(r.pendingClose.opId);

  // ---- 0. claim tabs already bound in this session
  const claimedTab = new Map<number, string>(); // tabId -> recordId
  const usedRecord = new Set<string>();
  for (const r of [...cur.values()]) {
    if (r.state !== 'open' || !r.live || r.live.sessionId !== sessionId) continue;
    const tab = tabById.get(r.live.tabId);
    if (!tab || claimedTab.has(tab.id!)) continue;
    claimedTab.set(tab.id!, r.id);
    usedRecord.add(r.id);
    if (busy.has(r.id) || isActivePending(r)) continue;
    if (r.pendingClose) {
      // Orphan marker and the tab is still here: never close blindly -> abort.
      if (input.resolveOrphans) {
        edit(r.id).pendingClose = null;
        plan.orphanAborted.push(r.id);
      }
      continue;
    }
    if (inScope(tab.id!)) {
      const w = structuredClone(r);
      if (applyTabData(w, tab, { updateUrl: isTrackableUrl(tabUrl(tab)) })) {
        plan.changed.set(r.id, w);
        cur.set(r.id, w);
      }
    }
  }

  // ---- unbound tabs in scope
  const urlsWithActivePending = new Set<string>();
  for (const r of cur.values()) {
    if (r.pendingClose && (isActivePending(r) || busy.has(r.id))) urlsWithActivePending.add(r.pendingClose.expectedUrl);
  }
  const unbound: chrome.tabs.Tab[] = [];
  for (const t of tabs) {
    if (claimedTab.has(t.id!) || !inScope(t.id!)) continue;
    const url = tabUrl(t);
    if (!isTrackableUrl(url) || isExtensionPage(url, input.extensionId)) continue;
    if (input.skipTabIds?.has(t.id!) || input.skipUrls?.has(url)) {
      plan.skippedTabs++;
      continue;
    }
    unbound.push(t);
  }

  const byUrl = new Map<string, TabRecord[]>();
  for (const r of cur.values()) {
    const list = byUrl.get(r.url);
    if (list) list.push(r);
    else byUrl.set(r.url, [r]);
  }
  const eligible = (r: TabRecord) => !usedRecord.has(r.id) && !busy.has(r.id) && !isActivePending(r);
  const bind = (r: TabRecord, tab: chrome.tabs.Tab, rule: 1 | 2 | 3 | 4) => {
    const before = stateSnapshot(r);
    const w = edit(r.id);
    if (rule === 4) plan.rebinds.push({ recordId: r.id, before });
    if (rule === 2) plan.orphanAborted.push(r.id);
    w.state = 'open';
    w.pendingClose = null;
    w.live = { tabId: tab.id!, windowId: tab.windowId, sessionId, boundAt: now };
    w.origin = originOf(tab, ordinals, input.groups);
    if (rule === 4) {
      delete w.implicitCloseAt;
      w.lastReason = 'Volvió a abrirse (re-vinculada)';
    }
    applyTabData(w, tab, { updateUrl: false });
    usedRecord.add(r.id);
    claimedTab.set(tab.id!, r.id);
    plan.bound.push({ recordId: r.id, tabId: tab.id!, rule });
  };
  const boundToLiveTab = (r: TabRecord) =>
    !!r.live && r.live.sessionId === sessionId && claimedTab.get(r.live.tabId) === r.id;

  // ---- rule 1: same tab id + same URL from a previous session (extension reload)
  for (const tab of unbound) {
    const r = (byUrl.get(tabUrl(tab)) ?? []).find(
      (x) => eligible(x) && x.state === 'open' && !x.pendingClose && !!x.live && x.live.tabId === tab.id && x.live.sessionId !== sessionId,
    );
    if (r) bind(r, tab, 1);
  }
  // ---- rule 2: interrupted close whose tab survived
  for (const tab of unbound) {
    if (claimedTab.has(tab.id!)) continue;
    const url = tabUrl(tab);
    const cands = [...cur.values()].filter((r) => r.pendingClose?.expectedUrl === url && eligible(r));
    if (cands.length === 0) continue;
    cands.sort((a, b) => Number(b.pendingClose!.tabId === tab.id) - Number(a.pendingClose!.tabId === tab.id));
    bind(cands[0]!, tab, 2);
  }
  // ---- rule 3: open record without a valid binding, same URL, nearest origin
  for (const tab of unbound) {
    if (claimedTab.has(tab.id!)) continue;
    const ord = ordinals.get(tab.windowId);
    let best: TabRecord | undefined;
    let bestScore = Infinity;
    for (const r of byUrl.get(tabUrl(tab)) ?? []) {
      if (r.state !== 'open' || r.pendingClose || !eligible(r) || boundToLiveTab(r)) continue;
      const s = nearestScore(r, ord, tab.index);
      if (s < bestScore) {
        best = r;
        bestScore = s;
      }
    }
    if (best) bind(best, tab, 3);
  }
  // ---- rule 4: implicitly closed recently (Ctrl+Shift+T, window restore)
  for (const tab of unbound) {
    if (claimedTab.has(tab.id!)) continue;
    const cands = (byUrl.get(tabUrl(tab)) ?? []).filter(
      (r) =>
        r.state !== 'open' &&
        !r.pendingClose &&
        eligible(r) &&
        typeof r.implicitCloseAt === 'number' &&
        now - r.implicitCloseAt <= REBIND_WINDOW_MS,
    );
    if (cands.length === 0) continue;
    cands.sort((a, b) => b.implicitCloseAt! - a.implicitCloseAt!);
    bind(cands[0]!, tab, 4);
  }
  // ---- rule 4b: the browser restored a tab we had closed right before it stopped (crash or
  // kill shortly after a mass archive: the session file still had the tab). Reuse the record
  // instead of creating a duplicate. Only inside the startup grace of a new session and only
  // for records closed shortly BEFORE that session started (never for closes in this session).
  if (now - input.startupAt < STARTUP_GRACE_MS) {
    const closedAt = (r: TabRecord) => (r.state === 'archived' ? r.archivedAt : r.state === 'trash' ? r.trashedAt : undefined);
    for (const tab of unbound) {
      if (claimedTab.has(tab.id!)) continue;
      const cands = (byUrl.get(tabUrl(tab)) ?? []).filter((r) => {
        const at = closedAt(r);
        return (
          !r.pendingClose &&
          eligible(r) &&
          r.implicitCloseAt === undefined &&
          typeof at === 'number' &&
          at < input.startupAt &&
          input.startupAt - at <= RESTORED_AFTER_CLOSE_WINDOW_MS
        );
      });
      if (cands.length === 0) continue;
      cands.sort((a, b) => closedAt(b)! - closedAt(a)!);
      bind(cands[0]!, tab, 4);
      plan.changed.get(cands[0]!.id)!.lastReason = 'El navegador restauró la pestaña tras el cierre (re-vinculada)';
    }
  }
  // ---- rule 5: new record
  for (const tab of unbound) {
    if (claimedTab.has(tab.id!)) continue;
    const url = tabUrl(tab);
    if (urlsWithActivePending.has(url)) {
      // A running close op may still own this URL: decide on the next pass.
      plan.skippedTabs++;
      continue;
    }
    if (!input.createSource) continue;
    const rec = newRecordFromTab(tab, {
      now,
      sessionId,
      startupAt: input.startupAt,
      source: input.createSource,
      ordinals,
      groups: input.groups,
    });
    plan.changed.set(rec.id, rec);
    cur.set(rec.id, rec);
    plan.created.push(rec.id);
    claimedTab.set(tab.id!, rec.id);
    usedRecord.add(rec.id);
  }

  const inGrace = now - input.startupAt < STARTUP_GRACE_MS;

  // ---- orphan pendingClose markers (op finished/lost without resolving them)
  if (input.resolveOrphans) {
    for (const r of [...cur.values()]) {
      const pc = r.pendingClose;
      if (!pc || busy.has(r.id) || activeOps.has(pc.opId) || usedRecord.has(r.id)) continue;
      let tabStillThere: boolean;
      if (pc.sessionId === sessionId) tabStillThere = tabById.has(pc.tabId);
      else tabStillThere = tabs.some((t) => tabUrl(t) === pc.expectedUrl);
      if (tabStillThere) {
        edit(r.id).pendingClose = null;
        plan.orphanAborted.push(r.id);
        continue;
      }
      if (pc.sessionId !== sessionId && inGrace) {
        plan.deferred++;
        continue;
      }
      const before = stateSnapshot(r);
      const w = edit(r.id);
      w.state = pc.targetState;
      if (pc.targetState === 'archived') w.archivedAt = now;
      else w.trashedAt = now;
      w.live = null;
      w.pendingClose = null;
      w.lastReason = pc.reason;
      delete w.implicitCloseAt;
      usedRecord.add(r.id);
      plan.orphanCompleted.push({ recordId: r.id, before, targetState: pc.targetState, reason: pc.reason });
    }
  }

  // ---- open records without a tab -> archived (never trash, never deleted)
  if (input.archiveMissing) {
    for (const r of [...cur.values()]) {
      if (r.state !== 'open' || r.pendingClose || busy.has(r.id) || boundToLiveTab(r)) continue;
      if (plan.created.includes(r.id)) continue;
      if (inGrace) {
        plan.deferred++;
        continue;
      }
      const before = stateSnapshot(r);
      const w = edit(r.id);
      w.state = 'archived';
      w.archivedAt = now;
      w.live = null;
      w.implicitCloseAt = now;
      w.lastReason = WINDOW_CLOSED_REASON;
      plan.windowClosed.push({ recordId: r.id, before });
    }
  }
  return plan;
}
