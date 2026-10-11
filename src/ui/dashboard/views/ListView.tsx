// Main list: search, filters, sort, selection + bulk actions, detail drawer, and four ways
// to look at the same filtered set: list (virtualized rows), cards (thumbnails), timeline
// (days and work sessions) and topics (contextual group suggestions).

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import { promptDialog, toast } from '../../common/feedback';
import { fmtDateTime, fmtNum, fmtRelative, parseTags, plural } from '../../common/format';
import { useStore } from '../../common/store';
import { Favicon, Spinner, StateBadge } from '../../common/widgets';
import { recordsStore, settingsStore } from '../data';
import { FacetPicker } from '../Facets';
import { closeRecords, editRecords, emptyTrash, purgeRecords, reopenRecords, restoreRecords } from '../ops';
import {
  countBy,
  DEFAULT_FILTERS,
  filterRecords,
  isFiltered,
  matchesState,
  rowDate,
  SORT_LABELS,
  sortRecords,
  STATE_FILTER_LABELS,
} from '../search';
import type { Filters, SortDir, SortKey, StateFilter } from '../search';
import { VirtualList } from '../VirtualList';
import { CardGrid } from './CardGrid';
import { Drawer } from './Drawer';
import { Timeline } from './Timeline';
import { TopicsView } from './Topics';

const ROW_H = 32;
const PREFS_KEY = 'fangio.list.prefs';

export type ViewMode = 'list' | 'cards' | 'timeline' | 'topics';
export const VIEW_LABELS: Record<ViewMode, string> = { list: 'Lista', cards: 'Tarjetas', timeline: 'Línea de tiempo', topics: 'Temas' };

interface Prefs {
  sortKey: SortKey;
  sortDir: SortDir;
  view: ViewMode;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    if (p && p.sortKey && p.sortKey in SORT_LABELS && (p.sortDir === 'asc' || p.sortDir === 'desc')) {
      return { sortKey: p.sortKey, sortDir: p.sortDir, view: p.view && p.view in VIEW_LABELS ? p.view : 'list' };
    }
  } catch {
    // ignore
  }
  return { sortKey: 'accessed', sortDir: 'desc', view: 'list' };
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}

export function ListView() {
  const { list, byId, loaded, error } = useStore(recordsStore);
  const settings = useStore(settingsStore);
  const now = useNow();

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [qInput, setQInput] = useState('');
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [ensure, setEnsure] = useState<{ index: number; seq: number } | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced search.
  useEffect(() => {
    const h = setTimeout(() => setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput })), 120);
    return () => clearTimeout(h);
  }, [qInput]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }, [prefs]);

  const sorted = useMemo(() => sortRecords(list, prefs.sortKey, prefs.sortDir), [list, prefs]);
  const filtered = useMemo(() => filterRecords(sorted, filters), [sorted, filters]);
  const filteredIds = useMemo(() => new Set(filtered.map((r) => r.id)), [filtered]);
  const indexOf = useMemo(() => new Map(filtered.map((r, i) => [r.id, i])), [filtered]);
  const stateScoped = useMemo(() => list.filter((r) => matchesState(r, filters.state)), [list, filters.state]);
  const domainOpts = useMemo(() => countBy(stateScoped, (r) => r.domain), [stateScoped]);
  const tagOpts = useMemo(() => countBy(stateScoped, (r) => r.tags), [stateScoped]);
  const projectOpts = useMemo(() => countBy(list.filter((r) => r.project), (r) => r.project), [list]);
  const stateCounts = useMemo(() => {
    const c = { open: 0, archived: 0, trash: 0 };
    for (const r of list) c[r.state]++;
    return { ...c, active: c.open + c.archived };
  }, [list]);

  // Drop selected ids that no longer exist (purged).
  useEffect(() => {
    setSelection((sel) => {
      let changed = false;
      for (const id of sel) if (!byId.has(id)) changed = true;
      return changed ? new Set([...sel].filter((id) => byId.has(id))) : sel;
    });
    if (drawerId && !byId.has(drawerId) && loaded) setDrawerId(null);
  }, [byId]);

  // Keep the cursor inside the list.
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(filtered.length - 1);
  }, [filtered.length]);

  const selectedIds = [...selection];
  const selectedRecs = selectedIds.map((id) => byId.get(id)).filter((r): r is TabRecord => !!r);
  const hiddenSelected = selectedIds.filter((id) => !filteredIds.has(id)).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selection.has(r.id));

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    anchor.current = null;
  }, []);

  const moveCursor = (i: number) => {
    const n = Math.max(0, Math.min(filtered.length - 1, i));
    setCursor(n);
    setEnsure({ index: n, seq: Date.now() + Math.random() });
  };

  // Global shortcuts: "/" focuses search, Esc closes drawer or clears selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === '/' && !isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'Escape') {
        if (drawerId) setDrawerId(null);
        else if (selection.size) clearSelection();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerId, selection, clearSelection]);

  const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  // ---------------------------------------------------------------- selection

  const selectRange = (from: number, to: number, value: boolean) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelection((sel) => {
      const next = new Set(sel);
      for (let i = a; i <= b; i++) {
        const r = filtered[i];
        if (!r) continue;
        if (value) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  };

  const toggleOne = (r: TabRecord, i: number, shift: boolean) => {
    if (shift && anchor.current !== null) {
      selectRange(anchor.current, i, true);
    } else {
      setSelection((sel) => {
        const next = new Set(sel);
        if (next.has(r.id)) next.delete(r.id);
        else next.add(r.id);
        return next;
      });
      anchor.current = i;
    }
  };

  const selectAllFiltered = () => {
    setSelection((sel) => {
      const next = new Set(sel);
      for (const r of filtered) next.add(r.id);
      return next;
    });
  };

  const unselectFiltered = () => {
    setSelection((sel) => new Set([...sel].filter((id) => !filteredIds.has(id))));
  };

  // ---------------------------------------------------------------- bulk actions

  const run = async (fn: () => Promise<unknown>, clear: boolean) => {
    await fn();
    if (clear) clearSelection();
  };

  const bulk = {
    reopen: () => void run(() => reopenRecords(selectedIds), true),
    archive: () => {
      const ids = selectedRecs.filter((r) => r.state !== 'archived').map((r) => r.id);
      if (!ids.length) return void toast('Ya están todas archivadas.', { kind: 'info' });
      // Bulk: confirm when open tabs would close; keep the selection if cancelled.
      void closeRecords(ids, 'archive', { confirm: true }).then((r) => r && clearSelection());
    },
    trash: () => {
      const ids = selectedRecs.filter((r) => r.state !== 'trash').map((r) => r.id);
      if (!ids.length) return void toast('Ya están todas en la papelera.', { kind: 'info' });
      void closeRecords(ids, 'trash', { confirm: true }).then((r) => r && clearSelection());
    },
    restore: () => {
      const ids = selectedRecs.filter((r) => r.state === 'trash').map((r) => r.id);
      void run(() => restoreRecords(ids), true);
    },
    purge: async () => {
      const ids = selectedRecs.filter((r) => r.state === 'trash').map((r) => r.id);
      if (await purgeRecords(ids)) clearSelection();
    },
    protect: (v: boolean) => void editRecords(selectedIds, { protected: v }, v ? 'Protegidas' : 'Desprotegidas'),
    pending: (v: boolean) => void editRecords(selectedIds, { pending: v }, v ? 'Marcadas pendientes' : 'Sin pendiente'),
    addTag: async () => {
      const v = await promptDialog({
        title: `Agregar etiqueta a ${plural(selectedIds.length, 'referencia', 'referencias')}`,
        input: { label: 'Etiquetas (separadas por coma)', suggestions: tagOpts.map((t) => t.value) },
        confirmLabel: 'Agregar',
      });
      const tags = v ? parseTags(v) : [];
      if (tags.length) void editRecords(selectedIds, { addTags: tags }, 'Etiquetadas');
    },
    removeTag: async () => {
      const present = countBy(selectedRecs, (r) => r.tags).map((t) => t.value);
      if (!present.length) return void toast('Las seleccionadas no tienen etiquetas.', { kind: 'info' });
      const v = await promptDialog({
        title: 'Quitar etiqueta',
        body: <p class="muted">Etiquetas en la selección: {present.join(', ')}</p>,
        input: { label: 'Etiquetas a quitar (separadas por coma)', suggestions: present },
        confirmLabel: 'Quitar',
      });
      const tags = v ? parseTags(v) : [];
      if (tags.length) void editRecords(selectedIds, { removeTags: tags }, 'Actualizadas');
    },
    project: async () => {
      const v = await promptDialog({
        title: `Asignar proyecto a ${plural(selectedIds.length, 'referencia', 'referencias')}`,
        body: <p class="muted">Dejalo vacío para quitar el proyecto.</p>,
        input: { label: 'Proyecto', suggestions: projectOpts.map((p) => p.value) },
        confirmLabel: 'Asignar',
      });
      if (v !== null) void editRecords(selectedIds, { project: v.trim() }, 'Actualizadas');
    },
  };

  const anySel = selectedRecs.length > 0;
  const allTrash = anySel && selectedRecs.every((r) => r.state === 'trash');
  const anyTrash = selectedRecs.some((r) => r.state === 'trash');

  // ---------------------------------------------------------------- rows

  const onRowClick = (e: MouseEvent, r: TabRecord, i: number) => {
    if (e.ctrlKey || e.metaKey) return toggleOne(r, i, false);
    if (e.shiftKey) {
      if (anchor.current !== null) selectRange(anchor.current, i, true);
      return;
    }
    setCursor(i);
    anchor.current = i;
    setDrawerId(r.id);
  };

  const renderRow = (r: TabRecord, i: number) => {
    const sel = selection.has(r.id);
    const d = rowDate(r, prefs.sortKey);
    const title = r.title || r.url;
    return (
      <div
        id={`row-${r.id}`}
        role="option"
        aria-selected={sel}
        class={`lrow${i === cursor ? ' is-cursor' : ''}${sel ? ' is-sel' : ''}${drawerId === r.id ? ' is-open' : ''}`}
        onClick={(e) => onRowClick(e, r, i)}
        onDblClick={() => void reopenRecords([r.id])}
      >
        <span class="c-check">
          <input
            type="checkbox"
            tabIndex={-1}
            checked={sel}
            aria-label={`Seleccionar ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleOne(r, i, e.shiftKey);
            }}
          />
        </span>
        <Favicon url={r.url} domain={r.domain} />
        <span class="c-title ellipsis" title={`${title}\n${r.url}`}>
          {title}
        </span>
        <span class="c-chips">
          {r.protected && <span class="chip chip-protected">Protegida</span>}
          {r.pending && <span class="chip chip-pending">Pendiente</span>}
          {r.project && <span class="chip">{r.project}</span>}
          {r.tags.slice(0, 2).map((t) => (
            <span class="chip chip-tag">{t}</span>
          ))}
          {r.tags.length > 2 && <span class="chip chip-tag">+{r.tags.length - 2}</span>}
          {r.note && (
            <span class="chip" title={r.note.slice(0, 300)}>
              Nota
            </span>
          )}
        </span>
        <span class="c-domain ellipsis" title={r.domain}>
          {r.domain}
        </span>
        <span class="c-state">
          <StateBadge state={r.state} />
        </span>
        <span class="c-date" title={`${d.label}: ${fmtDateTime(d.ms)}`}>
          {fmtRelative(d.ms, now)}
        </span>
        <span class="c-act">
          <button
            type="button"
            class="icon-btn"
            tabIndex={-1}
            title={r.state === 'open' ? 'Ya está abierta' : 'Reabrir'}
            aria-label={`Reabrir ${title}`}
            disabled={r.state === 'open'}
            onClick={(e) => {
              e.stopPropagation();
              void reopenRecords([r.id]);
            }}
          >
            ↗
          </button>
        </span>
      </div>
    );
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.target !== listRef.current) return;
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 400) / ROW_H) - 1);
    const cur = cursor < 0 ? 0 : cursor;
    const r = filtered[cur];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey && r) selectRange(cur, cur + 1, true);
        moveCursor(cursor < 0 ? 0 : cur + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey && r) selectRange(cur, cur - 1, true);
        moveCursor(cur - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        moveCursor(cur + page);
        break;
      case 'PageUp':
        e.preventDefault();
        moveCursor(cur - page);
        break;
      case 'Home':
        e.preventDefault();
        moveCursor(0);
        break;
      case 'End':
        e.preventDefault();
        moveCursor(filtered.length - 1);
        break;
      case 'Enter':
        if (r) {
          e.preventDefault();
          if (r.state === 'open') setDrawerId(r.id);
          else void reopenRecords([r.id]);
        }
        break;
      case ' ':
        if (r) {
          e.preventDefault();
          toggleOne(r, cur, e.shiftKey);
        }
        break;
      case 'i':
        if (r) setDrawerId(r.id);
        break;
    }
  };

  const resetKey = useMemo(() => ({}), [filters, prefs]);
  const filtersActive = isFiltered(filters);
  const cursorRec = cursor >= 0 ? filtered[cursor] : undefined;
  const sortOptions = Object.keys(SORT_LABELS) as SortKey[];
  const stateOptions = Object.keys(STATE_FILTER_LABELS) as StateFilter[];
  const stateCount = (s: StateFilter) => stateCounts[s];
  const retention = settings?.trashRetentionDays;
  const emptyEl = (
    <div class="empty">
      {list.length === 0
        ? 'Todavía no hay referencias guardadas.'
        : filtersActive
          ? 'Nada coincide con la búsqueda y los filtros.'
          : 'No hay referencias en este estado.'}
    </div>
  );
  const selectIds = (ids: string[], add: boolean) =>
    setSelection((sel) => {
      const next = new Set(sel);
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const clickAt = (e: MouseEvent, r: TabRecord) => onRowClick(e, r, indexOf.get(r.id) ?? 0);

  return (
    <div class={`listview${drawerId ? ' has-drawer' : ''}`}>
      <div class="list-main">
        <div class="toolbar">
          <div class="search">
            <input
              ref={searchRef}
              type="search"
              class="search-input"
              placeholder="Buscar en título, URL, nota y etiquetas…  ( / )"
              aria-label="Buscar"
              value={qInput}
              onInput={(e) => setQInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && qInput) {
                  e.stopPropagation();
                  setQInput('');
                } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  e.preventDefault();
                  setFilters((f) => ({ ...f, q: qInput }));
                  listRef.current?.focus();
                  if (cursor < 0) moveCursor(0);
                }
              }}
            />
          </div>
          <div class="seg" role="group" aria-label="Estado">
            {stateOptions.map((s) => (
              <button
                type="button"
                class={`seg-btn${filters.state === s ? ' is-on' : ''}`}
                aria-pressed={filters.state === s}
                onClick={() => {
                  setF({ state: s, domain: null, tags: [] });
                  clearSelection();
                }}
              >
                {STATE_FILTER_LABELS[s]} <span class="faint">{fmtNum(stateCount(s))}</span>
              </button>
            ))}
          </div>
          <div class="seg seg-views" role="group" aria-label="Vista">
            {(Object.keys(VIEW_LABELS) as ViewMode[]).map((v) => (
              <button
                type="button"
                class={'seg-btn' + (prefs.view === v ? ' is-on' : '')}
                aria-pressed={prefs.view === v}
                onClick={() => setPrefs({ ...prefs, view: v })}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
        </div>
        <div class="toolbar toolbar-2">
          <FacetPicker
            label="Dominio"
            placeholder="Todos los dominios"
            options={domainOpts}
            selected={filters.domain === null ? [] : [filters.domain]}
            onChange={(v) => setF({ domain: v[0] ?? null })}
            render={(v) => v || '(sin dominio)'}
          />
          <FacetPicker
            label="Etiquetas"
            placeholder="Etiquetas"
            multi
            options={tagOpts}
            selected={filters.tags}
            onChange={(v) => setF({ tags: v })}
            emptyText="Sin etiquetas todavía"
          />
          <select
            aria-label="Proyecto"
            value={filters.project === null ? '__all' : filters.project === '' ? '__none' : filters.project}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setF({ project: v === '__all' ? null : v === '__none' ? '' : v });
            }}
          >
            <option value="__all">Todos los proyectos</option>
            <option value="__none">Sin proyecto</option>
            {projectOpts.map((p) => (
              <option value={p.value}>
                {p.value} ({fmtNum(p.count)})
              </option>
            ))}
          </select>
          <label class="check">
            <input type="checkbox" checked={filters.pendingOnly} onChange={(e) => setF({ pendingOnly: e.currentTarget.checked })} />
            Sólo pendientes
          </label>
          <label class="check">
            <input type="checkbox" checked={filters.protectedOnly} onChange={(e) => setF({ protectedOnly: e.currentTarget.checked })} />
            Sólo protegidas
          </label>
          {filtersActive && (
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => {
                setQInput('');
                setFilters({ ...DEFAULT_FILTERS, state: filters.state });
              }}
            >
              Limpiar filtros
            </button>
          )}
          <span class="spacer" />
          <label class="row sort">
            <span class="muted">Orden</span>
            <select
              value={prefs.sortKey}
              onChange={(e) => setPrefs({ ...prefs, sortKey: e.currentTarget.value as SortKey })}
              aria-label="Ordenar por"
            >
              {sortOptions.map((k) => (
                <option value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            class="btn btn-sm"
            aria-label={prefs.sortDir === 'desc' ? 'Orden descendente (cambiar)' : 'Orden ascendente (cambiar)'}
            title={prefs.sortDir === 'desc' ? 'Descendente' : 'Ascendente'}
            onClick={() => setPrefs({ ...prefs, sortDir: prefs.sortDir === 'desc' ? 'asc' : 'desc' })}
          >
            {prefs.sortDir === 'desc' ? '↓' : '↑'}
          </button>
        </div>

        {anySel ? (
          <div class="bulkbar" role="toolbar" aria-label="Acciones sobre la selección">
            <strong>{plural(selectedRecs.length, 'seleccionada', 'seleccionadas')}</strong>
            {hiddenSelected > 0 && <span class="faint">({fmtNum(hiddenSelected)} fuera del filtro)</span>}
            {!allFilteredSelected && (
              <button type="button" class="link" onClick={selectAllFiltered}>
                Seleccionar todos los filtrados ({fmtNum(filtered.length)})
              </button>
            )}
            <button type="button" class="link" onClick={clearSelection}>
              Limpiar (Esc)
            </button>
            <span class="bulk-sep" />
            {allTrash ? (
              <>
                <button type="button" class="btn btn-sm" onClick={bulk.restore}>
                  Restaurar
                </button>
                <button type="button" class="btn btn-sm btn-danger" onClick={() => void bulk.purge()}>
                  Eliminar definitivamente
                </button>
              </>
            ) : (
              <>
                <button type="button" class="btn btn-sm" onClick={bulk.reopen}>
                  Reabrir
                </button>
                <button type="button" class="btn btn-sm" onClick={bulk.archive}>
                  Archivar
                </button>
                <button type="button" class="btn btn-sm" onClick={() => bulk.protect(true)}>
                  Proteger
                </button>
                <button type="button" class="btn btn-sm" onClick={() => bulk.protect(false)}>
                  Desproteger
                </button>
                <button type="button" class="btn btn-sm" onClick={() => bulk.pending(true)}>
                  Marcar pendiente
                </button>
                <button type="button" class="btn btn-sm" onClick={() => bulk.pending(false)}>
                  Quitar pendiente
                </button>
                <button type="button" class="btn btn-sm" onClick={() => void bulk.addTag()}>
                  + Etiqueta
                </button>
                <button type="button" class="btn btn-sm" onClick={() => void bulk.removeTag()}>
                  − Etiqueta
                </button>
                <button type="button" class="btn btn-sm" onClick={() => void bulk.project()}>
                  Proyecto
                </button>
                <button type="button" class="btn btn-sm" onClick={bulk.trash}>
                  Papelera
                </button>
                {anyTrash && (
                  <button type="button" class="btn btn-sm" onClick={bulk.restore}>
                    Restaurar
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div class="infobar">
            <span class="muted">
              {filtersActive || filters.state !== 'active'
                ? `${fmtNum(filtered.length)} de ${fmtNum(list.length)}`
                : `${plural(filtered.length, 'referencia', 'referencias')}`}
            </span>
            {filters.state === 'trash' && (
              <>
                <span class="faint">
                  {retention === 0
                    ? 'La papelera nunca se vacía sola.'
                    : retention
                      ? `Se eliminan definitivamente a los ${retention} días en la papelera (ver Reglas).`
                      : ''}
                </span>
                <span class="spacer" />
                <button type="button" class="btn btn-sm btn-danger" disabled={!stateCounts.trash} onClick={() => void emptyTrash(stateCounts.trash)}>
                  Vaciar papelera
                </button>
              </>
            )}
            {filters.state !== 'trash' && prefs.view !== 'topics' && (
              <span class="faint hide-narrow">
                {prefs.view === 'list'
                  ? 'Clic: detalle · doble clic o Enter: reabrir · Mayús+clic: rango · Espacio: seleccionar'
                  : prefs.view === 'cards'
                    ? 'Clic: detalle · doble clic: reabrir · Ctrl+clic: seleccionar · las miniaturas se activan en Reglas'
                    : 'Agrupado por día y por sesión de trabajo (pausas de más de 45 min) · el orden y la fecha siguen a «Orden»'}
              </span>
            )}
          </div>
        )}

        {prefs.view === 'list' && (
          <div class="lhead" aria-hidden="true">
            <span class="c-check">
              <input
                type="checkbox"
                tabIndex={-1}
                checked={allFilteredSelected}
                onClick={() => (allFilteredSelected ? unselectFiltered() : selectAllFiltered())}
                title="Seleccionar todos los filtrados"
              />
            </span>
            <span />
            <span>Título</span>
            <span />
            <span>Dominio</span>
            <span>Estado</span>
            <span>{prefs.sortKey === 'created' ? 'Creación' : prefs.sortKey === 'archived' ? 'Archivado' : 'Fecha'}</span>
            <span />
          </div>
        )}

        {!loaded ? (
          <div class="center-pad">
            <Spinner label="Cargando referencias…" />
          </div>
        ) : error ? (
          <div class="notice notice-danger">No se pudo leer la base de datos: {error}</div>
        ) : prefs.view === 'cards' ? (
          <CardGrid
            items={filtered}
            selection={selection}
            activeId={drawerId}
            sortKey={prefs.sortKey}
            now={now}
            resetKey={resetKey}
            empty={emptyEl}
            onCardClick={onRowClick}
            onToggle={toggleOne}
            onOpen={(r) => (r.state === 'open' ? setDrawerId(r.id) : void reopenRecords([r.id]))}
          />
        ) : prefs.view === 'timeline' ? (
          <Timeline
            items={filtered}
            sortKey={prefs.sortKey}
            sortDir={prefs.sortDir}
            now={now}
            selection={selection}
            activeId={drawerId}
            resetKey={resetKey}
            empty={emptyEl}
            onRowClick={clickAt}
            onToggle={(r) => toggleOne(r, indexOf.get(r.id) ?? 0, false)}
            onOpen={(r) => (r.state === 'open' ? setDrawerId(r.id) : void reopenRecords([r.id]))}
            onSelectIds={selectIds}
          />
        ) : prefs.view === 'topics' ? (
          <div class="records topics-scroll">
            <TopicsView
              records={filtered}
              byId={byId}
              projects={projectOpts.map((p) => p.value)}
              onSelect={(ids) => {
                setSelection(new Set(ids));
                toast('Seleccionadas ' + plural(ids.length, 'referencia', 'referencias') + ': usá las acciones de arriba.', { kind: 'info' });
              }}
              onOpenDrawer={(id) => setDrawerId(id)}
            />
          </div>
        ) : (
          <VirtualList
            items={filtered}
            rowHeight={ROW_H}
            renderRow={renderRow}
            getKey={(r) => r.id}
            resetKey={resetKey}
            ensureVisible={ensure}
            class="records"
            containerRef={listRef}
            containerProps={{
              tabIndex: 0,
              role: 'listbox',
              'aria-label': 'Referencias',
              'aria-multiselectable': true,
              'aria-activedescendant': cursorRec ? `row-${cursorRec.id}` : undefined,
              onKeyDown: onListKey,
              onFocus: () => {
                if (cursor < 0 && filtered.length) setCursor(0);
              },
            }}
            empty={emptyEl}
          />
        )}
      </div>
      {drawerId && byId.get(drawerId) && (
        <Drawer record={byId.get(drawerId) as TabRecord} onClose={() => setDrawerId(null)} projects={projectOpts.map((p) => p.value)} tags={tagOpts.map((t) => t.value)} />
      )}
    </div>
  );
}
