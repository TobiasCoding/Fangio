// Export helpers (JSON backup + Netscape bookmarks HTML). Shared by Copias and the import wizard.

import { buildBookmarksHtml, buildExport } from '../../core/backup';
import { getActions, getAllRecords, getSettings } from '../../core/db';
import { send } from '../common/api';
import { isoDay } from '../common/format';

function download(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Exports every record + settings + the last 1000 log entries. Returns the record count. */
export async function exportJson(): Promise<number> {
  const [records, settings, actions] = await Promise.all([getAllRecords(), getSettings(), getActions({ limit: 1000 })]);
  const file = buildExport(records, settings, actions, chrome.runtime.getManifest().version);
  download(`fangio-backup-${isoDay()}.json`, 'application/json', JSON.stringify(file));
  await send({ type: 'markBackup' });
  return records.length;
}

/** Exports records as a bookmarks HTML file importable in any browser. Returns the record count. */
export async function exportBookmarks(): Promise<number> {
  const records = await getAllRecords();
  download(`fangio-marcadores-${isoDay()}.html`, 'text/html', buildBookmarksHtml(records));
  await send({ type: 'markBackup' });
  return records.length;
}
