#!/usr/bin/env node
// Package dist/ into release/fangio-vX.Y.Z.zip (files at the zip root) and write
// release/SHA256SUMS.txt. Dependency-free ZIP writer: deflate (zlib.deflateRawSync), CRC-32,
// local + central directory headers, UTF-8 file names.
//
// Timestamps: SOURCE_DATE_EPOCH (seconds) if set, so CI can produce reproducible archives;
// otherwise the current time. Entries are sorted by path.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ROOT, crc32, fail, packageVersion, readJson } from './lib/common.mjs';

const DIST = resolve(ROOT, 'dist');
const RELEASE = resolve(ROOT, 'release');

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
    else throw new Error(`Entrada no soportada en dist/: ${p}`);
  }
  return out;
}

/** MS-DOS date/time (local fields of a UTC date, which is what most tools expect). */
function dosDateTime(date) {
  const y = Math.max(1980, date.getUTCFullYear());
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: day };
}

function createZip(entries, mtime = new Date()) {
  const { time, date } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;
  if (entries.length > 0xfffe) throw new Error('Demasiados archivos para un ZIP sin ZIP64');

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('Archivo demasiado grande para ZIP sin ZIP64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8); // method: 0 store, 8 deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: UNIX, 2.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    const mode = name.endsWith('.sh') ? 0o100755 : 0o100644; // regular file, executable for shell scripts
    central.writeUInt32LE((mode << 16) >>> 0, 38); // external attrs (UNIX mode in the high 16 bits)
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function main() {
  const version = packageVersion();
  if (!existsSync(join(DIST, 'manifest.json'))) fail('No existe dist/manifest.json: ejecutá "npm run build" primero.');
  const manifest = readJson(join(DIST, 'manifest.json'));
  if (manifest.version !== version) {
    fail(`dist/ es de la versión ${manifest.version} pero package.json dice ${version}: volvé a compilar.`);
  }

  const files = listFiles(DIST)
    .map((p) => ({ name: relative(DIST, p).split(sep).join('/'), path: p }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const mtime = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
  const zip = createZip(files.map((f) => ({ name: f.name, data: readFileSync(f.path) })), mtime);

  mkdirSync(RELEASE, { recursive: true });
  // Remove artifacts from previous runs so release/ only holds this version.
  for (const name of readdirSync(RELEASE)) {
    if (/^fangio-v.+\.zip$/.test(name) || name === 'SHA256SUMS.txt') rmSync(join(RELEASE, name));
  }
  const zipName = `fangio-v${version}.zip`;
  writeFileSync(join(RELEASE, zipName), zip);
  const sha = createHash('sha256').update(zip).digest('hex');
  // Same format as `sha256sum` (two spaces), so `sha256sum -c SHA256SUMS.txt` works.
  writeFileSync(join(RELEASE, 'SHA256SUMS.txt'), `${sha}  ${zipName}\n`);

  console.log(`release/${zipName}  (${files.length} archivos, ${(zip.length / 1024).toFixed(1)} KiB)`);
  console.log(`SHA-256 ${sha}`);
}

main();
