#!/usr/bin/env node
// v1.1 e2e: views (list, cards, timeline, topics), real thumbnails and contextual groups
// in an isolated Chromium (Playwright build, temporary profile, never the user's browser).
// Every hostname resolves to a local HTTPS server (--host-resolver-rules, throwaway
// self-signed certificate made with openssl, --ignore-certificate-errors), so "google.com",
// "chatgpt.com" or "react.dev" are local fixture pages: nothing reaches the network.
// (HTTPS because those hosts are HSTS-preloaded: Chrome never loads them over http.)
//
//   node e2e/views.mjs [--headed] [--no-build]
// Output: e2e/.results/views/*.png + summary.json
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FANGIO_ID, freshProfile, helperId, killAll, launchBrowser, sleep, waitFor } from './lib/browser.mjs';
import { openDashboard, sendMsg } from './lib/fangio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = new Set(process.argv.slice(2));
const OUT = join(here, '.results', 'views');
const MIN = 60_000;

// title, url, opener (index of the tab it was opened from)
const TABS = [
  ['hooks de react - Buscar con Google', 'https://www.google.com/search?q=hooks+de+react'],
  ['Hooks de React explicados', 'https://chatgpt.com/c/68a1f0'],
  ['Using the Effect Hook – React', 'https://legacy.reactjs.org/docs/hooks-effect.html', 0],
  ['useEffect – React', 'https://react.dev/reference/react/useEffect', 0],
  ['reactjs - When to use useEffect hooks? - Stack Overflow', 'https://stackoverflow.com/questions/1/when-to-use-useeffect-hooks', 0],
  ['Pronóstico extendido Buenos Aires', 'https://www.smn.gob.ar/pronostico'],
  ['bicicleta rodado 29 - Buscar con Google', 'https://www.google.com/search?q=bicicleta+rodado+29'],
  ['Bicicleta Mtb Rodado 29 | MercadoLibre', 'https://articulo.mercadolibre.com.ar/MLA-1-bicicleta-mtb-rodado-29', 6],
  ['Cómo elegir una bicicleta MTB rodado 29', 'https://www.bikeblog.com/elegir-bicicleta-mtb', 6],
  ['Bicicletas rodado 29: comparativa 2026', 'https://www.youtube.com/watch?v=bike29'],
  ['Vuelos baratos a Lisboa', 'https://www.vuelos.com/lisboa'],
  ['Hoteles en Lisboa centro', 'https://www.hoteles.com/lisboa'],
  ['Qué ver en Lisboa en 3 días', 'https://www.blogviajes.com/lisboa-3-dias'],
  ['Receta de pan de masa madre', 'https://www.cocina.com/pan-masa-madre'],
];

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function selfSignedCert(dir) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=fangio-e2e'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function startSites(tls) {
  const key = (u) => u.host + u.pathname + u.search;
  const titles = new Map(TABS.map(([t, u]) => [key(new URL(u)), t]));
  const server = createHttpsServer(tls, (req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const u = new URL(req.url, 'https://' + host);
    if (u.pathname === '/favicon.ico' || u.pathname === '/generate_204') {
      res.writeHead(204);
      return res.end();
    }
    const title = titles.get(key(u)) ?? host;
    const h = hue(host);
    const body =
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
      `<body style="margin:0;font:16px system-ui;background:hsl(${h} 70% 96%)">` +
      `<header style="background:hsl(${h} 55% 45%);color:#fff;padding:14px 28px;font-weight:700">${esc(host)}</header>` +
      `<main style="padding:28px"><h1 style="font-size:34px;margin:0 0 16px">${esc(title)}</h1>` +
      `<p style="max-width:720px;line-height:1.6;color:#333">${'Contenido de ejemplo para la miniatura. '.repeat(8)}</p>` +
      `<div style="display:flex;gap:12px;margin-top:20px">${[1, 2, 3].map((i) => `<div style="flex:1;height:120px;border-radius:12px;background:hsl(${(h + i * 40) % 360} 60% 80%)"></div>`).join('')}</div>` +
      `</main></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => server.close() })));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
}

async function readDb(page) {
  return page.eval(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fangio');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(['records', 'thumbs']);
    const get = (q) => new Promise((r) => (q.onsuccess = () => r(q.result)));
    const recs = await get(tx.objectStore('records').getAll());
    const thumbs = await get(tx.objectStore('thumbs').getAll());
    db.close();
    return {
      recs: recs.map((x) => ({ id: x.id, url: x.url, title: x.title, openerId: x.openerId ?? null })),
      thumbs: thumbs.map((t) => ({ id: t.id, w: t.w, h: t.h, type: t.type, bytes: t.data.byteLength })),
    };
  });
}

async function clickView(page, label, waitSel, min = 1) {
  await page.click('.seg-views .seg-btn', { text: label });
  await page.waitFor((a) => document.querySelectorAll(a.sel).length >= a.min, { sel: waitSel, min }, { timeout: 30000, label: label + ': ' + waitSel });
  await sleep(600);
}

async function openFixtures(helper) {
  const tabIds = [];
  for (const [, url, opener] of TABS) {
    const id = await helper.eval(
      async (a) => {
        const t = await chrome.tabs.create({ url: a.url, active: true, ...(a.opener !== undefined ? { openerTabId: a.opener } : {}) });
        for (let i = 0; i < 100; i++) {
          const x = await chrome.tabs.get(t.id);
          if (x.status === 'complete') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return t.id;
      },
      { url, opener: opener !== undefined ? tabIds[opener] : undefined },
    );
    tabIds.push(id);
    await sleep(2700); // settle (1.5 s) + capture
  }
  return tabIds;
}

async function checkData(dash) {
  const db = await readDb(dash);
  const byUrl = new Map(db.recs.map((r) => [r.url, r]));
  const rootRec = byUrl.get(TABS[0][1]);
  check('every fixture tab has a record', TABS.every(([, u]) => byUrl.has(u)), db.recs.length);
  check('opener recorded for tabs opened from the search', [2, 3, 4].every((i) => byUrl.get(TABS[i][1])?.openerId === rootRec?.id));
  check('real thumbnails captured (WebP, 320 px)', db.thumbs.length >= 10 && db.thumbs.every((t) => t.w === 320 && t.type === 'image/webp'), {
    count: db.thumbs.length,
    avgKB: Math.round(db.thumbs.reduce((a, t) => a + t.bytes, 0) / Math.max(1, db.thumbs.length) / 102.4) / 10,
  });
  return db;
}

async function checkViews(dash, helper) {
  await dash.front();
  await dash.reload();
  await shot(dash, '1-lista');
  await clickView(dash, 'Tarjetas', '.rcard', TABS.length);
  await dash.waitFor(() => document.querySelectorAll('.rcard img.thumb-img').length >= 8, undefined, { timeout: 15000, label: 'thumbnails in cards' });
  check('cards show thumbnails', true, await dash.eval(() => document.querySelectorAll('.rcard img.thumb-img').length));
  await shot(dash, '2-tarjetas');
  await clickView(dash, 'Línea de tiempo', '.tl-day');
  check('timeline has day and session rows', true, await dash.eval(() => ({ days: document.querySelectorAll('.tl-day').length, sessions: document.querySelectorAll('.tl-session').length })));
  await shot(dash, '3-linea-de-tiempo');
  await clickView(dash, 'Temas', '.topic', 2);
  const topics = await dash.eval(() =>
    [...document.querySelectorAll('.topic')].map((t) => ({
      name: t.querySelector('.topic-name')?.textContent ?? '',
      members: [...t.querySelectorAll('.topic-member .ellipsis')].map((x) => x.textContent),
      trail: [...t.querySelectorAll('.trail-step')].map((x) => x.textContent),
    })),
  );
  const find = (title) => topics.find((t) => t.members.includes(title));
  const react = find('Hooks de React explicados');
  check('React group: search + ChatGPT + 3 sites, without noise', !!react && react.members.length === 5 && react.members.includes('hooks de react - Buscar con Google') && !react.members.includes('Pronóstico extendido Buenos Aires'), react);
  check('React trail starts with the Google search', !!react && /hooks de react/.test(react.trail[0] ?? ''), react?.trail);
  const bike = find('Bicicleta Mtb Rodado 29 | MercadoLibre');
  check('bike group (search + store + blog + video)', !!bike && bike.members.length >= 3 && bike !== react, bike);
  const lisboa = find('Hoteles en Lisboa centro');
  check('Lisboa group', !!lisboa && lisboa.members.length === 3, lisboa);
  check('noise stays out of every group', !topics.some((t) => t.members.includes('Receta de pan de masa madre')));
  await shot(dash, '4-temas');

  // "Agrupar en Chrome" on the React topic.
  await dash.eval(() => {
    const card = [...document.querySelectorAll('.topic')].find((t) => t.textContent.includes('Hooks de React explicados'));
    [...card.querySelectorAll('button')].find((x) => x.textContent.startsWith('Agrupar en Chrome')).click();
  });
  const groups = await waitFor(
    () =>
      helper.eval(async () => {
        const gs = await chrome.tabGroups.query({});
        const out = [];
        for (const g of gs) out.push({ title: g.title, color: g.color, tabs: (await chrome.tabs.query({ groupId: g.id })).length });
        return out.length ? out : null;
      }),
    { timeout: 10000, label: 'tab group' },
  );
  check('Chrome tab group created with the 5 React tabs', groups.length === 1 && groups[0].tabs === 5, groups);

  for (const scheme of ['light', 'dark']) {
    await dash.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await clickView(dash, 'Temas', '.topic', 2);
    await shot(dash, '5-temas-' + scheme);
    await clickView(dash, 'Tarjetas', '.rcard', TABS.length);
    await shot(dash, '6-tarjetas-' + scheme);
  }
  // Clearing thumbnails falls back to generated posters (and the page reacts to the change event).
  const cleared = await sendMsg(dash, { type: 'clearThumbs' });
  await dash.waitFor(() => document.querySelectorAll('.rcard img.thumb-img').length === 0 && document.querySelectorAll('.rcard .poster').length > 0, undefined, { timeout: 10000, label: 'posters' });
  check('clearing thumbnails switches cards to generated posters', cleared.deleted >= 10, cleared);
  await shot(dash, '7-tarjetas-sin-miniaturas');

  // Settings: the thumbnails section reflects the stored setting and the granted permission.
  await dash.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await dash.goto('chrome-extension://' + FANGIO_ID + '/dashboard.html#/reglas');
  const rules = await dash.waitFor(() => {
    const h = [...document.querySelectorAll('h2')].find((x) => x.textContent === 'Miniaturas de páginas');
    if (!h) return null;
    h.scrollIntoView({ block: 'start' });
    const sw = h.parentElement.querySelector('input[role="switch"]');
    return { checked: sw?.checked, permissionNotice: !!h.parentElement.querySelector('.notice') };
  }, undefined, { timeout: 15000, label: 'thumbnails settings' });
  check('settings: thumbnails switch on, no missing-permission notice', rules.checked === true && !rules.permissionNotice, rules);
  await sleep(300);
  await shot(dash, '8-reglas-miniaturas');
  return topics;
}

async function main() {
  if (!args.has('--no-build')) execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit', cwd: root });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // Copy of dist/ where the user already granted the optional host permission (the browser
  // prompt cannot be clicked from automation); everything else is the shipped build.
  const ext = join(here, '.profiles', 'views-ext');
  rmSync(ext, { recursive: true, force: true });
  cpSync(join(root, 'dist'), ext, { recursive: true });
  const mf = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['<all_urls>'];
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

  const sites = await startSites(selfSignedCert(join(here, '.profiles', 'views-tls')));
  const b = await launchBrowser({
    profileDir: freshProfile(join(here, '.profiles', 'views')),
    loadExtensions: [ext, join(here, 'helper-ext')],
    headless: !args.has('--headed'),
    extraArgs: ['--host-resolver-rules=MAP * 127.0.0.1:' + sites.port + ', EXCLUDE localhost', '--ignore-certificate-errors'],
  });
  try {
    check('browser', true, await b.version());
    const helper = b.ext(await helperId(b));
    await b.ext(FANGIO_ID).attach(60000);
    const dash = await openDashboard(b, '#/lista');
    await sendMsg(dash, { type: 'skipOnboarding' });
    const s = await sendMsg(dash, { type: 'getSettings' });
    await sendMsg(dash, { type: 'saveSettings', settings: { ...s, thumbnails: true } });
    await openFixtures(helper);
    await sleep(1500);
    const db = await checkData(dash);
    const topics = await checkViews(dash, helper);
    writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ checks, topics, thumbs: db.thumbs.length }, null, 2));
  } finally {
    await b.close().catch(() => b.kill());
    sites.close();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks OK. Screenshots: ' + OUT);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  killAll();
  process.exit(1);
});
