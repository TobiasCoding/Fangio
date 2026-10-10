// Shared helpers for the build / package / release scripts. No dependencies.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (parent of scripts/). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Strict X.Y.Z (no leading zeros, no pre-release). Chrome allows each part up to 65535. */
const VERSION_RE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

export function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v) : null;
  if (!m) return null;
  const parts = m.slice(1, 4).map(Number);
  if (parts.some((n) => n > 65535)) return null;
  return parts;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Versión inválida: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** package.json version, validated as X.Y.Z (throws otherwise). */
export function packageVersion(root = ROOT) {
  const pkg = readJson(resolve(root, 'package.json'));
  if (!parseVersion(pkg.version)) {
    throw new Error(
      `package.json "version" debe tener la forma X.Y.Z (números, sin sufijos); encontrado: ${JSON.stringify(pkg.version)}`,
    );
  }
  return pkg.version;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), as used by PNG and ZIP. */
export function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}
