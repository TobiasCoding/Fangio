// Turns a BulkResult into a toast with "ver detalle" / "Deshacer" / force actions.

import type { BulkResult } from '../../shared/messages';
import { getAction } from '../../core/db';
import { needsUndoConfirm, undoReopenCount } from '../dashboard/safety';
import { errMsg, send } from './api';
import { confirmDialog, infoDialog, toast } from './feedback';
import type { ToastAction } from './feedback';
import { fmtNum, plural } from './format';

export interface ReportOptions {
  /** Past participle shown before the count, e.g. "Archivadas". */
  verb: string;
  /** Resolves a record id to a readable title for the detail dialog. */
  titleOf?: (id: string) => string | undefined;
  /** Skipped record ids that were refused because they are protected. */
  protectedIds?: string[];
  /** Called after the user confirms forcing the protected ones. */
  onForce?: (ids: string[]) => Promise<void> | void;
  /** Label for the force action, e.g. "Desproteger y archivar". */
  forceLabel?: string;
  /** Don't toast when everything succeeded silently (e.g. small edits). */
  quietOnSuccess?: boolean;
}

export function showBulkDetail(res: BulkResult, titleOf?: (id: string) => string | undefined): Promise<void> {
  const name = (id?: string, tabId?: number) =>
    (id && titleOf?.(id)) || (id ? `Registro ${id.slice(0, 8)}` : typeof tabId === 'number' ? `Pestaña ${tabId}` : 'Elemento');
  return infoDialog(
    'Detalle de la operación',
    <div class="detail-list">
      <p>
        Completadas: <strong>{fmtNum(res.done.length)}</strong> · omitidas: <strong>{fmtNum(res.skipped.length)}</strong> · con
        error: <strong>{fmtNum(res.failed.length)}</strong>
      </p>
      {res.skipped.length > 0 && (
        <>
          <h3>Omitidas (la pestaña quedó como estaba)</h3>
          <ul>
            {res.skipped.slice(0, 500).map((s) => (
              <li>
                <span class="detail-title">{name(s.recordId, s.tabId)}</span> — <span class="muted">{s.reason}</span>
              </li>
            ))}
          </ul>
          {res.skipped.length > 500 && <p class="muted">… y {fmtNum(res.skipped.length - 500)} más.</p>}
        </>
      )}
      {res.failed.length > 0 && (
        <>
          <h3>Con error</h3>
          <ul>
            {res.failed.slice(0, 500).map((f) => (
              <li>
                <span class="detail-title">{name(f.recordId, f.tabId)}</span> — <span class="error-text">{f.error}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>,
  );
}

/**
 * Undo an action. Unless the caller already asked, an undo that would reopen more
 * than 20 tabs (any action kind) asks for confirmation first.
 */
export async function undoAction(actionId: string, alreadyConfirmed = false): Promise<void> {
  if (!alreadyConfirmed) {
    let entry;
    try {
      entry = await getAction(actionId);
    } catch {
      entry = undefined;
    }
    if (entry && needsUndoConfirm(entry)) {
      const n = undoReopenCount(entry);
      const ok = await confirmDialog({
        title: `Deshacer reabre ${plural(n, 'pestaña', 'pestañas')}`,
        body: <p>Se abren de a pocas a la vez y van cargando progresivamente. ¿Continuar?</p>,
        confirmLabel: 'Deshacer',
      });
      if (!ok) return;
    }
  }
  try {
    const r = await send({ type: 'undo', actionId });
    // No "Deshacer" link on the result of an undo (it can be undone from Registro if needed).
    reportBulk({ ...r, actionId: undefined }, { verb: 'Deshechas' });
  } catch (e) {
    toast(`No se pudo deshacer: ${errMsg(e)}`, { kind: 'error' });
  }
}

export function reportBulk(res: BulkResult, opts: ReportOptions): void {
  const parts = [`${opts.verb} ${fmtNum(res.done.length)}`];
  if (res.skipped.length) parts.push(`omitidas ${fmtNum(res.skipped.length)}`);
  if (res.failed.length) parts.push(`con error ${fmtNum(res.failed.length)}`);
  const actions: ToastAction[] = [];
  if (res.skipped.length || res.failed.length) {
    actions.push({ label: 'Ver detalle', onClick: () => void showBulkDetail(res, opts.titleOf) });
  }
  const prot = opts.protectedIds ?? [];
  if (prot.length && opts.onForce) {
    const label = opts.forceLabel ?? 'Desproteger y continuar';
    actions.push({
      label: `${label} (${fmtNum(prot.length)})`,
      onClick: async () => {
        const ok = await confirmDialog({
          title: `${label}: ${plural(prot.length, 'referencia protegida', 'referencias protegidas')}`,
          body: (
            <p>
              Las marcaste como <strong>protegidas</strong> para que nada las cierre. Si confirmás, se quita la protección y se
              aplica la acción igual. La referencia queda guardada y podés deshacerlo desde Registro.
            </p>
          ),
          confirmLabel: label,
          danger: true,
        });
        if (ok) await opts.onForce?.(prot);
      },
    });
  }
  if (res.actionId) {
    const id = res.actionId;
    actions.push({ label: 'Deshacer', onClick: () => void undoAction(id) });
  }
  const kind = res.failed.length ? 'error' : res.skipped.length ? 'warn' : 'ok';
  if (opts.quietOnSuccess && kind === 'ok' && !res.actionId) return;
  toast(parts.join(' · '), { kind, actions });
}
