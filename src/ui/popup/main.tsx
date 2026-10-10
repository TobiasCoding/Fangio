// Popup: actions on the current tab + counters + shortcut to the dashboard.

import '../common/base.css';
import './popup.css';
import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { StatusInfo, TabRecord } from '../../shared/types';
import type { RecordEdit } from '../../shared/messages';
import { getRecord } from '../../core/db';
import { isTrackableUrl } from '../../core/url';
import { errMsg, onChanges, send } from '../common/api';
import { confirmDialog, DialogHost, toast, ToastHost } from '../common/feedback';
import { fmtNum, fmtRelative } from '../common/format';
import { openDashboard } from '../common/openDashboard';
import { reportBulk, undoAction } from '../common/results';
import { Favicon, NoteEditor, Spinner, StateBadge, TagEditor } from '../common/widgets';

function openPanel() {
  void openDashboard().then(() => window.close());
}

function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [record, setRecord] = useState<TabRecord | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [archivedAction, setArchivedAction] = useState<string | null | undefined>(undefined);
  const recordId = useRef<string | null>(null);

  const loadStatus = useCallback(() => {
    send({ type: 'getStatus' })
      .then(setStatus)
      .catch(() => {});
  }, []);

  const loadCurrent = useCallback(async () => {
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTab(t ?? null);
      if (!t || typeof t.id !== 'number') {
        setRecord(null);
        return;
      }
      const res = await send({ type: 'getTabRecord', tabId: t.id });
      setRecord(res.record);
      recordId.current = res.record?.id ?? null;
      if (res.tab) setTab(res.tab);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRecord = useCallback(async () => {
    const id = recordId.current;
    if (!id) return loadCurrent();
    try {
      const r = await getRecord(id);
      if (r) setRecord(r);
    } catch {
      // ignore: the next change event retries
    }
  }, [loadCurrent]);

  useEffect(() => {
    void loadCurrent();
    loadStatus();
    return onChanges((ev) => {
      if (ev.type === 'records') {
        const id = recordId.current;
        if (!ev.ids || !id || ev.ids.includes(id)) void refreshRecord();
        loadStatus();
      } else if (ev.type === 'status' || ev.type === 'settings') loadStatus();
    });
  }, [loadCurrent, loadStatus, refreshRecord]);

  const edit = async (e: RecordEdit) => {
    if (!record) return;
    const prev = record;
    setRecord({
      ...record,
      ...(e.protected !== undefined ? { protected: e.protected } : {}),
      ...(e.pending !== undefined ? { pending: e.pending } : {}),
    });
    try {
      const r = await send({ type: 'updateRecords', recordIds: [record.id], edit: e });
      if (r.failed.length) throw new Error(r.failed[0]?.error ?? 'Error');
      await refreshRecord();
    } catch (err) {
      setRecord(prev);
      toast(`No se pudo guardar: ${errMsg(err)}`, { kind: 'error' });
    }
  };

  const archive = async () => {
    if (!tab || typeof tab.id !== 'number') return;
    let force = false;
    if (record?.protected) {
      force = await confirmDialog({
        title: 'Esta pestaña está protegida',
        body: <p>La marcaste como protegida para que no se cierre. ¿Querés desprotegerla y archivarla igual?</p>,
        confirmLabel: 'Desproteger y archivar',
        danger: true,
      });
      if (!force) return;
    }
    setBusy(true);
    try {
      const res = await send({ type: 'archiveTab', tabId: tab.id, force });
      if (res.done.length) {
        setArchivedAction(res.actionId ?? null);
        await refreshRecord();
        loadStatus();
      } else {
        reportBulk(res, { verb: 'Archivadas' });
      }
    } catch (e) {
      toast(`No se pudo archivar: ${errMsg(e)}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const counts = status?.counts;
  const trackable = !!tab?.url && isTrackableUrl(tab.url);

  return (
    <div class="popup">
      <header class="popup-head">
        <span class="popup-brand">Fangio</span>
        {counts && (
          <span class="popup-counts" aria-label="Contadores">
            <span>
              <strong>{fmtNum(counts.open)}</strong> abiertas
            </span>
            <span>
              <strong>{fmtNum(counts.archived)}</strong> archivadas
            </span>
            <span>
              <strong>{fmtNum(counts.pending)}</strong> pend.
            </span>
          </span>
        )}
      </header>

      {loading ? (
        <Spinner label="Cargando…" />
      ) : error ? (
        <div class="notice notice-danger">{error}</div>
      ) : !record ? (
        <div class="notice">
          <strong>Esta página no se archiva.</strong>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            {trackable
              ? 'Todavía no está registrada. Esperá un segundo y volvé a abrir este panel.'
              : 'Fangio sólo guarda páginas web (http, https, file, ftp). Las páginas internas del navegador, las de Fangio y las de incógnito no se registran.'}
          </p>
        </div>
      ) : (
        <>
          <div class="cur">
            <Favicon url={record.url} domain={record.domain} />
            <div class="grow">
              <div class="cur-title" title={record.title}>
                {record.title || record.url}
              </div>
              <div class="cur-meta">
                <StateBadge state={record.state} />
                <span class="ellipsis">{record.domain}</span>
                {record.lastAccessedAt && <span class="faint">· vista {fmtRelative(record.lastAccessedAt)}</span>}
              </div>
            </div>
          </div>

          {archivedAction !== undefined ? (
            <div class="notice notice-ok" role="status">
              <strong>Archivada.</strong> La referencia quedó guardada antes de cerrar la pestaña.{' '}
              {archivedAction && (
                <button type="button" class="link" onClick={() => void undoAction(archivedAction)}>
                  Deshacer
                </button>
              )}
            </div>
          ) : (
            <div class="popup-actions">
              <button type="button" class="btn btn-primary" disabled={busy || record.state !== 'open'} onClick={archive}>
                {busy ? 'Archivando…' : record.protected ? 'Archivar (protegida)' : 'Archivar'}
              </button>
              <button
                type="button"
                class={`btn${record.protected ? ' is-on' : ''}`}
                aria-pressed={record.protected}
                title="Una pestaña protegida nunca se cierra automáticamente"
                onClick={() => void edit({ protected: !record.protected })}
              >
                {record.protected ? 'Protegida' : 'Proteger'}
              </button>
              <button
                type="button"
                class={`btn${record.pending ? ' is-on' : ''}`}
                aria-pressed={record.pending}
                title="Marcar como pendiente"
                onClick={() => void edit({ pending: !record.pending })}
              >
                {record.pending ? '★ Pendiente' : '☆ Pendiente'}
              </button>
            </div>
          )}

          <div class="popup-section">
            <label for="popup-note">Nota</label>
            <NoteEditor
              key={record.id}
              id="popup-note"
              value={record.note}
              rows={3}
              onSave={async (note) => {
                const r = await send({ type: 'updateRecords', recordIds: [record.id], edit: { note } });
                if (r.failed.length) throw new Error(r.failed[0]?.error);
              }}
            />
          </div>
          <div class="popup-section">
            <label>Etiquetas</label>
            <TagEditor tags={record.tags} onAdd={(addTags) => void edit({ addTags })} onRemove={(t) => void edit({ removeTags: [t] })} />
          </div>
        </>
      )}

      {status?.update && (
        <div class="notice notice-info">
          Hay una versión nueva ({status.update.latest}).{' '}
          <button type="button" class="link" onClick={openPanel}>
            Ver cómo actualizar
          </button>
        </div>
      )}

      <footer class="popup-foot">
        <span class="faint">{status?.automationEnabled ? 'Automatización activada' : 'Automatización desactivada'}</span>
        <button type="button" class="btn" onClick={openPanel}>
          Abrir panel
        </button>
      </footer>
      <ToastHost />
      <DialogHost />
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<Popup />, root);
