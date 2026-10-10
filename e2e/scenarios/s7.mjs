// S7 — Scale UI: import a synthetic 10,000-record JSON backup through #/copias, then
// measure dashboard load, search latency, virtualized scrolling and JSON export round trip.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freshProfile, launchBrowser } from '../lib/browser.mjs';
import { readState } from '../lib/checks.mjs';
import { checker, DASH, installAndSnapshot, num, openDashboard, sleep } from '../lib/fangio.mjs';

const TOPICS = ['viaje', 'trabajo', 'música', 'cocina'];

function synthetic(n) {
  const now = Date.now();
  const records = [];
  for (let i = 0; i < n; i++) {
    const created = now - (n - i) * 60000;
    const state = i % 20 === 0 ? 'trash' : 'archived';
    records.push({
      id: randomUUID(), url: `https://sitio${i % 300}.example/ruta/${i}?q=${i}`, title: `Registro ${i} — tema ${TOPICS[i % 4]}`,
      domain: '', state, protected: i % 97 === 0, pending: i % 31 === 0, tags: i % 7 === 0 ? ['lectura', `t${i % 13}`] : [],
      project: i % 11 === 0 ? 'Proyecto E2E' : '', note: i % 5 === 0 ? `Nota de prueba ${i}` : '', source: 'tracked',
      createdAt: created, updatedAt: created + 1000, lastAccessedAt: created + 500, archivedAt: created + 1000,
      ...(state === 'trash' ? { trashedAt: created + 2000 } : {}),
      origin: { windowOrdinal: 1 + (i % 4), index: i % 200 }, previousUrls: [], reopenCount: 0, mergedFrom: [], live: null, pendingClose: null, rev: 1,
    });
  }
  return { format: 'fangio-export', schemaVersion: 1, exportedAt: now, appVersion: 'e2e', records, settings: {} };
}

/** Scrolls the list with real wheel input while sampling animation frames. */
async function scrollTest(page) {
  await page.eval(() => {
    window.__frames = [];
    const tick = (t) => { window.__frames.push(t); if (window.__frames.length < 100000) window.__raf = requestAnimationFrame(tick); };
    window.__raf = requestAnimationFrame(tick);
  });
  const box = await page.locateWait('.vlist.records');
  let maxRows = 0;
  for (let i = 0; i < 80; i++) {
    await page.wheel(box.x, box.y, 4000);
    await sleep(16);
    if (i % 10 === 0) maxRows = Math.max(maxRows, await page.eval(() => document.querySelectorAll('.records .vrow').length));
  }
  await page.eval(() => { const el = document.querySelector('.vlist.records'); el.scrollTop = el.scrollHeight; });
  await sleep(300);
  const bottom = await page.eval(() => {
    cancelAnimationFrame(window.__raf);
    const f = window.__frames;
    let maxGap = 0;
    for (let i = 1; i < f.length; i++) maxGap = Math.max(maxGap, f[i] - f[i - 1]);
    const el = document.querySelector('.vlist.records');
    const rows = [...el.querySelectorAll('.vrow')];
    const total = Math.round(el.querySelector('.vlist-inner').getBoundingClientRect().height / 32);
    const last = rows.some((r) => r.style.transform === `translateY(${(total - 1) * 32}px)` && r.textContent.trim().length > 0);
    return { frames: f.length, maxFrameGapMs: Math.round(maxGap), rows: rows.length, totalRows: total, lastRowRendered: last, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
  });
  return { ...bottom, maxDomRows: Math.max(maxRows, bottom.rows) };
}

export default {
  title: 'Escala: 10.000 registros (importar, cargar, buscar, scroll, exportar)',
  async run(ctx) {
    const c = checker();
    const N = 10000;
    const dir = freshProfile(resolve(ctx.profilesDir, 'scale'));
    const b = await launchBrowser({ profileDir: dir, headless: ctx.headless, startUrl: `${ctx.srv.origin}/p/1` });
    ctx.shared.cleanup = [...(ctx.shared.cleanup ?? []), () => b.close().catch(() => b.kill())];
    await installAndSnapshot(ctx, b, 1);
    const file = resolve(ctx.resultsDir, `synthetic-${N}.json`);
    writeFileSync(file, JSON.stringify(synthetic(N)));
    const dl = resolve(ctx.resultsDir, 'downloads');
    mkdirSync(dl, { recursive: true });
    await b.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
    const page = await openDashboard(b, '#/copias');
    await page.locateWait('h1');
    let t0 = Date.now();
    await page.setFiles('input[type=file]', [file]);
    const res = await page.waitFor(() => [...document.querySelectorAll('.notice-ok')].find((n) => /Nuevas/.test(n.textContent))?.textContent, undefined, { timeout: 300000, label: 'import result' });
    const importMs = Date.now() - t0;
    c('10,000 records imported through the UI', num(/Nuevas:\s*([\d.]+)/.exec(res)?.[1]) === N, res);
    ctx.log(`  import of ${N} records: ${importMs} ms`);
    await page.goto(`${DASH}#/lista`);
    const loads = [];
    for (let i = 0; i < 3; i++) {
      t0 = Date.now();
      await page.reload();
      await page.waitFor(() => document.querySelectorAll('.records .lrow').length > 0 && /\d/.test(document.querySelector('.infobar')?.textContent ?? ''), undefined, { timeout: 120000, label: 'list rows' });
      loads.push(Date.now() - t0);
    }
    const loadMs = [...loads].sort((a, b) => a - b)[1];
    ctx.log(`  dashboard load with ${N} records: ${loads.join(' / ')} ms`);
    const search = async (q, pred) => {
      await page.click('.search-input');
      await page.eval(() => document.querySelector('.search-input').select());
      const s = Date.now();
      await page.type(q);
      await page.waitFor(pred, q, { timeout: 30000, interval: 10, label: `search ${q}` });
      return Date.now() - s;
    };
    const searchExact = await search('Registro 7777 ', (q) => { const rows = document.querySelectorAll('.records .lrow'); return rows.length === 1 && rows[0].textContent.includes(q.trim()); });
    const searchBroad = await search('cocina', () => { const rows = [...document.querySelectorAll('.records .lrow')]; return rows.length > 5 && rows.every((r) => r.textContent.includes('cocina')); });
    const searchNone = await search('zzzz-no-existe', () => document.querySelectorAll('.records .lrow').length === 0 && /Nada coincide/.test(document.body.innerText));
    await page.click('.search-input');
    await page.press('Escape');
    await page.waitFor(() => document.querySelectorAll('.records .lrow').length > 5, undefined, { label: 'list restored' });
    ctx.log(`  search latency (incl. 120 ms debounce): exact ${searchExact} ms, broad ${searchBroad} ms, none ${searchNone} ms`);
    const scroll = await scrollTest(page);
    c('virtualized list renders the last row at the bottom', scroll.lastRowRendered && scroll.atBottom, scroll);
    c('DOM row count stays small while scrolling', scroll.maxDomRows < 120, `${scroll.maxDomRows} rows in DOM for ${scroll.totalRows}`);
    const heap = await page.jsHeap();
    // Export (real download through the UI) + round trip.
    await page.goto(`${DASH}#/copias`);
    const begin = b.cdp.waitEvent((m) => m.method === 'Browser.downloadWillBegin', 60000, 'download begin');
    t0 = Date.now();
    await page.click('button', { text: 'Exportar copia JSON' });
    const will = await begin;
    await b.cdp.waitEvent((m) => m.method === 'Browser.downloadProgress' && m.params.guid === will.params.guid && m.params.state === 'completed', 120000, 'download completed');
    const exportMs = Date.now() - t0;
    const text = readFileSync(resolve(dl, will.params.suggestedFilename), 'utf8');
    const exported = JSON.parse(text);
    const st = await readState(b, { actions: false });
    const ids = new Set(exported.records.map((r) => r.id));
    c('export contains every record', exported.records.length === st.records.length && st.records.every((r) => ids.has(r.id)), `${exported.records.length} / ${st.records.length}`);
    const sample = st.records.find((r) => r.title?.startsWith('Registro 4242 '));
    const ex = exported.records.find((r) => r.id === sample?.id);
    c('exported record keeps url/title/state', !!ex && ex.url === sample.url && ex.title === sample.title && ex.state === sample.state && ex.live === null);
    t0 = Date.now();
    const rt = await page.eval((txt) => chrome.runtime.sendMessage({ type: 'importJson', data: txt }), text, 300000);
    const reimportMs = Date.now() - t0;
    c('re-importing the export changes nothing (round trip)', rt?.ok && rt.data.added === 0 && rt.data.updated === 0 && rt.data.unchanged === st.records.length, rt?.data ?? rt);
    await b.close().catch(() => b.kill());
    return {
      checks: c.list,
      metrics: { records: N, importMs, dashboardLoadMs: loadMs, dashboardLoadsMs: loads, searchExactMs: searchExact, searchBroadMs: searchBroad,
        searchNoResultMs: searchNone, scroll, dashboardJsHeapMB: Math.round(heap.usedJSHeap / 1048576), domNodes: heap.nodes,
        exportMs, exportBytes: text.length, reimportMs },
    };
  },
};
