import { afterEach, describe, expect, it, vi } from 'vitest';
import { REBIND_WINDOW_MS } from '../src/shared/constants';
import { freshBrowser, idle, startWorker } from './helpers/env';

afterEach(() => {
  vi.useRealTimers();
});

describe('tracker: who closed the tab', () => {
  it('user-closed tabs go to trash with reason and one coalesced log entry', async () => {
    const fc = freshBrowser();
    const tabs = fc.seedTabs(5);
    const w = await startWorker(fc);
    await idle(w);
    for (const t of tabs.slice(0, 3)) fc.userCloseTab(t.id);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const trashed = recs.filter((r) => r.state === 'trash');
    expect(trashed).toHaveLength(3);
    expect(trashed.every((r) => r.lastReason === 'Cerrada por el usuario' && r.implicitCloseAt && r.trashedAt && !r.live)).toBe(true);
    const userClosed = (await w.db.getActions()).filter((a) => a.kind === 'user-closed');
    expect(userClosed).toHaveLength(1);
    expect(userClosed[0]!.recordIds).toHaveLength(3);
    // Undo reopens them with the same ids.
    const res = await w.call({ type: 'undo', actionId: userClosed[0]!.id });
    expect(res.done.sort()).toEqual(trashed.map((r) => r.id).sort());
    await idle(w);
    expect((await w.db.getAllRecords()).filter((r) => r.state === 'open')).toHaveLength(5);
    expect(await w.db.getAllRecords()).toHaveLength(5);
  });

  it('window closing changes nothing at the event; reconcile archives after the grace (never trash)', async () => {
    const fc = freshBrowser();
    const w1 = fc.addWindow();
    fc.seedTabs(3, (i) => `https://keep${i}.example/`, { windowId: w1 });
    const w2 = fc.addWindow();
    fc.seedTabs(4, (i) => `https://win2-${i}.example/`, { windowId: w2 });
    const w = await startWorker(fc);
    await idle(w);
    fc.closeWindow(w2);
    await idle(w);
    let recs = await w.db.getAllRecords();
    expect(recs.filter((r) => r.state === 'open')).toHaveLength(7);
    await w.call({ type: 'reconcileNow' }); // still inside the startup grace
    recs = await w.db.getAllRecords();
    expect(recs.filter((r) => r.state === 'open')).toHaveLength(7);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60000);
    await w.call({ type: 'reconcileNow' });
    recs = await w.db.getAllRecords();
    expect(recs.filter((r) => r.state === 'archived' && r.url.startsWith('https://win2-'))).toHaveLength(4);
    expect(recs.filter((r) => r.state === 'trash')).toHaveLength(0);
    const wc = (await w.db.getActions()).find((a) => a.kind === 'window-closed')!;
    expect(wc.recordIds).toHaveLength(4);
  });

  it('closes made by Fangio are not "user-closed"', async () => {
    const fc = freshBrowser();
    fc.seedTabs(6);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    await w.call({ type: 'trash', recordIds: recs.slice(0, 3).map((r) => r.id) });
    await idle(w);
    expect((await w.db.getActions()).some((a) => a.kind === 'user-closed')).toBe(false);
    const after = await w.db.getAllRecords();
    expect(after.filter((r) => r.state === 'trash').every((r) => r.lastReason === 'Enviada a la papelera manualmente')).toBe(true);
  });
});

describe('tracker: rebind instead of duplicates', () => {
  it('Ctrl+Shift+T within REBIND_WINDOW_MS rebinds the same record; later it creates a new one', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const ra = (await w.db.getAllRecords()).find((r) => r.live!.tabId === a!.id)!;
    fc.userCloseTab(a!.id);
    await idle(w);
    expect((await w.db.getRecord(ra.id))!.state).toBe('trash');
    const reopened = fc.addTab({ url: a!.url, title: a!.title });
    await idle(w);
    let recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(2);
    const back = (await w.db.getRecord(ra.id))!;
    expect(back.state).toBe('open');
    expect(back.live!.tabId).toBe(reopened.id);
    expect((await w.db.getActions()).some((x) => x.kind === 'rebind' && x.recordIds.includes(ra.id))).toBe(true);

    fc.userCloseTab(reopened.id);
    await idle(w);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + REBIND_WINDOW_MS + 60000);
    fc.addTab({ url: a!.url });
    await idle(w);
    recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(3);
    expect((await w.db.getRecord(ra.id))!.state).toBe('trash');
  });

  it('explicitly archived records are never rebound', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const ra = (await w.db.getAllRecords()).find((r) => r.live!.tabId === a!.id)!;
    await w.call({ type: 'archive', recordIds: [ra.id] });
    fc.addTab({ url: a!.url });
    await idle(w);
    expect((await w.db.getRecord(ra.id))!.state).toBe('archived');
    expect(await w.db.getAllRecords()).toHaveLength(3);
  });

  it('navigation updates the URL and keeps the previous one', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(1, () => 'https://a.example/1');
    const w = await startWorker(fc);
    await idle(w);
    fc.navigate(a!.id, 'https://a.example/2', 'Página 2');
    await idle(w);
    const [r] = await w.db.getAllRecords();
    expect(r!.url).toBe('https://a.example/2');
    expect(r!.title).toBe('Página 2');
    expect(r!.previousUrls).toEqual(['https://a.example/1']);
  });

  it('new tabs and untrackable pages', async () => {
    const fc = freshBrowser();
    fc.seedTabs(1);
    const w = await startWorker(fc);
    await idle(w);
    fc.addTab({ url: 'chrome://newtab/' });
    fc.addTab({ url: 'about:blank' });
    fc.addTab({ url: 'chrome-extension://fangiotestextensionid/dashboard.html' });
    const t = fc.addTab({ url: 'https://new.example/x?y=1' });
    await idle(w);
    const recs = await w.db.getAllRecords();
    expect(recs).toHaveLength(2);
    const r = recs.find((x) => x.live!.tabId === t.id)!;
    expect(r.source).toBe('tracked');
    expect(r.url).toBe('https://new.example/x?y=1');
  });

  it('activation and audio are tracked', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(2, (i) => `https://x${i}.example/`, { lastAccessed: 1000 });
    const w = await startWorker(fc);
    await idle(w);
    fc.activate(a!.id);
    fc.setAudible(a!.id, true);
    await idle(w);
    const r = (await w.db.getAllRecords()).find((x) => x.live!.tabId === a!.id)!;
    expect(r.lastAccessedAt).toBeGreaterThan(Date.now() - 5000);
    expect(r.lastAudibleAt).toBeGreaterThan(Date.now() - 5000);
  });
});
