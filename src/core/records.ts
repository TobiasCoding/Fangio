// Pure helpers to build and update TabRecords.

import { MAX_PREVIOUS_URLS, MAX_TITLE_LENGTH, STARTUP_GRACE_MS } from '../shared/constants';
import type { ActionEntry, ActionKind, RecordPatch, RecordSource, TabOrigin, TabRecord } from '../shared/types';
import { domainOf, sanitizeFavicon, tabUrl } from './url';

export type GroupInfo = { title?: string; color?: string };
export type GroupMap = ReadonlyMap<number, GroupInfo>;

/** 1-based ordinal of each window id (ascending id order). Informative only. */
export function windowOrdinals(tabs: readonly chrome.tabs.Tab[]): Map<number, number> {
  const ids = [...new Set(tabs.map((t) => t.windowId))].sort((a, b) => a - b);
  return new Map(ids.map((id, i) => [id, i + 1]));
}

export function originOf(tab: chrome.tabs.Tab, ordinals: ReadonlyMap<number, number>, groups?: GroupMap): TabOrigin {
  const o: TabOrigin = { index: tab.index };
  const ord = ordinals.get(tab.windowId);
  if (ord !== undefined) o.windowOrdinal = ord;
  if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
    const g = groups?.get(tab.groupId);
    if (g?.title) o.groupTitle = g.title;
    if (g?.color) o.groupColor = g.color;
  }
  return o;
}

export function clampTitle(title: string | undefined, fallback: string): string {
  const t = (title ?? '').trim() || fallback;
  return t.length > MAX_TITLE_LENGTH ? t.slice(0, MAX_TITLE_LENGTH) : t;
}

export interface NewRecordCtx {
  now: number;
  sessionId: string;
  startupAt: number;
  source: RecordSource;
  ordinals: ReadonlyMap<number, number>;
  groups?: GroupMap;
}

export function newRecordFromTab(tab: chrome.tabs.Tab, ctx: NewRecordCtx): TabRecord {
  const url = tabUrl(tab);
  const rec: TabRecord = {
    id: crypto.randomUUID(),
    url,
    title: clampTitle(tab.title, url),
    domain: domainOf(url),
    state: 'open',
    protected: false,
    pending: false,
    tags: [],
    project: '',
    note: '',
    source: ctx.source,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    origin: originOf(tab, ctx.ordinals, ctx.groups),
    previousUrls: [],
    reopenCount: 0,
    mergedFrom: [],
    live: { tabId: tab.id!, windowId: tab.windowId, sessionId: ctx.sessionId, boundAt: ctx.now },
    pendingClose: null,
    rev: 0,
  };
  const fav = sanitizeFavicon(tab.favIconUrl);
  if (fav) rec.favIconUrl = fav;
  if (ctx.source === 'install-snapshot') rec.importedAt = ctx.now;
  else if (ctx.now - ctx.startupAt >= STARTUP_GRACE_MS) rec.openedAt = ctx.now;
  if (typeof tab.lastAccessed === 'number' && tab.lastAccessed > 0) rec.lastAccessedAt = tab.lastAccessed;
  if (tab.audible) rec.lastAudibleAt = ctx.now;
  return rec;
}

/**
 * Applies fresh tab data (url, title, favicon, window) to a record in place.
 * A changed trackable URL moves the old one into previousUrls. Returns true if anything changed.
 */
export function applyTabData(rec: TabRecord, tab: chrome.tabs.Tab, opts: { updateUrl?: boolean } = {}): boolean {
  let changed = false;
  const url = tabUrl(tab);
  if (opts.updateUrl !== false && url && url !== rec.url) {
    rec.previousUrls = [rec.url, ...rec.previousUrls.filter((u) => u !== rec.url && u !== url)].slice(0, MAX_PREVIOUS_URLS);
    rec.url = url;
    rec.domain = domainOf(url);
    changed = true;
  }
  if (rec.url === url) {
    const title = (tab.title ?? '').trim();
    if (title && title !== rec.title) {
      rec.title = clampTitle(title, rec.url);
      changed = true;
    }
    const fav = sanitizeFavicon(tab.favIconUrl);
    if (fav && fav !== rec.favIconUrl) {
      rec.favIconUrl = fav;
      changed = true;
    }
  }
  if (rec.live && rec.live.windowId !== tab.windowId) {
    rec.live = { ...rec.live, windowId: tab.windowId };
    changed = true;
  }
  return changed;
}

export function maxDefined(...xs: (number | undefined)[]): number | undefined {
  let m: number | undefined;
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x) && (m === undefined || x > m)) m = x;
  return m;
}

/** Minutes since the tab was last viewed (max of our tracking and tab.lastAccessed; falls back to createdAt). */
export function idleMinutesOf(rec: TabRecord | undefined, tab: chrome.tabs.Tab | undefined, now: number): number {
  const last = maxDefined(rec?.lastAccessedAt, tab?.lastAccessed) ?? rec?.createdAt ?? now;
  return Math.max(0, (now - last) / 60000);
}

/** "45 min", "26 h", "3 días". */
export function formatAgo(minutes: number): string {
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  const h = minutes / 60;
  if (h < 48) return `${Math.floor(h)} h`;
  return `${Math.floor(h / 24)} días`;
}

/** Fields undo needs to restore a state change. */
export function stateSnapshot(r: TabRecord): RecordPatch {
  const p: RecordPatch = { state: r.state, lastReason: r.lastReason, archivedAt: r.archivedAt, trashedAt: r.trashedAt };
  if (r.implicitCloseAt !== undefined) p.implicitCloseAt = r.implicitCloseAt;
  return p;
}

export function newAction(kind: ActionKind, init: Partial<ActionEntry> & { reason: string }): ActionEntry {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind,
    auto: false,
    recordIds: [],
    undoable: false,
    ...init,
  };
}

/** Live binding valid in the given session. */
export function isBoundIn(r: TabRecord, sessionId: string): boolean {
  return r.state === 'open' && !!r.live && r.live.sessionId === sessionId;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
