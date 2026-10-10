import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSemver } from '../src/core/updateCheck';
import { freshBrowser, idle, startWorker } from './helpers/env';

const DAY = 86400000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function withTrash(n = 4) {
  const fc = freshBrowser();
  fc.seedTabs(n + 2);
  const w = await startWorker(fc);
  await idle(w);
  const recs = await w.db.getAllRecords();
  const trashIds = recs.slice(0, n).map((r) => r.id);
  await w.call({ type: 'trash', recordIds: trashIds });
  await w.call({ type: 'archive', recordIds: [recs[n]!.id] });
  return { fc, w, recs, trashIds, archivedId: recs[n]!.id };
}

describe('purge (permanent deletion) only from trash, with confirmation', () => {
  it('requires ELIMINAR, skips non-trash, deletes trash, is not undoable', async () => {
    const { w, trashIds, archivedId } = await withTrash();
    const bad = await w.send({ type: 'purge', recordIds: trashIds, confirm: 'eliminar' });
    expect(bad.ok).toBe(false);
    expect(await w.db.getAllRecords()).toHaveLength(6);
    const res = await w.call({ type: 'purge', recordIds: [trashIds[0], archivedId], confirm: 'ELIMINAR' });
    expect(res.done).toEqual([trashIds[0]]);
    expect(res.skipped[0].recordId).toBe(archivedId);
    expect(await w.db.getRecord(trashIds[0]!)).toBeUndefined();
    const [p] = await w.db.getActions({ limit: 1 });
    expect(p!.kind).toBe('purge');
    expect(p!.undoable).toBe(false);
    const u = await w.send({ type: 'undo', actionId: p!.id });
    expect(u.ok).toBe(false);
    const empty = await w.call({ type: 'emptyTrash', confirm: 'ELIMINAR' });
    expect(empty.done).toHaveLength(3);
    expect((await w.db.getAllRecords()).filter((r) => r.state === 'trash')).toHaveLength(0);
    expect(await w.db.getAllRecords()).toHaveLength(2);
  });

  it('restore moves trash -> archived and is undoable', async () => {
    const { w, trashIds } = await withTrash(2);
    const res = await w.call({ type: 'restore', recordIds: trashIds });
    expect(res.done).toHaveLength(2);
    expect((await w.db.getRecord(trashIds[0]!))!.state).toBe('archived');
    await w.call({ type: 'undo', actionId: res.actionId });
    expect((await w.db.getRecord(trashIds[0]!))!.state).toBe('trash');
  });

  it('maintenance alarm purges trash older than trashRetentionDays and prunes the log', async () => {
    const { fc, w, trashIds } = await withTrash(3);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 20 * DAY);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-maintenance', scheduledTime: Date.now() });
    await idle(w);
    expect((await w.db.getAllRecords()).filter((r) => r.state === 'trash')).toHaveLength(3);
    vi.setSystemTime(Date.now() + 11 * DAY);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-maintenance', scheduledTime: Date.now() });
    await idle(w);
    for (const id of trashIds) expect(await w.db.getRecord(id)).toBeUndefined();
    const purge = (await w.db.getActions()).find((a) => a.kind === 'purge')!;
    expect(purge.auto).toBe(true);
    expect(purge.reason).toMatch(/más de 30 días/);
    // Log retention (90 days by default).
    vi.setSystemTime(Date.now() + 100 * DAY);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-maintenance', scheduledTime: Date.now() });
    await idle(w);
    const actions = await w.db.getActions();
    expect(actions.every((a) => a.at > Date.now() - 90 * DAY)).toBe(true);
  });

  it('trashRetentionDays = 0 never purges', async () => {
    const { fc, w } = await withTrash(2);
    const s = await w.call({ type: 'getSettings' });
    await w.call({ type: 'saveSettings', settings: { ...s, trashRetentionDays: 0 } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 400 * DAY);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-maintenance', scheduledTime: Date.now() });
    await idle(w);
    expect((await w.db.getAllRecords()).filter((r) => r.state === 'trash')).toHaveLength(2);
  });
});

describe('message router', () => {
  it('answers every request type with an Envelope', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(3);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'v1.2.0', html_url: 'https://github.com/x' }) }));
    const s = await w.call({ type: 'getSettings' });
    const reqs: unknown[] = [
      { type: 'getStatus' },
      { type: 'getSettings' },
      { type: 'saveSettings', settings: s },
      { type: 'updateRecords', recordIds: [recs[2]!.id], edit: { pending: true } },
      { type: 'previewRules' },
      { type: 'getImportPreview' },
      { type: 'getTabRecord', tabId: a!.id },
      { type: 'markBackup' },
      { type: 'reconcileNow' },
      { type: 'checkUpdate' },
      { type: 'runRulesNow' },
      { type: 'archive', recordIds: [recs[0]!.id] },
      { type: 'reopen', recordIds: [recs[0]!.id] },
      { type: 'trash', recordIds: [recs[1]!.id] },
      { type: 'restore', recordIds: [recs[1]!.id] },
      { type: 'merge', keepId: recs[0]!.id, mergeIds: [recs[1]!.id] },
      { type: 'archiveTab', tabId: 99999 },
      { type: 'emptyTrash', confirm: 'ELIMINAR' },
      { type: 'purge', recordIds: [], confirm: 'ELIMINAR' },
      { type: 'importJson', data: { format: 'fangio-export', schemaVersion: 1, records: [] } },
      { type: 'applyImport', archiveIds: [], trashIds: [], protectIds: [] },
      { type: 'skipOnboarding' },
      { type: 'undo', actionId: 'nope' },
      { type: 'reloadExtension' },
      { type: 'doesNotExist' },
      null,
      { type: 'archive' },
    ];
    for (const r of reqs) {
      const env = await w.send(r);
      expect(env, JSON.stringify(r)).toBeTruthy();
      expect(typeof env.ok).toBe('boolean');
      if (!env.ok) expect(typeof env.error).toBe('string');
    }
    expect((await w.send({ type: 'doesNotExist' })).ok).toBe(false);
    expect((await w.send({ type: 'archive' })).ok).toBe(false);
    const st = await w.call({ type: 'getStatus' });
    expect(st.version).toBe('1.2.0');
    expect(st.update).toBeNull();
    expect(st.counts.total).toBe(2); // the merged record was purged by emptyTrash
    expect(st.onboardingDone).toBe(true);
    expect(typeof st.lastBackupAt).toBe('number');
    const keepTab = recs[2]!.live!.tabId;
    const tr = await w.call({ type: 'getTabRecord', tabId: keepTab });
    expect(tr.tab.id).toBe(keepTab);
    expect(tr.record.id).toBe(recs[2]!.id);
    expect((await w.call({ type: 'getTabRecord', tabId: 424242 })).tab).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(fc.reloadCount).toBe(1);
  });

  it('getActions({before}) is exclusive and newest first', async () => {
    const { w } = await withTrash(2);
    const all = await w.db.getActions();
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.at).toBeGreaterThanOrEqual(all[i]!.at);
    const older = await w.db.getActions({ before: all[0]!.at });
    expect(older.every((a) => a.at < all[0]!.at)).toBe(true);
  });
});

describe('import wizard', () => {
  it('suggests keep for blocked tabs, rule action for matching URLs, and applies protect/archive/trash', async () => {
    const fc = freshBrowser();
    const pinned = fc.addTab({ url: 'https://pinned.example/', pinned: true }, { silent: true });
    const gpt = fc.addTab({ url: 'https://chatgpt.com/' }, { silent: true });
    const d1 = fc.addTab({ url: 'https://dup.example/' }, { silent: true });
    const d2 = fc.addTab({ url: 'https://dup.example/' }, { silent: true });
    const p = fc.addTab({ url: 'https://protect-me.example/' }, { silent: true });
    const w = await startWorker(fc);
    await idle(w);
    const prev = await w.call({ type: 'getImportPreview' });
    const by = (id: number) => prev.find((c: { tabId: number }) => c.tabId === id);
    expect(by(pinned.id).suggested).toBe('keep');
    expect(by(pinned.id).blockedBy).toContain('pinned');
    expect(by(gpt.id).suggested).toBe('trash');
    expect(by(d1.id).duplicateCount).toBe(2);
    expect(by(d1.id).suggested).toBe('archive');
    const res = await w.call({
      type: 'applyImport',
      archiveIds: [by(d1.id).recordId, by(d2.id).recordId, by(p.id).recordId],
      trashIds: [by(gpt.id).recordId],
      protectIds: [by(p.id).recordId],
    });
    expect(res.failed).toEqual([]);
    const recs = await w.db.getAllRecords();
    const rid = (id: string) => recs.find((r) => r.id === id)!;
    expect(rid(by(d1.id).recordId).state).toBe('archived');
    expect(rid(by(d2.id).recordId).state).toBe('archived');
    expect(rid(by(gpt.id).recordId).state).toBe('trash');
    expect(rid(by(p.id).recordId).state).toBe('open');
    expect(rid(by(p.id).recordId).protected).toBe(true);
    expect(fc.tabs.has(p.id)).toBe(true);
    expect((await w.db.getSettings()).onboardingDone).toBe(true);
  });
});

describe('commands and badge', () => {
  it('archive-current-tab archives the active tab; refused pages flash "!"', async () => {
    const fc = freshBrowser();
    const [a] = fc.seedTabs(3);
    fc.activate(a!.id);
    const w = await startWorker(fc);
    await idle(w);
    fc.ev.commands.onCommand.fire('archive-current-tab');
    await idle(w);
    expect(fc.tabs.has(a!.id)).toBe(false);
    const ntp = fc.addTab({ url: 'chrome://newtab/', active: true });
    fc.activate(ntp.id);
    fc.ev.commands.onCommand.fire('archive-current-tab');
    await idle(w);
    expect(fc.badgeText).toBe('!');
    expect(fc.tabs.has(ntp.id)).toBe(true);
  });

  it('open-dashboard opens once, then focuses the existing tab', async () => {
    const fc = freshBrowser();
    fc.seedTabs(1);
    const w = await startWorker(fc);
    await idle(w);
    fc.ev.commands.onCommand.fire('open-dashboard');
    await idle(w);
    fc.ev.commands.onCommand.fire('open-dashboard');
    await idle(w);
    const dash = [...fc.tabs.values()].filter((t) => (t.url || t.pendingUrl)!.endsWith('/dashboard.html'));
    expect(dash).toHaveLength(1);
    expect(await w.db.getAllRecords()).toHaveLength(1); // own pages are never tracked
  });

  it('badge shows the number of open records', async () => {
    const fc = freshBrowser();
    fc.seedTabs(7);
    const w = await startWorker(fc);
    await idle(w);
    await w.bg.updateBadge();
    expect(fc.badgeText).toBe('7');
  });

  it('alarms exist after init with explicit periods', async () => {
    const fc = freshBrowser();
    const w = await startWorker(fc);
    await idle(w);
    expect(fc.alarms.get('fangio-maintenance')!.periodInMinutes).toBe(15);
    expect(fc.alarms.get('fangio-update-check')!.periodInMinutes).toBe(1440);
    expect(fc.alarms.has('fangio-automation')).toBe(false);
  });
});

describe('update check', () => {
  it('compares semver tags', () => {
    expect(compareSemver('v1.2.3', '1.2.2')).toBe(1);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
    expect(compareSemver('v2.0.0-beta', '2.0.0')).toBe(-1);
    expect(compareSemver('garbage', '1.0.0')).toBe(0);
  });

  it('stores newer releases, returns null when up to date, never throws', async () => {
    const fc = freshBrowser();
    const w = await startWorker(fc);
    await idle(w);
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v1.3.0', html_url: 'https://github.com/TobiasCoding/Fangio/releases/tag/v1.3.0' }),
    }));
    const up = await w.call({ type: 'checkUpdate' });
    expect(up.latest).toBe('1.3.0');
    expect((await w.call({ type: 'getStatus' })).update.latest).toBe('1.3.0');
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const env = await w.send({ type: 'checkUpdate' });
    expect(env.ok).toBe(true);
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'v1.2.0' }) }));
    expect(await w.call({ type: 'checkUpdate' })).toBeNull();
  });
});
