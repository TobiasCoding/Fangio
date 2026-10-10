import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshBrowser, idle, never, startWorker } from './helpers/env';

afterEach(() => {
  vi.useRealTimers();
});

describe('startup sweep after an interrupted close', () => {
  it('a close interrupted by a crash, whose tabs are not restored, is completed by the startup sweep (not left pending until maintenance)', async () => {
    const fc = freshBrowser();
    fc.seedTabs(6);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    // Crash right after the tabs were removed, before the final write.
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterRemove') {
        reached();
        return never();
      }
    };
    void w.send({ type: 'archive', recordIds: recs.map((r) => r.id) });
    await hit;
    // Browser restart: the closed tabs do not come back.
    fc.restartBrowser({ restore: false });
    const w2 = await startWorker(fc);
    fc.ev.runtime.onStartup.fire();
    await idle(w2);
    let after = await w2.db.getAllRecords();
    // Inside the grace: deferred, never trashed or deleted.
    expect(after).toHaveLength(6);
    expect(after.every((r) => r.state === 'open' && r.pendingClose)).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60000);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-startup-sweep', scheduledTime: Date.now() });
    await idle(w2);
    after = await w2.db.getAllRecords();
    expect(after).toHaveLength(6);
    expect(after.every((r) => r.state === 'archived' && !r.pendingClose && !r.live)).toBe(true);
    expect(await w2.db.getOps({ unfinishedOnly: true })).toHaveLength(0);
  });
});

describe('tabs restored by the browser right after we closed them (crash after a mass archive)', () => {
  async function archivedThenRestart(advanceMs: number) {
    const fc = freshBrowser();
    fc.seedTabs(5);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const urls = recs.map((r) => r.url);
    await w.call({ type: 'archive', recordIds: recs.map((r) => r.id) });
    if (advanceMs) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + advanceMs);
    }
    // The session file still had the tabs: the browser brings them back after the restart.
    fc.restartBrowser({ restore: false });
    const w2 = await startWorker(fc);
    fc.ev.runtime.onStartup.fire();
    await idle(w2);
    for (const u of urls) fc.addTab({ url: u });
    await idle(w2);
    return { fc, w2, recs };
  }

  it('re-binds them to the SAME records instead of creating duplicates', async () => {
    const { w2, recs } = await archivedThenRestart(0);
    const after = await w2.db.getAllRecords();
    expect(after).toHaveLength(5);
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(recs.map((r) => r.id)));
    expect(after.every((r) => r.state === 'open' && r.live)).toBe(true);
    expect((await w2.db.getActions()).some((a) => a.kind === 'rebind' && a.recordIds.length === 5)).toBe(true);
  });

  it('does not touch records archived long before the restart (a new tab with that URL is a new record)', async () => {
    const { w2 } = await archivedThenRestart(20 * 60000);
    const after = await w2.db.getAllRecords();
    expect(after).toHaveLength(10);
    expect(after.filter((r) => r.state === 'archived')).toHaveLength(5);
    expect(after.filter((r) => r.state === 'open' && r.source === 'tracked')).toHaveLength(5);
  });

  it('never re-binds a record archived in the CURRENT session (explicit archive stays archived)', async () => {
    const fc = freshBrowser();
    const [t] = fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const rec = (await w.db.getAllRecords()).find((r) => r.url === t!.url)!;
    await w.call({ type: 'archive', recordIds: [rec.id] });
    fc.addTab({ url: t!.url });
    await idle(w);
    const after = await w.db.getAllRecords();
    expect(after.find((r) => r.id === rec.id)!.state).toBe('archived');
    expect(after.filter((r) => r.url === t!.url)).toHaveLength(2);
  });
});
