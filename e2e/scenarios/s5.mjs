// S5 — Reopen 50 archived records from the list UI (keyboard multi-select + "Reabrir"),
// observe concurrency from a second extension, then re-archive and undo (ids preserved).
import { checkInvariants, readState, waitSettled } from '../lib/checks.mjs';
import { checker, DASH, num, sendMsg, sleep, waitFor } from '../lib/fangio.mjs';

function maxOverlap(events, urls) {
  const start = new Map();
  const end = new Map();
  for (const e of events) {
    if (e.ev === 'created' && urls.has(e.url)) start.set(e.id, e.t);
    if (start.has(e.id) && !end.has(e.id) && ((e.ev === 'status' && e.status === 'complete') || e.ev === 'removed')) end.set(e.id, e.t);
  }
  const pts = [];
  for (const [id, t] of start) {
    pts.push([t, 1]);
    pts.push([end.get(id) ?? Infinity, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of pts) max = Math.max(max, (cur += d));
  return { created: start.size, completed: end.size, maxConcurrentLoading: max };
}

async function waitStates(b, ids, state, label, timeout = 300000) {
  return waitFor(
    async () => {
      const st = await readState(b, { actions: false });
      const rs = st.records.filter((r) => ids.has(r.id));
      return rs.length === ids.size && rs.every((r) => r.state === state && !r.pendingClose) ? st : null;
    },
    { timeout, interval: 250, label },
  );
}

export default {
  title: 'Reabrir 50 desde la UI (concurrencia, mismos ids, deshacer)',
  async run(ctx) {
    const c = checker();
    const { b, helper, page } = ctx.shared.main;
    await page.goto(`${DASH}#/lista`);
    await page.front();
    await page.click('.seg-btn', { text: 'Archivadas' });
    await page.waitFor(() => document.querySelectorAll('.lrow').length > 0, undefined, { label: 'archived rows' });
    const st0 = await readState(b, { actions: false });
    const settings = st0.settings;
    const archived0 = new Set(st0.records.filter((r) => r.state === 'archived').map((r) => r.id));
    await page.eval(() => document.querySelector('.vlist.records').focus());
    for (let i = 0; i < 49; i++) await page.press('ArrowDown', ['Shift']);
    const selText = await page.waitFor(() => document.querySelector('.bulkbar strong')?.textContent, undefined, { label: 'bulkbar' });
    c('keyboard multi-select selects 50 rows', num(selText) === 50, selText);
    await helper.eval(() => helper.startRecording());
    await page.click('.bulkbar button', { text: 'Reabrir', exact: true });
    await page.locateWait('dialog[open] button[type=submit]');
    const t0 = Date.now();
    await page.click('dialog[open] button[type=submit]');
    const reopened = await waitFor(
      async () => {
        const st = await readState(b, { actions: false });
        const rs = st.records.filter((r) => archived0.has(r.id) && r.state === 'open');
        return rs.length >= 50 ? { st, rs } : null;
      },
      { timeout: 600000, interval: 250, label: '50 records open' },
    );
    const boundMs = Date.now() - t0;
    await waitFor(async () => (await readState(b, { actions: false })).ops.filter((o) => o.kind === 'reopen').every((o) => o.finished), {
      timeout: 600000, interval: 500, label: 'reopen op finished',
    });
    const doneMs = Date.now() - t0;
    await sleep(1000);
    const events = await helper.eval(() => helper.stopRecording());
    const ids = new Set(reopened.rs.map((r) => r.id));
    const urls = new Set(reopened.rs.map((r) => r.url));
    const conc = maxOverlap(events, urls);
    ctx.log(`  reopen 50: all bound after ${boundMs} ms, op finished after ${doneMs} ms; ${JSON.stringify(conc)}`);
    c('exactly 50 records reopened, no new records', reopened.rs.length === 50 && reopened.st.records.length === st0.records.length,
      `${reopened.rs.length} reopened, records ${st0.records.length}→${reopened.st.records.length}`);
    c(`concurrency never exceeds reopenConcurrency (${settings.reopenConcurrency})`, conc.maxConcurrentLoading <= settings.reopenConcurrency && conc.created === 50, conc);
    c('reopened records bound to live tabs with reopenCount>=1', reopened.rs.every((r) => r.live && r.reopenCount >= 1));
    await waitSettled(b);
    const stA = await readState(b);
    c.invariants('S5 reopen', checkInvariants(ctx.shared.original, stA, { testCreated: ctx.shared.testCreated }));
    const discarded = stA.tabs.filter((t) => urls.has(t.url) && t.discarded).length;

    // Re-archive the same 50 (same message the list's "Archivar" sends).
    const t1 = Date.now();
    const ar = await sendMsg(page, { type: 'archive', recordIds: [...ids] });
    const rearchiveMs = Date.now() - t1;
    await waitStates(b, ids, 'archived', 're-archived');
    c('re-archive keeps the same ids', ar.done.length === 50 && ar.done.every((id) => ids.has(id)), { done: ar.done.length, skipped: ar.skipped.length });

    // Undo that archive from Registro (reopens the same ids).
    await page.goto(`${DASH}#/registro`);
    await page.waitFor(() => document.querySelectorAll('.log-entry').length > 0, undefined, { label: 'log entries' });
    await page.click('.log-entry button', { text: 'Deshacer', index: 0 });
    await sleep(300);
    if (await page.eval(() => !!document.querySelector('dialog[open]'))) await page.click('dialog[open] button[type=submit]');
    const t2 = Date.now();
    const stU = await waitStates(b, ids, 'open', 'undo reopened');
    const undoMs = Date.now() - t2;
    c('undo reopens exactly the same record ids', stU.records.length === st0.records.length);
    await waitSettled(b);
    // Leave the browser as it was (archived) for the following scenarios.
    await sendMsg(page, { type: 'archive', recordIds: [...ids] });
    await waitStates(b, ids, 'archived', 'final re-archive');
    await waitSettled(b);
    const stEnd = await readState(b);
    c('record count unchanged after reopen/archive/undo/archive', stEnd.records.length === st0.records.length);
    c.invariants('S5 end', checkInvariants(ctx.shared.original, stEnd, { testCreated: ctx.shared.testCreated }));
    return {
      checks: c.list,
      metrics: { reopen50AllBoundMs: boundMs, reopen50OpFinishedMs: doneMs, ...conc, reopenConcurrency: settings.reopenConcurrency,
        discardedAfterBulkReopen: discarded, rearchive50Ms: rearchiveMs, undoReopen50Ms: undoMs },
    };
  },
};
