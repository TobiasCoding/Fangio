// Pure formatting helpers and Spanish labels shared by popup and dashboard.

import type { ActionKind, BlockReason, DecisionAction, RecordSource, RecordState } from '../../shared/types';

export const BLOCK_LABELS: Record<BlockReason, string> = {
  protected: 'Protegida',
  pinned: 'Fijada',
  active: 'Activa',
  highlighted: 'Seleccionada',
  audible: 'Reproduciendo audio',
  'recent-audio': 'Audio reciente',
  'site-excluded': 'Sitio excluido',
  incognito: 'Incógnito',
  'extension-page': 'Página de Fangio',
  'untrackable-url': 'URL interna',
  'recently-viewed': 'Vista recientemente',
  'pending-operation': 'Operación en curso',
};

export function blockLabel(r: BlockReason | string): string {
  return (BLOCK_LABELS as Record<string, string>)[r] ?? r;
}

export const STATE_LABELS: Record<RecordState, string> = {
  open: 'Abierta',
  archived: 'Archivada',
  trash: 'Papelera',
};

export const DECISION_LABELS: Record<DecisionAction, string> = {
  archive: 'Archivar',
  trash: 'Papelera',
  keep: 'Mantener',
};

export const SOURCE_LABELS: Record<RecordSource, string> = {
  'install-snapshot': 'Captura al instalar',
  tracked: 'Seguida desde que se abrió',
  'json-import': 'Importada desde copia JSON',
  manual: 'Creada manualmente',
};

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  'install-snapshot': 'Captura inicial',
  archive: 'Archivar',
  trash: 'Papelera',
  reopen: 'Reabrir',
  restore: 'Restaurar',
  purge: 'Eliminación definitiva',
  update: 'Edición',
  merge: 'Fusión',
  'user-closed': 'Cerradas por vos',
  'window-closed': 'Ventana cerrada',
  rebind: 'Re-vinculación',
  'import-json': 'Importación JSON',
  settings: 'Configuración',
  undo: 'Deshacer',
};

const nf = new Intl.NumberFormat('es-AR');
export function fmtNum(n: number): string {
  return nf.format(n);
}

/** "1 pestaña" / "3 pestañas". */
export function plural(n: number, one: string, many: string): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

const dtf = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' });

export function fmtDateTime(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? dtf.format(ms) : '—';
}

export function fmtDate(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? df.format(ms) : '—';
}

/** Compact relative time: "ahora", "hace 5 min", "hace 3 h", "hace 3 d", "hace 2 meses", "hace 1 año". */
export function fmtRelative(ms: number | undefined, now = Date.now()): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const diff = now - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60000);
  let s: string;
  if (min < 1) return 'ahora';
  if (min < 60) s = `${min} min`;
  else if (min < 60 * 24) s = `${Math.floor(min / 60)} h`;
  else if (min < 60 * 24 * 30) s = `${Math.floor(min / 1440)} d`;
  else if (min < 60 * 24 * 365) {
    const m = Math.floor(min / (1440 * 30));
    s = m === 1 ? '1 mes' : `${m} meses`;
  } else {
    const y = Math.floor(min / (1440 * 365));
    s = y === 1 ? '1 año' : `${y} años`;
  }
  return future ? `en ${s}` : `hace ${s}`;
}

/** Duration in minutes → "45 min", "26 h", "3 d". */
export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.max(0, Math.round(min))} min`;
  if (min < 60 * 48) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

/** Lowercase + strip diacritics, for accent/case-insensitive search. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Favicon from the browser cache (requires the "favicon" permission). Never fetches the site. */
export function faviconUrl(pageUrl: string, size = 16): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`);
}

/** YYYY-MM-DD in local time. */
export function isoDay(ms = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parses free tag input "a, b c" → ['a','b','c'] normalized like the core does. */
export function parseTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
