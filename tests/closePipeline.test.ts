import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import type { TabRecord } from '../src/shared/types';
import { freshBrowser, idle, startWorker } from './helpers/env';

async function rawRecords(): Promise<TabRecord[]> {
  // Independent connection: only committed data is visible.
  const db = await openDB('fangio');
  const all = (await db.getAll('records')) as TabRecord[];
  db.close();
  return all;
}

describe('close pipeline: persistence and ordering', () => {
  it('every tab is committed (pendingClose + exact URL) before tabs.remove is called', async () => {
    const fc = freshBrowser();
    const tabs = fc.seedTabs(60, (i) => `https://ex.com/p/${i}?q=${i}#f${i}`);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    let checkedTabs = 0;
    fc.removeHook = async (ids) => {
      const committed = await rawRecords();
      for (const id of ids) {
        const tab = fc.tabs.get(id)!;
        const r = committed.find((x) => x.pendingClose?.tabId === id);
        expect(r, `record for tab ${id} committed before remove`).toBeTruthy();
        expect(r!.pendingClose!.expectedUrl).toBe(tab.url);
        expect(r!.url).toBe(tab.url);
        checkedTabs++;
      }
    };
    const res = await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(60);
    expect(checkedTabs).toBe(60);
    expect(fc.tabs.size).toBe(1); // a fresh empty tab was created so the browser is never left empty
    const after = await rawRecords();
    for (const t of tabs) {
      const r = after.find((x) => x.url === t.url)!;
      expect(r.state).toBe('archived');
      expect(r.pendingClose).toBeNull();
      expect(r.live).toBeNull();
    }
    const [action] = await w.db.getActions({ limit: 1 });
    expect(action!.kind).toBe('archive');
    expect(Object.values(action!.before!).every((b) => b.state === 'open')).toBe(true);
    expect((await w.db.getOps({ unfinishedOnly: true })).length).toBe(0);
    expect(fc.removeCalls.every((c) => c.length <= 25)).toBe(true);
  });

  it('records survive closing and reopening the database (new worker)', async () => {
    const fc = freshBrowser();
    fc.seedTabs(10);
    let w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    await w.call({ type: 'archive', recordIds: recs.slice(0, 5).map((r) => r.id) });
    await w.call({ type: 'updateRecords', recordIds: [recs[6]!.id], edit: { note: 'importante', addTags: ['Trabajo'] } });
    await w.db.__resetDbForTests();
    w = await startWorker(fc);
    await idle(w);
    const again = await w.db.getAllRecords();
    expect(again).toHaveLength(10);
    expect(again.filter((r) => r.state === 'archived')).toHaveLength(5);
    const r6 = again.find((r) => r.id === recs[6]!.id)!;
    expect(r6.note).toBe('importante');
    expect(r6.tags).toEqual(['trabajo']);
  });
});

describe('close pipeline: storage failure never closes tabs', () => {
  it('save throws -> no tab closed, items failed, records unchanged', async () => {
    const fc = freshBrowser();
    fc.seedTabs(20);
    const w = await startWorker(fc);
    await idle(w);
    const before = await w.db.getAllRecords();
    w.db.testHooks.beforeWrite = (store) => {
      if (store === 'records') throw new Error('QuotaExceededError (simulada)');
    };
    const env = await w.send({ type: 'archive', recordIds: before.map((r) => r.id) });
    w.db.testHooks.beforeWrite = undefined;
    expect(env.ok).toBe(true);
    expect(env.data.ok).toBe(false);
    expect(env.data.done).toEqual([]);
    expect(env.data.failed).toHaveLength(20);
    expect(fc.removeCalls).toHaveLength(0);
    expect(fc.tabs.size).toBe(20);
    const after = await w.db.getAllRecords();
    for (const r of after) {
      const b = before.find((x) => x.id === r.id)!;
      expect(r.state).toBe('open');
      expect(r.pendingClose).toBeNull();
      expect(r.rev).toBe(b.rev);
    }
  });

  it('only the batch whose write failed keeps its tabs open (450 tabs, 2nd batch fails)', async () => {
    const fc = freshBrowser();
    fc.seedTabs(450);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    let n = 0;
    w.db.testHooks.beforeWrite = (store) => {
      if (store === 'records' && ++n === 2) throw new Error('disk full');
    };
    const res = await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    w.db.testHooks.beforeWrite = undefined;
    expect(res.failed).toHaveLength(200);
    expect(res.done).toHaveLength(250);
    const after = await w.db.getAllRecords();
    const failedIds = new Set(res.failed.map((f: { recordId: string }) => f.recordId));
    for (const r of after) {
      if (failedIds.has(r.id)) {
        expect(r.state).toBe('open');
        expect(fc.tabs.has(r.live!.tabId)).toBe(true);
      } else expect(r.state).toBe('archived');
    }
    expect(fc.tabs.size).toBe(200);
  });
});

describe('close pipeline: revalidation and remove failures', () => {
  it('tab navigated between save and close -> skipped, stays open, marker cleared', async () => {
    const fc = freshBrowser();
    const [a, b] = fc.seedTabs(3);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const ra = recs.find((r) => r.live!.tabId === a!.id)!;
    const rb = recs.find((r) => r.live!.tabId === b!.id)!;
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterSave') fc.tabs.get(a!.id)!.url = 'https://elsewhere.example/';
    };
    const res = await w.call({ type: 'archive', recordIds: [ra.id, rb.id] });
    w.db.testHooks.checkpoint = undefined;
    expect(res.done).toEqual([rb.id]);
    expect(res.skipped[0].recordId).toBe(ra.id);
    expect(fc.tabs.has(a!.id)).toBe(true);
    const ra2 = (await w.db.getRecord(ra.id))!;
    expect(ra2.state).toBe('open');
    expect(ra2.pendingClose).toBeNull();
  });

  it('batch remove error: tabs already gone are finalized, the rest retried one by one', async () => {
    const fc = freshBrowser();
    const tabs = fc.seedTabs(10);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    fc.partialRemoveFailure = true;
    fc.failRemove.add(tabs[4]!.id);
    const res = await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    expect(res.done).toHaveLength(9);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].tabId).toBe(tabs[4]!.id);
    const stuck = (await w.db.getAllRecords()).find((r) => r.url === tabs[4]!.url)!;
    expect(stuck.state).toBe('open');
    expect(stuck.pendingClose).toBeNull();
    expect(fc.tabs.has(tabs[4]!.id)).toBe(true);
    await idle(w);
    expect((await w.db.getAllRecords()).filter((r) => r.state === 'trash')).toHaveLength(0);
  });

  it('never leaves the browser without a normal tab', async () => {
    const fc = freshBrowser();
    fc.seedTabs(3);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    expect(fc.normalTabCount()).toBe(1);
    const createIdx = fc.log.findIndex((l) => l.startsWith('tabs.create'));
    const removeIdx = fc.log.findIndex((l) => l.startsWith('tabs.remove'));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeLessThan(removeIdx);
  });

  it('user closing a tab while it is being archived does not trash it', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const ra = (await w.db.getAllRecords()).find((r) => r.live!.tabId === a!.id)!;
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterSave') fc.userCloseTab(a!.id);
    };
    const res = await w.call({ type: 'archive', recordIds: [ra.id] });
    w.db.testHooks.checkpoint = undefined;
    await idle(w);
    expect(res.done).toEqual([ra.id]);
    expect((await w.db.getRecord(ra.id))!.state).toBe('archived');
  });

  it('archiveTab: success has done + actionId; untrackable pages are refused', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(2);
    const ntp = fc.addTab({ url: 'chrome://newtab/' }, { silent: true });
    const w = await startWorker(fc);
    await idle(w);
    const ok = await w.call({ type: 'archiveTab', tabId: a!.id });
    expect(ok.done).toHaveLength(1);
    expect(ok.actionId).toBeTruthy();
    const no = await w.call({ type: 'archiveTab', tabId: ntp.id });
    expect(no.ok).toBe(false);
    expect(no.done).toHaveLength(0);
    expect(fc.tabs.has(ntp.id)).toBe(true);
  });
});
