#!/usr/bin/env node
// Build Fangio into dist/ (an unpacked Chromium MV3 extension).
//
//   node scripts/build.mjs            one-off build (not minified, no sourcemaps)
//   node scripts/build.mjs --watch    rebuild on change (inline sourcemaps, for development)
//   node scripts/build.mjs --minify   minified build (never used for releases)
//
// The release output is intentionally readable: anyone can open dist/*.js and audit what runs.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT, fail, packageVersion, readJson } from './lib/common.mjs';

const args = new Set(process.argv.slice(2));
const WATCH = args.has('--watch');
const MINIFY = args.has('--minify');
for (const a of args) {
  if (!['--watch', '--minify'].includes(a)) fail(`Opción desconocida: ${a} (válidas: --watch, --minify)`);
}

const DIST = resolve(ROOT, 'dist');

/** Bundled entry points: output name (without extension) -> source. CSS imports become <name>.css. */
const ENTRIES = {
  background: 'src/background/index.ts',
  dashboard: 'src/ui/dashboard/main.tsx',
  popup: 'src/ui/popup/main.tsx',
};

/** Plain files copied as-is: destination (relative to dist/) -> source. */
const COPIES = {
  'dashboard.html': 'src/ui/dashboard/dashboard.html',
  'popup.html': 'src/ui/popup/popup.html',
  'update.ps1': 'scripts/update.ps1',
  'update.cmd': 'scripts/update.cmd',
  'update.sh': 'scripts/update.sh',
};

function checkSources() {
  const missing = [...Object.values(ENTRIES), ...Object.values(COPIES), 'static/manifest.json'].filter(
    (f) => !existsSync(resolve(ROOT, f)),
  );
  if (missing.length) {
    throw new Error(
      `Faltan archivos de entrada necesarios para compilar:\n${missing.map((f) => `  - ${f}`).join('\n')}\n` +
        'Revisá que existan (o que la ruta coincida con scripts/build.mjs).',
    );
  }
}

function cleanDist() {
  // Safety: only ever delete <repo>/dist.
  if (relative(ROOT, DIST) !== 'dist') throw new Error(`Ruta de salida inesperada: ${DIST}`);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
}

/** Copy manifest (with version injected), static assets, HTML pages and helper scripts. */
function copyAssets() {
  const version = packageVersion();
  const manifest = readJson(resolve(ROOT, 'static/manifest.json'));
  manifest.version = version;
  writeFileSync(join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(DIST, 'VERSION'), `${version}\n`);

  // Everything else under static/ (icons/...) is copied verbatim.
  const staticDir = resolve(ROOT, 'static');
  cpSync(staticDir, DIST, { recursive: true, filter: (src) => relative(staticDir, src) !== 'manifest.json' });

  for (const [dest, src] of Object.entries(COPIES)) cpSync(resolve(ROOT, src), join(DIST, dest));
  return version;
}

/** Fail if the manifest or an HTML page points at a file that is not in dist/. */
function verifyDist() {
  const problems = [];
  const need = (file, from) => {
    const p = join(DIST, file.replace(/^\.?\//, ''));
    if (!existsSync(p) || !statSync(p).isFile()) problems.push(`${from} -> ${file}`);
  };
  const m = readJson(join(DIST, 'manifest.json'));
  if (m.background?.service_worker) need(m.background.service_worker, 'manifest background.service_worker');
  if (m.action?.default_popup) need(m.action.default_popup, 'manifest action.default_popup');
  for (const f of Object.values(m.icons ?? {})) need(f, 'manifest icons');
  for (const f of Object.values(m.action?.default_icon ?? {})) need(f, 'manifest action.default_icon');

  for (const page of ['dashboard.html', 'popup.html']) {
    const html = readFileSync(join(DIST, page), 'utf8');
    const refs = [
      ...html.matchAll(/<(?:script|img|iframe|source)\b[^>]*?\bsrc\s*=\s*["']([^"'#?]+)["']/gi),
      ...html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"'#?]+)["']/gi),
    ];
    for (const [, ref] of refs) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) {
        problems.push(`${page} -> ${ref} (recurso externo: la CSP de la extensión sólo permite archivos propios)`);
        continue;
      }
      need(ref, page);
    }
  }
  if (problems.length) {
    throw new Error(`dist/ referencia archivos que no existen:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  checkNoLocalPaths();
}

/** The repo is public: never ship absolute local paths (e.g. from esbuild's path comments). */
function checkNoLocalPaths() {
  const needles = [ROOT, homedir()]
    // Only specific paths (at least two segments), so e.g. a home of "/root" can't false-positive.
    .filter((p) => p && p.split(/[\\/]/).filter(Boolean).length >= 2)
    .flatMap((p) => [p, p.split(sep).join('/'), p.split(sep).join('\\\\')])
    .map((p) => p.toLowerCase());
  const offenders = [];
  for (const name of readdirSync(DIST)) {
    if (!/\.(js|css|html|json)$/.test(name)) continue;
    const text = readFileSync(join(DIST, name), 'utf8').toLowerCase();
    const hit = needles.find((n) => text.includes(n));
    // esbuild path comments (`// path` in JS, `/* path */` in CSS) must be repo-relative.
    const abs = /^(?:\/\/|\/\*) (?:[a-z]:[\x5c/]|\/|~)/m.exec(text);
    if (abs) offenders.push(`${name} contiene un comentario con ruta absoluta (${text.slice(abs.index).split('\n')[0]})`);
    if (hit) offenders.push(`${name} contiene una ruta local (${hit})`);
  }
  if (offenders.length) throw new Error(`Salida con rutas absolutas del equipo:\n${offenders.map((o) => `  - ${o}`).join('\n')}`);
}

/** esbuild options shared by one-off and watch builds. */
function buildOptions() {
  return {
    absWorkingDir: ROOT,
    entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([out, src]) => [out, resolve(ROOT, src)])),
    outdir: DIST,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome121',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css' },
    minify: MINIFY,
    sourcemap: WATCH ? 'inline' : false,
    charset: 'utf8',
    legalComments: 'inline',
    logLevel: 'warning',
  };
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');

async function buildOnce() {
  checkSources();
  cleanDist();
  const t0 = Date.now();
  await esbuild.build(buildOptions());
  const version = copyAssets();
  verifyDist();
  console.log(`Fangio v${version} compilado en ${rel(DIST)}/ (${Date.now() - t0} ms)`);
}

async function buildWatch() {
  checkSources();
  cleanDist();
  const stamp = () => new Date().toLocaleTimeString();
  const syncAssets = (what) => {
    try {
      const version = copyAssets();
      verifyDist();
      console.log(`[${stamp()}] ${what} (v${version}) -> ${rel(DIST)}/`);
    } catch (e) {
      console.error(`[${stamp()}] ${e instanceof Error ? e.message : e}`);
    }
  };
  const assetsPlugin = {
    name: 'fangio-assets',
    setup(build) {
      build.onEnd((result) => {
        if (!result.errors.length) syncAssets('compilado');
      });
    },
  };
  const ctx = await esbuild.context({ ...buildOptions(), plugins: [assetsPlugin], logLevel: 'info' });
  await ctx.watch();

  // esbuild only watches bundled sources; re-copy plain files when they change.
  let timer;
  const recopy = () => {
    clearTimeout(timer);
    timer = setTimeout(() => syncAssets('archivos estáticos copiados'), 150);
  };
  for (const f of [...Object.values(COPIES), 'static/manifest.json', 'package.json']) watch(resolve(ROOT, f), recopy);
  if (existsSync(resolve(ROOT, 'static/icons'))) watch(resolve(ROOT, 'static/icons'), recopy);
  console.log('Observando cambios (Ctrl+C para salir). Recargá la extensión en chrome://extensions tras cada cambio.');
}

try {
  await (WATCH ? buildWatch() : buildOnce());
} catch (e) {
  // esbuild errors carry an `errors` array and were already printed with file/line details.
  const isEsbuild = e && typeof e === 'object' && Array.isArray(e.errors);
  fail(isEsbuild ? 'La compilación falló (ver errores arriba).' : e instanceof Error ? e.message : String(e));
}
