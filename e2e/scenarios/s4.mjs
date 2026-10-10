// S4 — HARD KILL mid-archive: start a mass archive of every open record, kill the whole
// browser process tree (taskkill /F /T) at several points, relaunch and check that no tab
// was lost without a record and the journal was resumed/aborted per spec.
import { resolve } from 'node:path';
import { copyProfile } from '../lib/fixtures.mjs';
import { checkInvariants, readState, waitSettled } from '../lib/checks.mjs';
import { checker, FANGIO, installAndSnapshot, launchProfile, openDashboard, sendNoWait, sleep, trackableTabs, waitFor } from '../lib/fangio.mjs';

const GRACE_MS = 3 * 60 * 1000;
const summarize = (st, inv) => ({
  ...inv.stats, unfinishedOps: st.ops.filter((o) => !o.finished).length,
  newTrackedRecords: st.records.filter((r) => r.source === 'tracked').length, warnings: inv.warnings,
});

async function swReachable(page) {
  return page.eval(async () => {
    try {
      const e = await chrome.runtime.sendMessage({ type: 'getStatus' });
      return !!e?.ok;
    } catch {
      return false;
    }
  });
}

async function killPoint(ctx, b, helper, timing, ids, n0) {
  const tabCount = async () => helper.eval(async () => (await chrome.tabs.query({})).length);
  if (timing === 'early') {
    const fangio = b.ext(FANGIO);
    return waitFor(
      () => fangio.eval(async () => {
        const db = await new Promise((res) => { const r = indexedDB.open('fangio'); r.onsuccess = () => res(r.result); });
        const ops = await new Promise((res) => { const r = db.transaction('ops').objectStore('ops').getAll(); r.onsuccess = () => res(r.result); });
        db.close();
        const op = ops.find((o) => o.kind === 'close' && !o.finished);
        return op ? `journal written (${op.items.filter((i) => i.status !== 'pending').length} items past 'pending')` : null;
      }),
      { timeout: 60000, interval: 10, label: 'close journal' },
    );
  }
  const frac = timing === 'middle' ? 0.5 : 0.95;
  return waitFor(async () => {
    const n = await tabCount();
    return n0 - n >= ids.length * frac ? `${n0 - n} tabs closed` : null;
  }, { timeout: 300000, interval: 25, label: `${frac * 100}% closed` });
}

async function oneRun(ctx, timing, c) {
  const tpl = await ctx.template();
  const dir = copyProfile(tpl.dir, resolve(ctx.profilesDir, `kill-${timing}`));
  let { b, helper } = await launchProfile(ctx, dir, { expectTabs: tpl.restoredTabs });
  try {
    const { tabs } = await trackableTabs(helper);
    const original = tabs.map((t) => ({ url: t.url }));
    await installAndSnapshot(ctx, b, tabs.length);
    await waitSettled(b);
    let page = await openDashboard(b, '#/lista');
    const st0 = await readState(b, { actions: false });
    const ids = st0.records.filter((r) => r.state === 'open').map((r) => r.id);
    const n0 = await helper.eval(async () => (await chrome.tabs.query({})).length);
    const t0 = Date.now();
    await sendNoWait(page, { type: 'archive', recordIds: ids, reason: 'E2E: archivado masivo' });
    const observed = await killPoint(ctx, b, helper, timing, ids, n0);
    const killAfterMs = Date.now() - t0;
    b.kill();
    await b.waitExit();
    ctx.log(`  [${timing}] killed ${killAfterMs} ms after starting to archive ${ids.length} (${observed})`);
    const res = { timing, targets: ids.length, killAfterMs, observed };

    // Relaunch #1 right after the crash.
    ({ b, helper } = await launchProfile(ctx, dir, { withFangio: true }));
    await sleep(4000);
    page = await openDashboard(b, '#/registro');
    res.serviceWorkerStartsAfterCrash = await swReachable(page);
    const stCrash = await readState(page);
    const invCrash = checkInvariants(original, stCrash, { allowDeferredPending: true });
    // Without a running worker nothing can be bound: only "no URL lost / no inflation" apply here.
    c(`kill ${timing}: right after the crash no URL is lost and no record is duplicated`, invCrash.stats.lost === 0 && invCrash.stats.inflatedUrls === 0 && stCrash.records.length <= original.length, invCrash.stats);
    res.afterCrashRelaunch = summarize(stCrash, invCrash);
    if (!res.serviceWorkerStartsAfterCrash) {
      ctx.log(`  [${timing}] Fangio's service worker does not start in the first session after the crash (Chromium); restarting the browser normally`);
      await b.close();
      ({ b, helper } = await launchProfile(ctx, dir, { withFangio: true }));
      await sleep(3000);
    }
    await waitSettled(b, { interval: 2000 });
    const st = await readState(b);
    const inv = checkInvariants(original, st, { allowDeferredPending: true });
    c.invariants(`kill ${timing} (Fangio running, inside startup grace)`, inv);
    res.afterRestart = summarize(st, inv);
    if (!ctx.quick) {
      const wait = Math.max(0, st.sess.startupAt + GRACE_MS + 20000 - Date.now());
      ctx.log(`  [${timing}] waiting ${Math.round(wait / 1000)} s for the startup grace + sweep…`);
      await sleep(wait);
      await waitSettled(b, { interval: 2000 });
      const st2 = await readState(b);
      const inv2 = checkInvariants(original, st2, { allowDeferredPending: true });
      c.invariants(`kill ${timing} (after the startup grace)`, inv2);
      res.afterGrace = summarize(st2, inv2);
      c(`kill ${timing}: interrupted close resolved after the grace (no pendingClose / unfinished op left)`, inv2.stats.pendingClose === 0 && res.afterGrace.unfinishedOps === 0,
        { pendingClose: inv2.stats.pendingClose, unfinishedOps: res.afterGrace.unfinishedOps });
    }
    return res;
  } finally {
    await b.close().catch(() => b.kill());
  }
}

export default {
  title: 'Corte duro (taskkill /F /T) durante un archivado masivo',
  async run(ctx) {
    const c = checker();
    const runs = [];
    for (const timing of ctx.opts.killAt) {
      try {
        runs.push(await oneRun(ctx, timing, c));
      } catch (e) {
        c(`kill ${timing} run completed`, false, String(e?.stack ?? e));
      }
    }
    for (const r of runs) ctx.log(`  [${r.timing}] ${JSON.stringify(r)}`);
    return { checks: c.list, metrics: { runs } };
  },
};
