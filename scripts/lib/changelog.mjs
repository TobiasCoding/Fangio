// Minimal "Keep a Changelog" helpers used by release.mjs and changelog-notes.mjs.

export const REPO_URL = 'https://github.com/TobiasCoding/Fangio';

const isHeading = (l) => /^## /.test(l);
const isLinkRef = (l) => /^\[[^\]]+\]:\s*\S/.test(l);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sectionBounds(lines, name) {
  const re = new RegExp(`^## \\[${escapeRe(name)}\\]`, 'i');
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end]) && !isLinkRef(lines[end])) end++;
  return { start, end };
}

/** Body (without heading) of the section "## [name]", trimmed; null if absent. */
export function getSection(text, name) {
  const lines = text.split(/\r?\n/);
  const b = sectionBounds(lines, name);
  return b ? lines.slice(b.start + 1, b.end).join('\n').trim() : null;
}

/**
 * Move the "## [Unreleased]" notes into a new "## [version] - date" section, leave an empty
 * Unreleased section and update the comparison links at the bottom.
 */
export function releaseChangelog(text, version, prevVersion, date) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const b = sectionBounds(lines, 'Unreleased');
  if (!b) throw new Error('CHANGELOG.md no tiene una sección "## [Unreleased]".');
  const notes = lines.slice(b.start + 1, b.end).join('\n').trim();
  if (!notes) {
    throw new Error(
      'La sección [Unreleased] de CHANGELOG.md está vacía. Describí los cambios ahí (y hacé commit) antes de publicar.',
    );
  }
  if (sectionBounds(lines, version)) throw new Error(`CHANGELOG.md ya tiene una sección [${version}].`);

  const out = [
    ...lines.slice(0, b.start + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    notes,
    '',
    ...lines.slice(b.end),
  ];

  const unreleasedLink = `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: ${REPO_URL}/compare/v${prevVersion}...v${version}`;
  const li = out.findIndex((l) => /^\[Unreleased\]:/i.test(l));
  if (li >= 0) out.splice(li, 1, unreleasedLink, versionLink);
  else {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('', unreleasedLink, versionLink);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`;
}
