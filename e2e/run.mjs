#!/usr/bin/env node
// Fangio real-browser e2e harness.
//
//   npm run test:e2e                        all scenarios, 820 tabs
//   node e2e/run.mjs --only s1,s2 --tabs 200
//   node e2e/run.mjs --list
// Options: --only <ids>  --tabs <N>  --headed  --quick (skip startup-grace waits)  --keep-profiles
//          --no-build (do not run `node scripts/build.mjs` first)  --kill-at early,middle,late
// Results: e2e/.results/<timestamp>/results.json (+ latest.json). Profiles: e2e/.profiles (temp).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { buildTemplate } from './lib/fixtures.mjs';
import { chromiumPath, killAll } from './lib/browser.mjs';
import { basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const SCENARIOS = ['s1', 's2', 's9', 's5', 's3', 's4', 's6', 's7', 's8'];
const NEEDS = { s2: ['s1'], s9: ['s2'], s5: ['s2'], s3: ['s2'], s8: ['s2'] };

function parseArgs(argv) {
  const o = { only: null, tabs: 820, headed: false, quick: false, keep: false, build: true, list: false, killAt: ['early', 'middle', 'late'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim().toLowerCase());
    else if (a === '--tabs') o.tabs = Number(argv[++i]);
    else if (a === '--headed') o.headed = true;
    else if (a === '--quick') o.quick = true;
    else if (a === '--keep-profiles') o.keep = true;
    else if (a === '--no-build') o.build = false;
    else if (a === '--list') o.list = true;
    else if (a === '--kill-at') o.killAt = argv[++i].split(',');
    else throw new Error(`Unknown option ${a}`);
  }
  if (!Number.isInteger(o.tabs) || o.tabs < 40) throw new Error('--tabs must be an integer >= 40');
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mods = {};
  for (const id of SCENARIOS) mods[id] = (await import(`./scenarios/${id}.mjs`)).default;
  if (opts.list) {
    for (const id of SCENARIOS) console.log(`${id}  ${mods[id].title}`);
    return;
  }
  if (opts.build) execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit', cwd: root });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = resolve(here, '.results', stamp);
  const profilesDir = resolve(here, '.profiles');
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  const srv = await startServer();
  const t0 = Date.now();
  const ctx = {
    root, here, dist: resolve(root, 'dist'), helperPath: resolve(here, 'helper-ext'), srv, N: opts.tabs, opts,
    headless: !opts.headed, quick: opts.quick, resultsDir, profilesDir, memory: [], shared: {}, done: {},
    log: (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a),
    _template: null,
    async template() {
      if (!this._template) {
        this.log(`Building template profile with ${this.N} tabs (helper extension only, no Fangio)…`);
        this._template = await buildTemplate({ dir: resolve(profilesDir, 'template'), helperPath: this.helperPath, srv, N: this.N, log: this.log });
        this.log(`template ready: ${this._template.restoredTabs} tabs after restore (built ${this._template.buildMs} ms)`);
      }
      return this._template;
    },
  };
  const wanted = opts.only ?? SCENARIOS;
  const order = [];
  const add = (id) => {
    if (!mods[id]) throw new Error(`Unknown scenario ${id}`);
    for (const d of NEEDS[id] ?? []) add(d);
    if (!order.includes(id)) order.push(id);
  };
  for (const id of SCENARIOS) if (wanted.includes(id)) add(id);
  const report = { startedAt: new Date().toISOString(), options: opts, chromium: (() => { const p = chromiumPath(); return [basename(dirname(dirname(p))), basename(dirname(p)), basename(p)].join('/'); })(), scenarios: [], memory: ctx.memory };
  const save = () => {
    report.template = ctx._template ? { ...ctx._template, dir: undefined } : undefined;
    writeFileSync(resolve(resultsDir, 'results.json'), JSON.stringify(report, null, 2));
    writeFileSync(resolve(here, '.results', 'latest.json'), JSON.stringify(report, null, 2));
  };
  for (const id of order) {
    const m = mods[id];
    ctx.log(`=== ${id}: ${m.title}`);
    const st = Date.now();
    let res;
    try {
      res = await m.run(ctx);
    } catch (e) {
      res = { status: 'FAIL', error: String(e?.stack ?? e), checks: [], metrics: {} };
    }
    res.id = id;
    res.title = m.title;
    res.ms = Date.now() - st;
    res.status ??= res.checks?.every((c) => c.ok) ? 'PASS' : 'FAIL';
    ctx.done[id] = res;
    report.scenarios.push(res);
    ctx.log(`=== ${id}: ${res.status} (${(res.ms / 1000).toFixed(1)} s)${res.error ? `\n${res.error}` : ''}`);
    for (const c of res.checks ?? []) if (!c.ok) ctx.log(`   FAILED CHECK: ${c.name} — ${c.detail ?? ''}`);
    save();
  }
  for (const fn of ctx.shared.cleanup ?? []) await fn().catch(() => {});
  if (ctx.shared.main?.b) { try { await ctx.shared.main.b.close(); } catch { ctx.shared.main.b.kill(); } }
  await srv.close();
  report.finishedAt = new Date().toISOString();
  save();
  if (!opts.keep && existsSync(profilesDir)) rmSync(profilesDir, { recursive: true, force: true });
  console.log('\nSummary:');
  for (const s of report.scenarios) console.log(`  ${s.status.padEnd(4)} ${s.id} ${s.title} (${(s.ms / 1000).toFixed(1)} s)`);
  console.log(`Results: ${resultsDir}`);
  process.exitCode = report.scenarios.every((s) => s.status !== 'FAIL') ? 0 : 1;
}

process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => {
    killAll();
    setTimeout(() => process.exit(), 500);
  });
