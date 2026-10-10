// Duplicates: references with the IDENTICAL url string (no normalization: query
// strings and fragments make URLs distinct). Nothing is merged automatically.

import { MAX_NOTE_LENGTH } from '../shared/constants';
import type { BulkResult } from '../shared/messages';
import type { RecordPatch, TabRecord } from '../shared/types';
import { getRecordsByIds, putAction, putRecords } from './db';
import { dbLock } from './mutex';
import { maxDefined, newAction, stateSnapshot } from './records';
import { broadcast, recordsChanged, rt } from './runtime';
import { normalizeTags } from './url';

/** Groups of >= 2 records with exactly the same url (any state), largest groups first. */
export function groupDuplicates(records: readonly TabRecord[]): { url: string; records: TabRecord[] }[] {
  const by = new Map<string, TabRecord[]>();
  for (const r of records) {
    const list = by.get(r.url);
    if (list) list.push(r);
    else by.set(r.url, [r]);
  }
  return [...by.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([url, list]) => ({ url, records: [...list].sort((a, b) => a.createdAt - b.createdAt) }))
    .sort((a, b) => b.records.length - a.records.length || a.url.localeCompare(b.url));
}

export interface MergePlan {
  keep: TabRecord;
  merged: TabRecord[];
  before: Record<string, RecordPatch>;
}

function minDefined(...xs: (number | undefined)[]): number | undefined {
  let m: number | undefined;
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x) && (m === undefined || x < m)) m = x;
  return m;
}

/**
 * Pure merge: keep gets the union of tags, concatenated notes, pending/protected OR,
 * earliest createdAt/openedAt, latest lastAccessedAt, mergedFrom; the others go to trash.
 * Throws (Spanish message) if a merged record is open.
 */
export function planMerge(keep: TabRecord, others: readonly TabRecord[], now: number): MergePlan {
  const list = others.filter((o) => o.id !== keep.id);
  if (list.length === 0) throw new Error('No hay registros para fusionar');
  const open = list.find((o) => o.state === 'open');
  if (open) throw new Error(`«${open.title}» está abierta: archívela antes de fusionarla`);
  const before: Record<string, RecordPatch> = {};
  const k = structuredClone(keep);
  before[k.id] = {
    tags: [...keep.tags],
    note: keep.note,
    pending: keep.pending,
    protected: keep.protected,
    project: keep.project,
    createdAt: keep.createdAt,
    openedAt: keep.openedAt,
    lastAccessedAt: keep.lastAccessedAt,
    mergedFrom: [...keep.mergedFrom],
  };
  k.tags = normalizeTags([...keep.tags, ...list.flatMap((o) => o.tags)]);
  const notes = [keep.note, ...list.map((o) => o.note)].map((n) => (n ?? '').trim()).filter(Boolean);
  k.note = [...new Set(notes)].join('\n\n').slice(0, MAX_NOTE_LENGTH);
  k.pending = keep.pending || list.some((o) => o.pending);
  k.protected = keep.protected || list.some((o) => o.protected);
  if (!k.project) k.project = list.find((o) => o.project)?.project ?? '';
  k.createdAt = minDefined(keep.createdAt, ...list.map((o) => o.createdAt)) ?? keep.createdAt;
  const opened = minDefined(keep.openedAt, ...list.map((o) => o.openedAt));
  if (opened !== undefined) k.openedAt = opened;
  const la = maxDefined(keep.lastAccessedAt, ...list.map((o) => o.lastAccessedAt));
  if (la !== undefined) k.lastAccessedAt = la;
  k.mergedFrom = [...new Set([...keep.mergedFrom, ...list.flatMap((o) => [o.id, ...o.mergedFrom])])].filter((id) => id !== k.id);
  const merged = list.map((o) => {
    before[o.id] = stateSnapshot(o);
    const m = structuredClone(o);
    m.state = 'trash';
    m.trashedAt = now;
    m.live = null;
    m.lastReason = `Fusionada en «${keep.title}»`;
    delete m.implicitCloseAt;
    return m;
  });
  return { keep: k, merged, before };
}

/** Applies a merge (one undoable 'merge' action). */
export async function mergeRecords(keepId: string, mergeIds: string[]): Promise<BulkResult> {
  const result: BulkResult = { ok: false, done: [], skipped: [], failed: [] };
  await dbLock.run(async () => {
    const ids = [...new Set(mergeIds)].filter((id) => id !== keepId);
    const recs = await getRecordsByIds([keepId, ...ids]);
    const keep = recs.get(keepId);
    if (!keep) throw new Error('El registro a conservar no existe');
    const others: TabRecord[] = [];
    for (const id of ids) {
      const r = recs.get(id);
      if (!r) result.failed.push({ recordId: id, error: 'Registro inexistente' });
      else if (rt.busyRecords.has(id) || r.pendingClose) result.skipped.push({ recordId: id, reason: 'Operación en curso' });
      else others.push(r);
    }
    const plan = planMerge(keep, others, Date.now());
    await putRecords([plan.keep, ...plan.merged]);
    const action = newAction('merge', {
      reason: `Fusionadas ${plan.merged.length} referencias duplicadas en «${keep.title}»`,
      recordIds: [plan.keep.id, ...plan.merged.map((m) => m.id)],
      before: plan.before,
      undoable: true,
    });
    await putAction(action);
    result.done.push(plan.keep.id, ...plan.merged.map((m) => m.id));
    result.actionId = action.id;
  });
  recordsChanged(result.done);
  broadcast({ type: 'actions' });
  result.ok = result.failed.length === 0 && result.done.length > 0;
  return result;
}
