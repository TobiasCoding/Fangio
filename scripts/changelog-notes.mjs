#!/usr/bin/env node
// Print the CHANGELOG.md notes for a version (used as GitHub Release notes by CI).
//   node scripts/changelog-notes.mjs 1.2.3 > notes.md
// Exits with code 2 (and prints nothing) when there is no such section or it is empty.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/common.mjs';
import { getSection } from './lib/changelog.mjs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!version) {
  console.error('Uso: node scripts/changelog-notes.mjs <X.Y.Z>');
  process.exit(1);
}
const notes = getSection(readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!notes) process.exit(2);
process.stdout.write(`${notes}\n`);
