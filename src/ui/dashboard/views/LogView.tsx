// Registro: action log, newest first, paginated, with undo.

import { useEffect, useState } from 'preact/hooks';
import type { ActionEntry } from '../../../shared/types';
import { getActions } from '../../../core/db';
import { errMsg } from '../../common/api';
import { confirmDialog } from '../../common/feedback';
import { ACTION_KIND_LABELS, fmtDateTime, fmtNum, fmtRelative, plural } from '../../common/format';
import { undoAction } from '../../common/results';
import { useStore } from '../../common/store';
import { Spinner } from '../../common/widgets';
import { actionsVersion, recordsStore } from '../data';

const PAGE = 50;
const REOPEN_CONFIRM = 20;

function nameOf(id: string | undefined, byId: Map<string, { title: string; url: string }>): string {
  if (!id) return '(sin referencia)';
  const r = byId.get(id);
  return r ? r.title || r.url : `(eliminada ${id.slice(0, 8)})`;
}

async function undo(a: ActionEntry) {
  const reopens = a.before ? Object.values(a.before).filter((p) => p.state === 'open').length : 0;
  if ((a.kind === 'archive' || a.kind === 'trash') && reopens > REOPEN_CONFIRM) {
    const ok = await confirmDialog({
      title: `Deshacer reabre ${plural(reopens, 'pestaña', 'pestañas')}`,
      body: <p>Se abren de a pocas a la vez y van cargando progresivamente. ¿Continuar?</p>,
      confirmLabel: 'Deshacer',
    });
    if (!ok) return;
  }
  await undoAction(a.id);
}

function Entry({ a, byId }: { a: ActionEntry; byId: Map<string, { title: string; url: string }> }) {
  const [open, setOpen] = useState(false);
  const n = a.recordIds.length;
  const skipped = a.skipped?.length ?? 0;
  const failed = a.failed?.length ?? 0;
  return (
    <li class={`log-entry${a.undoneAt ? ' is-undone' : ''}`}>
      <div class="log-line">
        <time class="log-time" dateTime={new Date(a.at).toISOString()} title={fmtRelative(a.at)}>
          {fmtDateTime(a.at)}
        </time>
        <span class={`badge ${a.auto ? 'badge-auto' : ''}`}>{a.auto ? 'Automática' : 'Manual'}</span>
        <strong class="log-kind">{ACTION_KIND_LABELS[a.kind] ?? a.kind}</strong>
        <span class="log-reason ellipsis" title={a.reason}>
          {a.reason}
        </span>
        <span class="log-count">
          {fmtNum(n)}
          {skipped ? <span class="chip chip-warn">omitidas {skipped}</span> : null}
          {failed ? <span class="chip chip-warn">errores {failed}</span> : null}
        </span>
        {a.undoneAt ? (
          <span class="faint" title={fmtDateTime(a.undoneAt)}>
            Deshecha
          </span>
        ) : a.undoable ? (
          <button type="button" class="btn btn-sm" onClick={() => void undo(a)}>
            Deshacer
          </button>
        ) : (
          <span />
        )}
        <button type="button" class="icon-btn" aria-expanded={open} aria-label={open ? 'Ocultar detalle' : 'Ver detalle'} onClick={() => setOpen(!open)}>
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div class="log-detail">
          {n > 0 && (
            <>
              <h4>Referencias</h4>
              <ul>
                {a.recordIds.slice(0, 200).map((id) => (
                  <li>{nameOf(id, byId)}</li>
                ))}
              </ul>
              {n > 200 && <p class="faint">… y {fmtNum(n - 200)} más.</p>}
            </>
          )}
          {skipped > 0 && (
            <>
              <h4>Omitidas</h4>
              <ul>
                {a.skipped?.slice(0, 200).map((s) => (
                  <li>
                    {s.recordId ? nameOf(s.recordId, byId) : `Pestaña ${s.tabId ?? '?'}`} — <span class="muted">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {failed > 0 && (
            <>
              <h4>Con error</h4>
              <ul>
                {a.failed?.slice(0, 200).map((f) => (
                  <li>
                    {f.recordId ? nameOf(f.recordId, byId) : `Pestaña ${f.tabId ?? '?'}`} — <span class="error-text">{f.error}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.undoOf && <p class="faint">Deshace la acción {a.undoOf.slice(0, 8)}.</p>}
        </div>
      )}
    </li>
  );
}

export function LogView() {
  const version = useStore(actionsVersion);
  const { byId } = useStore(recordsStore);
  const [entries, setEntries] = useState<ActionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)load the first page(s) whenever the log changes, keeping the amount already shown.
  useEffect(() => {
    let cancelled = false;
    const limit = Math.max(PAGE, entries.length);
    getActions({ limit })
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setHasMore(list.length >= limit);
        setError(null);
      })
      .catch((e) => !cancelled && setError(errMsg(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const more = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoading(true);
    try {
      // `before` is exclusive: ask from last.at + 1 so entries sharing that timestamp are not skipped, then dedupe.
      const list = await getActions({ limit: PAGE, before: last.at + 1 });
      const seen = new Set(entries.map((e) => e.id));
      const fresh = list.filter((e) => !seen.has(e.id));
      setEntries([...entries, ...fresh]);
      setHasMore(fresh.length > 0 && list.length >= PAGE);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="page">
      <h1>Registro de acciones</h1>
      <p class="muted">
        Todo lo que hizo Fangio (automáticamente o a pedido tuyo), con su motivo. «Deshacer» reabre las pestañas cerradas o
        restaura los datos anteriores. Las eliminaciones definitivas no se pueden deshacer.
      </p>
      {error && <div class="notice notice-danger">No se pudo leer el registro: {error}</div>}
      {entries.length === 0 && !loading && !error && <div class="notice">Todavía no hay acciones registradas.</div>}
      <ul class="log">
        {entries.map((a) => (
          <Entry key={a.id} a={a} byId={byId} />
        ))}
      </ul>
      {loading && <Spinner label="Cargando…" />}
      {hasMore && !loading && (
        <button type="button" class="btn" onClick={() => void more()}>
          Cargar más
        </button>
      )}
    </div>
  );
}
