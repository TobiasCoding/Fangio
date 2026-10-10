// S3 — Restart persistence: graceful browser close + relaunch of the same profile
// (session restore). Archive must be intact, restored tabs rebound to the SAME record ids,
// and records whose window was closed must wait for the startup grace before being archived.
import { checkInvariants, readState, waitSettled, TRACKABLE } from '../lib/checks.mjs';
import { checker, DASH, launchProfile, mem, openDashboard, sleep, waitFor } from '../lib/fangio.mjs';

const GRACE_MS = 3 * 60 * 1000;

export default {
  title: 'Reinicio del navegador: persistencia y re-vinculación',
  async run(ctx) {
    const c = checker();
    const main = ctx.shared.main;
    const { b, helper } = main;
    await waitSettled(b);
    const stA = await readState(b);
    const sidA = stA.sess.sessionId;
    // Close the smallest window that does not hold the dashboard: its open records lose their tab.
    const dashWin = stA.tabs.find((t) => t.url.startsWith(DASH))?.windowId;
    const wins = new Map();
    for (const t of stA.tabs) if (t.windowId !== dashWin) wins.set(t.windowId, [...(wins.get(t.windowId) ?? []), t]);
    const [closeWin, closeTabs] = [...wins].filter(([, ts]) => ts.some((t) => TRACKABLE.test(t.url))).sort((a, b) => a[1].length - b[1].length)[0];
    const closedIds = new Set(closeTabs.map((t) => t.id));
    const expectDeferred = new Set(stA.records.filter((r) => r.state === 'open' && r.live?.sessionId === sidA && closedIds.has(r.live.tabId)).map((r) => r.id));
    await helper.eval((id) => helper.closeWindow(id), closeWin);
    await sleep(2500);
    const stA2 = await readState(b, { actions: false });
    c('closing a window does not change its records (no trash, no archive)', [...expectDeferred].every((id) => stA2.records.find((r) => r.id === id)?.state === 'open'),
      `${expectDeferred.size} records of the closed window`);
    const archivedA = new Map(stA2.records.filter((r) => r.state === 'archived').map((r) => [r.id, r.url]));
    const openBoundA = new Set(stA2.records.filter((r) => r.state === 'open' && !expectDeferred.has(r.id)).map((r) => r.id));
    const tabsBefore = stA2.tabs.length;
    const t0 = Date.now();
    await b.close();
    const shutdownMs = Date.now() - t0;
    const t1 = Date.now();
    const { b: b2, helper: h2 } = await launchProfile(ctx, main.dir, { withFangio: true, expectTabs: tabsBefore });
    const restoreMs = Date.now() - t1;
    Object.assign(main, { b: b2, helper: h2 });
    const settleMs = await waitSettled(b2);
    const stB = await readState(b2);
    const sinceStart = Date.now() - stB.sess.startupAt;
    ctx.log(`  relaunch: tabs restored in ${restoreMs} ms, Fangio settled ${settleMs} ms later (${Math.round(sinceStart / 1000)} s since startup)`);
    mem(b2, 'S3 después de reiniciar (sesión restaurada, Fangio)', ctx);
    c('new browser session', stB.sess.sessionId !== sidA);
    c('record count unchanged', stB.records.length === stA2.records.length, `${stA2.records.length} → ${stB.records.length}`);
    const archivedB = new Map(stB.records.filter((r) => r.state === 'archived').map((r) => [r.id, r.url]));
    c('archive intact (same ids and URLs)', archivedA.size === archivedB.size && [...archivedA].every(([id, u]) => archivedB.get(id) === u), `${archivedA.size} vs ${archivedB.size}`);
    const boundB = new Set(stB.records.filter((r) => r.state === 'open' && r.live?.sessionId === stB.sess.sessionId).map((r) => r.id));
    const missing = [...openBoundA].filter((id) => !boundB.has(id));
    c('restored tabs rebound to the SAME record ids', missing.length === 0 && boundB.size === openBoundA.size, { before: openBoundA.size, after: boundB.size, missing: missing.length });
    c('no new records created by the restore', !stB.records.some((r) => r.source === 'tracked' && r.createdAt > t1));
    const deferred = stB.records.filter((r) => expectDeferred.has(r.id));
    c('records of the closed window still open (unbound) during the startup grace', sinceStart < GRACE_MS && deferred.every((r) => r.state === 'open'),
      { sinceStartS: Math.round(sinceStart / 1000), states: deferred.map((r) => r.state) });
    c.invariants('S3 restart', checkInvariants(ctx.shared.original, stB, { testCreated: ctx.shared.testCreated }));
    const tD = Date.now();
    const page = await openDashboard(b2, '#/lista');
    await page.waitFor(() => document.querySelectorAll('.lrow').length > 0, undefined, { timeout: 60000, label: 'list rows' });
    const dashboardLoadMs = Date.now() - tD;
    main.page = page;
    c('dashboard loads after restart', dashboardLoadMs < 60000, `${dashboardLoadMs} ms`);
    let sweep = null;
    if (!ctx.quick && expectDeferred.size) {
      ctx.log('  waiting for the startup grace (3 min) + sweep alarm…');
      const stS = await waitFor(
        async () => {
          const s = await readState(b2, { actions: false });
          const rs = s.records.filter((r) => expectDeferred.has(r.id));
          return rs.every((r) => r.state !== 'open') ? { s, rs } : null;
        },
        { timeout: GRACE_MS + 180000, interval: 5000, label: 'startup sweep' },
      ).catch(() => null);
      if (stS) {
        const at = Math.min(...stS.rs.map((r) => r.archivedAt));
        sweep = { afterStartupMs: at - stS.s.sess.startupAt, states: [...new Set(stS.rs.map((r) => r.state))], reason: stS.rs[0].lastReason };
      }
      c('after the grace, the closed window\'s records are archived (window-closed), never trashed or deleted',
        !!sweep && sweep.afterStartupMs >= GRACE_MS && sweep.states.every((s) => s === 'archived'), sweep ?? 'sweep did not happen');
      await waitSettled(b2);
      c.invariants('S3 after sweep', checkInvariants(ctx.shared.original, await readState(b2), { testCreated: ctx.shared.testCreated }));
    }
    return {
      checks: c.list,
      metrics: { shutdownMs, relaunchUntilTabsRestoredMs: restoreMs, fangioSettleAfterRestoreMs: settleMs, dashboardLoadMs,
        closedWindowRecords: expectDeferred.size, sweep },
      notes: ['Relaunch loads Fangio with --load-extension (same dist/ path, same id): CDP-loaded unpacked extensions are not persisted by Chromium across restarts.'],
    };
  },
};
