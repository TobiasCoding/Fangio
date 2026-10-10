#!/usr/bin/env node
// Cut a release locally:  npm run release -- <patch|minor|major|X.Y.Z>
//
//  1. Requires branch "main" and a clean working tree; the tag must not exist yet.
//  2. Runs typecheck + tests on the clean tree.
//  3. Bumps package.json / package-lock.json, moves CHANGELOG.md [Unreleased] notes into a
//     new [X.Y.Z] section, builds (validates the version injection).
//  4. git commit "release: vX.Y.Z" + annotated tag vX.Y.Z.
//  5. Prints (does not run) the push command. Pushing the tag triggers
//     .github/workflows/release.yml, which publishes the GitHub Release.
//
// Passing the *current* version (e.g. the very first 1.0.0) only verifies, builds and tags it:
// CHANGELOG.md must already contain that section.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, compareVersions, fail, packageVersion, parseVersion } from './lib/common.mjs';
import { getSection, releaseChangelog } from './lib/changelog.mjs';

const PKG = resolve(ROOT, 'package.json');
const LOCK = resolve(ROOT, 'package-lock.json');
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
function run(cmd) {
  console.log(`\n> ${cmd}`);
  const r = spawnSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`Falló "${cmd}" (código ${r.status ?? r.signal}).`);
}

function nextVersion(current, spec) {
  const [ma, mi, pa] = parseVersion(current);
  if (spec === 'patch') return `${ma}.${mi}.${pa + 1}`;
  if (spec === 'minor') return `${ma}.${mi + 1}.0`;
  if (spec === 'major') return `${ma + 1}.0.0`;
  const v = spec.replace(/^v/, '');
  if (!parseVersion(v)) fail(`Versión inválida: "${spec}". Usá patch, minor, major o X.Y.Z.`);
  return v;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const spec = process.argv[2];
if (!spec || process.argv.length > 3) fail('Uso: npm run release -- <patch|minor|major|X.Y.Z>');

// ---- preconditions -------------------------------------------------------------------
let branch;
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch {
  fail('No es un repositorio git (o no hay commits todavía).');
}
if (branch !== 'main') fail(`Hay que publicar desde "main" (rama actual: ${branch}).`);
const dirty = git('status', '--porcelain');
if (dirty) fail(`El árbol de trabajo no está limpio. Hacé commit o descartá estos cambios:\n${dirty}`);

const current = packageVersion();
const version = nextVersion(current, spec);
const tag = `v${version}`;
const tagOnly = version === current;
if (git('tag', '--list', tag)) fail(`La etiqueta ${tag} ya existe.`);
if (!tagOnly && compareVersions(version, current) <= 0) {
  fail(`La nueva versión (${version}) tiene que ser mayor que la actual (${current}).`);
}
const changelogText = readFileSync(CHANGELOG, 'utf8');
if (tagOnly && !getSection(changelogText, version)) {
  fail(`CHANGELOG.md no tiene notas para [${version}]: agregalas antes de etiquetar.`);
}
if (!tagOnly) {
  try {
    releaseChangelog(changelogText, version, current, today()); // validate the notes early
  } catch (e) {
    fail(e.message);
  }
}

console.log(tagOnly ? `Etiquetando la versión actual ${tag}` : `Publicando ${current} -> ${version}`);

// ---- checks on the clean tree --------------------------------------------------------
try {
  run('npm run typecheck');
  run('npm test');
} catch (e) {
  fail(`${e.message}\nNo se modificó nada.`);
}

// ---- bump, build, commit, tag --------------------------------------------------------
const originals = new Map([PKG, LOCK, CHANGELOG].map((f) => [f, readFileSync(f, 'utf8')]));
let committed = false;
try {
  if (!tagOnly) {
    const pkg = JSON.parse(originals.get(PKG));
    pkg.version = version;
    writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);

    const lock = JSON.parse(originals.get(LOCK));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);

    writeFileSync(CHANGELOG, releaseChangelog(changelogText, version, current, today()));
  }

  run('npm run build');

  if (!tagOnly) {
    git('add', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md');
    git('commit', '-m', `release: ${tag}`);
    committed = true;
  }
  git('tag', '-a', tag, '-m', `Fangio ${tag}`);
} catch (e) {
  if (!committed) {
    for (const [f, text] of originals) writeFileSync(f, text);
    console.error('\nSe restauraron package.json, package-lock.json y CHANGELOG.md.');
  } else {
    console.error(`\nEl commit "release: ${tag}" quedó hecho pero la etiqueta falló. Creala con:\n  git tag -a ${tag} -m "Fangio ${tag}"`);
  }
  fail(e.message);
}

console.log(`
Listo: ${tagOnly ? `etiqueta ${tag} creada` : `commit "release: ${tag}" y etiqueta ${tag} creados`} localmente.
Para publicar (GitHub Actions compila, empaqueta y crea el release):

  git push origin main --follow-tags
`);
