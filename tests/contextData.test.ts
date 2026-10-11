// v1.1 data additions: opener tracking, DB v2 migration, thumbnails store, privacy filters.
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../src/core/backup';
import { needsCapture, thumbBlockReason } from '../src/core/thumbs';
import { THUMB_REFRESH_MS } from '../src/shared/constants';
import { defaultSettings, sanitizeSettings } from '../src/shared/settings';
import { freshBrowser, idle, startWorker } from './helpers/env';

const thumb = (id: string, at: number) => ({ id, url: 'https://x.com/', at, w: 2, h: 2, type: 'image/webp', data: new ArrayBuffer(4) });

describe('opener tracking', () => {
  it('records the record of the opener tab for tabs opened from another tab', async () => {
    const fc = freshBrowser();
    const [root] = fc.seedTabs(1, () => 'https://docs.example.com/guide');
    const w = await startWorker(fc);
    await idle(w);
    fc.addTab({ url: 'https://example.org/linked', title: 'Linked', openerTabId: root!.id });
    fc.addTab({ url: 'https://example.org/typed', title: 'Typed' });
    await idle(w);
    const recs = await w.db.getAllRecords();
    const rootRec = recs.find((r) => r.url === 'https://docs.example.com/guide')!;
    expect(recs.find((r) => r.url === 'https://example.org/linked')!.openerId).toBe(rootRec.id);
    expect(recs.find((r) => r.url === 'https://example.org/typed')!.openerId).toBeUndefined();
  });

  it('keeps openerId through JSON validation and drops invalid values', () => {
    const base = { id: 'a', url: 'https://a.com/', state: 'archived' };
    expect((validateRecord({ ...base, openerId: 'b' }) as any).openerId).toBe('b');
    expect((validateRecord({ ...base, openerId: 42 }) as any).openerId).toBeUndefined();
    expect((validateRecord({ ...base, openerId: 'x'.repeat(500) }) as any).openerId).toBeUndefined();
  });
});

describe('database v2', () => {
  it('upgrades a v1 database without touching records and adds the thumbs store', async () => {
    freshBrowser();
    const v1 = await openDB('fangio', 1, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('state', 'state');
        records.createIndex('url', 'url');
        records.createIndex('domain', 'domain');
        records.createIndex('tags', 'tags', { multiEntry: true });
        records.createIndex('updatedAt', 'updatedAt');
        db.createObjectStore('actions', { keyPath: 'id' }).createIndex('at', 'at');
        db.createObjectStore('ops', { keyPath: 'id' }).createIndex('finishedFlag', 'finishedFlag');
        db.createObjectStore('kv', { keyPath: 'key' });
      },
    });
    await v1.put('records', { id: 'old', url: 'https://old.example/', state: 'archived', title: 'Old', domain: 'old.example', tags: [], updatedAt: 1 });
    v1.close();
    const db = await import('../src/core/db');
    await db.__resetDbForTests();
    expect((await db.getRecord('old'))?.title).toBe('Old');
    await db.putThumb(thumb('old', 5));
    expect((await db.getThumb('old'))?.at).toBe(5);
    await db.__resetDbForTests();
  });

  it('permanent deletion removes thumbnails; pruning drops orphans and the oldest above the cap', async () => {
    const fc = freshBrowser();
    fc.seedTabs(3);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    for (const [i, r] of recs.entries()) await w.db.putThumb({ ...thumb(r.id, 100 + i), url: r.url });
    await w.db.putThumb(thumb('ghost', 1));
    await w.db.deleteRecords([recs[0]!.id]);
    expect(await w.db.getThumb(recs[0]!.id)).toBeUndefined();
    const ids = new Set(recs.slice(1).map((r) => r.id));
    expect(await w.db.pruneThumbs(1, ids)).toBe(2); // ghost + oldest
    expect(await w.db.getThumbIds()).toEqual([recs[2]!.id]);
    const res = await w.call({ type: 'clearThumbs' });
    expect(res.deleted).toBe(1);
  });
});

describe('thumbnail guards', () => {
  const s = { siteExclusions: ['mail.google.com'], thumbnailExclusions: ['*.mibanco.com'] };
  it('blocks non-web, excluded and sensitive pages', () => {
    expect(thumbBlockReason('https://react.dev/learn', s)).toBeNull();
    expect(thumbBlockReason('file:///C:/x.pdf', s)).toMatch(/http/);
    expect(thumbBlockReason('https://mail.google.com/mail/u/0', s)).toMatch(/excluido/);
    expect(thumbBlockReason('https://online.mibanco.com/home', s)).toMatch(/miniaturas/);
    expect(thumbBlockReason('https://accounts.google.com/signin', s)).toMatch(/sensible/);
    expect(thumbBlockReason('https://shop.com/checkout/step-2', s)).toMatch(/sensible/);
    expect(thumbBlockReason('https://app.com/login', s)).toMatch(/sensible/);
    expect(thumbBlockReason('https://app.com/cb?code=abc', s)).toMatch(/credenciales/);
    expect(thumbBlockReason('https://blog.com/authors-i-like', s)).toBeNull();
  });
  it('refreshes only when missing, stale or showing another URL', () => {
    const now = 10 * THUMB_REFRESH_MS;
    expect(needsCapture(undefined, 'https://a/', now)).toBe(true);
    expect(needsCapture({ url: 'https://a/', at: now - 1000 }, 'https://a/', now)).toBe(false);
    expect(needsCapture({ url: 'https://b/', at: now - 1000 }, 'https://a/', now)).toBe(true);
    expect(needsCapture({ url: 'https://a/', at: now - THUMB_REFRESH_MS }, 'https://a/', now)).toBe(true);
  });
  it('settings: thumbnails are off by default and sanitized', () => {
    expect(defaultSettings().thumbnails).toBe(false);
    const c = sanitizeSettings({ thumbnails: 'yes', thumbnailExclusions: [' Bank.COM ', 3, ''] });
    expect(c.thumbnails).toBe(false);
    expect(c.thumbnailExclusions).toEqual(['bank.com']);
  });
});
