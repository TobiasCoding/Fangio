// Thumbnail cache for the dashboard: object URLs loaded lazily in batches from the
// "thumbs" store, evicted LRU (revoking URLs), refreshed on 'thumbs' change events.

import type { TabRecord } from '../../shared/types';
import { getThumbs } from '../../core/db';
import { onChanges } from '../common/api';
import { createStore } from '../common/store';

const MAX_CACHED = 600;

interface Cached {
  src: string;
  url: string;
  at: number;
}

const cache = new Map<string, Cached>(); // insertion order = LRU order
const missing = new Set<string>();
const queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;

/** Bumped whenever cached thumbnails change; components read it with useStore to re-render. */
export const thumbsVersion = createStore(0);

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function evict(): void {
  while (cache.size > MAX_CACHED) {
    const [id, c] = cache.entries().next().value as [string, Cached];
    URL.revokeObjectURL(c.src);
    cache.delete(id);
  }
}

function forget(ids: readonly string[] | null): void {
  if (!ids || ids.length === 0) {
    for (const c of cache.values()) URL.revokeObjectURL(c.src);
    cache.clear();
    missing.clear();
  } else {
    for (const id of ids) {
      const c = cache.get(id);
      if (c) URL.revokeObjectURL(c.src);
      cache.delete(id);
      missing.delete(id);
    }
  }
  thumbsVersion.update((v) => v + 1);
}

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  onChanges((ev) => {
    if (ev.type === 'thumbs') forget(ev.ids.length ? ev.ids : null);
  });
}

async function flush(): Promise<void> {
  timer = null;
  const ids = [...queued];
  queued.clear();
  if (!ids.length) return;
  try {
    const found = await getThumbs(ids);
    for (const id of ids) {
      const t = found.get(id);
      if (!t) {
        missing.add(id);
        continue;
      }
      const old = cache.get(id);
      if (old) URL.revokeObjectURL(old.src);
      cache.set(id, { src: URL.createObjectURL(new Blob([t.data], { type: t.type })), url: t.url, at: t.at });
    }
    evict();
  } catch {
    for (const id of ids) missing.add(id);
  }
  thumbsVersion.update((v) => v + 1);
}

/**
 * Object URL of the record's thumbnail, or undefined (not captured yet / still loading).
 * Only returned when it was captured on the record's current site (a tab that navigated
 * elsewhere keeps its old screenshot until it is seen again).
 */
export function thumbFor(r: Pick<TabRecord, 'id' | 'url'>): { src: string; at: number } | undefined {
  subscribe();
  const c = cache.get(r.id);
  if (c) {
    cache.delete(r.id);
    cache.set(r.id, c);
    return originOf(c.url) === originOf(r.url) ? { src: c.src, at: c.at } : undefined;
  }
  if (!missing.has(r.id) && !queued.has(r.id)) {
    queued.add(r.id);
    if (!timer) timer = setTimeout(() => void flush(), 30);
  }
  return undefined;
}
