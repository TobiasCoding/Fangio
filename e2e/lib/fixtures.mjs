// Builds the "user's browser": ~N tabs spread over 4 windows (pinned tabs, tab groups,
// exact duplicates, near-duplicates, root "/" pages, localhost pages for site
// exclusions, one audio page), then restarts so session restore leaves most tabs
// UNLOADED (the realistic state of a long-lived profile). The resulting profile is
// used as a template (copied) by the scenarios. Fangio is NOT installed here.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { launchBrowser, freshProfile, helperId, sleep, waitFor } from './browser.mjs';

export function makeSpec(srv, N) {
  const origin = srv.origin;
  const local = `http://localhost:${srv.port}`;
  const raw = [Math.round(N * 0.5), Math.round(N * 0.3), Math.round(N * 0.15)];
  const sizes = [...raw, Math.max(5, N - raw.reduce((a, b) => a + b, 0))];
  let k = 1000;
  const special = {
    0: { 1: { pinned: true }, 2: { pinned: true }, 3: { pinned: true }, 6: { url: `${origin}/` }, 8: { url: `${local}/p/1` } },
    1: { 1: { pinned: true }, 2: { url: `${origin}/audio`, keepLoaded: true }, 4: { url: `${origin}/` }, 7: { url: `${local}/p/2` }, 3: { url: `${origin}/p/5` } },
    2: { 3: { url: `${origin}/` }, 6: { url: `${local}/p/3` }, 2: { url: `${origin}/p/5` } },
    3: { 3: { url: `${local}/p/4` }, 2: { url: `${origin}/p/5` } },
  };
  const groups = [
    [{ from: 10, to: 24, g: { title: 'Trabajo', color: 'blue' } }, { from: 30, to: 39, g: { title: 'Lectura', color: 'green' } }],
    [{ from: 10, to: 17, g: { title: 'Compras', color: 'red' } }],
    [],
    [],
  ];
  const windows = sizes.map((size, wi) => {
    const tabs = [];
    let near = null;
    for (let i = 0; i < size; i++) {
      const sp = special[wi]?.[i] ?? {};
      let url;
      if (sp.url) url = sp.url;
      else if (wi === 0 && i === 5) url = `${origin}/p/5`;
      else if (near && near.left > 0) {
        url = near.left === 2 ? `${origin}/p/${near.k}?q=b` : `${origin}/p/${near.k}#sec`;
        near.left--;
      } else if (i > 12 && i % 37 === 0) url = tabs[i - 5].url; // exact duplicate
      else if (i > 12 && i % 53 === 0) {
        near = { k: k++, left: 2 };
        url = `${origin}/p/${near.k}?q=a`;
      } else url = `${origin}/p/${k++}`;
      const t = { url };
      if (sp.pinned) t.pinned = true;
      if (sp.keepLoaded) t.keepLoaded = true;
      const g = groups[wi].find((x) => i >= x.from && i <= x.to);
      if (g && !t.pinned) t.group = g.g;
      tabs.push(t);
    }
    return { tabs };
  });
  return { concurrency: 8, windows };
}

/** Builds the template profile (once per run). Returns { dir, buildMs, restoreMs, tabs }. */
export async function buildTemplate({ dir, helperPath, srv, N, log }) {
  freshProfile(dir);
  const spec = makeSpec(srv, N);
  const expected = spec.windows.reduce((a, w) => a + w.tabs.length, 0);
  const b = await launchBrowser({
    profileDir: dir,
    loadExtensions: [helperPath],
    extraArgs: ['--renderer-process-limit=6'],
  });
  let built;
  try {
    const h = b.ext(await helperId(b));
    const t0 = Date.now();
    built = await h.eval((s) => helper.build(s), spec, 900000);
    built.ms = Date.now() - t0;
    log?.(`template: ${expected} tabs created in ${built.ms} ms (load retries ${built.loadTimeouts}, failures ${built.loadFailures ?? 0})`);
    await sleep(3000); // let the session service persist everything
  } finally {
    await b.close();
  }
  // Restart once: session restore leaves most tabs unloaded (lazy), like a real long-lived profile.
  const t1 = Date.now();
  const b2 = await launchBrowser({ profileDir: dir, loadExtensions: [helperPath], restore: true });
  let snap;
  try {
    const h2 = b2.ext(await helperId(b2));
    snap = await waitFor(
      async () => {
        const s = await h2.eval(() => helper.snapshot());
        return s.tabs.length >= expected ? s : null;
      },
      { timeout: 120000, interval: 1000, label: `restored tab count ${expected}` },
    ).catch(async () => h2.eval(() => helper.snapshot()));
    await sleep(2000);
  } finally {
    await b2.close();
  }
  return { dir, expected, buildMs: built.ms, loadFailures: built.loadFailures ?? 0, restoreMs: Date.now() - t1, restoredTabs: snap.tabs.length };
}

export function copyProfile(template, dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(template, dest, { recursive: true });
  rmSync(`${dest}/DevToolsActivePort`, { force: true });
  rmSync(`${dest}/SingletonLock`, { force: true });
  return dest;
}
