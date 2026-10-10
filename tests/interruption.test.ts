import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeChrome } from './helpers/fakeChrome';
import { freshBrowser, idle, never, startWorker, type Worker } from './helpers/env';

afterEach(() => {
  vi.useRealTimers();
});

/** Makes the worker "die" at a checkpoint: the op hangs there forever. Resolves when reached. */
function crashAt(w: Worker, point: string, after = 1): Promise<void> {
  let n = 0;
  return new Promise((reached) => {
    w.db.testHooks.checkpoint = (name) => {
      if (name === point && ++n >= after) {
        reached();
        return never();
      }
    };
  });
}

async function setup(n = 10) {
  const fc = freshBrowser();
  const tabs = fc.seedTabs(n);
  const w = await startWorker(fc);
  await idle(w);
  const recs = await w.db.getAllRecords();
  return { fc, tabs, w, recs };
}

function assertNoDuplicates(fc: FakeChrome, recs: { live: { tabId: number } | null; state: string }[]) {
  const bound = recs.filter((r) => r.state === 'open').map((r) => r.live!.tabId);
  expect(new Set(bound).size).toBe(bound.length);
  for (const t of fc.tabs.values()) if (t.url.startsWith('http')) expect(bound).toContain(t.id);
}

describe('interrupted close', () => {
  it('crash after journal (nothing saved) -> items skipped, nothing changes', async () => {
    const { fc, w, recs } = await setup();
    const reached = crashAt(w, 'close:afterJournal');
    void w.send({ type: 'archive', recordIds: recs.map((r) => r.id) });
    await reached;
    const w2 = await startWorker(fc);
    await idle(w2);
    expect(fc.tabs.size).toBe(10);
    const after = await w2.db.getAllRecords();
    expect(after.every((r) => r.state === 'open' && !r.pendingClose)).toBe(true);
    expect(await w2.db.getOps({ unfinishedOnly: true })).toHaveLength(0);
  });

  it('crash after save, before remove -> resume aborts: tabs stay open, no duplicates', async () => {
    const { fc, w, recs } = await setup();
    const reached = crashAt(w, 'close:afterSave');
    void w.send({ type: 'archive', recordIds: recs.map((r) => r.id) });
    await reached;
    expect((await w.db.getAllRecords()).every((r) => r.pendingClose)).toBe(true);
    const w2 = await startWorker(fc);
    await idle(w2);
    expect(fc.removeCalls).toHaveLength(0);
    expect(fc.tabs.size).toBe(10);
    const after = await w2.db.getAllRecords();
    expect(after).toHaveLength(10);
    expect(after.every((r) => r.state === 'open' && r.pendingClose === null)).toBe(true);
    assertNoDuplicates(fc, after);
    const ops = await w2.db.getOps();
    expect(ops[0]!.finished).toBe(true);
    expect(ops[0]!.items.every((i) => i.status === 'skipped')).toBe(true);
  });

  it('crash after remove, before the final write -> resume completes to archived', async () => {
    const { fc, w, recs, tabs } = await setup();
    const reached = crashAt(w, 'close:afterRemove');
    void w.send({ type: 'archive', recordIds: recs.map((r) => r.id) });
    await reached;
    expect(fc.tabs.size).toBe(1); // only the safety new-tab
    const w2 = await startWorker(fc);
    await idle(w2);
    const after = await w2.db.getAllRecords();
    expect(after).toHaveLength(10);
    expect(after.every((r) => r.state === 'archived' && !r.pendingClose && !r.live)).toBe(true);
    for (const t of tabs) expect(after.some((r) => r.url === t.url)).toBe(true);
    const a = (await w2.db.getActions()).find((x) => x.kind === 'archive')!;
    expect(a.recordIds).toHaveLength(10);
    expect(a.undoable).toBe(true);
    expect(after.filter((r) => r.state === 'trash')).toHaveLength(0);
  });

  it('crash after save + browser restart (new tab ids) -> abort and rebind by URL', async () => {
    const { fc, w, recs } = await setup(6);
    const reached = crashAt(w, 'close:afterSave');
    void w.send({ type: 'archive', recordIds: recs.map((r) => r.id) });
    await reached;
    fc.restartBrowser({ restartIdsFrom: 500 });
    const w2 = await startWorker(fc);
    fc.ev.runtime.onStartup.fire();
    await idle(w2);
    const after = await w2.db.getAllRecords();
    expect(after).toHaveLength(6);
    expect(after.every((r) => r.state === 'open' && !r.pendingClose)).toBe(true);
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(recs.map((r) => r.id)));
    assertNoDuplicates(fc, after);
  });
});

describe('interrupted reopen', () => {
  async function archivedSetup() {
    const { fc, w, recs } = await setup(4);
    await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    fc.createCalls = [];
    return { fc, w, recs };
  }
  const tabsWithUrl = (fc: FakeChrome, url: string) => [...fc.tabs.values()].filter((t) => (t.url || t.pendingUrl) === url);

  it("crash at 'creating' before tabs.create -> resume creates exactly one tab", async () => {
    const { fc, w, recs } = await archivedSetup();
    const reached = crashAt(w, 'reopen:afterCreating');
    void w.send({ type: 'reopen', recordIds: [recs[0]!.id] });
    await reached;
    expect(fc.createCalls).toHaveLength(0);
    const w2 = await startWorker(fc);
    await idle(w2);
    await vi.waitFor(async () => expect((await w2.db.getRecord(recs[0]!.id))!.state).toBe('open'));
    await idle(w2);
    expect(tabsWithUrl(fc, recs[0]!.url)).toHaveLength(1);
    expect(fc.createCalls).toHaveLength(1);
    expect(await w2.db.getAllRecords()).toHaveLength(4);
  });

  it('crash after tabs.create but before its id was persisted -> binds that tab, no second tab', async () => {
    const { fc, w, recs } = await archivedSetup();
    const reached = crashAt(w, 'reopen:afterCreateBeforePersist');
    void w.send({ type: 'reopen', recordIds: [recs[1]!.id] });
    await reached;
    await new Promise((r) => setTimeout(r, 20)); // let the tab load
    const w2 = await startWorker(fc);
    await idle(w2);
    expect(tabsWithUrl(fc, recs[1]!.url)).toHaveLength(1);
    expect(fc.createCalls).toHaveLength(1);
    const r = (await w2.db.getRecord(recs[1]!.id))!;
    expect(r.state).toBe('open');
    expect(r.live!.tabId).toBe(tabsWithUrl(fc, recs[1]!.url)[0]!.id);
    expect(await w2.db.getAllRecords()).toHaveLength(4);
  });

  it('crash after the tab id was persisted -> binds it, no second tab', async () => {
    const { fc, w, recs } = await archivedSetup();
    const reached = crashAt(w, 'reopen:afterCreate');
    void w.send({ type: 'reopen', recordIds: [recs[2]!.id] });
    await reached;
    const w2 = await startWorker(fc);
    await idle(w2);
    expect(tabsWithUrl(fc, recs[2]!.url)).toHaveLength(1);
    expect((await w2.db.getRecord(recs[2]!.id))!.state).toBe('open');
    expect(await w2.db.getAllRecords()).toHaveLength(4);
  });
});

describe('extension reload and browser restart', () => {
  it('extension reload (new sessionId, same tab ids) rebinds the same record ids, even for identical URLs', async () => {
    const fc = freshBrowser();
    const a = fc.addTab({ url: 'https://same.example/' }, { silent: true });
    const b = fc.addTab({ url: 'https://same.example/' }, { silent: true });
    fc.seedTabs(5);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const ra = recs.find((r) => r.live!.tabId === a.id)!;
    const rb = recs.find((r) => r.live!.tabId === b.id)!;
    await w.call({ type: 'updateRecords', recordIds: [ra.id], edit: { note: 'A' } });
    await w.call({ type: 'updateRecords', recordIds: [rb.id], edit: { note: 'B' } });
    const oldSession = ra.live!.sessionId;
    fc.reloadExtension();
    const w2 = await startWorker(fc);
    fc.ev.runtime.onInstalled.fire({ reason: 'update' });
    await idle(w2);
    const after = await w2.db.getAllRecords();
    expect(after).toHaveLength(7);
    const ra2 = after.find((r) => r.id === ra.id)!;
    expect(ra2.live!.tabId).toBe(a.id);
    expect(ra2.note).toBe('A');
    expect(after.find((r) => r.id === rb.id)!.live!.tabId).toBe(b.id);
    expect(ra2.live!.sessionId).not.toBe(oldSession);
    assertNoDuplicates(fc, after);
  });

  it('browser restart (new tab ids) rebinds by URL; unmatched records are archived only after the grace', async () => {
    const fc = freshBrowser();
    const tabs = fc.seedTabs(8);
    let w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    // Two tabs are not restored by the browser.
    fc.clearListeners();
    fc.userCloseTab(tabs[6]!.id);
    fc.userCloseTab(tabs[7]!.id);
    fc.restartBrowser({ restartIdsFrom: 1 });
    w = await startWorker(fc);
    fc.ev.runtime.onStartup.fire();
    await idle(w);
    let after = await w.db.getAllRecords();
    expect(after).toHaveLength(8);
    expect(after.filter((r) => r.state === 'open')).toHaveLength(8); // inside the grace nothing is archived
    const sid = (await w.core.session.getSession()).sessionId;
    for (const t of fc.tabs.values()) {
      const r = after.find((x) => x.live?.tabId === t.id && x.live.sessionId === sid);
      expect(r?.url).toBe(t.url);
    }
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(recs.map((r) => r.id)));
    expect(fc.alarms.has('fangio-startup-sweep')).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60000);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-startup-sweep', scheduledTime: Date.now() });
    await idle(w);
    after = await w.db.getAllRecords();
    const missing = after.filter((r) => r.url === tabs[6]!.url || r.url === tabs[7]!.url);
    expect(missing.every((r) => r.state === 'archived' && r.lastReason?.startsWith('No encontrada'))).toBe(true);
    expect(after.filter((r) => r.state === 'open')).toHaveLength(6);
    expect(after.filter((r) => r.state === 'trash')).toHaveLength(0);
    expect(after).toHaveLength(8);
  });

  it('tabs restored progressively after a restart are rebound by the tracker (no duplicates)', async () => {
    const fc = freshBrowser();
    fc.seedTabs(5);
    let w = await startWorker(fc);
    await idle(w);
    const urls = [...fc.tabs.values()].map((t) => t.url);
    fc.restartBrowser({ restore: false });
    w = await startWorker(fc);
    fc.ev.runtime.onStartup.fire();
    await idle(w);
    for (const u of urls) fc.addTab({ url: u });
    await idle(w);
    const after = await w.db.getAllRecords();
    expect(after).toHaveLength(5);
    expect(after.every((r) => r.state === 'open')).toBe(true);
    assertNoDuplicates(fc, after);
  });
});
