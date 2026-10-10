import type { Settings, UrlRule } from './types';

export const DEFAULT_URL_RULES: UrlRule[] = [
  { id: 'preset-chatgpt-home', enabled: true, url: 'https://chatgpt.com/', action: 'trash', afterMinutes: 60, label: 'Inicio de ChatGPT' },
  { id: 'preset-instagram-home', enabled: true, url: 'https://www.instagram.com/', action: 'trash', afterMinutes: 60, label: 'Inicio de Instagram' },
  { id: 'preset-google-newtab', enabled: true, url: 'https://www.google.com/', action: 'trash', afterMinutes: 60, label: 'Inicio de Google' },
];

/** Sites with work in progress (editors, calls, chats) that automation never closes. */
export const DEFAULT_SITE_EXCLUSIONS: string[] = [
  'meet.google.com',
  'docs.google.com',
  '*.zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'app.slack.com',
  'www.figma.com',
  'web.whatsapp.com',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
];

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    automationEnabled: false,
    targetOpenTabs: 15,
    idleArchiveHours: 24,
    targetMinIdleMinutes: 60,
    audioGraceMinutes: 10,
    checkIntervalMinutes: 5,
    maxAutoClosePerRun: 50,
    siteExclusions: [...DEFAULT_SITE_EXCLUSIONS],
    urlRules: DEFAULT_URL_RULES.map((r) => ({ ...r })),
    trashRetentionDays: 30,
    reopenConcurrency: 3,
    discardAfterBulkReopen: true,
    restoreGroups: true,
    updateCheck: true,
    logRetentionDays: 90,
    onboardingDone: false,
  };
}

/** Clamp / repair a settings object coming from storage, the UI or a JSON import. Never throws. */
export function sanitizeSettings(input: unknown): Settings {
  const d = defaultSettings();
  if (!input || typeof input !== 'object') return d;
  const s = input as Partial<Settings>;
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  const strList = (v: unknown, def: string[]) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))] : def;
  const rules = Array.isArray(s.urlRules)
    ? s.urlRules
        .filter((r): r is UrlRule => !!r && typeof r === 'object' && typeof (r as UrlRule).url === 'string')
        .map((r) => ({
          id: typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID(),
          enabled: bool(r.enabled, true),
          url: r.url.trim(),
          action: r.action === 'archive' ? ('archive' as const) : ('trash' as const),
          afterMinutes: num(r.afterMinutes, 60, 0, 60 * 24 * 365),
          ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim() } : {}),
        }))
        .filter((r) => r.url.length > 0)
    : d.urlRules;
  return {
    schemaVersion: 1,
    automationEnabled: bool(s.automationEnabled, d.automationEnabled),
    targetOpenTabs: num(s.targetOpenTabs, d.targetOpenTabs, 1, 10000),
    idleArchiveHours: num(s.idleArchiveHours, d.idleArchiveHours, 0, 24 * 365),
    targetMinIdleMinutes: num(s.targetMinIdleMinutes, d.targetMinIdleMinutes, 0, 60 * 24 * 30),
    audioGraceMinutes: num(s.audioGraceMinutes, d.audioGraceMinutes, 0, 60 * 24),
    checkIntervalMinutes: num(s.checkIntervalMinutes, d.checkIntervalMinutes, 1, 24 * 60),
    maxAutoClosePerRun: num(s.maxAutoClosePerRun, d.maxAutoClosePerRun, 1, 1000),
    siteExclusions: strList(s.siteExclusions, d.siteExclusions),
    urlRules: rules,
    trashRetentionDays: num(s.trashRetentionDays, d.trashRetentionDays, 0, 3650),
    reopenConcurrency: num(s.reopenConcurrency, d.reopenConcurrency, 1, 10),
    discardAfterBulkReopen: bool(s.discardAfterBulkReopen, d.discardAfterBulkReopen),
    restoreGroups: bool(s.restoreGroups, d.restoreGroups),
    updateCheck: bool(s.updateCheck, d.updateCheck),
    logRetentionDays: num(s.logRetentionDays, d.logRetentionDays, 1, 3650),
    ...(typeof s.lastBackupAt === 'number' ? { lastBackupAt: s.lastBackupAt } : {}),
    onboardingDone: bool(s.onboardingDone, d.onboardingDone),
  };
}
