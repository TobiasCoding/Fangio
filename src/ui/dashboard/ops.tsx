// Record mutations used by the list, the drawer and other views. Each one sends
// a message to the background and reports the BulkResult as a toast.

import type { BulkResult, RecordEdit } from '../../shared/messages';
import { errMsg, send } from '../common/api';
import { confirmDialog, toast } from '../common/feedback';
import { fmtNum, plural } from '../common/format';
import { reportBulk } from '../common/results';
import { recordsStore, titleOf } from './data';

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

/** Archive or send to trash. Protected records are refused by the background; the toast offers forcing. */
export async function closeRecords(ids: string[], target: 'archive' | 'trash'): Promise<BulkResult | null> {
  if (!ids.length) return null;
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

export async function purgeRecords(ids: string[]): Promise<boolean> {
  if (!ids.length) return false;
  const ok = await confirmDialog({
    title: `Eliminar definitivamente ${plural(ids.length, 'referencia', 'referencias')}`,
    body: (
      <p>
        Esto <strong>no se puede deshacer</strong> (sólo se recupera desde una copia JSON). Las referencias desaparecen de la
        base de datos.
      </p>
    ),
    confirmLabel: 'Eliminar definitivamente',
    danger: true,
    requireText: 'ELIMINAR',
  });
  if (!ok) return false;
  try {
    reportBulk(await send({ type: 'purge', recordIds: ids, confirm: 'ELIMINAR' }), { verb: 'Eliminadas', titleOf });
    return true;
  } catch (e) {
    fail('No se pudo eliminar', e);
    return false;
  }
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
    requireText: 'ELIMINAR',
  });
  if (!ok) return;
  try {
    reportBulk(await send({ type: 'emptyTrash', confirm: 'ELIMINAR' }), { verb: 'Eliminadas', titleOf });
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
