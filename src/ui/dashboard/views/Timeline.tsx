// Timeline view: references grouped by day and, inside a day, by work session (bursts of
// activity separated by more than SESSION_GAP_MS). Each day shows a 24-hour activity strip;
// day and session headers can select their references for bulk actions.

import { useMemo } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import { fmtNum, plural } from '../../common/format';
import { Favicon, StateBadge } from '../../common/widgets';
import { accessedOf, archivedOf, type SortDir, type SortKey } from '../search';
import { VirtualList } from '../VirtualList';

export const SESSION_GAP_MS = 45 * 60 * 1000;
const ROW_H = 32;

export type TimelineRow =
  | { kind: 'day'; key: string; label: string; count: number; hours: number[]; ids: string[] }
  | { kind: 'session'; key: string; label: string; ids: string[] }
  | { kind: 'rec'; key: string; r: TabRecord; at: number | undefined; index: number };

/** Date the timeline uses for the current sort key ("Creación" = when it was opened when known). */
export function timelineDate(r: TabRecord, key: SortKey): number | undefined {
  if (key === 'archived') return archivedOf(r);
  if (key === 'created') return r.openedAt ?? r.createdAt;
  return accessedOf(r);
}

const dayFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function dayKey(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function dayLabel(ms: number, now: number): string {
  const k = dayKey(ms);
  if (k === dayKey(now)) return 'Hoy · ' + dayFmt.format(ms);
  if (k === dayKey(now - 86_400_000)) return 'Ayer · ' + dayFmt.format(ms);
  return dayFmt.format(ms).replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** Pure: flattens records into day / session / record rows (dir = chronological direction). */
export function buildTimeline(items: readonly TabRecord[], key: SortKey, dir: SortDir, now: number): TimelineRow[] {
  const dated = items.map((r) => ({ r, at: timelineDate(r, key) }));
  const known = dated.filter((d) => d.at !== undefined) as { r: TabRecord; at: number }[];
  const unknown = dated.filter((d) => d.at === undefined);
  known.sort((a, b) => (dir === 'desc' ? b.at - a.at : a.at - b.at));
  const rows: TimelineRow[] = [];
  let i = 0;
  let index = 0;
  while (i < known.length) {
    const dk = dayKey(known[i]!.at);
    let j = i;
    while (j < known.length && dayKey(known[j]!.at) === dk) j++;
    const day = known.slice(i, j);
    const hours = new Array<number>(24).fill(0);
    for (const d of day) hours[new Date(d.at).getHours()]!++;
    rows.push({ kind: 'day', key: 'd-' + dk, label: dayLabel(day[0]!.at, now), count: day.length, hours, ids: day.map((d) => d.r.id) });
    // sessions inside the day
    let s = 0;
    while (s < day.length) {
      let e = s + 1;
      while (e < day.length && Math.abs(day[e]!.at - day[e - 1]!.at) <= SESSION_GAP_MS) e++;
      const sess = day.slice(s, e);
      const first = Math.min(sess[0]!.at, sess[sess.length - 1]!.at);
      const last = Math.max(sess[0]!.at, sess[sess.length - 1]!.at);
      const [a, z] = [timeFmt.format(first), timeFmt.format(last)];
      const range = a === z ? a : a + ' – ' + z;
      rows.push({ kind: 'session', key: 's-' + dk + '-' + s, label: range + ' · ' + plural(sess.length, 'referencia', 'referencias'), ids: sess.map((d) => d.r.id) });
      for (const d of sess) rows.push({ kind: 'rec', key: d.r.id, r: d.r, at: d.at, index: index++ });
      s = e;
    }
    i = j;
  }
  if (unknown.length) {
    rows.push({ kind: 'day', key: 'd-unknown', label: 'Sin fecha conocida', count: unknown.length, hours: [], ids: unknown.map((d) => d.r.id) });
    for (const d of unknown) rows.push({ kind: 'rec', key: d.r.id, r: d.r, at: undefined, index: index++ });
  }
  return rows;
}

function HourStrip({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  return (
    <svg class="hourstrip" viewBox="0 0 96 16" width={96} height={16} role="img" aria-label="Actividad por hora">
      {hours.map((v, h) => {
        const height = v ? Math.max(2, (v / max) * 16) : 1;
        return (
          <rect x={h * 4} y={16 - height} width={3} height={height} class={v ? 'hs-on' : 'hs-off'}>
            <title>{String(h).padStart(2, '0') + ' h: ' + v}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export interface TimelineProps {
  items: TabRecord[];
  sortKey: SortKey;
  sortDir: SortDir;
  now: number;
  selection: ReadonlySet<string>;
  activeId: string | null;
  resetKey: unknown;
  empty: preact.ComponentChildren;
  onRowClick: (e: MouseEvent, r: TabRecord) => void;
  onToggle: (r: TabRecord) => void;
  onOpen: (r: TabRecord) => void;
  onSelectIds: (ids: string[], add: boolean) => void;
}

export function Timeline(p: TimelineProps) {
  const hour = Math.floor(p.now / 3_600_000);
  const rows = useMemo(() => buildTimeline(p.items, p.sortKey, p.sortDir, p.now), [p.items, p.sortKey, p.sortDir, hour]);
  const allSel = (ids: string[]) => ids.length > 0 && ids.every((id) => p.selection.has(id));
  const render = (row: TimelineRow) => {
    if (row.kind === 'day') {
      const on = allSel(row.ids);
      return (
        <div class="tl-day">
          <input type="checkbox" checked={on} aria-label={'Seleccionar ' + row.label} title="Seleccionar el día" onClick={() => p.onSelectIds(row.ids, !on)} />
          <strong class="ellipsis">{row.label}</strong>
          <span class="faint">{fmtNum(row.count)}</span>
          <span class="spacer" />
          {row.hours.length > 0 && <HourStrip hours={row.hours} />}
        </div>
      );
    }
    if (row.kind === 'session') {
      const on = allSel(row.ids);
      return (
        <div class="tl-session">
          <input type="checkbox" checked={on} aria-label={'Seleccionar sesión ' + row.label} title="Seleccionar la sesión" onClick={() => p.onSelectIds(row.ids, !on)} />
          <span class="tl-dot" aria-hidden="true" />
          <span class="muted">{row.label}</span>
        </div>
      );
    }
    const r = row.r;
    const sel = p.selection.has(r.id);
    const title = r.title || r.url;
    return (
      <div
        class={'tl-rec' + (sel ? ' is-sel' : '') + (p.activeId === r.id ? ' is-open' : '')}
        onClick={(e) => p.onRowClick(e, r)}
        onDblClick={() => p.onOpen(r)}
        role="option"
        aria-selected={sel}
      >
        <input
          type="checkbox"
          tabIndex={-1}
          checked={sel}
          aria-label={'Seleccionar ' + title}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle(r);
          }}
        />
        <span class="tl-time faint">{row.at !== undefined ? timeFmt.format(row.at) : ''}</span>
        <span class="tl-line" aria-hidden="true" />
        <Favicon url={r.url} domain={r.domain} />
        <span class="ellipsis tl-title" title={title + '\n' + r.url}>
          {title}
        </span>
        <span class="ellipsis c-domain">{r.domain}</span>
        <StateBadge state={r.state} />
      </div>
    );
  };
  return (
    <VirtualList
      items={rows}
      rowHeight={ROW_H}
      renderRow={render}
      getKey={(row) => row.key}
      resetKey={p.resetKey}
      class="records timeline"
      containerProps={{ role: 'listbox', 'aria-label': 'Línea de tiempo', 'aria-multiselectable': true }}
      empty={p.empty}
    />
  );
}
