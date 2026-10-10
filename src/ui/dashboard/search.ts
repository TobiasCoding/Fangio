// Pure search / filter / sort helpers for the list view. Designed for 10k records:
// haystacks are cached per record object (records are immutable snapshots, so a
// changed record is a new object and gets a new haystack).

import type { TabRecord } from '../../shared/types';
import { fold } from '../common/format';

const hayCache = new WeakMap<TabRecord, string>();

export function haystack(r: TabRecord): string {
  let h = hayCache.get(r);
  if (h === undefined) {
    h = fold(`${r.title}\n${r.url}\n${r.note}\n${r.tags.join(' ')}\n${r.project}`);
    hayCache.set(r, h);
  }
  return h;
}

export function tokenize(q: string): string[] {
  return fold(q).split(/\s+/).filter(Boolean);
}

export type StateFilter = 'active' | 'open' | 'archived' | 'trash';
export type SortKey = 'accessed' | 'archived' | 'created' | 'title' | 'domain';
export type SortDir = 'asc' | 'desc';

export const STATE_FILTER_LABELS: Record<StateFilter, string> = {
  active: 'Todas activas',
  open: 'Abiertas',
  archived: 'Archivadas',
  trash: 'Papelera',
};

export const SORT_LABELS: Record<SortKey, string> = {
  accessed: 'Último acceso',
  archived: 'Fecha de archivado',
  created: 'Creación / importación',
  title: 'Título',
  domain: 'Dominio',
};

export interface Filters {
  q: string;
  state: StateFilter;
  /** null = any domain. */
  domain: string | null;
  /** Record must have all of these tags. */
  tags: string[];
  /** null = any; '' = without project. */
  project: string | null;
  pendingOnly: boolean;
  protectedOnly: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  q: '',
  state: 'active',
  domain: null,
  tags: [],
  project: null,
  pendingOnly: false,
  protectedOnly: false,
};

export function matchesState(r: TabRecord, s: StateFilter): boolean {
  return s === 'active' ? r.state !== 'trash' : r.state === s;
}

export function accessedOf(r: TabRecord): number | undefined {
  return r.lastAccessedAt ?? r.reopenedAt ?? r.openedAt ?? r.createdAt;
}

export function archivedOf(r: TabRecord): number | undefined {
  return r.state === 'trash' ? (r.trashedAt ?? r.archivedAt) : r.archivedAt;
}

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Sorted copy. Unknown dates always go last regardless of direction. */
export function sortRecords(list: TabRecord[], key: SortKey, dir: SortDir): TabRecord[] {
  const out = list.slice();
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'title' || key === 'domain') {
    const keyOf = key === 'title' ? (r: TabRecord) => r.title || r.url : (r: TabRecord) => r.domain;
    out.sort((a, b) => sign * collator.compare(keyOf(a), keyOf(b)) || collator.compare(a.title, b.title));
    return out;
  }
  const dateOf = key === 'accessed' ? accessedOf : key === 'archived' ? archivedOf : (r: TabRecord) => r.createdAt;
  // decorate-sort-undecorate: avoids recomputing keys in the comparator
  const dec = out.map((r) => ({ r, k: dateOf(r) }));
  dec.sort((a, b) => {
    if (a.k === undefined) return b.k === undefined ? 0 : 1;
    if (b.k === undefined) return -1;
    return sign * (a.k - b.k);
  });
  return dec.map((d) => d.r);
}

/** Filters an already sorted list (order preserved). */
export function filterRecords(sorted: TabRecord[], f: Filters): TabRecord[] {
  const tokens = tokenize(f.q);
  const tags = f.tags;
  return sorted.filter((r) => {
    if (!matchesState(r, f.state)) return false;
    if (f.domain !== null && r.domain !== f.domain) return false;
    if (f.project !== null && r.project !== f.project) return false;
    if (f.pendingOnly && !r.pending) return false;
    if (f.protectedOnly && !r.protected) return false;
    for (const t of tags) if (!r.tags.includes(t)) return false;
    if (tokens.length) {
      const h = haystack(r);
      for (const t of tokens) if (!h.includes(t)) return false;
    }
    return true;
  });
}

export function isFiltered(f: Filters): boolean {
  return !!(f.q.trim() || f.domain !== null || f.tags.length || f.project !== null || f.pendingOnly || f.protectedOnly);
}

/** Date shown in the row, depending on sort key and state. */
export function rowDate(r: TabRecord, key: SortKey): { ms: number | undefined; label: string } {
  if (key === 'created') return { ms: r.createdAt, label: r.importedAt ? 'Importada' : 'Creada' };
  if (key === 'archived') return { ms: archivedOf(r), label: r.state === 'trash' ? 'En papelera' : 'Archivada' };
  if (key === 'accessed') return { ms: accessedOf(r), label: 'Último acceso' };
  if (r.state === 'archived') return { ms: r.archivedAt, label: 'Archivada' };
  if (r.state === 'trash') return { ms: r.trashedAt, label: 'En papelera' };
  return { ms: accessedOf(r), label: 'Último acceso' };
}

/** Counts per key for facet lists, sorted by count desc then name. */
export function countBy(list: TabRecord[], keys: (r: TabRecord) => string | string[]): { value: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of list) {
    const k = keys(r);
    if (Array.isArray(k)) for (const x of k) m.set(x, (m.get(x) ?? 0) + 1);
    else m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value));
}
