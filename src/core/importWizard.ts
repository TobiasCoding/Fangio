// Initial import wizard: preview of every open tab with a suggested action, and
// the application of the user's choices through the safe close pipeline.

import type { BulkResult } from '../shared/messages';
import type { ImportCandidate, TabRecord } from '../shared/types';
import { markOnboardingDone } from './settingsOps';
import { getRecordsByState, getSettings } from './db';
import { updateRecords } from './actions';
import { runCloseOp } from './closeOp';
import { idleMinutesOf, windowOrdinals } from './records';
import { blockReasons, describeBlocks, matchUrlRule, ruleLabel } from './rules';
import { getSession } from './session';
import { queryAllTabs, queryGroups, reconcile } from './tracker';
import { isTrackableUrl, tabUrl } from './url';

export async function getImportPreview(): Promise<ImportCandidate[]> {
  await reconcile();
  const [session, settings, tabs, open, groups] = await Promise.all([
    getSession(),
    getSettings(),
    queryAllTabs(),
    getRecordsByState('open'),
    queryGroups(),
  ]);
  const now = Date.now();
  const byTab = new Map<number, TabRecord>();
  for (const r of open) if (r.live?.sessionId === session.sessionId) byTab.set(r.live.tabId, r);
  const ordinals = windowOrdinals(tabs);
  const urlCount = new Map<string, number>();
  for (const t of tabs) {
    const u = tabUrl(t);
    if (isTrackableUrl(u)) urlCount.set(u, (urlCount.get(u) ?? 0) + 1);
  }
  const extId = chrome.runtime?.id;
  const out: ImportCandidate[] = [];
  for (const tab of tabs) {
    const rec = byTab.get(tab.id!);
    if (!rec) continue;
    const url = tabUrl(tab) || rec.url;
    const blocked = blockReasons(tab, rec, settings, now, 'import', { extensionId: extId });
    const rule = matchUrlRule(url, settings.urlRules);
    let suggested: ImportCandidate['suggested'];
    let reason: string;
    const dup = urlCount.get(url) ?? 1;
    if (blocked.length > 0) {
      suggested = 'keep';
      reason = `Se mantiene: ${describeBlocks(blocked)}`;
    } else if (rule) {
      suggested = rule.action;
      reason = `Coincide con la regla «${ruleLabel(rule)}»`;
    } else {
      suggested = 'archive';
      const idle = idleMinutesOf(rec, tab, now);
      reason = dup > 1 ? `Archivar (hay ${dup} pestañas con esta misma URL)` : `Archivar (sin consultar hace ${Math.floor(idle / 60)} h)`;
    }
    const g = typeof tab.groupId === 'number' && tab.groupId >= 0 ? groups.get(tab.groupId) : undefined;
    const c: ImportCandidate = {
      recordId: rec.id,
      tabId: tab.id!,
      windowOrdinal: ordinals.get(tab.windowId) ?? 1,
      index: tab.index,
      url,
      title: tab.title || rec.title,
      domain: rec.domain,
      pinned: !!tab.pinned,
      active: !!tab.active,
      audible: !!tab.audible,
      discarded: !!tab.discarded,
      protected: rec.protected,
      duplicateCount: dup,
      suggested,
      blockedBy: blocked,
      reason,
    };
    if (rec.favIconUrl) c.favIconUrl = rec.favIconUrl;
    if (g?.title) c.groupTitle = g.title;
    const la = rec.lastAccessedAt ?? tab.lastAccessed;
    if (typeof la === 'number') c.lastAccessedAt = la;
    out.push(c);
  }
  out.sort((a, b) => a.windowOrdinal - b.windowOrdinal || a.index - b.index);
  return out;
}

function mergeResults(parts: BulkResult[]): BulkResult {
  const r: BulkResult = { ok: true, done: [], skipped: [], failed: [] };
  for (const p of parts) {
    r.done.push(...p.done);
    r.skipped.push(...p.skipped);
    r.failed.push(...p.failed);
    if (p.actionId) r.actionId = p.actionId;
  }
  r.ok = r.failed.length === 0;
  return r;
}

/** Protect some, archive some, trash some (protection wins over the other lists). Marks onboardingDone. */
export async function applyImport(archiveIds: string[], trashIds: string[], protectIds: string[]): Promise<BulkResult> {
  const protect = new Set(protectIds);
  const archive = [...new Set(archiveIds)].filter((id) => !protect.has(id));
  const archiveSet = new Set(archive);
  const trash = [...new Set(trashIds)].filter((id) => !protect.has(id) && !archiveSet.has(id));
  const parts: BulkResult[] = [];
  if (protect.size > 0) parts.push(await updateRecords([...protect], { protected: true }));
  if (archive.length > 0) {
    parts.push(
      await runCloseOp({
        items: archive.map((recordId) => ({ recordId })),
        targetState: 'archived',
        mode: 'import',
        reason: 'Importación inicial: archivada',
      }),
    );
  }
  if (trash.length > 0) {
    parts.push(
      await runCloseOp({
        items: trash.map((recordId) => ({ recordId })),
        targetState: 'trash',
        mode: 'import',
        reason: 'Importación inicial: enviada a la papelera',
      }),
    );
  }
  await markOnboardingDone();
  return mergeResults(parts);
}
