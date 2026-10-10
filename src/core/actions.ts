// Record mutations that do not close tabs (edit, restore, purge), the action log
// maintenance and undo.

import { MAX_NOTE_LENGTH, MAX_TITLE_LENGTH } from '../shared/constants';
import type { BulkResult, RecordEdit } from '../shared/messages';
import type { ActionEntry, RecordPatch, TabRecord } from '../shared/types';
import {
  deleteRecords,
  getAction,
  getAllRecords,
  getRecordsByIds,
  getRecordsByState,
  getSettings,
  pruneActions,
  pruneOps,
  putAction,
  putRecords,
} from './db';
import { dbLock } from './mutex';
import { newAction, stateSnapshot } from './records';
import { reopenRecords } from './reopenOp';
import { broadcast, recordsChanged, rt } from './runtime';
import { normalizeTags } from './url';

const DAY = 86400000;
export const PURGE_CONFIRM = 'ELIMINAR';

function bulk(): BulkResult {
  return { ok: false, done: [], skipped: [], failed: [] };
}
function done(r: BulkResult): BulkResult {
  r.ok = r.failed.length === 0 && r.done.length > 0;
  return r;
}

function describeEdit(e: RecordEdit): string {
  const parts: string[] = [];
  if (e.protected !== undefined) parts.push(e.protected ? 'protegida' : 'desprotegida');
  if (e.pending !== undefined) parts.push(e.pending ? 'marcada como pendiente' : 'pendiente quitado');
  if (e.setTags || e.addTags || e.removeTags) parts.push('etiquetas');
  if (e.note !== undefined) parts.push('nota');
  if (e.project !== undefined) parts.push('proyecto');
  if (e.title !== undefined) parts.push('título');
  return parts.length ? `Edición: ${parts.join(', ')}` : 'Edición';
}

/** Pure: applies an edit to a record copy. Returns the patch with the previous values of what changed. */
export function applyEdit(r: TabRecord, e: RecordEdit): RecordPatch | null {
  const before: RecordPatch = {};
  let changed = false;
  if (typeof e.protected === 'boolean' && e.protected !== r.protected) {
    before.protected = r.protected;
    r.protected = e.protected;
    changed = true;
  }
  if (typeof e.pending === 'boolean' && e.pending !== r.pending) {
    before.pending = r.pending;
    r.pending = e.pending;
    changed = true;
  }
  if (e.setTags || e.addTags || e.removeTags) {
    let tags = e.setTags ? normalizeTags(e.setTags) : [...r.tags];
    if (e.addTags) tags = normalizeTags([...tags, ...e.addTags]);
    if (e.removeTags) {
      const rm = new Set(normalizeTags(e.removeTags));
      tags = tags.filter((t) => !rm.has(t));
    }
    if (tags.join('\u0000') !== r.tags.join('\u0000')) {
      before.tags = [...r.tags];
      r.tags = tags;
      changed = true;
    }
  }
  if (typeof e.note === 'string') {
    const note = e.note.slice(0, MAX_NOTE_LENGTH);
    if (note !== r.note) {
      before.note = r.note;
      r.note = note;
      changed = true;
    }
  }
  if (typeof e.project === 'string') {
    const p = e.project.trim().slice(0, 200);
    if (p !== r.project) {
      before.project = r.project;
      r.project = p;
      changed = true;
    }
  }
  if (typeof e.title === 'string' && e.title.trim()) {
    const t = e.title.trim().slice(0, MAX_TITLE_LENGTH);
    if (t !== r.title) {
      before.title = r.title;
      r.title = t;
      changed = true;
    }
  }
  return changed ? before : null;
}

export async function updateRecords(recordIds: string[], edit: RecordEdit): Promise<BulkResult> {
  const r = bulk();
  await dbLock.run(async () => {
    const recs = await getRecordsByIds(recordIds);
    const list: TabRecord[] = [];
    const before: Record<string, RecordPatch> = {};
    for (const id of new Set(recordIds)) {
      const rec = recs.get(id);
      if (!rec) {
        r.failed.push({ recordId: id, error: 'Registro inexistente' });
        continue;
      }
      const b = applyEdit(rec, edit);
      if (!b) {
        r.skipped.push({ recordId: id, reason: 'Sin cambios' });
        continue;
      }
      before[id] = b;
      list.push(rec);
    }
    await putRecords(list);
    r.done.push(...list.map((x) => x.id));
    if (list.length > 0) {
      const a = newAction('update', { reason: describeEdit(edit), recordIds: r.done.slice(), before, undoable: true });
      await putAction(a);
      r.actionId = a.id;
    }
  });
  if (r.done.length) {
    recordsChanged(r.done);
    broadcast({ type: 'actions' });
  }
  // "No changes" is still a success for the UI.
  r.ok = r.failed.length === 0;
  return r;
}

/** trash -> archived */
export async function restoreRecords(recordIds: string[]): Promise<BulkResult> {
  const r = bulk();
  await dbLock.run(async () => {
    const recs = await getRecordsByIds(recordIds);
    const list: TabRecord[] = [];
    const before: Record<string, RecordPatch> = {};
    const now = Date.now();
    for (const id of new Set(recordIds)) {
      const rec = recs.get(id);
      if (!rec) r.failed.push({ recordId: id, error: 'Registro inexistente' });
      else if (rec.state !== 'trash') r.skipped.push({ recordId: id, reason: 'No está en la papelera' });
      else {
        before[id] = stateSnapshot(rec);
        rec.state = 'archived';
        rec.archivedAt = now;
        rec.lastReason = 'Restaurada desde la papelera';
        delete rec.implicitCloseAt;
        list.push(rec);
      }
    }
    await putRecords(list);
    r.done.push(...list.map((x) => x.id));
    if (list.length) {
      const a = newAction('restore', { reason: 'Restaurada desde la papelera', recordIds: r.done.slice(), before, undoable: true });
      await putAction(a);
      r.actionId = a.id;
    }
  });
  recordsChanged(r.done);
  broadcast({ type: 'actions' });
  return done(r);
}

// ------------------------------------------------------------------ purge (permanent deletion, only from trash)

export async function purgeRecords(
  recordIds: string[],
  confirm: unknown,
  opts: { auto?: boolean; reason?: string } = {},
): Promise<BulkResult> {
  if (confirm !== PURGE_CONFIRM) throw new Error('Confirmación inválida: escriba ELIMINAR para borrar definitivamente');
  const r = bulk();
  await dbLock.run(async () => {
    const recs = await getRecordsByIds(recordIds);
    const ids: string[] = [];
    for (const id of new Set(recordIds)) {
      const rec = recs.get(id);
      if (!rec) r.skipped.push({ recordId: id, reason: 'Ya no existe' });
      else if (rec.state !== 'trash') r.skipped.push({ recordId: id, reason: 'Sólo se eliminan definitivamente registros de la papelera' });
      else if (rt.busyRecords.has(id) || rec.pendingClose) r.skipped.push({ recordId: id, reason: 'Operación en curso' });
      else ids.push(id);
    }
    await deleteRecords(ids);
    r.done.push(...ids);
    if (ids.length) {
      const a = newAction('purge', {
        auto: !!opts.auto,
        reason: opts.reason ?? `Eliminadas definitivamente ${ids.length} referencias de la papelera`,
        recordIds: ids,
        undoable: false,
      });
      await putAction(a);
      r.actionId = a.id;
    }
  });
  recordsChanged(r.done);
  broadcast({ type: 'actions' });
  broadcast({ type: 'status' });
  r.ok = r.failed.length === 0;
  return r;
}

export async function emptyTrash(confirm: unknown): Promise<BulkResult> {
  if (confirm !== PURGE_CONFIRM) throw new Error('Confirmación inválida: escriba ELIMINAR para vaciar la papelera');
  const ids = (await getRecordsByState('trash')).map((x) => x.id);
  return purgeRecords(ids, confirm, { reason: `Papelera vaciada: ${ids.length} referencias eliminadas definitivamente` });
}

/** Safety cap: permanent deletions per maintenance run (the rest waits for the next run). */
export const MAX_PURGE_PER_RUN = 500;
/** Tolerance before a trashedAt in the future is taken as "the clock went backwards". */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Maintenance: purge trash older than trashRetentionDays (0 = never).
 * Guards against clock jumps: if any trash record was trashed "in the future"
 * (the clock went backwards) nothing is purged this run; and never more than
 * MAX_PURGE_PER_RUN records (oldest first) are deleted per run.
 */
export async function purgeExpired(now = Date.now()): Promise<number> {
  const s = await getSettings();
  if (s.trashRetentionDays <= 0) return 0;
  const trash = await getRecordsByState('trash');
  const stamp = (x: TabRecord) => x.trashedAt ?? x.updatedAt;
  let maxSeen = -Infinity;
  for (const x of trash) maxSeen = Math.max(maxSeen, stamp(x));
  if (maxSeen > now + CLOCK_SKEW_TOLERANCE_MS) {
    console.warn('[fangio] purge skipped: the system clock seems to have gone backwards');
    return 0;
  }
  const cutoff = now - s.trashRetentionDays * DAY;
  const expired = trash.filter((x) => stamp(x) < cutoff).sort((a, b) => stamp(a) - stamp(b));
  if (expired.length === 0) return 0;
  const old = expired.slice(0, MAX_PURGE_PER_RUN).map((x) => x.id);
  const capped = expired.length > old.length;
  const res = await purgeRecords(old, PURGE_CONFIRM, {
    auto: true,
    reason:
      `Eliminación automática: más de ${s.trashRetentionDays} días en la papelera (${old.length} referencias)` +
      (capped ? `; tope de ${MAX_PURGE_PER_RUN} por ejecución, quedan ${expired.length - old.length} para la próxima` : ''),
  });
  return res.done.length;
}

/** Maintenance: prune the action log (logRetentionDays) and old finished ops. */
export async function pruneLog(now = Date.now()): Promise<number> {
  const s = await getSettings();
  const n = await pruneActions(now - s.logRetentionDays * DAY);
  await pruneOps(now - 7 * DAY);
  if (n) broadcast({ type: 'actions' });
  return n;
}

// ------------------------------------------------------------------ undo

const RESULT_STATE: Partial<Record<ActionEntry['kind'], TabRecord['state']>> = {
  archive: 'archived',
  trash: 'trash',
  'user-closed': 'trash',
  'window-closed': 'archived',
  restore: 'archived',
};
const STATE_FIELDS = new Set(['state', 'archivedAt', 'trashedAt', 'lastReason', 'implicitCloseAt']);

function applyPatch(rec: TabRecord, patch: RecordPatch, skip?: Set<string>): void {
  const target = rec as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (skip?.has(k)) continue;
    if (v === undefined) delete target[k];
    else target[k] = Array.isArray(v) ? [...v] : v;
  }
}

/**
 * Undo per ARCHITECTURE: archive/trash/user-closed/window-closed of formerly open
 * tabs -> reopen (same record ids); other actions -> restore fields from `before`.
 * Purge is never undoable. Writes an 'undo' entry and sets undoneAt.
 */
export async function undoAction(actionId: string): Promise<BulkResult> {
  const a = await getAction(actionId);
  if (!a) throw new Error('La acción ya no existe en el registro');
  if (a.kind === 'purge' || !a.undoable) throw new Error('Esta acción no se puede deshacer');
  if (a.undoneAt) throw new Error('Esta acción ya se deshizo');
  const r = bulk();
  const before = a.before ?? {};
  const resultState = RESULT_STATE[a.kind];
  const reopenIds: string[] = [];
  const restored: string[] = [];

  await dbLock.run(async () => {
    const recs = await getRecordsByIds(Object.keys(before));
    const list: TabRecord[] = [];
    for (const [id, patch] of Object.entries(before)) {
      const rec = recs.get(id);
      if (!rec) {
        r.skipped.push({ recordId: id, reason: 'El registro ya no existe' });
        continue;
      }
      if (rt.busyRecords.has(id) || rec.pendingClose) {
        r.skipped.push({ recordId: id, reason: 'Operación en curso' });
        continue;
      }
      const touchesState = patch.state !== undefined;
      const expected = a.kind === 'merge' ? (id === a.recordIds[0] ? undefined : 'trash') : resultState;
      if (touchesState && expected && rec.state !== expected) {
        r.skipped.push({ recordId: id, reason: 'Cambió de estado desde esa acción' });
        continue;
      }
      if (patch.state === 'open') {
        reopenIds.push(id);
        continue;
      }
      applyPatch(rec, patch);
      if (touchesState) rec.live = null;
      list.push(rec);
    }
    await putRecords(list);
    restored.push(...list.map((x) => x.id));
  });

  if (reopenIds.length > 0) {
    const res = await reopenRecords({ recordIds: reopenIds, log: false, reason: `Deshacer: ${a.reason}` });
    r.skipped.push(...res.skipped);
    r.failed.push(...res.failed);
    // Restore non-state fields (e.g. protection removed by a forced archive).
    const extra = res.done.filter((id) => Object.keys(before[id] ?? {}).some((k) => !STATE_FIELDS.has(k)));
    if (extra.length) {
      await dbLock.run(async () => {
        const recs = await getRecordsByIds(extra);
        const list = [...recs.values()];
        for (const rec of list) applyPatch(rec, before[rec.id]!, STATE_FIELDS);
        await putRecords(list);
      });
    }
    restored.push(...res.done);
  }
  r.done.push(...restored);
  if (r.done.length > 0) {
    const u = newAction('undo', {
      reason: `Deshacer: ${a.reason}`,
      recordIds: r.done.slice(),
      undoOf: a.id,
      undoable: false,
      ...(r.skipped.length ? { skipped: [...r.skipped] } : {}),
      ...(r.failed.length ? { failed: [...r.failed] } : {}),
    });
    await putAction(u);
    a.undoneAt = u.at;
    await putAction(a);
    r.actionId = u.id;
  }
  recordsChanged(r.done);
  broadcast({ type: 'actions' });
  broadcast({ type: 'status' });
  return done(r);
}

/** Counts used by getStatus. */
export async function statusCounts(): Promise<{ open: number; archived: number; trash: number; protected: number; pending: number; total: number }> {
  const all = await getAllRecords();
  const c = { open: 0, archived: 0, trash: 0, protected: 0, pending: 0, total: all.length };
  for (const x of all) {
    c[x.state]++;
    if (x.protected) c.protected++;
    if (x.pending) c.pending++;
  }
  return c;
}
