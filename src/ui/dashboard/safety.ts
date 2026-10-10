// Pure decision helpers for the dashboard's safety prompts (no DOM, no chrome.*),
// shared by the views and covered by unit tests.

import type { ActionEntry, DecisionAction, ImportCandidate, TabRecord } from '../../shared/types';

// ------------------------------------------------------------------ import wizard

/**
 * A blocked candidate (protected, pinned, active, highlighted, audible, recent audio,
 * excluded site, ...) is never closed by the wizard: it is locked to "keep".
 */
export function isImportBlocked(c: Pick<ImportCandidate, 'blockedBy'>): boolean {
  return c.blockedBy.length > 0;
}

export function initialImportChoice(c: Pick<ImportCandidate, 'blockedBy' | 'protected' | 'suggested'>): DecisionAction {
  return c.protected || isImportBlocked(c) ? 'keep' : c.suggested;
}

/** Sets `action` on `ids`, skipping protected and blocked rows. */
export function setImportChoices(
  prev: Readonly<Record<string, DecisionAction>>,
  ids: readonly string[],
  action: DecisionAction,
  locked: (id: string) => boolean,
): Record<string, DecisionAction> {
  const next = { ...prev };
  for (const id of ids) if (!locked(id)) next[id] = action;
  return next;
}

/** Archive <-> keep for every unlocked row (trash untouched). */
export function invertImportChoices(
  prev: Readonly<Record<string, DecisionAction>>,
  ids: readonly string[],
  locked: (id: string) => boolean,
): Record<string, DecisionAction> {
  const next = { ...prev };
  for (const id of ids) {
    if (locked(id)) continue;
    if (next[id] === 'archive') next[id] = 'keep';
    else if (next[id] === 'keep') next[id] = 'archive';
  }
  return next;
}

/** What applyImport receives. Blocked rows are never archived nor trashed; protection is allowed on any row. */
export function buildImportLists(
  cands: readonly ImportCandidate[],
  choice: Readonly<Record<string, DecisionAction>>,
  protect: ReadonlySet<string>,
): { archiveIds: string[]; trashIds: string[]; protectIds: string[]; blocked: number } {
  const archiveIds: string[] = [];
  const trashIds: string[] = [];
  let blocked = 0;
  for (const c of cands) {
    if (isImportBlocked(c)) {
      blocked++;
      continue;
    }
    if (protect.has(c.recordId)) continue;
    const a = choice[c.recordId];
    if (a === 'archive') archiveIds.push(c.recordId);
    else if (a === 'trash') trashIds.push(c.recordId);
  }
  return { archiveIds, trashIds, protectIds: cands.filter((c) => protect.has(c.recordId)).map((c) => c.recordId), blocked };
}

// ------------------------------------------------------------------ bulk close from the list

export const BULK_CLOSE_CONFIRM_THRESHOLD = 5;

/** Open records in a selection (their tabs would be closed). */
export function openRecordsOf(ids: readonly string[], byId: ReadonlyMap<string, Pick<TabRecord, 'state'>>): string[] {
  return ids.filter((id) => byId.get(id)?.state === 'open');
}

/** Confirm when 5+ tabs would close, or when any open tab would go to the trash. */
export function needsBulkCloseConfirm(openCount: number, target: 'archive' | 'trash'): boolean {
  if (openCount <= 0) return false;
  return openCount >= BULK_CLOSE_CONFIRM_THRESHOLD || target === 'trash';
}

// ------------------------------------------------------------------ undo

export const UNDO_REOPEN_CONFIRM = 20;
const CLOSING_KINDS = new Set<ActionEntry['kind']>(['archive', 'trash', 'user-closed', 'window-closed']);

/** Tabs an undo would reopen: records whose `before.state` was open (any kind). */
export function undoReopenCount(a: Pick<ActionEntry, 'kind' | 'before' | 'recordIds'>): number {
  if (a.before) return Object.values(a.before).filter((p) => p.state === 'open').length;
  return CLOSING_KINDS.has(a.kind) ? a.recordIds.length : 0;
}

export function needsUndoConfirm(a: Pick<ActionEntry, 'kind' | 'before' | 'recordIds'>): boolean {
  return undoReopenCount(a) > UNDO_REOPEN_CONFIRM;
}

// ------------------------------------------------------------------ automation

/**
 * automationEnabled to save: the draft's value only if the user toggled it in this
 * draft; otherwise whatever is stored now (never resurrect a stale value).
 */
export function resolveAutomationEnabled(draft: boolean, loadedWith: boolean, stored: boolean): boolean {
  return draft !== loadedWith ? draft : stored;
}
