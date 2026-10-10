// Safety review fixes for data handling: ready() single-flight (L1), JSON import
// validation and reopen URL guard (L4), imported trash retention + settings log
// (L5), overwrite of live records on import (L6), purge clock guard / cap (L8).
import { describe, expect, it } from 'vitest';
import { buildExport, parseAndValidateImport } from '../src/core/backup';
import type { TabRecord } from '../src/shared/types';
import { freshBrowser, idle, sleep, startWorker, type Worker } from './helpers/env';

const DAY = 86400000;

function clone(base: TabRecord, p: Partial<TabRecord>): TabRecord {
  return { ...structuredClone(base), live: null, pendingClose: null, ...p };
}

async function exportFile(w: Worker, mutate: (r: TabRecord) => TabRecord = (r) => r) {
  const recs = (await w.db.getAllRecords()).map((r) => mutate(structuredClone(r)));
  return JSON.parse(JSON.stringify(buildExport(recs, await w.db.getSettings(), await w.db.getActions(), '1.2.0')));
}

describe('L1: ready() retries init once for concurrent callers', () => {
  it('three concurrent ready() after a failed init start a single new init', async () => {
    const fc = freshBrowser();
    const orig = fc.api.storage.session.get;
    let calls = 0;
    let fail = true;
    fc.api.storage.session.get = (...a: unknown[]) => {
      calls++;
      return fail ? Promise.reject(new Error('session storage down')) : orig(...a);
    };
    const w = await startWorker(fc, { awaitReady: false });
    await sleep(30);
    expect(calls).toBe(1);
    await Promise.allSettled([w.bg.ready(), w.bg.ready(), w.bg.ready()]);
    expect(calls).toBe(2);
    fail = false;
    await w.bg.ready();
    expect(calls).toBe(3);
  });
});

describe('L4: JSON import validation', () => {
  it('rejects non-trackable / oversized URLs and caps fields', () => {
    const base = { id: 'ok', url: 'https://a.example/', state: 'archived' };
    const parsed = parseAndValidateImport({
      format: 'fangio-export',
      schemaVersion: 1,
      records: [
        { ...base, id: 'js', url: 'javascript:alert(1)' },
        { ...base, id: 'data', url: 'data:text/html,<b>x</b>' },
        { ...base, id: 'chrome', url: 'chrome://settings/' },
        { ...base, id: 'long', url: 'https://a.example/?' + 'x'.repeat(9000) },
        {
          ...base,
          title: 't'.repeat(5000),
          project: 'p'.repeat(500),
          tags: Array.from({ length: 150 }, (_, i) => `tag${i}-${'z'.repeat(200)}`),
          previousUrls: ['javascript:void(0)', ...Array.from({ length: 20 }, (_, i) => `https://prev${i}.example/`)],
        },
      ],
      actions: [
        { id: 'a1', at: 1, kind: 'archive', recordIds: ['ok'], before: { ok: { state: 'open' } }, undoable: true, evil: 'x' },
        { id: 'a2', at: 1, kind: 'bogus', recordIds: [] },
      ],
    });
    expect(parsed.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    const r = parsed.records[0]!;
    expect(r.title.length).toBe(1000);
    expect(r.project.length).toBe(200);
    expect(r.tags.length).toBe(100);
    expect(r.tags.every((t) => t.length <= 100)).toBe(true);
    expect(r.previousUrls).toHaveLength(10);
    expect(r.previousUrls.every((u) => u.startsWith('https://'))).toBe(true);
    expect(parsed.actions).toHaveLength(1);
    const a = parsed.actions[0]!;
    expect(a.undoable).toBe(false);
    expect(a.before).toBeUndefined();
    expect('evil' in a).toBe(false);
  });

  it('reopen refuses a non-trackable URL: item failed, no tab created, record unchanged', async () => {
    const fc = freshBrowser();
    fc.seedTabs(1);
    const w = await startWorker(fc);
    await idle(w);
    const [base] = await w.db.getAllRecords();
    const bad = clone(base!, { id: 'bad-1', url: 'javascript:alert(1)', state: 'archived' });
    await w.db.putRecords([bad]);
    const creates = fc.createCalls.length;
    const res = await w.call({ type: 'reopen', recordIds: ['bad-1'] });
    await idle(w);
    expect(res.done).toEqual([]);
    expect(res.failed[0].recordId).toBe('bad-1');
    expect(res.failed[0].error).toMatch(/No se reabre/);
    expect(fc.createCalls.length).toBe(creates);
    expect((await w.db.getRecord('bad-1'))!.state).toBe('archived');
  });
});

describe('L5: imported trash retention and settings log', () => {
  it('trashedAt restarts at import time and the restored settings are logged', async () => {
    const fc1 = freshBrowser();
    fc1.seedTabs(3);
    const w1 = await startWorker(fc1);
    await idle(w1);
    const old = Date.now() - 100 * DAY;
    const file = await exportFile(w1, (r) => ({ ...r, state: 'trash', trashedAt: old }));
    const fc = freshBrowser();
    const w = await startWorker(fc);
    const t0 = Date.now();
    const res = await w.call({ type: 'importJson', data: file });
    expect(res.added).toBe(3);
    const recs = await w.db.getAllRecords();
    expect(recs.every((r) => r.state === 'trash' && r.trashedAt! >= t0)).toBe(true);
    expect(await w.core.actions.purgeExpired(Date.now())).toBe(0);
    const acts = await w.db.getActions();
    expect(acts.some((a) => a.kind === 'settings' && /Configuración restaurada/.test(a.reason))).toBe(true);
  });
});

describe('L6: importing over existing records', () => {
  it('open records keep url/state/live; otherwise the old URL goes to previousUrls', async () => {
    const fc = freshBrowser();
    const [a, b] = fc.seedTabs(2, (i) => `https://orig${i}.example/`);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const ra = recs.find((r) => r.live!.tabId === a!.id)!;
    const rb = recs.find((r) => r.live!.tabId === b!.id)!;
    await w.call({ type: 'archive', recordIds: [rb.id] });
    const later = Date.now() + 60000;
    const file = await exportFile(w, (r) => ({
      ...r,
      url: r.id === ra.id ? 'https://changed-a.example/' : 'https://changed-b.example/',
      state: 'archived',
      updatedAt: later,
    }));
    const res = await w.call({ type: 'importJson', data: file });
    expect(res.updated).toBe(2);
    const a2 = (await w.db.getRecord(ra.id))!;
    expect(a2.state).toBe('open');
    expect(a2.url).toBe(a!.url);
    expect(a2.live?.tabId).toBe(a!.id);
    expect(a2.previousUrls[0]).toBe('https://changed-a.example/');
    const b2 = (await w.db.getRecord(rb.id))!;
    expect(b2.url).toBe('https://changed-b.example/');
    expect(b2.domain).toBe('changed-b.example');
    expect(b2.previousUrls[0]).toBe(b!.url);
  });
});

describe('L8: purge guards', () => {
  async function withTrashRecords(stamps: number[]) {
    const fc = freshBrowser();
    fc.seedTabs(1);
    const w = await startWorker(fc);
    await idle(w);
    const [base] = await w.db.getAllRecords();
    await w.db.putRecords(stamps.map((t, i) => clone(base!, { id: `t-${i}`, url: `https://t${i}.example/`, state: 'trash', trashedAt: t })));
    return w;
  }

  it('skips purging when a trash record is dated in the future (clock went backwards)', async () => {
    const now = Date.now();
    const w = await withTrashRecords([now - 60 * DAY, now - 45 * DAY, now + 2 * DAY]);
    expect(await w.core.actions.purgeExpired(now)).toBe(0);
    expect((await w.db.getAllRecords()).filter((r) => r.state === 'trash')).toHaveLength(3);
  });

  it('purges at most 500 records per run, oldest first, and logs the cap', async () => {
    const now = Date.now();
    const w = await withTrashRecords(Array.from({ length: 510 }, (_, i) => now - 40 * DAY - i * 1000));
    expect(await w.core.actions.purgeExpired(now)).toBe(500);
    const left = (await w.db.getAllRecords()).filter((r) => r.state === 'trash').map((r) => r.id);
    expect(left).toHaveLength(10);
    expect(left).toContain('t-0'); // the newest ones remain
    const purge = (await w.db.getActions()).find((a) => a.kind === 'purge')!;
    expect(purge.reason).toMatch(/tope de 500/);
    expect(await w.core.actions.purgeExpired(now)).toBe(10);
  });
});
