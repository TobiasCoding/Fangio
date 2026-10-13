// Implements every Request of src/shared/messages.ts. Throws Error(Spanish
// message) on invalid input; index.ts wraps the result into an Envelope.

import type { RecordEdit, Request, ResponseMap } from '../shared/messages';
import type { StatusInfo } from '../shared/types';
import { emptyTrash, purgeRecords, restoreRecords, statusCounts, undoAction, updateRecords } from '../core/actions';
import { previewRules, runAutomation, type LastAutoRun } from '../core/automation';
import { importJson } from '../core/backup';
import { archiveTab, runCloseOp } from '../core/closeOp';
import { getKv, getRecordsByState, getSettings } from '../core/db';
import { dedupeArchived, mergeRecords } from '../core/duplicates';
import { applyImport, getImportPreview } from '../core/importWizard';
import { reopenRecords } from '../core/reopenOp';
import { groupTabs } from '../core/tabGroups';
import { captureTab, clearThumbnails } from '../core/thumbs';
import { rt } from '../core/runtime';
import { getSession } from '../core/session';
import { markBackup, markOnboardingDone, saveSettings } from '../core/settingsOps';
import { flushNow, onTabCreated, reconcile } from '../core/tracker';
import { checkForUpdate, getStoredUpdate } from '../core/updateCheck';
import { isTrackableUrl, tabUrl } from '../core/url';

function ids(x: unknown, field = 'recordIds'): string[] {
  if (!Array.isArray(x)) throw new Error(`Solicitud inválida: falta ${field}`);
  const out = x.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200);
  return [...new Set(out)];
}
function int(x: unknown, field: string): number {
  if (typeof x !== 'number' || !Number.isInteger(x)) throw new Error(`Solicitud inválida: ${field}`);
  return x;
}
function edit(x: unknown): RecordEdit {
  if (!x || typeof x !== 'object') throw new Error('Solicitud inválida: edit');
  const e = x as Record<string, unknown>;
  const out: RecordEdit = {};
  if (typeof e.protected === 'boolean') out.protected = e.protected;
  if (typeof e.pending === 'boolean') out.pending = e.pending;
  for (const k of ['setTags', 'addTags', 'removeTags'] as const) if (Array.isArray(e[k])) out[k] = ids(e[k], k);
  for (const k of ['note', 'project', 'title'] as const) if (typeof e[k] === 'string') out[k] = e[k] as string;
  return out;
}

export async function getStatus(): Promise<StatusInfo> {
  const [counts, settings, last, update] = await Promise.all([
    statusCounts(),
    getSettings(),
    getKv<LastAutoRun>('lastAutoRun'),
    getStoredUpdate(),
  ]);
  const s: StatusInfo = {
    version: chrome.runtime.getManifest().version,
    counts,
    automationEnabled: settings.automationEnabled,
    runningOps: rt.runningOpIds.size,
    update,
    onboardingDone: settings.onboardingDone,
  };
  if (last) {
    s.lastAutoRunAt = last.at;
    s.lastAutoRunSummary = last.summary;
  }
  if (settings.lastBackupAt !== undefined) s.lastBackupAt = settings.lastBackupAt;
  return s;
}

async function getTabRecord(tabId: number): Promise<ResponseMap['getTabRecord']> {
  await flushNow();
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { tab: null, record: null };
  }
  const find = async () => {
    const sid = (await getSession()).sessionId;
    return (await getRecordsByState('open')).find((r) => r.live?.sessionId === sid && r.live.tabId === tabId) ?? null;
  };
  let record = await find();
  if (!record && tab && !tab.incognito && isTrackableUrl(tabUrl(tab))) {
    onTabCreated(tab);
    await flushNow();
    record = await find();
  }
  return { tab, record };
}

/** Runs the archived-duplicates rule after operations that add archived records. Never fails the operation. */
async function thenDedupe<T>(p: Promise<T>): Promise<T> {
  const out = await p;
  await dedupeArchived().catch((e) => console.warn('[fangio] dedupe failed', e));
  return out;
}

export async function handleRequest(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'getStatus':
      return getStatus();
    case 'getSettings':
      return getSettings();
    case 'saveSettings':
      return saveSettings(req.settings);
    case 'archive':
      return thenDedupe(runCloseOp({
        items: ids(req.recordIds).map((recordId) => ({ recordId })),
        targetState: 'archived',
        mode: 'manual',
        force: req.force === true,
        reason: typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim() : 'Archivada manualmente',
      }));
    case 'trash':
      return runCloseOp({
        items: ids(req.recordIds).map((recordId) => ({ recordId })),
        targetState: 'trash',
        mode: 'manual',
        force: req.force === true,
        reason: typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim() : 'Enviada a la papelera manualmente',
      });
    case 'archiveTab':
      return thenDedupe(archiveTab(int(req.tabId, 'tabId'), req.force === true));
    case 'reopen': {
      const o: Parameters<typeof reopenRecords>[0] = { recordIds: ids(req.recordIds), active: req.active === true };
      if (typeof req.windowId === 'number') o.windowId = req.windowId;
      return reopenRecords(o);
    }
    case 'restore':
      return restoreRecords(ids(req.recordIds));
    case 'purge':
      return purgeRecords(ids(req.recordIds), req.confirm);
    case 'emptyTrash':
      return emptyTrash(req.confirm);
    case 'updateRecords':
      return updateRecords(ids(req.recordIds), edit(req.edit));
    case 'merge':
      if (typeof req.keepId !== 'string') throw new Error('Solicitud inválida: keepId');
      return mergeRecords(req.keepId, ids(req.mergeIds, 'mergeIds'));
    case 'undo':
      if (typeof req.actionId !== 'string') throw new Error('Solicitud inválida: actionId');
      return undoAction(req.actionId);
    case 'previewRules':
      return previewRules();
    case 'runRulesNow':
      return thenDedupe(runAutomation('manual'));
    case 'getImportPreview':
      return getImportPreview();
    case 'applyImport':
      return thenDedupe(applyImport(ids(req.archiveIds, 'archiveIds'), ids(req.trashIds, 'trashIds'), ids(req.protectIds, 'protectIds')));
    case 'skipOnboarding':
      await markOnboardingDone();
      return { ok: true };
    case 'importJson':
      return thenDedupe(importJson(req.data));
    case 'markBackup':
      await markBackup();
      return { ok: true };
    case 'getTabRecord':
      return getTabRecord(int(req.tabId, 'tabId'));
    case 'reconcileNow': {
      const r = await reconcile();
      return { ok: true, summary: r.summary };
    }
    case 'checkUpdate':
      return checkForUpdate({ force: true });
    case 'reloadExtension':
      setTimeout(() => chrome.runtime.reload(), 150);
      return { ok: true };
    case 'captureTab':
      return captureTab(int(req.tabId, 'tabId'), { viaActiveTab: true });
    case 'groupTabs':
      return groupTabs(ids(req.recordIds), typeof req.title === 'string' ? req.title : '', typeof req.color === 'string' ? req.color : undefined);
    case 'clearThumbs':
      return { deleted: await clearThumbnails() };
    default:
      throw new Error(`Solicitud desconocida: ${String((req as { type?: unknown }).type)}`);
  }
}
