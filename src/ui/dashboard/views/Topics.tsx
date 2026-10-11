// Temas: groups suggested by the contextual engine (shared terms + time proximity +
// opener/group links), with the evidence that produced them (search -> AI chat -> sites
// trail, shared terms) and one-click actions: select, project, tag, Chrome tab group,
// reopen, archive, dismiss. Optional names from Chrome's on-device AI.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import type { Suggestion } from '../../../core/context/engine';
import type { SiteKind } from '../../../core/context/text';
import { errMsg, send } from '../../common/api';
import { confirmDialog, promptDialog, toast } from '../../common/feedback';
import { fmtNum, parseTags, plural } from '../../common/format';
import { Favicon, Spinner, StateBadge } from '../../common/widgets';
import { clearDismissed, dismiss, isDismissed, loadDismissed, loadNames, saveName, undismiss, useContextAnalysis } from '../context';
import { aiAvailability, nameGroup, startAi, type AiAvailability } from '../localAi';
import { closeRecords, editRecords, reopenRecords } from '../ops';
import { hueOf, Thumb } from './CardGrid';

const KIND_LABEL: Record<SiteKind, string> = { search: 'Búsqueda', ai: 'Chat con IA', video: 'Video', page: 'Sitio' };
const MAX_AI_GROUPS = 24;

export function KindIcon({ kind }: { kind: SiteKind }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': true } as const;
  if (kind === 'search')
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" stroke-linecap="round" />
      </svg>
    );
  if (kind === 'ai')
    return (
      <svg {...common}>
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round" />
      </svg>
    );
  if (kind === 'video')
    return (
      <svg {...common}>
        <rect x="1.5" y="3" width="13" height="10" rx="2" />
        <path d="M6.5 6v4l3.5-2z" fill="currentColor" stroke="none" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </svg>
  );
}

const rangeFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const timeFmt = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function spanLabel(s: Suggestion): string {
  if (s.start === undefined || s.end === undefined) return 'Sin fechas de actividad';
  const sameDay = new Date(s.start).toDateString() === new Date(s.end).toDateString();
  const startTime = timeFmt.format(s.start);
  const endTime = timeFmt.format(s.end);
  if (sameDay) return rangeFmt.format(s.start) + (endTime !== startTime ? ' – ' + endTime : '');
  return rangeFmt.format(s.start) + ' → ' + rangeFmt.format(s.end);
}

function affinity(score: number): { label: string; cls: string } {
  if (score >= 0.7) return { label: 'Afinidad alta', cls: 'aff-high' };
  if (score >= 0.45) return { label: 'Afinidad media', cls: 'aff-mid' };
  return { label: 'Afinidad baja', cls: 'aff-low' };
}

const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
function colorFor(key: string): string {
  return CHROME_COLORS[(hueOf(key) % (CHROME_COLORS.length - 1)) + 1]!;
}

export interface TopicsProps {
  records: TabRecord[];
  byId: ReadonlyMap<string, TabRecord>;
  projects: string[];
  onSelect: (ids: string[]) => void;
  onOpenDrawer: (id: string) => void;
}

interface CardProps {
  s: Suggestion;
  name: string;
  aiNamed: boolean;
  outliers: string[];
  byId: ReadonlyMap<string, TabRecord>;
  projects: string[];
  onRename: (name: string) => void;
  onRemove: (ids: string[]) => void;
  onDismiss: () => void;
  onSelect: (ids: string[]) => void;
  onOpenDrawer: (id: string) => void;
}

function TopicCard(p: CardProps) {
  const { s } = p;
  const [expanded, setExpanded] = useState(false);
  const recs = s.ids.map((id) => p.byId.get(id)).filter((r): r is TabRecord => !!r);
  const open = recs.filter((r) => r.state === 'open');
  const aff = affinity(s.score);
  const central = s.central.map((id) => p.byId.get(id)).filter((r): r is TabRecord => !!r).slice(0, 4);
  const shown = expanded ? recs.slice(0, 60) : recs.slice(0, 5);
  const ids = recs.map((r) => r.id);
  const inProject = s.project ? recs.filter((r) => r.project === s.project).length : 0;

  const assignProject = async () => {
    const v = await promptDialog({
      title: 'Asignar proyecto a ' + plural(ids.length, 'referencia', 'referencias'),
      input: { label: 'Proyecto', initial: s.project ?? p.name, suggestions: p.projects },
      confirmLabel: 'Asignar',
    });
    if (v !== null && v.trim()) void editRecords(ids, { project: v.trim() }, 'Proyecto asignado');
  };
  const addTag = async () => {
    const v = await promptDialog({
      title: 'Etiquetar ' + plural(ids.length, 'referencia', 'referencias'),
      input: { label: 'Etiquetas (separadas por coma)', initial: (s.keywords[0] ?? p.name).toLowerCase() },
      confirmLabel: 'Etiquetar',
    });
    const tags = v ? parseTags(v) : [];
    if (tags.length) void editRecords(ids, { addTags: tags }, 'Etiquetadas');
  };
  const groupInChrome = async () => {
    try {
      const r = await send({ type: 'groupTabs', recordIds: open.map((x) => x.id), title: p.name, color: colorFor(s.key) });
      toast(
        r.grouped
          ? 'Agrupadas ' + plural(r.grouped, 'pestaña', 'pestañas') + (r.windows > 1 ? ' en ' + r.windows + ' ventanas' : '') + (r.skipped ? ' (' + r.skipped + ' omitidas: fijadas o cambiaron)' : '')
          : 'No había pestañas para agrupar (fijadas o ya cerradas).',
        { kind: r.grouped ? 'ok' : 'info' },
      );
    } catch (e) {
      toast('No se pudo agrupar: ' + errMsg(e), { kind: 'error' });
    }
  };
  const rename = async () => {
    const v = await promptDialog({ title: 'Nombre del grupo', input: { label: 'Nombre', initial: p.name }, confirmLabel: 'Guardar' });
    if (v !== null && v.trim()) p.onRename(v.trim());
  };

  return (
    <article class="topic" style={{ '--h': String(hueOf(s.key)) }}>
      <div class="topic-head">
        <div class={'topic-mosaic n' + Math.min(4, central.length)} aria-hidden="true">
          {central.map((r) => (
            <div class="topic-tile">
              <Thumb r={r} small />
            </div>
          ))}
        </div>
        <div class="topic-title">
          <h3>
            <button type="button" class="link topic-name" title="Cambiar el nombre" onClick={() => void rename()}>
              {p.name}
            </button>
            {p.aiNamed && <span class="chip chip-ai" title="Nombre sugerido por la IA local de Chrome">IA</span>}
          </h3>
          <div class="topic-meta">
            <span class={'aff ' + aff.cls} title={'Cohesión del grupo: ' + Math.round(s.score * 100) + '%'}>
              {aff.label}
            </span>
            <span>{plural(recs.length, 'referencia', 'referencias')}</span>
            <span>{plural(s.domains.length, 'sitio', 'sitios')}</span>
            <span class="faint">{spanLabel(s)}</span>
          </div>
          <div class="topic-kinds">
            {(Object.keys(KIND_LABEL) as SiteKind[])
              .filter((k) => s.kinds[k] > 0)
              .map((k) => (
                <span class={'kind kind-' + k} title={KIND_LABEL[k]}>
                  <KindIcon kind={k} /> {s.kinds[k]}
                </span>
              ))}
          </div>
        </div>
      </div>

      {s.trail.length > 1 && (
        <ol class="trail" aria-label="Recorrido en el tiempo">
          {s.trail.map((t) => (
            <li>
              <button type="button" class={'trail-step kind-' + t.kind} title={KIND_LABEL[t.kind] + ' · ' + t.domain + ' · ' + timeFmt.format(t.at)} onClick={() => p.onOpenDrawer(t.id)}>
                <KindIcon kind={t.kind} />
                <span class="ellipsis">{t.kind === 'search' ? '«' + t.text + '»' : t.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {s.evidence.length > 0 && (
        <p class="topic-evidence">
          <span class="faint">En común:</span>{' '}
          {s.evidence.slice(0, 5).map((e, i) => (
            <span>
              {i > 0 && ' · '}
              <strong>{e.term}</strong> <span class="faint">×{e.count}</span>
            </span>
          ))}
        </p>
      )}
      {s.project && (
        <p class="topic-note">
          {inProject === recs.length ? 'Ya es el proyecto' : 'Coincide con el proyecto'} <strong>{s.project}</strong>
          {inProject < recs.length && ' (' + inProject + ' de ' + recs.length + '): asignalo para sumar las demás.'}
        </p>
      )}
      {p.outliers.length > 0 && (
        <p class="topic-note topic-note-ai">
          La IA sugiere que {p.outliers.length === 1 ? 'esta no pertenece' : 'estas no pertenecen'}:{' '}
          {p.outliers.map((id) => p.byId.get(id)?.title ?? id).join(' · ')}{' '}
          <button type="button" class="link" onClick={() => p.onRemove(p.outliers)}>
            Quitar del grupo
          </button>
        </p>
      )}

      <ul class="topic-members">
        {shown.map((r) => (
          <li>
            <button type="button" class="topic-member" onClick={() => p.onOpenDrawer(r.id)} title={r.url}>
              <Favicon url={r.url} domain={r.domain} />
              <span class="ellipsis">{r.title || r.url}</span>
              <StateBadge state={r.state} />
            </button>
          </li>
        ))}
      </ul>
      {recs.length > 5 && (
        <button type="button" class="link topic-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Ver menos' : 'Ver las ' + fmtNum(recs.length)}
        </button>
      )}

      <div class="topic-actions">
        <button type="button" class="btn btn-sm btn-primary" onClick={() => p.onSelect(ids)} title="Seleccionarlas para usar las acciones de la lista">
          Seleccionar
        </button>
        <button type="button" class="btn btn-sm" onClick={() => void assignProject()}>
          Proyecto
        </button>
        <button type="button" class="btn btn-sm" onClick={() => void addTag()}>
          Etiquetar
        </button>
        <button type="button" class="btn btn-sm" disabled={!open.length} onClick={() => void groupInChrome()} title="Crea un grupo de pestañas de Chrome con las que están abiertas">
          Agrupar en Chrome{open.length ? ' (' + open.length + ')' : ''}
        </button>
        {recs.some((r) => r.state !== 'open') && (
          <button type="button" class="btn btn-sm" onClick={() => void reopenRecords(recs.filter((r) => r.state !== 'open').map((r) => r.id))}>
            Reabrir
          </button>
        )}
        {open.length > 0 && (
          <button type="button" class="btn btn-sm" onClick={() => void closeRecords(open.map((r) => r.id), 'archive', { confirm: true })}>
            Archivar abiertas
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="btn btn-sm btn-ghost" onClick={p.onDismiss} title="No volver a sugerir este grupo">
          Descartar
        </button>
      </div>
    </article>
  );
}

export function TopicsView(p: TopicsProps) {
  const { result, running, error, refresh } = useContextAnalysis(p.records);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [names, setNames] = useState(loadNames);
  const [removed, setRemoved] = useState<Record<string, string[]>>({});
  const [outliers, setOutliers] = useState<Record<string, string[]>>({});
  const [aiNamed, setAiNamed] = useState<Set<string>>(() => new Set());
  const [showGrouped, setShowGrouped] = useState(false);
  const [ai, setAi] = useState<AiAvailability>('unsupported');
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void aiAvailability().then(setAi);
    return () => abort.current?.abort();
  }, []);

  const visible = useMemo(() => {
    if (!result) return [];
    return result.suggestions
      .map((s) => {
        const gone = new Set(removed[s.key] ?? []);
        return gone.size || s.ids.some((id) => !p.byId.has(id)) ? { ...s, ids: s.ids.filter((id) => !gone.has(id) && p.byId.has(id)) } : s;
      })
      .filter((s) => s.ids.length >= 2 && !isDismissed(s, dismissed))
      .filter((s) => showGrouped || !(s.project && s.ids.every((id) => p.byId.get(id)?.project === s.project)));
  }, [result, removed, dismissed, showGrouped, p.byId]);

  const nameOf = (s: Suggestion) => names[s.key] ?? s.label;

  const runAi = async () => {
    if (ai === 'downloadable') {
      const ok = await confirmDialog({
        title: 'Activar la IA local de Chrome',
        body: (
          <>
            <p>
              Chrome va a descargar una sola vez su modelo integrado (Gemini Nano, varios GB). Después funciona sin conexión y{' '}
              <strong>nada sale de tu equipo</strong>: los títulos se procesan en este dispositivo.
            </p>
            <p class="muted">Requiere un equipo compatible (GPU con más de 4 GB o 16 GB de RAM) y espacio libre en disco.</p>
          </>
        ),
        confirmLabel: 'Descargar y nombrar',
      });
      if (!ok) return;
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      setAiBusy('Preparando el modelo…');
      await startAi((f) => setAiBusy('Descargando el modelo… ' + Math.round(f * 100) + '%'));
      setAi('available');
      const todo = visible.filter((s) => !names[s.key]).slice(0, MAX_AI_GROUPS);
      let done = 0;
      for (const s of todo) {
        if (ctrl.signal.aborted) break;
        setAiBusy('Nombrando ' + (done + 1) + ' de ' + todo.length + '…');
        const members = s.ids.slice(0, 10);
        const res = await nameGroup(
          { key: s.key, keywords: s.keywords, titles: members.map((id) => p.byId.get(id)?.title ?? '') },
          ctrl.signal,
        ).catch(() => null);
        done++;
        if (!res) continue;
        setNames(saveName(s.key, res.name));
        setAiNamed((prev) => new Set(prev).add(s.key));
        if (res.outliers.length) setOutliers((prev) => ({ ...prev, [s.key]: res.outliers.map((i) => members[i]!).filter(Boolean) }));
      }
      toast(done ? 'Grupos nombrados con la IA local: ' + done : 'No había grupos sin nombre propio.', { kind: 'info' });
    } catch (e) {
      if (!ctrl.signal.aborted) toast('La IA local no está disponible: ' + errMsg(e), { kind: 'warn' });
    } finally {
      setAiBusy(null);
    }
  };

  const doDismiss = (s: Suggestion) => {
    setDismissed(dismiss(s));
    toast('Sugerencia descartada: «' + nameOf(s) + '»', {
      kind: 'info',
      actions: [
        {
          label: 'Deshacer',
          onClick: () => setDismissed(undismiss(s.ids)),
        },
      ],
    });
  };

  const stats = result?.stats;
  return (
    <div class="topics">
      <div class="topics-bar">
        <div class="grow">
          {result ? (
            <span>
              <strong>{plural(visible.length, 'grupo sugerido', 'grupos sugeridos')}</strong>{' '}
              <span class="muted">
                a partir de {plural(stats?.docs ?? 0, 'referencia', 'referencias')} · análisis local en {fmtNum(stats?.ms ?? 0)} ms
              </span>
            </span>
          ) : (
            <span class="muted">Analizando…</span>
          )}
          {running && result && <Spinner label="Actualizando…" />}
        </div>
        <label class="check">
          <input type="checkbox" checked={showGrouped} onChange={(e) => setShowGrouped(e.currentTarget.checked)} />
          Mostrar los que ya son un proyecto
        </label>
        {dismissed.length > 0 && (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onClick={() => {
              clearDismissed();
              setDismissed([]);
            }}
          >
            Restablecer descartadas ({dismissed.length})
          </button>
        )}
        {(ai === 'available' || ai === 'downloadable' || ai === 'downloading') && (
          <button type="button" class="btn btn-sm" disabled={!!aiBusy || !visible.length} onClick={() => void runAi()} title="Usa el modelo integrado de Chrome (Gemini Nano), en tu equipo">
            {aiBusy ?? 'Nombrar con IA local'}
          </button>
        )}
        <button type="button" class="btn btn-sm" disabled={running} onClick={refresh}>
          Actualizar
        </button>
      </div>
      <details class="topics-help">
        <summary>Cómo se arman estos grupos</summary>
        <ul>
          <li>
            <strong>Palabras en común</strong> entre títulos, lo que buscaste en Google, Bing, YouTube o Mercado Libre y las palabras de la
            URL. Las que se repiten en todo un sitio (su nombre, «Stack Overflow»…) se ignoran solas.
          </li>
          <li>
            <strong>Cercanía en el tiempo</strong>: lo que abriste o miraste en la misma sesión pesa mucho más que la misma palabra semanas
            después. Así una búsqueda, una conversación con una IA y los sitios que leíste después quedan juntos.
          </li>
          <li>
            <strong>Estructura</strong>: pestañas abiertas desde otra (un enlace), el mismo grupo de Chrome o el mismo proyecto.
          </li>
          <li>
            El grafo resultante se divide en comunidades (algoritmo de Louvain) y cada grupo se nombra con los términos que lo distinguen del
            resto (c-TF-IDF). Todo se calcula en tu equipo; nada se envía a ningún servidor.
          </li>
        </ul>
        <p class="faint">Respeta la búsqueda y los filtros de arriba: filtrá por estado, dominio o etiqueta para analizar sólo una parte.</p>
      </details>

      {error && <div class="notice notice-danger">No se pudo analizar: {error}</div>}
      {!result ? (
        <div class="center-pad">
          <Spinner label="Buscando relaciones entre tus pestañas…" />
        </div>
      ) : visible.length === 0 ? (
        <div class="empty">
          {p.records.length < 3
            ? 'Hacen falta al menos 3 referencias para sugerir grupos.'
            : 'No se encontraron grupos con suficiente relación. A medida que uses el navegador (búsquedas, enlaces, sesiones) van a aparecer.'}
        </div>
      ) : (
        <div class="topic-grid">
          {visible.map((s) => (
            <TopicCard
              key={s.key}
              s={s}
              name={nameOf(s)}
              aiNamed={aiNamed.has(s.key)}
              outliers={(outliers[s.key] ?? []).filter((id) => s.ids.includes(id))}
              byId={p.byId}
              projects={p.projects}
              onRename={(n) => {
                setNames(saveName(s.key, n));
                setAiNamed((prev) => {
                  const x = new Set(prev);
                  x.delete(s.key);
                  return x;
                });
              }}
              onRemove={(ids) => setRemoved((prev) => ({ ...prev, [s.key]: [...(prev[s.key] ?? []), ...ids] }))}
              onDismiss={() => doDismiss(s)}
              onSelect={p.onSelect}
              onOpenDrawer={p.onOpenDrawer}
            />
          ))}
        </div>
      )}
    </div>
  );
}
