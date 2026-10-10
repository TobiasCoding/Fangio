// S2 — Initial import wizard driven through the real dashboard UI (#/importar):
// preview counts & suggestions, protect a few rows, apply, measure, verify.
import { checkInvariants, readState, waitSettled, TRACKABLE } from '../lib/checks.mjs';
import { checker, DASH, mem, num, openDashboard, sendMsg, sleep } from '../lib/fangio.mjs';

const summary = (page) =>
  page.eval(() => {
    const t = document.querySelector('.import-summary')?.textContent ?? '';
    const m = /archivarán\s*([\d.]+).*papelera\s*([\d.]+).*abiertas\s*([\d.]+)/s.exec(t);
    return m ? { archive: m[1], trash: m[2], keep: m[3] } : null;
  });

/** Title our test server gives a URL (unloaded restored tabs may report the URL as title). */
function serverTitle(url) {
  const u = new URL(url);
  if (u.pathname === '/') return 'Inicio de prueba';
  if (u.pathname === '/audio') return 'Audio de prueba';
  const m = /^\/p\/(\d+)$/.exec(u.pathname);
  const q = u.searchParams.get('q');
  return m ? `Página ${m[1]}${q ? ` (${q})` : ''}` : null;
}

export default {
  title: 'Asistente de importación por la UI (archivar ~800)',
  async run(ctx) {
    const c = checker();
    const { b } = ctx.shared.main;
    const original = ctx.shared.original;
    const page = await openDashboard(b, '#/lista');
    ctx.shared.main.page = page;
    // Site exclusion for the localhost pages (default exclusions are real sites we cannot serve).
    const s0 = await sendMsg(page, { type: 'getSettings' });
    await sendMsg(page, { type: 'saveSettings', settings: { ...s0, siteExclusions: [...s0.siteExclusions, 'localhost'] } });
    const tNav = Date.now();
    await page.goto(`${DASH}#/importar`);
    const sum0 = await page.waitFor(
      () => {
        const t = document.querySelector('.import-summary')?.textContent ?? '';
        return document.querySelectorAll('.itab').length > 0 && /archivarán/.test(t) ? t : null;
      },
      undefined,
      { timeout: 120000, label: 'import preview' },
    );
    const previewMs = Date.now() - tNav;
    const ui0 = await summary(page);
    ctx.log(`  preview shown in ${previewMs} ms: ${JSON.stringify(ui0)}`);

    // Expected suggestions from the real tab state.
    const st0 = await readState(b, { actions: false });
    const sid = st0.sess.sessionId;
    const byTab = new Map(st0.records.filter((r) => r.live?.sessionId === sid).map((r) => [r.live.tabId, r]));
    const exp = { archive: 0, keep: 0, trash: 0 };
    const blockedUrls = [];
    for (const t of st0.tabs) {
      if (!TRACKABLE.test(t.url) || !byTab.has(t.id)) continue;
      const host = new URL(t.url).hostname;
      const blocked = t.pinned || t.active || t.audible || byTab.get(t.id).protected || host === 'localhost';
      if (blocked) {
        exp.keep++;
        blockedUrls.push({ url: t.url, why: { pinned: t.pinned, active: t.active, audible: t.audible, localhost: host === 'localhost' } });
      } else exp.archive++;
    }
    c('preview counts match protections (pinned/active/audible/site-excluded kept)',
      num(ui0.archive) === exp.archive && num(ui0.keep) === exp.keep && num(ui0.trash) === 0, { ui: ui0, expected: exp });
    const audibleKept = blockedUrls.filter((x) => x.why.audible).length;

    // Protect three rows through the UI.
    const protectedUrls = [];
    for (let i = 0; i < 3; i++) {
      const url = await page.eval(() => document.querySelector('.itab.act-archive .ititle')?.getAttribute('title')?.split('\n')[1]);
      await page.click('.itab.act-archive .iprot input');
      await sleep(150);
      protectedUrls.push(url);
    }
    const ui1 = await summary(page);
    c('protecting rows updates the summary', num(ui1.archive) === exp.archive - 3 && num(ui1.keep) === exp.keep + 3, { ui1 });

    const memBefore = mem(b, 'S2 antes de archivar (Fangio instalado, ~N pestañas)', ctx);
    await page.click('.import-summary .btn-primary', { text: 'Confirmar' });
    await page.locateWait('dialog[open] button[type=submit]');
    const t0 = Date.now();
    await page.click('dialog[open] button[type=submit]');
    await page.waitFor(() => [...document.querySelectorAll('h1')].some((h) => h.textContent.includes('Importación lista')), undefined, {
      timeout: 900000, interval: 100, label: 'import done',
    });
    const applyMs = Date.now() - t0;
    const done = await page.eval(() => {
      const t = [...document.querySelectorAll('.notice')].find((n) => /Procesadas/.test(n.textContent))?.textContent ?? '';
      const m = /Procesadas:\s*([\d.]+).*omitidas:\s*([\d.]+).*error:\s*([\d.]+)/s.exec(t);
      return m ? { done: m[1], skipped: m[2], failed: m[3] } : t;
    });
    ctx.log(`  apply finished in ${applyMs} ms: ${JSON.stringify(done)}`);
    const settleMs = await waitSettled(b);
    const st = await readState(b);
    await sleep(5000);
    const memAfter = mem(b, 'S2 después de archivar', ctx);
    const archived = st.records.filter((r) => r.state === 'archived');
    c('UI result: all processed (archived + protected), none failed', num(done.done) === num(ui1.archive) + 3 && num(done.failed) === 0, done);
    c('archived count equals the selection', archived.length === num(ui1.archive), `${archived.length} vs ${ui1.archive}`);
    const openTrack = st.tabs.filter((t) => TRACKABLE.test(t.url));
    c('only expected tabs remain open', openTrack.length === num(ui1.keep), `${openTrack.length} open vs ${ui1.keep} expected`);
    const prot = st.records.filter((r) => protectedUrls.includes(r.url) && r.protected && r.state === 'open');
    c('rows protected in the wizard stay open and protected', prot.length >= 3, protectedUrls);
    const stillOpen = new Set(openTrack.map((t) => t.url));
    c('blocked tabs (pinned/active/audible/excluded) never closed', blockedUrls.every((x) => stillOpen.has(x.url)));
    const origByUrl = new Map();
    for (const o of original) origByUrl.set(o.url, [...(origByUrl.get(o.url) ?? []), o]);
    const bad = archived.filter((r) => {
      const os = origByUrl.get(r.url);
      if (!os) return true;
      if (!os.some((o) => o.title === r.title) && r.title !== serverTitle(r.url)) return true;
      const gs = new Set(os.map((o) => o.groupTitle));
      if (!gs.has(r.origin?.groupTitle)) return true;
      return typeof r.origin?.windowOrdinal !== 'number' || typeof r.origin?.index !== 'number';
    });
    c('archived records keep exact URL, title, window/index and group', bad.length === 0, bad.slice(0, 3).map((r) => ({ rec: { url: r.url, title: r.title, origin: r.origin }, originals: origByUrl.get(r.url) })));
    c('archived records include group info', archived.filter((r) => r.origin?.groupTitle).length > 0);
    c('browser still has windows and tabs', st.tabs.length > 0, `${st.tabs.length} tabs`);
    const act = st.actions.find((a) => a.kind === 'archive' && a.reason.startsWith('Importación inicial'));
    c('undoable action log entry', act && act.undoable && act.n === archived.length, act);
    c.invariants('S2', checkInvariants(original, st, { testCreated: ctx.shared.testCreated }));
    ctx.shared.importActionId = act?.id;
    return {
      checks: c.list,
      metrics: {
        previewMs, applyMs, settleAfterApplyMs: settleMs, archived: archived.length, keptOpen: openTrack.length,
        archivePerSecond: Math.round((archived.length / applyMs) * 1000), uiResult: done, audibleKept,
        memBeforeMB: memBefore.workingSetMB, memAfterMB: memAfter.workingSetMB,
      },
    };
  },
};
