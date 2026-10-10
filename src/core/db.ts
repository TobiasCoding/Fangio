// IndexedDB access layer (idb). MUST NOT touch chrome.* at import time: UI pages
// import it to read records directly. Every record write is a readwrite
// transaction with durability 'strict' and resolves only after tx.done.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DB_NAME,
  DB_VERSION,
  STORE_ACTIONS,
  STORE_KV,
  STORE_OPS,
  STORE_RECORDS,
  WRITE_BATCH_SIZE,
} from '../shared/constants';
import { sanitizeSettings } from '../shared/settings';
import type { ActionEntry, OpJournal, RecordState, Settings, TabRecord } from '../shared/types';

interface KvEntry {
  key: string;
  value: unknown;
}

type StoredOp = OpJournal & { finishedFlag: 0 | 1 };

interface FangioDB extends DBSchema {
  records: {
    key: string;
    value: TabRecord;
    indexes: { state: string; url: string; domain: string; tags: string; updatedAt: number };
  };
  actions: { key: string; value: ActionEntry; indexes: { at: number } };
  ops: { key: string; value: StoredOp; indexes: { finishedFlag: number } };
  kv: { key: string; value: KvEntry };
}

export type FangioDb = IDBPDatabase<FangioDB>;

/**
 * Test hooks. Production code never sets them.
 * - beforeWrite(store): called before every write transaction; may throw to simulate a storage failure.
 * - afterWrite(store): called after a write transaction committed (tx.done resolved).
 * - checkpoint(name): called by multi-phase operations at named points; may return a
 *   never-resolving promise to simulate the service worker being killed at that point.
 */
export const testHooks: {
  beforeWrite?: (store: string) => void;
  afterWrite?: (store: string) => void;
  checkpoint?: (name: string) => void | Promise<void>;
} = {};

let dbPromise: Promise<FangioDb> | null = null;

export function getDb(): Promise<FangioDb> {
  if (!dbPromise) {
    const p = openDB<FangioDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Additive migrations only: never drop stores with user data.
        if (oldVersion < 1) {
          const records = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
          records.createIndex('state', 'state');
          records.createIndex('url', 'url');
          records.createIndex('domain', 'domain');
          records.createIndex('tags', 'tags', { multiEntry: true });
          records.createIndex('updatedAt', 'updatedAt');
          const actions = db.createObjectStore(STORE_ACTIONS, { keyPath: 'id' });
          actions.createIndex('at', 'at');
          const ops = db.createObjectStore(STORE_OPS, { keyPath: 'id' });
          ops.createIndex('finishedFlag', 'finishedFlag');
          db.createObjectStore(STORE_KV, { keyPath: 'key' });
        }
      },
      blocking() {
        // A newer version wants to upgrade: release our connection.
        void p.then((db) => db.close()).catch(() => {});
        if (dbPromise === p) dbPromise = null;
      },
      terminated() {
        if (dbPromise === p) dbPromise = null;
      },
    });
    dbPromise = p;
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
  }
  return dbPromise;
}

/** Closes the cached connection (tests: simulate a restart / wipe the DB). */
export async function __resetDbForTests(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (p) {
    try {
      (await p).close();
    } catch {
      /* ignore */
    }
  }
}

function hookBefore(store: string): void {
  testHooks.beforeWrite?.(store);
}
function hookAfter(store: string): void {
  testHooks.afterWrite?.(store);
}

// ------------------------------------------------------------------ records

export async function getAllRecords(): Promise<TabRecord[]> {
  const db = await getDb();
  return db.getAll(STORE_RECORDS);
}

export async function getRecord(id: string): Promise<TabRecord | undefined> {
  if (typeof id !== 'string' || !id) return undefined;
  const db = await getDb();
  return db.get(STORE_RECORDS, id);
}

/** Several records in one readonly transaction (missing ids are omitted). */
export async function getRecordsByIds(ids: readonly string[]): Promise<Map<string, TabRecord>> {
  const out = new Map<string, TabRecord>();
  const list = [...new Set(ids)].filter((x) => typeof x === 'string' && x);
  if (list.length === 0) return out;
  const db = await getDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const res = await Promise.all(list.map((id) => tx.store.get(id)));
  await tx.done;
  for (const r of res) if (r) out.set(r.id, r);
  return out;
}

export async function getRecordsByState(state: RecordState): Promise<TabRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex(STORE_RECORDS, 'state', state);
}

export async function getRecordsByUrl(url: string): Promise<TabRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex(STORE_RECORDS, 'url', url);
}

/** Records for several URLs in one readonly transaction. */
export async function getRecordsByUrls(urls: Iterable<string>): Promise<TabRecord[]> {
  const list = [...new Set(urls)].filter(Boolean);
  if (list.length === 0) return [];
  const db = await getDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const idx = tx.store.index('url');
  const res = await Promise.all(list.map((u) => idx.getAll(u)));
  await tx.done;
  return res.flat();
}

export async function countByState(): Promise<Record<RecordState, number>> {
  const db = await getDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const idx = tx.store.index('state');
  const [open, archived, trash] = await Promise.all([idx.count('open'), idx.count('archived'), idx.count('trash')]);
  await tx.done;
  return { open, archived, trash };
}

export interface PutRecordsOptions {
  /** Keep the updatedAt carried by the records (JSON import). Default: set updatedAt = now. */
  preserveUpdatedAt?: boolean;
}

/**
 * Writes records in batches of WRITE_BATCH_SIZE. Each batch is one readwrite
 * transaction with durability 'strict'; resolves after every tx.done. Rejects on
 * the first failing batch (earlier batches stay committed).
 * Increments rev and sets updatedAt (unless preserveUpdatedAt) on the passed objects.
 */
export async function putRecords(records: readonly TabRecord[], opts: PutRecordsOptions = {}): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (let i = 0; i < records.length; i += WRITE_BATCH_SIZE) {
    const batch = records.slice(i, i + WRITE_BATCH_SIZE);
    hookBefore(STORE_RECORDS);
    const tx = db.transaction(STORE_RECORDS, 'readwrite', { durability: 'strict' });
    const copies = batch.map((r) => ({
      ...r,
      rev: (typeof r.rev === 'number' && Number.isFinite(r.rev) ? r.rev : 0) + 1,
      updatedAt: opts.preserveUpdatedAt && typeof r.updatedAt === 'number' ? r.updatedAt : now,
    }));
    for (const c of copies) void tx.store.put(c).catch(() => {});
    await tx.done;
    // Reflect committed rev/updatedAt on the caller's objects only after commit.
    batch.forEach((r, j) => {
      r.rev = copies[j]!.rev;
      r.updatedAt = copies[j]!.updatedAt;
    });
    hookAfter(STORE_RECORDS);
  }
}

export async function deleteRecords(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  for (let i = 0; i < ids.length; i += WRITE_BATCH_SIZE) {
    const batch = ids.slice(i, i + WRITE_BATCH_SIZE);
    hookBefore(STORE_RECORDS);
    const tx = db.transaction(STORE_RECORDS, 'readwrite', { durability: 'strict' });
    for (const id of batch) void tx.store.delete(id).catch(() => {});
    await tx.done;
    hookAfter(STORE_RECORDS);
  }
}

// ------------------------------------------------------------------ kv / settings

export async function getKv<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const e = await db.get(STORE_KV, key);
  return e ? (e.value as T) : undefined;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  hookBefore(STORE_KV);
  const tx = db.transaction(STORE_KV, 'readwrite', { durability: 'strict' });
  void tx.store.put({ key, value }).catch(() => {});
  await tx.done;
  hookAfter(STORE_KV);
}

/** Sanitized settings; defaults when nothing was stored yet. */
export async function getSettings(): Promise<Settings> {
  return sanitizeSettings(await getKv<Settings>('settings'));
}

/** Sanitizes and stores settings; returns what was stored. */
export async function putSettings(s: Settings): Promise<Settings> {
  const clean = sanitizeSettings(s);
  await setKv('settings', clean);
  return clean;
}

// ------------------------------------------------------------------ actions

/** Newest first. `before` = only entries with at < before. */
export async function getActions(opts: { limit?: number; before?: number } = {}): Promise<ActionEntry[]> {
  const db = await getDb();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const range = typeof opts.before === 'number' ? IDBKeyRange.upperBound(opts.before, true) : undefined;
  const out: ActionEntry[] = [];
  const tx = db.transaction(STORE_ACTIONS, 'readonly');
  let cursor = await tx.store.index('at').openCursor(range, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

export async function getAction(id: string): Promise<ActionEntry | undefined> {
  if (typeof id !== 'string' || !id) return undefined;
  const db = await getDb();
  return db.get(STORE_ACTIONS, id);
}

export async function putAction(a: ActionEntry): Promise<void> {
  await putActions([a]);
}

export async function putActions(list: readonly ActionEntry[]): Promise<void> {
  if (list.length === 0) return;
  const db = await getDb();
  hookBefore(STORE_ACTIONS);
  const tx = db.transaction(STORE_ACTIONS, 'readwrite', { durability: 'strict' });
  for (const a of list) void tx.store.put(a).catch(() => {});
  await tx.done;
  hookAfter(STORE_ACTIONS);
}

/** Deletes action entries with at < cutoff. Returns the number deleted. */
export async function pruneActions(cutoff: number): Promise<number> {
  const db = await getDb();
  const keys = await db.getAllKeysFromIndex(STORE_ACTIONS, 'at', IDBKeyRange.upperBound(cutoff, true));
  if (keys.length === 0) return 0;
  hookBefore(STORE_ACTIONS);
  const tx = db.transaction(STORE_ACTIONS, 'readwrite', { durability: 'strict' });
  for (const k of keys) void tx.store.delete(k).catch(() => {});
  await tx.done;
  hookAfter(STORE_ACTIONS);
  return keys.length;
}

// ------------------------------------------------------------------ ops journal

function stripOp(o: StoredOp): OpJournal {
  const { finishedFlag: _f, ...rest } = o;
  return rest;
}

/** Oldest first. */
export async function getOps(opts: { unfinishedOnly?: boolean } = {}): Promise<OpJournal[]> {
  const db = await getDb();
  const list = opts.unfinishedOnly
    ? await db.getAllFromIndex(STORE_OPS, 'finishedFlag', 0)
    : await db.getAll(STORE_OPS);
  return list.map(stripOp).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getOp(id: string): Promise<OpJournal | undefined> {
  const db = await getDb();
  const o = await db.get(STORE_OPS, id);
  return o ? stripOp(o) : undefined;
}

export async function putOp(op: OpJournal): Promise<void> {
  const db = await getDb();
  op.updatedAt = Date.now();
  const stored: StoredOp = { ...op, items: op.items.map((i) => ({ ...i })), finishedFlag: op.finished ? 1 : 0 };
  hookBefore(STORE_OPS);
  const tx = db.transaction(STORE_OPS, 'readwrite', { durability: 'strict' });
  void tx.store.put(stored).catch(() => {});
  await tx.done;
  hookAfter(STORE_OPS);
}

/** Deletes finished ops last updated before cutoff. */
export async function pruneOps(cutoff: number): Promise<number> {
  const db = await getDb();
  const finished = await db.getAllFromIndex(STORE_OPS, 'finishedFlag', 1);
  const old = finished.filter((o) => o.updatedAt < cutoff);
  if (old.length === 0) return 0;
  hookBefore(STORE_OPS);
  const tx = db.transaction(STORE_OPS, 'readwrite', { durability: 'strict' });
  for (const o of old) void tx.store.delete(o.id).catch(() => {});
  await tx.done;
  hookAfter(STORE_OPS);
  return old.length;
}
