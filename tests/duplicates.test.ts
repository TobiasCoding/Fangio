import { describe, expect, it } from 'vitest';
import { groupDuplicates, planMerge } from '../src/core/duplicates';
import type { TabRecord } from '../src/shared/types';
import { freshBrowser, idle, startWorker } from './helpers/env';

function rec(id: string, url: string, p: Partial<TabRecord> = {}): TabRecord {
  return {
    id, url, title: id, domain: 'x', state: 'archived', protected: false, pending: false, tags: [], project: '', note: '',
    source: 'tracked', createdAt: 1000, updatedAt: 1000, origin: {}, previousUrls: [], reopenCount: 0, mergedFrom: [],
    live: null, pendingClose: null, rev: 1, ...p,
  };
}

describe('duplicates grouping', () => {
  it('groups by the exact URL string only (params and fragments are distinct), any state', () => {
    const groups = groupDuplicates([
      rec('1', 'https://a.com/x'),
      rec('2', 'https://a.com/x', { state: 'open' }),
      rec('3', 'https://a.com/x?y=1'),
      rec('4', 'https://a.com/x#f'),
      rec('5', 'https://a.com/X'),
      rec('6', 'https://b.com/'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.url).toBe('https://a.com/x');
    expect(groups[0]!.records.map((r) => r.id).sort()).toEqual(['1', '2']);
  });

  it('planMerge refuses to merge an open record', () => {
    expect(() => planMerge(rec('k', 'u'), [rec('o', 'u', { state: 'open' })], 5)).toThrow(/abierta/);
  });
});

describe('identical tabs keep separate records and states', () => {
  it('two tabs with the same URL -> two records; archiving one leaves the other open', async () => {
    const fc = freshBrowser();
    const a = fc.addTab({ url: 'https://dup.example/' }, { silent: true });
    const b = fc.addTab({ url: 'https://dup.example/' }, { silent: true });
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(2);
    const ra = recs.find((r) => r.live!.tabId === a.id)!;
    await w.call({ type: 'archive', recordIds: [ra.id] });
    await idle(w);
    const after = await w.db.getAllRecords();
    expect(after.find((r) => r.id === ra.id)!.state).toBe('archived');
    expect(after.find((r) => r.live?.tabId === b.id)!.state).toBe('open');
    expect(groupDuplicates(after)).toHaveLength(1);
  });
});

describe('merge', () => {
  it('preserves dates, notes, tags and associations; trashes the others; undoable', async () => {
    const fc = freshBrowser();
    fc.addTab({ url: 'https://m.example/', lastAccessed: 5000 }, { silent: true });
    fc.addTab({ url: 'https://m.example/', lastAccessed: 9000 }, { silent: true });
    fc.addTab({ url: 'https://m.example/', lastAccessed: 7000 }, { silent: true });
    fc.addTab({ url: 'https://other.example/' }, { silent: true });
    const w = await startWorker(fc);
    await idle(w);
    let recs = (await w.db.getAllRecords()).filter((r) => r.url === 'https://m.example/');
    const [k, o1, o2] = recs;
    await w.call({ type: 'updateRecords', recordIds: [k!.id], edit: { note: 'nota k', setTags: ['a'] } });
    await w.call({ type: 'updateRecords', recordIds: [o1!.id], edit: { note: 'nota o1', setTags: ['b'], pending: true, project: 'Tesis' } });
    await w.call({ type: 'updateRecords', recordIds: [o2!.id], edit: { setTags: ['a', 'c'] } });
    // An open record cannot be merged into another.
    const refused = await w.send({ type: 'merge', keepId: k!.id, mergeIds: [o1!.id] });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/abierta/);
    await w.call({ type: 'archive', recordIds: [o1!.id, o2!.id] });
    await w.call({ type: 'updateRecords', recordIds: [o2!.id], edit: { protected: true } });
    const before = await w.db.getRecordsByIds([k!.id, o1!.id, o2!.id]);
    const res = await w.call({ type: 'merge', keepId: k!.id, mergeIds: [o1!.id, o2!.id] });
    expect(res.done).toHaveLength(3);
    const kept = (await w.db.getRecord(k!.id))!;
    expect(kept.tags).toEqual(['a', 'b', 'c']);
    expect(kept.note).toBe('nota k\n\nnota o1');
    expect(kept.pending).toBe(true);
    expect(kept.protected).toBe(true);
    expect(kept.project).toBe('Tesis');
    expect(kept.mergedFrom.sort()).toEqual([o1!.id, o2!.id].sort());
    expect(kept.createdAt).toBe(Math.min(...[...before.values()].map((r) => r.createdAt)));
    expect(kept.lastAccessedAt).toBe(Math.max(...[...before.values()].map((r) => r.lastAccessedAt ?? 0)));
    for (const id of [o1!.id, o2!.id]) {
      const r = (await w.db.getRecord(id))!;
      expect(r.state).toBe('trash');
      expect(r.lastReason).toMatch(/^Fusionada en/);
    }
    const undo = await w.call({ type: 'undo', actionId: res.actionId });
    expect(undo.done).toHaveLength(3);
    const k2 = (await w.db.getRecord(k!.id))!;
    expect(k2.tags).toEqual(['a']);
    expect(k2.note).toBe('nota k');
    expect(k2.mergedFrom).toEqual([]);
    expect((await w.db.getRecord(o1!.id))!.state).toBe('archived');
    expect((await w.db.getRecord(o2!.id))!.state).toBe('archived');
    recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(4);
  });
});
