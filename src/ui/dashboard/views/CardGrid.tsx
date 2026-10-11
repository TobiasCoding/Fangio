// Cards view: virtualized grid of records with a page thumbnail (when captured) or a
// generated poster (site color + large favicon) as fallback.

import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import { faviconUrl, fmtDateTime, fmtRelative } from '../../common/format';
import { useStore } from '../../common/store';
import { StateBadge } from '../../common/widgets';
import type { SortKey } from '../search';
import { rowDate } from '../search';
import { thumbFor, thumbsVersion } from '../thumbCache';
import { VirtualList } from '../VirtualList';

const CARD_MIN_W = 230;
const CARD_H = 248;
const GAP = 14;
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
  const cols = Math.max(1, Math.floor((width - 2 * PAD + GAP) / (CARD_MIN_W + GAP)));
  const rows = useMemo(() => {
    const out: { start: number; items: TabRecord[] }[] = [];
    for (let i = 0; i < p.items.length; i += cols) out.push({ start: i, items: p.items.slice(i, i + cols) });
    return out;
  }, [p.items, cols]);

  const card = (r: TabRecord, i: number) => {
    const sel = p.selection.has(r.id);
    const d = rowDate(r, p.sortKey);
    const title = r.title || r.url;
    return (
      <article
        class={`rcard${sel ? ' is-sel' : ''}${p.activeId === r.id ? ' is-open' : ''} state-${r.state}`}
        style={{ '--h': String(hueOf(r.domain || r.url)) }}
        onClick={(e) => p.onCardClick(e, r, i)}
        onDblClick={() => p.onOpen(r)}
        aria-label={title}
      >
        <div class="rcard-media">
          <Thumb r={r} />
          <label class="rcard-check" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={sel} aria-label={`Seleccionar ${title}`} onClick={(e) => p.onToggle(r, i, e.shiftKey)} />
          </label>
          <span class="rcard-state">
            <StateBadge state={r.state} />
          </span>
        </div>
        <div class="rcard-body">
          <div class="rcard-meta">
            <img class="fav" src={faviconUrl(r.url)} width={16} height={16} alt="" loading="lazy" />
            <span class="ellipsis">{r.domain}</span>
            <span class="spacer" />
            <span class="faint" title={`${d.label}: ${fmtDateTime(d.ms)}`}>
              {fmtRelative(d.ms, p.now)}
            </span>
          </div>
          <h3 class="rcard-title" title={`${title}\n${r.url}`}>
            {title}
          </h3>
          <div class="rcard-chips">
            {r.protected && <span class="chip chip-protected">Protegida</span>}
            {r.pending && <span class="chip chip-pending">Pendiente</span>}
            {r.project && <span class="chip">{r.project}</span>}
            {r.tags.slice(0, 2).map((t) => (
              <span class="chip chip-tag">{t}</span>
            ))}
          </div>
        </div>
      </article>
    );
  };

  return (
    <div class="cardgrid-wrap" ref={wrap}>
      <VirtualList
        items={rows}
        rowHeight={CARD_H + GAP}
        overscan={3}
        class="cardgrid records"
        resetKey={p.resetKey}
        getKey={(row) => row.items[0]?.id ?? row.start}
        containerProps={{ role: 'list', 'aria-label': 'Referencias en tarjetas' }}
        empty={p.empty}
        renderRow={(row) => (
          <div class="cardrow" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, height: `${CARD_H}px` }}>
            {row.items.map((r, k) => card(r, row.start + k))}
          </div>
        )}
      />
    </div>
  );
}
