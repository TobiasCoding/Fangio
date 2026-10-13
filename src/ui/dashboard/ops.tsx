// Record mutations used by the list, the drawer and other views. Each one sends
// a message to the background and reports the BulkResult as a toast.

import type { BulkResult, RecordEdit } from '../../shared/messages';
import type { RulePreview, TabRecord } from '../../shared/types';
import { errMsg, send } from '../common/api';
import { confirmDialog, toast } from '../common/feedback';
import { fmtNum, plural } from '../common/format';
import { reportBulk } from '../common/results';
import { recordsStore, titleOf } from './data';
import { needsBulkCloseConfirm, openRecordsOf } from './safety';
import { previewCounts } from './views/PreviewTable';

const REOPEN_CONFIRM_THRESHOLD = 20;

function fail(what: string, e: unknown) {
  toast(`${what}: ${errMsg(e)}`, { kind: 'error' });
}

function protectedSkipped(res: BulkResult): string[] {
  const byId = recordsStore.get().byId;
  const ids = new Set<string>();
  for (const s of res.skipped) {
    if (s.recordId && byId.get(s.recordId)?.protected) ids.add(s.recordId);
  }
  return [...ids];
}

/** Best effort: how many of these tabs are pinned / active / audible right now. */
async function liveTabFlags(tabIds: number[]): Promise<{ pinned: number; active: number; audible: number } | null> {
  try {
    const want = new Set(tabIds);
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && want.has(t.id));
    return {
      pinned: tabs.filter((t) => t.pinned).length,
      active: tabs.filter((t) => t.active).length,
      audible: tabs.filter((t) => t.audible).length,
    };
  } catch {
    return null;
  }
}

/** Bulk close of open records: states how many tabs will close (and how many are pinned/active/audible). */
async function confirmBulkClose(ids: string[], target: 'archive' | 'trash'): Promise<boolean> {
  const byId = recordsStore.get().byId;
  const open = openRecordsOf(ids, byId);
  if (!needsBulkCloseConfirm(open.length, target)) return true;
  const tabIds = open.map((id) => byId.get(id)?.live?.tabId).filter((t): t is number => typeof t === 'number');
  const flags = await liveTabFlags(tabIds);
  const special = flags
    ? [
        flags.pinned ? plural(flags.pinned, 'fijada', 'fijadas') : '',
        flags.active ? plural(flags.active, 'activa', 'activas') : '',
        flags.audible ? plural(flags.audible, 'con audio', 'con audio') : '',
      ].filter(Boolean)
    : [];
  const dest = target === 'archive' ? 'se archivan' : 'van a la papelera';
  return confirmDialog({
    title: `¿Cerrar ${plural(open.length, 'pestaña abierta', 'pestañas abiertas')}?`,
    body: (
      <>
        <p>
          Se cierran <strong>{plural(open.length, 'pestaña', 'pestañas')}</strong> y {dest}
          {ids.length > open.length ? ` (junto con ${plural(ids.length - open.length, 'referencia sin pestaña', 'referencias sin pestaña')})` : ''}.
        </p>
        {special.length > 0 && (
          <p>
            <strong>Atención:</strong> entre ellas hay {special.join(', ')}.
          </p>
        )}
        <p class="muted">Cada referencia se guarda antes de cerrar su pestaña. Podés deshacerlo desde Registro.</p>
      </>
    ),
    confirmLabel: target === 'archive' ? `Archivar ${fmtNum(ids.length)}` : `Enviar ${fmtNum(ids.length)} a la papelera`,
    danger: target === 'trash',
  });
}

/**
 * Archive or send to trash. Protected records are refused by the background; the toast offers forcing.
 * `confirm` (bulk selection): asks first when open tabs would be closed (5+, or any to the trash).
 * Returns null when cancelled or failed.
 */
export async function closeRecords(ids: string[], target: 'archive' | 'trash', opts: { confirm?: boolean } = {}): Promise<BulkResult | null> {
  if (!ids.length) return null;
  if (opts.confirm && !(await confirmBulkClose(ids, target))) return null;
  const verb = target === 'archive' ? 'Archivadas' : 'Enviadas a papelera';
  const forceLabel = target === 'archive' ? 'Desproteger y archivar' : 'Desproteger y enviar a papelera';
  try {
    const res = await send({ type: target, recordIds: ids });
    reportBulk(res, {
      verb,
      titleOf,
      protectedIds: protectedSkipped(res),
      forceLabel,
      onForce: async (forceIds) => {
        try {
          const r2 = await send({ type: target, recordIds: forceIds, force: true });
          reportBulk(r2, { verb, titleOf });
        } catch (e) {
          fail('No se pudo completar', e);
        }
      },
    });
    return res;
  } catch (e) {
    fail(target === 'archive' ? 'No se pudo archivar' : 'No se pudo enviar a la papelera', e);
    return null;
  }
}

/** Reopen records. One → active tab in this window; several → background tabs (confirm above 20). */
export async function reopenRecords(ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (ids.length > REOPEN_CONFIRM_THRESHOLD) {
    const ok = await confirmDialog({
      title: `¿Reabrir ${plural(ids.length, 'pestaña', 'pestañas')}?`,
      body: (
        <p>
          Se abren en segundo plano de a pocas a la vez (concurrencia limitada en Reglas), así que van a ir cargando
          progresivamente. Podés seguir usando el navegador mientras tanto.
        </p>
      ),
      confirmLabel: `Reabrir ${fmtNum(ids.length)}`,
    });
    if (!ok) return;
  }
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {
    windowId = undefined;
  }
  try {
    const single = ids.length === 1;
    const res = await send({ type: 'reopen', recordIds: ids, active: single, ...(windowId !== undefined ? { windowId } : {}) });
    reportBulk(res, { verb: 'Reabiertas', titleOf });
  } catch (e) {
    fail('No se pudo reabrir', e);
  }
}

/**
 * Before turning automation on: runs the rules preview and asks for confirmation
 * showing how many tabs would be archived / trashed right now.
 * Returns the preview when confirmed, null when cancelled (or the preview failed).
 */
export async function confirmEnableAutomation(): Promise<RulePreview | null> {
  let preview: RulePreview;
  try {
    preview = await send({ type: 'previewRules' });
  } catch (e) {
    fail('No se pudo calcular la previsualización', e);
    return null;
  }
  const n = previewCounts(preview);
  const ok = await confirmDialog({
    title: '¿Activar la automatización?',
    body: (
      <>
        <p>
          Si la activás ahora, en la próxima ejecución se archivarían <strong>{fmtNum(n.archive)}</strong> y se enviarían a la
          papelera <strong>{fmtNum(n.trash)}</strong> de {plural(preview.openCount, 'pestaña abierta', 'pestañas abiertas')}
          {preview.capped ? ' (limitado por el tope por ejecución)' : ''}.
        </p>
        <p class="muted">
          Las pestañas protegidas, fijadas, activas, con audio y de sitios excluidos nunca se cierran automáticamente. Todo queda en
          Registro y se puede deshacer.
        </p>
      </>
    ),
    confirmLabel: 'Activar',
  });
  return ok ? preview : null;
}

/** Focus the live tab of an open record. */
export async function focusTab(tabId: number, windowId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
  } catch {
    toast('La pestaña ya no existe. Probá «Reabrir».', { kind: 'warn' });
  }
}

export async function restoreRecords(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    reportBulk(await send({ type: 'restore', recordIds: ids }), { verb: 'Restauradas', titleOf });
  } catch (e) {
    fail('No se pudo restaurar', e);
  }
}

/** Permanent deletion (only records in trash). No confirmation: the trash already was the safety net. */
export async function purgeRecords(ids: string[]): Promise<boolean> {
  if (!ids.length) return false;
  try {
    const res = await send({ type: 'purge', recordIds: ids, confirm: 'ELIMINAR' });
    // Permanent: no "Deshacer" on the toast.
    reportBulk({ ...res, actionId: undefined }, { verb: 'Eliminadas definitivamente', titleOf });
    return true;
  } catch (e) {
    fail('No se pudo eliminar', e);
    return false;
  }
}

/**
 * Delete key / "Eliminar": records already in trash are deleted permanently, the rest go to the
 * trash (closing their tab if open). No confirmation; going to the trash can be undone.
 */
export async function deleteRecords(records: readonly TabRecord[]): Promise<void> {
  const purge = records.filter((r) => r.state === 'trash').map((r) => r.id);
  const trash = records.filter((r) => r.state !== 'trash').map((r) => r.id);
  await Promise.all([purgeRecords(purge), closeRecords(trash, 'trash')]);
}

export async function emptyTrash(count: number): Promise<void> {
  const ok = await confirmDialog({
    title: 'Vaciar papelera',
    body: (
      <p>
        Se eliminan definitivamente <strong>{plural(count, 'referencia', 'referencias')}</strong>. No se puede deshacer
        (sólo desde una copia JSON).
      </p>
    ),
    confirmLabel: 'Vaciar papelera',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await send({ type: 'emptyTrash', confirm: 'ELIMINAR' });
    reportBulk({ ...res, actionId: undefined }, { verb: 'Eliminadas definitivamente', titleOf });
  } catch (e) {
    fail('No se pudo vaciar la papelera', e);
  }
}

/** Edit records. `verb` labels the toast; quiet for single-record inline edits. */
export async function editRecords(ids: string[], edit: RecordEdit, verb = 'Actualizadas', quiet = false): Promise<boolean> {
  if (!ids.length) return false;
  try {
    const res = await send({ type: 'updateRecords', recordIds: ids, edit });
    if (quiet && !res.failed.length && !res.skipped.length) return true;
    reportBulk(res, { verb, titleOf });
    return res.failed.length === 0;
  } catch (e) {
    fail('No se pudo guardar', e);
    return false;
  }
}
