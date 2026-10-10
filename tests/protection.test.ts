import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshBrowser, idle, startWorker } from './helpers/env';

const H = 3600000;

afterEach(() => {
  vi.useRealTimers();
});

async function setupMixed() {
  const fc = freshBrowser();
  const old = Date.now() - 30 * H;
  const mk = (url: string, p = {}) => fc.addTab({ url, lastAccessed: old, ...p }, { silent: true });
  const t = {
    prot: mk('https://protected.example/'),
    pinned: mk('https://pinned.example/', { pinned: true }),
    active: mk('https://active.example/', { active: true }),
    highlighted: mk('https://hl.example/', { highlighted: true }),
    audible: mk('https://audio.example/', { audible: true }),
    recentAudio: mk('https://recentaudio.example/'),
    excluded: mk('https://docs.google.com/document/d/1'),
    ext: mk('chrome-extension://fangiotestextensionid/dashboard.html'),
    plain1: mk('https://plain1.example/'),
    plain2: mk('https://plain2.example/'),
    plain3: mk('https://plain3.example/'),
  };
  const w = await startWorker(fc);
  await idle(w);
  const recs = await w.db.getAllRecords();
  const rid = (tab: { id: number }) => recs.find((r) => r.live?.tabId === tab.id)?.id;
  await w.call({ type: 'updateRecords', recordIds: [rid(t.prot)], edit: { protected: true } });
  fc.setAudible(t.recentAudio.id, true);
  fc.setAudible(t.recentAudio.id, false);
  await idle(w);
  return { fc, w, t, rid };
}

describe('automation never closes protected tabs', () => {
  it('runRulesNow closes only unprotected idle tabs', async () => {
    const { fc, w, t } = await setupMixed();
    expect(fc.tabs.size).toBe(11);
    const res = await w.call({ type: 'runRulesNow' });
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(3);
    const remaining = [...fc.tabs.values()].map((x) => x.url).sort();
    for (const k of ['prot', 'pinned', 'active', 'highlighted', 'audible', 'recentAudio', 'excluded', 'ext'] as const) {
      expect(remaining).toContain(t[k].url);
    }
    for (const k of ['plain1', 'plain2', 'plain3'] as const) expect(remaining).not.toContain(t[k].url);
    const archived = (await w.db.getAllRecords()).filter((r) => r.state === 'archived');
    expect(archived.every((r) => /Archivada automáticamente: sin consultar hace 30 h \(inactividad > 24 h\)/.test(r.lastReason!))).toBe(true);
    const last = await w.db.getKv<{ summary: string }>('lastAutoRun');
    expect(last!.summary).toContain('3 cerradas');
    const [a] = await w.db.getActions({ limit: 1 });
    expect(a!.auto).toBe(true);
  });

  it('alarm runs only when automationEnabled and after the startup grace; respects the cap', async () => {
    const { fc, w } = await setupMixed();
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-automation', scheduledTime: Date.now() });
    await idle(w);
    expect(fc.tabs.size).toBe(11);
    const s = await w.call({ type: 'getSettings' });
    await w.call({ type: 'saveSettings', settings: { ...s, automationEnabled: true, maxAutoClosePerRun: 2 } });
    await idle(w);
    expect(fc.alarms.get('fangio-automation')?.periodInMinutes).toBe(s.checkIntervalMinutes);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-automation', scheduledTime: Date.now() });
    await idle(w);
    expect(fc.tabs.size).toBe(11); // still inside the startup grace
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60000);
    fc.ev.alarms.onAlarm.fire({ name: 'fangio-automation', scheduledTime: Date.now() });
    await idle(w);
    expect(fc.tabs.size).toBe(9);
  });

  it('a tab that becomes active right before closing is skipped (auto revalidation)', async () => {
    const { fc, w, t } = await setupMixed();
    w.db.testHooks.checkpoint = (name) => {
      if (name === 'close:afterSave') {
        const tab = fc.tabs.get(t.plain1.id)!;
        tab.active = true;
      }
    };
    const res = await w.call({ type: 'runRulesNow' });
    w.db.testHooks.checkpoint = undefined;
    expect(res.done).toHaveLength(2);
    expect(fc.tabs.has(t.plain1.id)).toBe(true);
    expect(res.skipped.some((x: { tabId?: number }) => x.tabId === t.plain1.id)).toBe(true);
  });
});

describe('manual actions on protected records', () => {
  it('refused without force (skipped with recordId); force unprotects, archives, and undo restores both', async () => {
    const { fc, w, t, rid } = await setupMixed();
    const id = rid(t.prot)!;
    const refused = await w.call({ type: 'archive', recordIds: [id] });
    expect(refused.done).toEqual([]);
    expect(refused.skipped[0].recordId).toBe(id);
    expect(fc.tabs.has(t.prot.id)).toBe(true);

    const forced = await w.call({ type: 'archive', recordIds: [id], force: true });
    expect(forced.done).toEqual([id]);
    expect(fc.tabs.has(t.prot.id)).toBe(false);
    const rec = (await w.db.getRecord(id))!;
    expect(rec.state).toBe('archived');
    expect(rec.protected).toBe(false);
    const actions = await w.db.getActions({ limit: 5 });
    expect(actions.some((a) => a.kind === 'update' && a.recordIds.includes(id) && a.before![id]!.protected === true)).toBe(true);

    const undo = await w.call({ type: 'undo', actionId: forced.actionId });
    expect(undo.done).toEqual([id]);
    await idle(w);
    const back = (await w.db.getRecord(id))!;
    expect(back.state).toBe('open');
    expect(back.protected).toBe(true);
    expect([...fc.tabs.values()].filter((x) => x.url === t.prot.url)).toHaveLength(1);
    const orig = (await w.db.getActions({ limit: 10 })).find((a) => a.id === forced.actionId)!;
    expect(orig.undoneAt).toBeTruthy();
    await expect(w.call({ type: 'undo', actionId: forced.actionId })).rejects.toThrow(/ya se deshizo/);
  });

  it('manual archive closes pinned/active tabs (explicit user action)', async () => {
    const { fc, w, t, rid } = await setupMixed();
    const res = await w.call({ type: 'archive', recordIds: [rid(t.pinned), rid(t.active)] });
    expect(res.done).toHaveLength(2);
    expect(fc.tabs.has(t.pinned.id)).toBe(false);
  });
});
