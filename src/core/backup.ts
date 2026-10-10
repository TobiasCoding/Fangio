// Export / import. buildExport, buildBookmarksHtml and parseAndValidateImport are
// pure; importJson applies a validated file to the DB (never deletes anything).

import { MAX_NOTE_LENGTH, MAX_PREVIOUS_URLS, MAX_TITLE_LENGTH } from '../shared/constants';
import { sanitizeSettings } from '../shared/settings';
import {
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  type ActionEntry,
  type ExportFileV1,
  type ImportJsonResult,
  type RecordState,
  type Settings,
  type TabRecord,
} from '../shared/types';
import { getAction, getRecordsByIds, getSettings, putActions, putRecords, putSettings } from './db';
import { dbLock } from './mutex';
import { newAction } from './records';
import { broadcast, recordsChanged } from './runtime';
import { domainOf, normalizeTags, sanitizeFavicon } from './url';

export function buildExport(
  records: readonly TabRecord[],
  settings: Settings,
  actions: readonly ActionEntry[] | undefined,
  appVersion: string,
): ExportFileV1 {
  const out: ExportFileV1 = {
    format: EXPORT_FORMAT,
    schemaVersion: 1,
    exportedAt: Date.now(),
    appVersion,
    records: records.map((r) => ({ ...structuredClone(r), live: null, pendingClose: null })),
    settings: structuredClone(settings),
  };
  if (actions && actions.length) out.actions = structuredClone([...actions]);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FOLDER_NAMES: Record<RecordState, string> = { open: 'Abiertas', archived: 'Archivadas', trash: 'Papelera' };

/** Netscape bookmark file (importable by any browser), one folder per state. */
export function buildBookmarksHtml(records: readonly TabRecord[]): string {
  const secs = (ms?: number) => Math.floor((ms ?? Date.now()) / 1000);
  const now = secs();
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">Fangio</H3>`,
    '    <DL><p>',
  ];
  for (const state of ['open', 'archived', 'trash'] as const) {
    const list = records.filter((r) => r.state === state);
    if (list.length === 0) continue;
    lines.push(`        <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${FOLDER_NAMES[state]}</H3>`);
    lines.push('        <DL><p>');
    for (const r of list) {
      const tags = r.tags.length ? ` TAGS="${escapeHtml(r.tags.join(','))}"` : '';
      lines.push(
        `            <DT><A HREF="${escapeHtml(r.url)}" ADD_DATE="${secs(r.createdAt)}"${tags}>${escapeHtml(r.title || r.url)}</A>`,
      );
      if (r.note) lines.push(`            <DD>${escapeHtml(r.note)}`);
    }
    lines.push('        </DL><p>');
  }
  lines.push('    </DL><p>', '</DL><p>', '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ validation

export interface ParsedImport {
  records: TabRecord[];
  rejected: { index: number; error: string }[];
  settings: Settings | null;
  actions: ActionEntry[];
  exportedAt?: number;
  appVersion?: string;
}

const STATES = new Set(['open', 'archived', 'trash']);
const SOURCES = new Set(['install-snapshot', 'tracked', 'json-import', 'manual']);
const OPTIONAL_NUMBERS = [
  'importedAt',
  'openedAt',
  'lastAccessedAt',
  'lastAudibleAt',
  'archivedAt',
  'trashedAt',
  'reopenedAt',
  'implicitCloseAt',
] as const;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');

/** Validates one exported record; returns a clean TabRecord (live/pendingClose null) or a Spanish error. */
export function validateRecord(x: unknown, now = Date.now()): TabRecord | string {
  if (!isObj(x)) return 'no es un objeto';
  if (typeof x.id !== 'string' || !x.id.trim() || x.id.length > 200) return 'id inválido';
  if (typeof x.url !== 'string' || !x.url) return 'url inválida';
  try {
    new URL(x.url);
  } catch {
    return 'url inválida';
  }
  if (typeof x.state !== 'string' || !STATES.has(x.state)) return 'estado inválido';
  if (x.title !== undefined && typeof x.title !== 'string') return 'título inválido';
  for (const k of ['protected', 'pending'] as const) if (x[k] !== undefined && typeof x[k] !== 'boolean') return `${k} inválido`;
  for (const k of ['note', 'project', 'lastReason', 'favIconUrl', 'domain'] as const)
    if (x[k] !== undefined && typeof x[k] !== 'string') return `${k} inválido`;
  for (const k of ['tags', 'previousUrls', 'mergedFrom'] as const) if (x[k] !== undefined && !isStrArr(x[k])) return `${k} inválido`;
  for (const k of ['createdAt', 'updatedAt', 'reopenCount', 'rev', ...OPTIONAL_NUMBERS] as const)
    if (x[k] !== undefined && x[k] !== null && !isNum(x[k])) return `${k} inválido`;
  if (x.origin !== undefined && !isObj(x.origin)) return 'origin inválido';
  if (x.source !== undefined && (typeof x.source !== 'string' || !SOURCES.has(x.source))) return 'source inválido';

  const url = x.url;
  const rec: TabRecord = {
    id: x.id,
    url,
    title: ((x.title as string | undefined) || url).slice(0, MAX_TITLE_LENGTH),
    domain: domainOf(url),
    state: x.state as RecordState,
    protected: x.protected === true,
    pending: x.pending === true,
    tags: normalizeTags(x.tags ?? []),
    project: ((x.project as string | undefined) ?? '').trim(),
    note: ((x.note as string | undefined) ?? '').slice(0, MAX_NOTE_LENGTH),
    source: (x.source as TabRecord['source'] | undefined) ?? 'json-import',
    createdAt: isNum(x.createdAt) ? x.createdAt : now,
    updatedAt: isNum(x.updatedAt) ? x.updatedAt : 0,
    origin: {},
    previousUrls: ((x.previousUrls as string[] | undefined) ?? []).slice(0, MAX_PREVIOUS_URLS),
    reopenCount: isNum(x.reopenCount) ? x.reopenCount : 0,
    mergedFrom: (x.mergedFrom as string[] | undefined) ?? [],
    live: null,
    pendingClose: null,
    rev: isNum(x.rev) ? x.rev : 0,
  };
  const fav = sanitizeFavicon(x.favIconUrl as string | undefined);
  if (fav) rec.favIconUrl = fav;
  for (const k of OPTIONAL_NUMBERS) if (isNum(x[k])) rec[k] = x[k] as number;
  if (typeof x.lastReason === 'string') rec.lastReason = x.lastReason;
  if (isObj(x.origin)) {
    const o = x.origin;
    if (isNum(o.windowOrdinal)) rec.origin.windowOrdinal = o.windowOrdinal;
    if (isNum(o.index)) rec.origin.index = o.index;
    if (typeof o.groupTitle === 'string') rec.origin.groupTitle = o.groupTitle;
    if (typeof o.groupColor === 'string') rec.origin.groupColor = o.groupColor;
  }
  return rec;
}

/** Throws (Spanish) on an unknown format / schema; rejects malformed records individually. */
export function parseAndValidateImport(data: unknown): ParsedImport {
  let d = data;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      throw new Error('El archivo no es un JSON válido.');
    }
  }
  if (!isObj(d) || d.format !== EXPORT_FORMAT) {
    throw new Error('Formato no reconocido: el archivo no es una copia de seguridad de Fangio.');
  }
  if (d.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Versión de copia no compatible (schemaVersion ${String(d.schemaVersion)}). Esta versión de Fangio importa la versión ${EXPORT_SCHEMA_VERSION}; actualice la extensión.`,
    );
  }
  if (!Array.isArray(d.records)) throw new Error('La copia no contiene una lista de registros.');
  const out: ParsedImport = { records: [], rejected: [], settings: null, actions: [] };
  const seen = new Set<string>();
  const now = Date.now();
  d.records.forEach((x, index) => {
    const v = validateRecord(x, now);
    if (typeof v === 'string') out.rejected.push({ index, error: v });
    else if (seen.has(v.id)) out.rejected.push({ index, error: 'id duplicado en el archivo' });
    else {
      seen.add(v.id);
      out.records.push(v);
    }
  });
  if (isObj(d.settings)) out.settings = sanitizeSettings(d.settings);
  if (Array.isArray(d.actions)) {
    for (const a of d.actions) {
      if (isObj(a) && typeof a.id === 'string' && isNum(a.at) && typeof a.kind === 'string' && Array.isArray(a.recordIds)) {
        out.actions.push({ ...(a as unknown as ActionEntry), undoable: false });
      }
    }
  }
  if (isNum(d.exportedAt)) out.exportedAt = d.exportedAt;
  if (typeof d.appVersion === 'string') out.appVersion = d.appVersion;
  return out;
}

/**
 * Applies a JSON backup: 'open' records become 'archived' (they have no tab);
 * merge by id where the newest updatedAt wins; never deletes anything. Records
 * that are currently open in this browser keep their state and live binding.
 */
export async function importJson(data: unknown): Promise<ImportJsonResult> {
  const parsed = parseAndValidateImport(data);
  const result: ImportJsonResult = { added: 0, updated: 0, unchanged: 0, rejected: parsed.rejected };
  const touched: string[] = [];
  await dbLock.run(async () => {
    const now = Date.now();
    const existing = await getRecordsByIds(parsed.records.map((r) => r.id));
    const toWrite: TabRecord[] = [];
    for (const imp of parsed.records) {
      if (imp.state === 'open') {
        imp.state = 'archived';
        imp.archivedAt = now;
        imp.lastReason = 'Importada desde una copia de seguridad (estaba abierta)';
      }
      const ex = existing.get(imp.id);
      if (!ex) {
        toWrite.push(imp);
        result.added++;
      } else if (imp.updatedAt > ex.updatedAt) {
        if (ex.state === 'open' || ex.pendingClose) {
          imp.state = ex.state;
          imp.live = ex.live;
          imp.pendingClose = ex.pendingClose;
          if (ex.archivedAt === undefined) delete imp.archivedAt;
        }
        imp.rev = Math.max(imp.rev, ex.rev);
        toWrite.push(imp);
        result.updated++;
      } else result.unchanged++;
    }
    await putRecords(toWrite, { preserveUpdatedAt: true });
    touched.push(...toWrite.map((r) => r.id));

    const newActions: ActionEntry[] = [];
    for (const a of parsed.actions) if (!(await getAction(a.id))) newActions.push(a);
    const current = await getSettings();
    if (parsed.settings && !current.onboardingDone) {
      await putSettings({ ...parsed.settings, automationEnabled: false, onboardingDone: current.onboardingDone });
    }
    newActions.push(
      newAction('import-json', {
        reason: `Importación de copia JSON: ${result.added} nuevas, ${result.updated} actualizadas, ${result.unchanged} sin cambios, ${result.rejected.length} rechazadas`,
        recordIds: touched.slice(),
        undoable: false,
      }),
    );
    await putActions(newActions);
  });
  recordsChanged(touched);
  broadcast({ type: 'actions' });
  broadcast({ type: 'settings' });
  broadcast({ type: 'status' });
  return result;
}
