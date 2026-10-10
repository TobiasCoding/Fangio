import { describe, expect, it } from 'vitest';
import { freshBrowser, idle, startWorker } from './helpers/env';

describe('install snapshot', () => {
  it('800 existing tabs become 800 open records (source install-snapshot), bound to their tabs', async () => {
    const fc = freshBrowser();
    fc.seedTabs(800);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(800);
    expect(new Set(recs.map((r) => r.id)).size).toBe(800);
    expect(recs.every((r) => r.state === 'open' && r.source === 'install-snapshot' && r.importedAt && !r.openedAt)).toBe(true);
    const tabIds = new Set(recs.map((r) => r.live!.tabId));
    expect(tabIds.size).toBe(800);
    for (const t of fc.tabs.values()) {
      const r = recs.find((x) => x.live!.tabId === t.id)!;
      expect(r.url).toBe(t.url);
    }
    const actions = await w.db.getActions();
    expect(actions.some((a) => a.kind === 'install-snapshot' && a.recordIds.length === 800)).toBe(true);
    expect(await w.db.getKv('meta')).toBeTruthy();
  });

  it('no duplicates when tab events fire concurrently during init', async () => {
    const fc = freshBrowser();
    const seeded = fc.seedTabs(800);
    const w = await startWorker(fc, { awaitReady: false });
    // Events while init is still running.
    for (let i = 0; i < 20; i++) fc.addTab({ url: `https://new${i}.example.org/` });
    for (let i = 0; i < 50; i++) fc.ev.tabs.onUpdated.fire(seeded[i]!.id, { title: 'x' }, { ...seeded[i]! });
    for (let i = 0; i < 10; i++) fc.ev.tabs.onCreated.fire({ ...seeded[i]! }); // duplicate events for snapshot tabs
    fc.activate(seeded[5]!.id);
    await w.bg.ready();
    await idle(w);
    const recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(820);
    const bound = recs.map((r) => r.live!.tabId);
    expect(new Set(bound).size).toBe(820);
    expect([...fc.tabs.keys()].sort((a, b) => a - b)).toEqual([...bound].sort((a, b) => a - b));
  });

  it('restarting the worker (same session) does not re-snapshot or duplicate', async () => {
    const fc = freshBrowser();
    fc.seedTabs(30);
    let w = await startWorker(fc);
    await idle(w);
    w = await startWorker(fc);
    await idle(w);
    expect(await w.db.getAllRecords()).toHaveLength(30);
  });
});
