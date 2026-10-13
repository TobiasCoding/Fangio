// Cards view: virtualized grid of single-block cards (favicon, site, date, title, marks).
// What a card shows is configurable (cardPrefs.ts); the default is minimal, without image
// or colors. Poster/Thumb are also used by the Topics view.

import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import { faviconUrl, fmtDateTime, fmtRelative } from '../../common/format';
import { useStore } from '../../common/store';
import { Favicon, StateBadge } from '../../common/widgets';
import { cardMetrics, cardPrefsStore, DEFAULT_CARD_PREFS, setCardPrefs } from '../cardPrefs';
import type { CardPrefs } from '../cardPrefs';
import { settingsStore } from '../data';
import { usePopover } from '../Facets';
import type { SortKey } from '../search';
import { rowDate } from '../search';
import { thumbFor, thumbsVersion } from '../thumbCache';
import { VirtualList } from '../VirtualList';

const GAP = 12;
const PAD = 16;

/** Stable hue per site, used for posters and accents. */
export function hueOf(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Poster({ r, small }: { r: Pick<TabRecord, 'url' | 'domain' | 'title'>; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const hue = hueOf(r.domain || r.url);
  const letter = (r.domain || '?').charAt(0).toUpperCase();
  return (
    <div class={`poster${small ? ' poster-sm' : ''}`} style={{ '--h': String(hue) }} aria-hidden="true">
      <span class="poster-icon">
        {failed ? <span class="poster-letter">{letter}</span> : <img src={faviconUrl(r.url, 32)} width={32} height={32} alt="" onError={() => setFailed(true)} />}
      </span>
      {!small && <span class="poster-domain ellipsis">{r.domain}</span>}
    </div>
  );
}

export function Thumb({ r, small }: { r: TabRecord; small?: boolean }) {
  useStore(thumbsVersion);
  const t = thumbFor(r);
  if (!t) return <Poster r={r} small={small} />;
  return <img class="thumb-img" src={t.src} alt="" title={`Captura: ${fmtDateTime(t.at)}`} loading="lazy" decoding="async" />;
}

/** Thumbnail inside a card; without one, a neutral placeholder (or the colored poster when colors are on). */
function CardImage({ r, colors }: { r: TabRecord; colors: boolean }) {
  useStore(thumbsVersion);
  const t = thumbFor(r);
  if (t) return <img class="thumb-img" src={t.src} alt="" title={`Captura: ${fmtDateTime(t.at)}`} loading="lazy" decoding="async" />;
  if (colors) return <Poster r={r} small />;
  return (
    <div class="thumb-ph" aria-hidden="true">
      <Favicon url={r.url} domain={r.domain} />
    </div>
  );
}

export interface CardGridProps {
  items: TabRecord[];
  selection: ReadonlySet<string>;
  activeId: string | null;
  sortKey: SortKey;
  now: number;
  resetKey: unknown;
  empty: preact.ComponentChildren;
  onCardClick: (e: MouseEvent, r: TabRecord, i: number) => void;
  onToggle: (r: TabRecord, i: number, shift: boolean) => void;
  onOpen: (r: TabRecord) => void;
}

export function CardGrid(p: CardGridProps) {
  const prefs = useStore(cardPrefsStore);
  const m = cardMetrics(prefs);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(1, Math.floor((width - 2 * PAD + GAP) / (m.minWidth + GAP)));
  const rows = useMemo(() => {
    const out: { start: number; items: TabRecord[] }[] = [];
    for (let i = 0; i < p.items.length; i += cols) out.push({ start: i, items: p.items.slice(i, i + cols) });
    return out;
  }, [p.items, cols]);

  const card = (r: TabRecord, i: number) => {
    const sel = p.selection.has(r.id);
    const d = rowDate(r, p.sortKey);
    const title = r.title || r.url;
    const marks = prefs.showMarks && (r.protected || r.pending || !!r.project || r.tags.length > 0);
    return (
      <article
        class={`rcard${sel ? ' is-sel' : ''}${p.activeId === r.id ? ' is-open' : ''}${prefs.colors ? ' has-colors' : ''} state-${r.state}`}
        style={{ '--h': String(hueOf(r.domain || r.url)) }}
        onClick={(e) => p.onCardClick(e, r, i)}
        onDblClick={() => p.onOpen(r)}
        aria-label={title}
      >
        {prefs.image === 'thumb' && (
          <div class="rcard-thumb" style={{ height: `${m.thumbHeight}px` }}>
            <CardImage r={r} colors={prefs.colors} />
          </div>
        )}
        <div class="rcard-head">
          <span class="rcard-icon">
            <Favicon url={r.url} domain={r.domain} />
            <label class="rcard-check" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={sel} aria-label={`Seleccionar ${title}`} onClick={(e) => p.onToggle(r, i, e.shiftKey)} />
            </label>
          </span>
          {prefs.showDomain && <span class="rcard-domain ellipsis">{r.domain}</span>}
          <span class="spacer" />
          {prefs.showState && <StateBadge state={r.state} />}
        </div>
        <h3 class="rcard-title" style={{ WebkitLineClamp: String(m.titleLines) }} title={`${title}\n${r.url}`}>
          {title}
        </h3>
        {prefs.showUrl && <div class="rcard-url ellipsis">{r.url}</div>}
        {(prefs.showMarks || prefs.showDate) && (
          <div class="rcard-foot">
            {marks && (
              <>
                {r.protected && <span class="chip chip-protected">Protegida</span>}
                {r.pending && <span class="chip chip-pending">Pendiente</span>}
                {r.project && <span class="chip">{r.project}</span>}
                {r.tags.slice(0, 3).map((t) => (
                  <span class="chip chip-tag">{t}</span>
                ))}
              </>
            )}
            <span class="spacer" />
            {prefs.showDate && (
              <span class="rcard-date" title={`${d.label}: ${fmtDateTime(d.ms)}`}>
                {fmtRelative(d.ms, p.now)}
              </span>
            )}
          </div>
        )}
      </article>
    );
  };

  return (
    <div class="cardgrid-wrap" ref={wrap}>
      <VirtualList
        items={rows}
        rowHeight={m.height + GAP}
        overscan={3}
        class="cardgrid records"
        resetKey={p.resetKey}
        getKey={(row) => row.items[0]?.id ?? row.start}
        containerProps={{ role: 'list', 'aria-label': 'Referencias en tarjetas' }}
        empty={p.empty}
        renderRow={(row) => (
          <div class="cardrow" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, height: `${m.height}px` }}>
            {row.items.map((r, k) => card(r, row.start + k))}
          </div>
        )}
      />
    </div>
  );
}

const SHOW_OPTIONS: { key: keyof Pick<CardPrefs, 'showDomain' | 'showDate' | 'showUrl' | 'showMarks' | 'showState' | 'colors'>; label: string }[] = [
  { key: 'showDomain', label: 'Sitio' },
  { key: 'showDate', label: 'Fecha' },
  { key: 'showUrl', label: 'URL completa' },
  { key: 'showMarks', label: 'Marcas, proyecto y etiquetas' },
  { key: 'showState', label: 'Estado (abierta, archivada…)' },
  { key: 'colors', label: 'Colores por sitio' },
];

/** Toolbar button: what the cards show and how big they are. */
export function CardPrefsMenu() {
  const prefs = useStore(cardPrefsStore);
  const settings = useStore(settingsStore);
  const { open, setOpen, ref } = usePopover();
  const seg = <K extends 'image' | 'size'>(key: K, opts: [CardPrefs[K], string][]) => (
    <div class="seg" role="group">
      {opts.map(([v, label]) => (
        <button type="button" class={`seg-btn${prefs[key] === v ? ' is-on' : ''}`} aria-pressed={prefs[key] === v} onClick={() => setCardPrefs({ [key]: v })}>
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div class="facet" ref={ref}>
      <button type="button" class="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        Diseño de tarjetas ▾
      </button>
      {open && (
        <div class="facet-pop cardprefs" role="dialog" aria-label="Diseño de tarjetas">
          <div class="cardprefs-row">
            <span class="muted">Imagen</span>
            {seg('image', [
              ['none', 'Sin imagen'],
              ['thumb', 'Miniatura'],
            ])}
          </div>
          {prefs.image === 'thumb' && !settings?.thumbnails && <p class="faint cardprefs-hint">Las miniaturas se capturan si las activás en Reglas.</p>}
          <div class="cardprefs-row">
            <span class="muted">Tamaño</span>
            {seg('size', [
              ['compact', 'Compacta'],
              ['comfortable', 'Cómoda'],
            ])}
          </div>
          <div class="cardprefs-list">
            {SHOW_OPTIONS.map((o) => (
              <label class="check">
                <input type="checkbox" checked={prefs[o.key]} onChange={(e) => setCardPrefs({ [o.key]: e.currentTarget.checked })} />
                {o.label}
              </label>
            ))}
          </div>
          <button type="button" class="link" onClick={() => setCardPrefs({ ...DEFAULT_CARD_PREFS })}>
            Restablecer (minimalista)
          </button>
        </div>
      )}
    </div>
  );
}
