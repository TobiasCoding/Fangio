// S1 — Install snapshot: Fangio is loaded into a RUNNING browser that already has ~N tabs
// (CDP Extensions.loadUnpacked). Every trackable tab must get exactly one 'open' record.
import { resolve } from 'node:path';
import { copyProfile } from '../lib/fixtures.mjs';
import { checkInvariants, readState, waitSettled } from '../lib/checks.mjs';
import { checker, extensionPids, installAndSnapshot, launchProfile, mem, trackableTabs, wakeAudio } from '../lib/fangio.mjs';

export default {
  title: 'Instalación con pestañas existentes (snapshot)',
  async run(ctx) {
    const c = checker();
    const tpl = await ctx.template();
    const dir = copyProfile(tpl.dir, resolve(ctx.profilesDir, 'main'));
    const { b, helper } = await launchProfile(ctx, dir, { expectTabs: tpl.restoredTabs });
    ctx.shared.main = { b, helper, dir };
    const audible = await wakeAudio(helper);
    const { snap, tabs } = await trackableTabs(helper);
    const original = tabs.map((t) => ({ url: t.url, title: t.title, windowId: t.windowId, index: t.index, groupId: t.groupId, pinned: t.pinned }));
    const groupTitle = new Map(snap.groups.map((g) => [g.id, g.title]));
    for (const o of original) o.groupTitle = o.groupId >= 0 ? groupTitle.get(o.groupId) : undefined;
    ctx.shared.original = original;
    ctx.shared.testCreated = [];
    const windows = new Set(snap.tabs.map((t) => t.windowId)).size;
    const loaded = snap.tabs.filter((t) => t.status !== 'unloaded' && !t.discarded).length;
    ctx.log(`  browser has ${snap.tabs.length} tabs (${tabs.length} trackable) in ${windows} windows; ${loaded} loaded; audible tab: ${audible}`);
    const before = mem(b, 'S1 antes de instalar (pestañas existentes, sin Fangio)', ctx);
    const r = await installAndSnapshot(ctx, b, tabs.length);
    ctx.log(`  install snapshot: ${r.state.records.length} records in ${r.snapshotMs} ms (loadUnpacked ${r.loadMs} ms)`);
    await waitSettled(b);
    const st = await readState(b);
    const after = mem(b, 'S1 después del snapshot de instalación', ctx);
    const newExt = after.procs.filter((p) => p.type === 'extension' && !extensionPids(before).has(p.pid));
    ctx.shared.fangioExtPids = newExt.map((p) => p.pid);
    c('extension id pinned by manifest key', r.id === 'domaedkeecbijcmbcjcfpjeabbdcmefb', r.id);
    c('one record per trackable tab', st.records.length === tabs.length, `${st.records.length} records / ${tabs.length} tabs`);
    c('all records are install-snapshot and open', st.records.every((x) => x.source === 'install-snapshot' && x.state === 'open'));
    const perUrlTabs = new Map();
    for (const t of tabs) perUrlTabs.set(t.url, (perUrlTabs.get(t.url) ?? 0) + 1);
    const perUrlRecs = new Map();
    for (const x of st.records) perUrlRecs.set(x.url, (perUrlRecs.get(x.url) ?? 0) + 1);
    const dupUrls = [...perUrlTabs].filter(([, n]) => n > 1);
    const dupOk = dupUrls.every(([u, n]) => perUrlRecs.get(u) === n);
    ctx.shared.s9part1 = { dupUrls: dupUrls.length, dupOk };
    c('identical-URL tabs keep separate records', dupOk && dupUrls.length > 0, `${dupUrls.length} duplicated URLs`);
    const snapAction = st.actions.find((a) => a.kind === 'install-snapshot');
    c('install-snapshot action logged', snapAction && snapAction.n === tabs.length, snapAction ? `n=${snapAction.n}` : 'missing');
    const groupsOk = st.records.filter((x) => x.origin?.groupTitle).length;
    c('group titles captured in origin', groupsOk >= original.filter((o) => o.groupTitle).length, `${groupsOk} records with groupTitle`);
    c.invariants('S1', checkInvariants(original, st));
    return {
      checks: c.list,
      metrics: {
        tabs: snap.tabs.length, trackableTabs: tabs.length, windows, loadedTabs: loaded, audibleTab: audible,
        loadUnpackedMs: r.loadMs, installSnapshotMs: r.snapshotMs, records: st.records.length,
        fangioExtensionProcessMB: newExt.reduce((a, p) => a + p.workingSetMB, 0),
        memBeforeMB: before.workingSetMB, memAfterMB: after.workingSetMB,
      },
      notes: [audible ? 'Audio tab audible (fake audio sink).' : 'Audio tab NOT audible in this run.'],
    };
  },
};
