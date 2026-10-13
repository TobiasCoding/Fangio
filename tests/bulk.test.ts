import { describe, expect, it } from 'vitest';
import { freshBrowser, idle, startWorker } from './helpers/env';

const H = 3600000;

describe('bulk (fake chrome + fake-indexeddb; timings are NOT real-browser numbers)', () => {
  it('archives 850 tabs: every closed tab has an archived record with the exact URL, none lost or duplicated', async () => {
    const fc = freshBrowser();
    const w1 = fc.addWindow();
    fc.seedTabs(500, (i) => `https://bulk.example/item/${i % 450}?ref=${i % 3}#s${i % 2}`, { windowId: w1 });
    const w2 = fc.addWindow();
    fc.seedTabs(350, (i) => `https://other${i}.example/p?q=a&b=${i}`, { windowId: w2 });
    const urlsBefore = [...fc.tabs.values()].map((t) => t.url).sort();
    const t0 = performance.now();
    const w = await startWorker(fc);
    await idle(w);
    const tSnapshot = performance.now() - t0;
    const recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(850);
    // This test checks the close pipeline: the archived-duplicates rule (repeated URLs here) stays off.
    await w.call({ type: 'saveSettings', settings: { ...(await w.db.getSettings()), dedupeArchived: false } });

    const t1 = performance.now();
    const res = await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    const tArchive = performance.now() - t1;
    await idle(w);
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(850);
    const after = await w.db.getAllRecords();
    expect(after).toHaveLength(850);
    expect(new Set(after.map((r) => r.id)).size).toBe(850);
    expect(after.every((r) => r.state === 'archived' && !r.live && !r.pendingClose)).toBe(true);
    expect(after.map((r) => r.url).sort()).toEqual(urlsBefore);
    expect(fc.normalTabCount()).toBe(1); // safety tab
    const closedCount = fc.removeCalls.flat().length;
    expect(closedCount).toBe(850);
    console.log(
      `[fake env] snapshot 850 tabs: ${tSnapshot.toFixed(0)} ms; archive 850 tabs: ${tArchive.toFixed(0)} ms ` +
        `(${fc.removeCalls.length} tabs.remove calls)`,
    );
  });

  it('automation over 820 idle tabs: archives all eligible up to the cap, keeps the active one', async () => {
    const fc = freshBrowser();
    fc.seedTabs(820, (i) => `https://idle${i}.example/`, { lastAccessed: Date.now() - 30 * H });
    const first = [...fc.tabs.values()][0]!;
    first.active = true;
    const w = await startWorker(fc);
    await idle(w);
    const s = await w.call({ type: 'getSettings' });
    await w.call({ type: 'saveSettings', settings: { ...s, maxAutoClosePerRun: 1000, targetOpenTabs: 15 } });
    const t0 = performance.now();
    const res = await w.call({ type: 'runRulesNow' });
    const dt = performance.now() - t0;
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(819);
    expect(fc.tabs.has(first.id)).toBe(true);
    const after = await w.db.getAllRecords();
    expect(after.filter((r) => r.state === 'archived')).toHaveLength(819);
    expect(after).toHaveLength(820);
    console.log(`[fake env] automation run archiving 819 tabs: ${dt.toFixed(0)} ms`);
  });

  it('reopening 200 records with concurrency 3 never exceeds 3 loading tabs; same ids; groups restored', async () => {
    const fc = freshBrowser();
    const tabs = fc.seedTabs(200, (i) => `https://re${i}.example/`);
    fc.groups.set(1, { id: 1, windowId: tabs[0]!.windowId, title: 'Investigación', color: 'blue', collapsed: false });
    for (const t of tabs.slice(0, 10)) t.groupId = 1;
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    expect(recs.filter((r) => r.origin.groupTitle === 'Investigación')).toHaveLength(10);
    await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    fc.groups.clear();
    fc.maxLoading = 0;
    fc.loadingNow = 0;
    const t0 = performance.now();
    const res = await w.call({ type: 'reopen', recordIds: recs.map((r) => r.id) });
    const dt = performance.now() - t0;
    await idle(w);
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(200);
    expect(fc.maxLoading).toBeLessThanOrEqual(3);
    expect(fc.maxLoading).toBeGreaterThan(1);
    const after = await w.db.getAllRecords();
    expect(after).toHaveLength(200);
    expect(after.every((r) => r.state === 'open' && r.reopenCount === 1 && r.lastAccessedAt! > Date.now() - 60000)).toBe(true);
    for (const r of after) expect(fc.tabs.get(r.live!.tabId)!.url).toBe(r.url);
    expect(fc.discardCalls.length).toBeGreaterThanOrEqual(199);
    const groups = [...fc.groups.values()].filter((g) => g.title === 'Investigación');
    expect(groups).toHaveLength(1);
    expect([...fc.tabs.values()].filter((t) => t.groupId === groups[0]!.id)).toHaveLength(10);
    console.log(`[fake env] reopen 200 (concurrency 3, 2 ms fake load): ${dt.toFixed(0)} ms, max loading ${fc.maxLoading}`);
  });

  it('undo of a bulk archive reopens the tabs with the same record ids', async () => {
    const fc = freshBrowser();
    fc.seedTabs(120);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const res = await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    const undo = await w.call({ type: 'undo', actionId: res.actionId });
    await idle(w);
    expect(undo.done).toHaveLength(120);
    const after = await w.db.getAllRecords();
    expect(after).toHaveLength(120);
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(recs.map((r) => r.id)));
    expect(after.every((r) => r.state === 'open')).toBe(true);
    const sid = (await w.core.session.getSession()).sessionId;
    for (const r of after) {
      expect(r.live!.sessionId).toBe(sid);
      expect(fc.tabs.get(r.live!.tabId)!.url).toBe(r.url);
    }
    const kinds = (await w.db.getActions()).map((a) => a.kind);
    expect(kinds[0]).toBe('undo');
  });

  it('reopen of a record that is already open focuses its tab instead of creating another', async () => {
    const fc = freshBrowser();
    const [a, b] = fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const ra = (await w.db.getAllRecords()).find((r) => r.live!.tabId === b!.id)!;
    fc.createCalls = [];
    const res = await w.call({ type: 'reopen', recordIds: [ra.id] });
    expect(res.done).toEqual([ra.id]);
    expect(fc.createCalls).toHaveLength(0);
    expect(fc.tabs.get(b!.id)!.active).toBe(true);
    expect(fc.tabs.get(a!.id)!.active).toBe(false);
  });

  it('a failing tabs.create (e.g. file:// not allowed) marks the item failed and keeps the record archived', async () => {
    const fc = freshBrowser();
    fc.seedTabs(2, (i) => (i === 0 ? 'file:///C:/doc.pdf' : 'https://ok.example/'));
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    fc.failCreateUrls.add('file:///C:/doc.pdf');
    const res = await w.call({ type: 'reopen', recordIds: recs.map((r) => r.id) });
    expect(res.failed).toHaveLength(1);
    expect(res.done).toHaveLength(1);
    const f = (await w.db.getAllRecords()).find((r) => r.url.startsWith('file:'))!;
    expect(f.state).toBe('archived');
  });
});
