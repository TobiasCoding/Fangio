// UI <-> background message protocol. UI pages READ IndexedDB directly (same
// extension origin) but every MUTATION goes through the service worker with
// chrome.runtime.sendMessage, so tab side effects and the action log stay in
// one place. The background broadcasts changes on BroadcastChannel CHANGES_CHANNEL.

import type {
  ImportCandidate,
  ImportJsonResult,
  RulePreview,
  Settings,
  StatusInfo,
  TabRecord,
} from './types';

export const CHANGES_CHANNEL = 'fangio-changes';

export type ChangeEvent =
  | { type: 'records'; ids?: string[] } // ids omitted = many/unknown, reload all
  | { type: 'settings' }
  | { type: 'actions' }
  | { type: 'ops' }
  | { type: 'status' }
  | { type: 'thumbs'; ids: string[] };

/** Fields the user can edit on a record. Tag ops are applied in order: setTags, addTags, removeTags. */
export interface RecordEdit {
  protected?: boolean;
  pending?: boolean;
  setTags?: string[];
  addTags?: string[];
  removeTags?: string[];
  note?: string;
  project?: string;
  title?: string;
}

/** Result of a bulk operation that may partially succeed. */
export interface BulkResult {
  ok: boolean;
  /** Record ids that reached the requested state. */
  done: string[];
  skipped: { recordId?: string; tabId?: number; reason: string }[];
  failed: { recordId?: string; tabId?: number; error: string }[];
  actionId?: string;
}

export type Request =
  | { type: 'getStatus' }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: Settings }
  /** Close open records (or archive-in-place records with no tab) into 'archived'. force=false refuses protected records. */
  | { type: 'archive'; recordIds: string[]; reason?: string; force?: boolean }
  /** Same pipeline but the final state is 'trash'. Archived records just change state. */
  | { type: 'trash'; recordIds: string[]; reason?: string; force?: boolean }
  /** Archive the tab the popup was opened for / the active tab of the last focused window. */
  | { type: 'archiveTab'; tabId: number; force?: boolean }
  | { type: 'reopen'; recordIds: string[]; active?: boolean; windowId?: number }
  /** trash -> archived */
  | { type: 'restore'; recordIds: string[] }
  /** Permanent deletion. Only records in trash. confirm must be the string 'ELIMINAR'. */
  | { type: 'purge'; recordIds: string[]; confirm: 'ELIMINAR' }
  | { type: 'emptyTrash'; confirm: 'ELIMINAR' }
  | { type: 'updateRecords'; recordIds: string[]; edit: RecordEdit }
  | { type: 'merge'; keepId: string; mergeIds: string[] }
  | { type: 'undo'; actionId: string }
  | { type: 'previewRules' }
  | { type: 'runRulesNow' }
  | { type: 'getImportPreview' }
  /** Initial import: protect some, archive some, trash some. Marks onboardingDone. */
  | { type: 'applyImport'; archiveIds: string[]; trashIds: string[]; protectIds: string[] }
  | { type: 'skipOnboarding' }
  | { type: 'importJson'; data: unknown }
  | { type: 'markBackup' }
  | { type: 'getTabRecord'; tabId: number }
  | { type: 'reconcileNow' }
  | { type: 'checkUpdate' }
  | { type: 'reloadExtension' }
  /** Capture a thumbnail of this (visible) tab now, e.g. when the popup opens (activeTab grant). */
  | { type: 'captureTab'; tabId: number }
  /** Put the open tabs of these records into a Chrome tab group per window (title, optional color). */
  | { type: 'groupTabs'; recordIds: string[]; title: string; color?: string }
  /** Delete every stored thumbnail. */
  | { type: 'clearThumbs' };

export interface ResponseMap {
  getStatus: StatusInfo;
  getSettings: Settings;
  saveSettings: Settings;
  archive: BulkResult;
  trash: BulkResult;
  archiveTab: BulkResult;
  reopen: BulkResult;
  restore: BulkResult;
  purge: BulkResult;
  emptyTrash: BulkResult;
  updateRecords: BulkResult;
  merge: BulkResult;
  undo: BulkResult;
  previewRules: RulePreview;
  runRulesNow: BulkResult;
  getImportPreview: ImportCandidate[];
  applyImport: BulkResult;
  skipOnboarding: { ok: true };
  importJson: ImportJsonResult;
  markBackup: { ok: true };
  getTabRecord: { tab: chrome.tabs.Tab | null; record: TabRecord | null };
  reconcileNow: { ok: true; summary: string };
  checkUpdate: StatusInfo['update'];
  reloadExtension: { ok: true };
  captureTab: { captured: boolean; reason?: string };
  groupTabs: { grouped: number; windows: number; skipped: number };
  clearThumbs: { deleted: number };
}

/** Envelope returned by the background for every request. */
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export type RequestOf<K extends Request['type']> = Extract<Request, { type: K }>;
