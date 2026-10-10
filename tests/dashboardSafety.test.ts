// Pure helpers behind the dashboard's safety prompts (H1 import locks, M2 bulk
// close confirmation, M3 automationEnabled resolution, L7 undo confirmation).
import { describe, expect, it } from 'vitest';
import type { ActionEntry, ImportCandidate } from '../src/shared/types';
import {
  buildImportLists,
  initialImportChoice,
  invertImportChoices,
  needsBulkCloseConfirm,
  needsUndoConfirm,
  openRecordsOf,
  resolveAutomationEnabled,
  setImportChoices,
  undoReopenCount,
} from '../src/ui/dashboard/safety';

function cand(id: string, p: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    recordId: id,
    tabId: 1,
    windowOrdinal: 1,
    index: 0,
    url: `https://${id}.example/`,
    title: id,
    domain: `${id}.example`,
    pinned: false,
    active: false,
    audible: false,
    discarded: false,
    protected: false,
    duplicateCount: 1,
    suggested: 'archive',
    blockedBy: [],
    reason: '',
    ...p,
  };
}

describe('H1: import wizard choices', () => {
  const cands = [
    cand('plain'),
    cand('active', { active: true, suggested: 'keep', blockedBy: ['active'] }),
    cand('pinned', { pinned: true, suggested: 'keep', blockedBy: ['pinned'] }),
    cand('rule', { suggested: 'trash' }),
  ];
  const blocked = new Set(['active', 'pinned']);
  const locked = (id: string) => blocked.has(id);

  it('blocked rows start as keep and bulk helpers never change them', () => {
    const init = Object.fromEntries(cands.map((c) => [c.recordId, initialImportChoice(c)]));
    expect(init).toEqual({ plain: 'archive', active: 'keep', pinned: 'keep', rule: 'trash' });
    const all = cands.map((c) => c.recordId);
    const trashAll = setImportChoices(init, all, 'trash', locked);
    expect(trashAll.active).toBe('keep');
    expect(trashAll.pinned).toBe('keep');
    expect(trashAll.plain).toBe('trash');
    const inv = invertImportChoices(init, all, locked);
    expect(inv.active).toBe('keep');
    expect(inv.plain).toBe('keep');
  });

  it('applyImport lists never include blocked rows, even with a forged choice; protection allowed anywhere', () => {
    const choice = { plain: 'archive', active: 'archive', pinned: 'trash', rule: 'trash' } as const;
    const lists = buildImportLists(cands, choice, new Set(['active']));
    expect(lists.archiveIds).toEqual(['plain']);
    expect(lists.trashIds).toEqual(['rule']);
    expect(lists.protectIds).toEqual(['active']);
    expect(lists.blocked).toBe(2);
  });
});

describe('M2: bulk close confirmation', () => {
  it('confirms for 5+ open tabs or any trash of open tabs; never for closed-only selections', () => {
    const byId = new Map([
      ['a', { state: 'open' as const }],
      ['b', { state: 'archived' as const }],
    ]);
    expect(openRecordsOf(['a', 'b', 'x'], byId)).toEqual(['a']);
    expect(needsBulkCloseConfirm(0, 'trash')).toBe(false);
    expect(needsBulkCloseConfirm(1, 'archive')).toBe(false);
    expect(needsBulkCloseConfirm(4, 'archive')).toBe(false);
    expect(needsBulkCloseConfirm(5, 'archive')).toBe(true);
    expect(needsBulkCloseConfirm(1, 'trash')).toBe(true);
  });
});

describe('M3: automationEnabled is not resurrected from a stale draft', () => {
  it('uses the stored value unless toggled in the draft', () => {
    expect(resolveAutomationEnabled(true, true, false)).toBe(false); // disabled elsewhere meanwhile
    expect(resolveAutomationEnabled(true, false, false)).toBe(true); // user toggled on here
    expect(resolveAutomationEnabled(false, true, true)).toBe(false); // user toggled off here
    expect(resolveAutomationEnabled(false, false, true)).toBe(true); // enabled elsewhere meanwhile
  });
});

describe('L7: undo confirmation for any kind', () => {
  const entry = (kind: ActionEntry['kind'], openBefore: number, extra = 0): Pick<ActionEntry, 'kind' | 'before' | 'recordIds'> => {
    const before: ActionEntry['before'] = {};
    for (let i = 0; i < openBefore; i++) before[`o${i}`] = { state: 'open' };
    for (let i = 0; i < extra; i++) before[`x${i}`] = { state: 'archived' };
    return { kind, before, recordIds: Object.keys(before) };
  };
  it('counts records that were open before, regardless of kind', () => {
    expect(needsUndoConfirm(entry('window-closed', 21))).toBe(true);
    expect(needsUndoConfirm(entry('user-closed', 25))).toBe(true);
    expect(needsUndoConfirm(entry('archive', 20, 50))).toBe(false);
    expect(undoReopenCount(entry('merge', 3, 2))).toBe(3);
    expect(undoReopenCount({ kind: 'window-closed', recordIds: Array.from({ length: 30 }, (_, i) => `r${i}`) })).toBe(30);
    expect(undoReopenCount({ kind: 'update', recordIds: ['a'] })).toBe(0);
  });
});
