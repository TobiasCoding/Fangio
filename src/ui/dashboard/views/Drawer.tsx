// Detail drawer for one record: editable title/note/tags/project, toggles, dates, origin.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import { send } from '../../common/api';
import { toast } from '../../common/feedback';
import { fmtDateTime, fmtRelative, SOURCE_LABELS } from '../../common/format';
import { Favicon, NoteEditor, StateBadge, Switch, TagEditor } from '../../common/widgets';
import { useStore } from '../../common/store';
import { closeRecords, editRecords, focusTab, purgeRecords, reopenRecords, restoreRecords } from '../ops';
import { thumbFor, thumbsVersion } from '../thumbCache';

function DrawerThumb({ r }: { r: TabRecord }) {
  useStore(thumbsVersion);
  const t = thumbFor(r);
  if (!t) return null;
  return (
    <div class="drawer-thumb">
      <img class="thumb-img" src={t.src} alt="Miniatura de la página" title={'Captura: ' + fmtDateTime(t.at)} />
    </div>
  );
}

function DateRow({ label, ms, hint }: { label: string; ms?: number; hint?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {typeof ms === 'number' ? (
          <>
            {fmtDateTime(ms)} <span class="faint">({fmtRelative(ms)})</span>
          </>
        ) : (
          <span class="faint">{hint ?? '—'}</span>
        )}
      </dd>
    </>
  );
}

/** Text input that saves on blur / Enter when the value changed. */
function InlineInput(props: { value: string; onSave: (v: string) => void; label: string; class?: string; list?: string; placeholder?: string }) {
  const [v, setV] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(props.value);
  }, [props.value]);
  const commit = () => {
    if (v.trim() !== props.value.trim()) props.onSave(v.trim());
  };
  return (
    <input
      type="text"
      class={props.class}
      value={v}
      aria-label={props.label}
      list={props.list}
      placeholder={props.placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onInput={(e) => setV(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setV(props.value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function Drawer({ record: r, onClose, projects, tags }: { record: TabRecord; onClose: () => void; projects: string[]; tags: string[] }) {
  const ref = useRef<HTMLElement>(null);
  const ids = [r.id];
  const edit = (e: Parameters<typeof editRecords>[1]) => void editRecords(ids, e, 'Actualizada', true);
  const live = r.state === 'open' ? r.live : null;
  const unknownOpen = !r.openedAt && (r.source === 'install-snapshot' || !!r.importedAt);

  useEffect(() => {
    ref.current?.focus();
  }, [r.id]);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(r.url);
      toast('URL copiada', { kind: 'info', timeout: 2000 });
    } catch {
      toast('No se pudo copiar la URL', { kind: 'error' });
    }
  };

  return (
    <aside class="drawer" aria-label="Detalle de la referencia" tabIndex={-1} ref={ref}>
      <div class="drawer-head">
        <Favicon url={r.url} domain={r.domain} />
        <InlineInput key={r.id} class="drawer-title" label="Título" value={r.title} onSave={(title) => edit({ title })} />
        <button type="button" class="icon-btn" aria-label="Cerrar detalle (Esc)" title="Cerrar (Esc)" onClick={onClose}>
          ×
        </button>
      </div>

      <div class="drawer-body">
        <DrawerThumb r={r} />
        <div class="row wrap">
          <StateBadge state={r.state} />
          {r.protected && <span class="chip chip-protected">Protegida</span>}
          {r.pending && <span class="chip chip-pending">Pendiente</span>}
          <span class="faint">{r.domain}</span>
        </div>

        <div class="drawer-actions">
          {live ? (
            <button type="button" class="btn btn-primary btn-sm" onClick={() => void focusTab(live.tabId, live.windowId)}>
              Ir a la pestaña
            </button>
          ) : (
            <button type="button" class="btn btn-primary btn-sm" onClick={() => void reopenRecords(ids)}>
              Reabrir
            </button>
          )}
          {r.state !== 'archived' && r.state !== 'trash' && (
            <button type="button" class="btn btn-sm" onClick={() => void closeRecords(ids, 'archive')}>
              Archivar
            </button>
          )}
          {r.state !== 'trash' ? (
            <button type="button" class="btn btn-sm" onClick={() => void closeRecords(ids, 'trash')}>
              Papelera
            </button>
          ) : (
            <>
              <button type="button" class="btn btn-sm" onClick={() => void restoreRecords(ids)}>
                Restaurar
              </button>
              <button type="button" class="btn btn-sm btn-danger" onClick={() => void purgeRecords(ids)}>
                Eliminar definitivamente
              </button>
            </>
          )}
        </div>

        <section class="drawer-sec">
          <h3>URL</h3>
          <div class="url-box mono">{r.url}</div>
          <div class="row">
            <button type="button" class="btn btn-sm" onClick={() => void copyUrl()}>
              Copiar
            </button>
            <button type="button" class="btn btn-sm" disabled={r.state === 'open'} onClick={() => void reopenRecords(ids)}>
              Abrir
            </button>
          </div>
        </section>

        <section class="drawer-sec stack">
          <Switch
            checked={r.protected}
            onChange={(v) => edit({ protected: v })}
            label="Protegida"
            hint="Nunca se cierra automáticamente; las acciones manuales piden confirmación."
          />
          <Switch checked={r.pending} onChange={(v) => edit({ pending: v })} label="Pendiente" hint="Para volver a verla más adelante." />
        </section>

        <section class="drawer-sec">
          <h3>Nota</h3>
          <NoteEditor
            key={r.id}
            value={r.note}
            onSave={async (note) => {
              const res = await send({ type: 'updateRecords', recordIds: ids, edit: { note } });
              if (res.failed.length) throw new Error(res.failed[0]?.error);
            }}
          />
        </section>

        <section class="drawer-sec">
          <h3>Etiquetas</h3>
          <TagEditor tags={r.tags} suggestions={tags} onAdd={(addTags) => edit({ addTags })} onRemove={(t) => edit({ removeTags: [t] })} />
        </section>

        <section class="drawer-sec">
          <h3>Proyecto</h3>
          <InlineInput key={`p-${r.id}`} label="Proyecto" value={r.project} list="drawer-projects" placeholder="Sin proyecto" onSave={(project) => edit({ project })} />
          <datalist id="drawer-projects">
            {projects.map((p) => (
              <option value={p} />
            ))}
          </datalist>
        </section>

        <section class="drawer-sec">
          <h3>Fechas</h3>
          <dl class="kv">
            {unknownOpen ? (
              <>
                <DateRow label="Importada" ms={r.importedAt ?? r.createdAt} />
                <dt>Abierta</dt>
                <dd class="faint">Fecha de apertura desconocida (ya estaba abierta al instalar o importar)</dd>
              </>
            ) : (
              <>
                <DateRow label="Abierta" ms={r.openedAt} hint="Desconocida" />
                <DateRow label="Registrada" ms={r.createdAt} />
              </>
            )}
            <DateRow label="Último acceso" ms={r.lastAccessedAt} hint="Sin datos" />
            {r.archivedAt !== undefined && <DateRow label="Archivada" ms={r.archivedAt} />}
            {r.trashedAt !== undefined && <DateRow label="Enviada a papelera" ms={r.trashedAt} />}
            {r.reopenedAt !== undefined && <DateRow label="Reabierta" ms={r.reopenedAt} />}
            {r.lastAudibleAt !== undefined && <DateRow label="Último audio" ms={r.lastAudibleAt} />}
            <DateRow label="Modificada" ms={r.updatedAt} />
          </dl>
        </section>

        <section class="drawer-sec">
          <h3>Origen</h3>
          <dl class="kv">
            <dt>Ventana</dt>
            <dd>{r.origin.windowOrdinal ? `Ventana ${r.origin.windowOrdinal}` : '—'}</dd>
            <dt>Posición</dt>
            <dd>{typeof r.origin.index === 'number' ? `Pestaña ${r.origin.index + 1}` : '—'}</dd>
            <dt>Grupo</dt>
            <dd>
              {r.origin.groupTitle || r.origin.groupColor ? (
                <span class="row">
                  {r.origin.groupColor && <span class={`group-dot group-${r.origin.groupColor}`} aria-hidden="true" />}
                  {r.origin.groupTitle || '(sin título)'}
                </span>
              ) : (
                '—'
              )}
            </dd>
            <dt>Fuente</dt>
            <dd>{SOURCE_LABELS[r.source] ?? r.source}</dd>
            {r.reopenCount > 0 && (
              <>
                <dt>Reaperturas</dt>
                <dd>{r.reopenCount}</dd>
              </>
            )}
            {r.mergedFrom.length > 0 && (
              <>
                <dt>Fusionadas</dt>
                <dd>{r.mergedFrom.length} referencia(s) unidas en esta</dd>
              </>
            )}
            {r.lastReason && (
              <>
                <dt>Último motivo</dt>
                <dd>{r.lastReason}</dd>
              </>
            )}
          </dl>
        </section>

        {r.previousUrls.length > 0 && (
          <section class="drawer-sec">
            <h3>URLs anteriores</h3>
            <ol class="prev-urls">
              {r.previousUrls.map((u) => (
                <li class="mono" title={u}>
                  {u}
                </li>
              ))}
            </ol>
          </section>
        )}
        <p class="faint id-line">ID: {r.id}</p>
      </div>
    </aside>
  );
}
