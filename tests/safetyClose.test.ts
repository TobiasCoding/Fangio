// Safety review fixes in the close pipeline: import protections (H1), URL change
// right before remove (M1), concurrent zero-tabs guard (L2), automation URL
// binding (L3), forced close re-protection (L8).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshBrowser, idle, sleep, startWorker } from './helpers/env';

const H = 3600000;
afterEach(() => vi.useRealTimers());

describe('H1: import wizard keeps full protections', () => {
  it('active / pinned / audible / excluded tabs are blocked in the preview and never closed by applyImport', async () => {
    const fc = freshBrowser();
    const old = Date.now() - 30 * H;
    const mk = (url: string, p = {}) => fc.addTab({ url, lastAccessed: old, ...p }, { silent: true });
    const t = {
      pinned: mk('https://pinned.example/', { pinned: true }),
      active: mk('https://active.example/', { active: true }),
      audible: mk('https://audio.example/', { audible: true }),
      excluded: mk('https://docs.google.com/document/d/1'),
      plain: mk('https://plain.example/'),
    };
    const w = await startWorker(fc);
    await idle(w);
    const preview = await w.call({ type: 'getImportPreview' });
    const byTab = new Map(preview.map((c: { tabId: number }) => [c.tabId, c]));
    for (const k of ['pinned', 'active', 'audible', 'excluded'] as const) {
      expect((byTab.get(t[k].id) as { blockedBy: string[] }).blockedBy.length).toBeGreaterThan(0);
    }
    const all = preview.map((c: { recordId: string }) => c.recordId);
    const res = await w.call({ type: 'applyImport', archiveIds: all, trashIds: [], protectIds: [] });
    expect(res.done).toHaveLength(1);
    for (const k of ['pinned', 'active', 'audible', 'excluded'] as const) expect(fc.tabs.has(t[k].id)).toBe(true);
    expect(fc.tabs.has(t.plain.id)).toBe(false);
  });

  it('a tab that becomes active after the preview is skipped at revalidation', async () => {
    const fc = freshBrowser();
    const [a, b] = fc.seedTabs(3, (i) => `https://s${i}.example/`, { lastAccessed: Date.now() - 30 * H });
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const ra = recs.find((r) => r.live!.tabId === a!.id)!;
    const rb = recs.find((r) => r.live!.tabId === b!.id)!;
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterSave') fc.tabs.get(a!.id)!.active = true;
    };
    const res = await w.call({ type: 'applyImport', archiveIds: [ra.id, rb.id], trashIds: [], protectIds: [] });
    w.db.testHooks.checkpoint = undefined;
    expect(res.done).toEqual([rb.id]);
    expect(fc.tabs.has(a!.id)).toBe(true);
    const ra2 = (await w.db.getRecord(ra.id))!;
    expect(ra2.state).toBe('open');
    expect(ra2.pendingClose).toBeNull();
  });
});

describe('M1: URL changed between revalidation and tabs.remove', () => {
  it('the tab is not closed, the item is skipped and its marker cleared', async () => {
    const fc = freshBrowser();
    const [a, b] = fc.seedTabs(3);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const ra = recs.find((r) => r.live!.tabId === a!.id)!;
    const rb = recs.find((r) => r.live!.tabId === b!.id)!;
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:beforeRemove') fc.tabs.get(a!.id)!.url = 'https://elsewhere.example/';
    };
    const res = await w.call({ type: 'archive', recordIds: [ra.id, rb.id] });
    w.db.testHooks.checkpoint = undefined;
    expect(res.done).toEqual([rb.id]);
    expect(res.skipped).toEqual([expect.objectContaining({ recordId: ra.id, reason: 'La URL cambió antes de cerrar' })]);
    expect(fc.tabs.has(a!.id)).toBe(true);
    expect(fc.removeCalls.flat()).not.toContain(a!.id);
    const ra2 = (await w.db.getRecord(ra.id))!;
    expect(ra2.state).toBe('open');
    expect(ra2.pendingClose).toBeNull();
    expect((await w.db.getOps({ unfinishedOnly: true })).length).toBe(0);
  });
});

describe('L2: concurrent close ops never empty the browser', () => {
  it('two ops that together cover every tab leave a normal tab', async () => {
    const fc = freshBrowser();
    fc.seedTabs(4);
    const w = await startWorker(fc);
    await idle(w);
    const ids = (await w.db.getAllRecords()).map((r) => r.id);
    // A slow tabs.remove widens the window in which the other op could query stale tabs.
    fc.removeHook = async () => {
      await sleep(30);
    };
    const [r1, r2] = await Promise.all([
      w.call({ type: 'archive', recordIds: ids.slice(0, 2) }),
      w.call({ type: 'trash', recordIds: ids.slice(2) }),
    ]);
    expect(r1.done.length + r2.done.length).toBe(4);
    expect(fc.normalTabCount()).toBeGreaterThanOrEqual(1);
  });
});

describe('L3: automation decisions are tied to the evaluated URL', () => {
  it('runCloseOp auto skips when the tab no longer shows expectedUrl (classify and save phases)', async () => {
    const fc = freshBrowser();
    const [a, b] = fc.seedTabs(3, (i) => `https://s${i}.example/`, { lastAccessed: Date.now() - 30 * H });
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const ra = recs.find((r) => r.live!.tabId === a!.id)!;
    const rb = recs.find((r) => r.live!.tabId === b!.id)!;
    const r1 = await w.core.closeOp.runCloseOp({
      items: [{ recordId: ra.id, expectedUrl: 'https://other.example/' }],
      targetState: 'trash',
      mode: 'auto',
      reason: 'test',
    });
    expect(r1.done).toEqual([]);
    expect(r1.skipped[0]!.reason).toMatch(/URL cambió/);
    expect(fc.tabs.has(a!.id)).toBe(true);
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterJournal') fc.tabs.get(b!.id)!.url = 'https://s1.example/other';
    };
    const r2 = await w.core.closeOp.runCloseOp({
      items: [{ recordId: rb.id, expectedUrl: b!.url }],
      targetState: 'trash',
      mode: 'auto',
      reason: 'test',
    });
    w.db.testHooks.checkpoint = undefined;
    expect(r2.done).toEqual([]);
    expect(r2.skipped[0]!.reason).toMatch(/URL cambió/);
    expect(fc.tabs.has(b!.id)).toBe(true);
    expect((await w.db.getRecord(rb.id))!.pendingClose).toBeNull();
  });

  it('an alarm run stops before the next group once automation is disabled', async () => {
    const fc = freshBrowser();
    fc.seedTabs(4, (i) => (i < 2 ? `https://rule.example/${i}` : `https://idle${i}.example/`), { lastAccessed: Date.now() - 30 * H });
    const w = await startWorker(fc);
    await idle(w);
    const s = await w.call({ type: 'getSettings' });
    const urlRules = [0, 1].map((i) => ({ id: `r${i}`, enabled: true, url: `https://rule.example/${i}`, action: 'trash', afterMinutes: 0 }));
    await w.call({ type: 'saveSettings', settings: { ...s, automationEnabled: true, urlRules } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60000);
    let groups = 0;
    w.db.testHooks.checkpoint = async (name) => {
      if (name !== 'close:afterJournal') return;
      if (++groups === 1) await w.db.putSettings({ ...(await w.db.getSettings()), automationEnabled: false });
    };
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-automation', scheduledTime: Date.now() });
    await idle(w);
    w.db.testHooks.checkpoint = undefined;
    expect(groups).toBe(1);
    expect(fc.tabs.size).toBe(3);
    const last = await w.db.getKv<{ summary: string }>('lastAutoRun');
    expect(last!.summary).toMatch(/detenida/);
  });
});

describe('L8: forced close that does not happen restores protection', () => {
  it('protected record forced, tab navigates before close -> skipped and protected again', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const ra = (await w.db.getAllRecords()).find((r) => r.live!.tabId === a!.id)!;
    await w.call({ type: 'updateRecords', recordIds: [ra.id], edit: { protected: true } });
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterSave') fc.tabs.get(a!.id)!.url = 'https://moved.example/';
    };
    const res = await w.call({ type: 'trash', recordIds: [ra.id], force: true });
    w.db.testHooks.checkpoint = undefined;
    expect(res.done).toEqual([]);
    expect(fc.tabs.has(a!.id)).toBe(true);
    const back = (await w.db.getRecord(ra.id))!;
    expect(back.state).toBe('open');
    expect(back.protected).toBe(true);
  });
});
