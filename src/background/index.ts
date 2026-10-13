// Fangio service worker. Every listener is registered synchronously at the top
// level (MV3 requirement); every handler awaits ready() (idempotent init).

import {
  ALARM_AUTOMATION,
  ALARM_MAINTENANCE,
  ALARM_STARTUP_SWEEP,
  ALARM_UPDATE_CHECK,
  STARTUP_GRACE_MS,
} from '../shared/constants';
import type { Envelope, Request } from '../shared/messages';
import { defaultSettings } from '../shared/settings';
import { purgeExpired, pruneLog } from '../core/actions';
import { dedupeArchived } from '../core/duplicates';
import { countByState, getDb, getKv, getSettings, putSettings, setKv } from '../core/db';
import { resumeOps } from '../core/resume';
import { onLocalChange, rt } from '../core/runtime';
import { getSession, markStartup } from '../core/session';
import * as tracker from '../core/tracker';
import { runAutomation } from '../core/automation';
import { checkForUpdate } from '../core/updateCheck';
import { archiveTab } from '../core/closeOp';
import * as thumbs from '../core/thumbs';
import { handleRequest } from './router';

const MAINTENANCE_PERIOD_MIN = 15;
const UPDATE_PERIOD_MIN = 24 * 60;
const RECONCILE_STALE_MS = 5 * 60 * 1000;

interface Meta {
  installedAt: number;
  version: string;
}

function manifestVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

// ------------------------------------------------------------------ init

async function init(): Promise<void> {
  await getDb();
  if (!(await getKv('settings'))) await putSettings(defaultSettings());
  const session = await getSession();
  const now = Date.now();
  const meta = await getKv<Meta>('meta');
  if (!meta) {
    // First run: every existing tab becomes an 'open' record (the first backup).
    // Done here, not only in onInstalled, and before any queued tab event is applied.
    await tracker.reconcile({ createSource: 'install-snapshot', fromInit: true });
    await setKv('meta', { installedAt: now, version: manifestVersion() } satisfies Meta);
  } else if (meta.version !== manifestVersion()) {
    await setKv('meta', { ...meta, version: manifestVersion() });
  }
  const resumed = await resumeOps();
  if (meta) {
    const last = (await getKv<number>('lastReconcileAt')) ?? 0;
    if (session.isNew || now - last > RECONCILE_STALE_MS) await tracker.reconcile({ fromInit: true });
  }
  if (session.isNew) await scheduleStartupSweep(session.startupAt);
  await ensureAlarms();
  if (resumed.continuation) void resumed.continuation;
  scheduleBadge();
}

let readyP: Promise<void> = start();
function start(): Promise<void> {
  const p = init();
  p.catch((e) => console.error('[fangio] init failed', e));
  return p;
}
/** Idempotent: resolves once init succeeded; retries init if it had failed. */
export function ready(): Promise<void> {
  // Single-flight retry: concurrent callers that observed the same rejected
  // init share ONE new start() instead of each launching their own.
  const failed = readyP;
  return failed.catch(() => {
    if (readyP === failed) readyP = start();
    return readyP;
  });
}
tracker.setTrackerReady(ready);

// ------------------------------------------------------------------ alarms

async function ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
  const a = await chrome.alarms.get(name);
  if (!a || a.periodInMinutes !== periodInMinutes) {
    await chrome.alarms.create(name, { periodInMinutes, delayInMinutes: periodInMinutes });
  }
}

export async function ensureAlarms(): Promise<void> {
  const s = await getSettings();
  await ensureAlarm(ALARM_MAINTENANCE, MAINTENANCE_PERIOD_MIN);
  if (s.automationEnabled) await ensureAlarm(ALARM_AUTOMATION, Math.max(1, s.checkIntervalMinutes));
  else await chrome.alarms.clear(ALARM_AUTOMATION);
  if (s.updateCheck) await ensureAlarm(ALARM_UPDATE_CHECK, UPDATE_PERIOD_MIN);
  else await chrome.alarms.clear(ALARM_UPDATE_CHECK);
}

async function scheduleStartupSweep(startupAt: number): Promise<void> {
  await chrome.alarms.create(ALARM_STARTUP_SWEEP, { when: Math.max(Date.now() + 30000, startupAt + STARTUP_GRACE_MS + 5000) });
}

export async function runMaintenance(): Promise<void> {
  const r = await resumeOps();
  if (r.continuation) void r.continuation;
  await tracker.reconcile();
  await purgeExpired();
  await dedupeArchived();
  await pruneLog();
  await thumbs.pruneThumbnails().catch(() => 0);
  scheduleBadge();
}

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  await ready();
  switch (alarm.name) {
    case ALARM_AUTOMATION:
      await runAutomation('alarm');
      await dedupeArchived();
      break;
    case ALARM_MAINTENANCE:
      await runMaintenance();
      break;
    case ALARM_UPDATE_CHECK:
      await checkForUpdate();
      break;
    case ALARM_STARTUP_SWEEP: {
      // Close ops deferred by the startup grace (interrupted by a crash/restart) must be
      // resolved now too; otherwise their records stay 'open' with pendingClose (and tabs
      // with those URLs stay untracked) until the 15-minute maintenance alarm.
      const r = await resumeOps();
      if (r.continuation) void r.continuation;
      await tracker.reconcile();
      scheduleBadge();
      break;
    }
  }
}

// ------------------------------------------------------------------ badge

let badgeTimer: ReturnType<typeof setTimeout> | null = null;
let flashUntil = 0;

function scheduleBadge(delay = 500): void {
  if (rt.killed) return;
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    void updateBadge();
  }, delay);
}

export async function updateBadge(): Promise<void> {
  try {
    if (Date.now() < flashUntil || !chrome.action) return;
    const { open } = await countByState();
    const text = open === 0 ? '' : open > 999 ? '999+' : String(open);
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
    await chrome.action.setBadgeText({ text });
  } catch {
    /* badge is cosmetic */
  }
}

async function flashRefused(): Promise<void> {
  try {
    flashUntil = Date.now() + 3000;
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: '!' });
    setTimeout(() => {
      flashUntil = 0;
      void updateBadge();
    }, 3000);
  } catch {
    /* ignore */
  }
}

onLocalChange((ev) => {
  if (ev.type === 'settings') void track(ensureAlarms());
  if (ev.type === 'records' || ev.type === 'status') scheduleBadge();
});

// ------------------------------------------------------------------ commands

export async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (t.url || t.pendingUrl || '').startsWith(url));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

async function handleCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  await ready();
  if (command === 'open-dashboard') {
    await openDashboard();
    return;
  }
  if (command === 'archive-current-tab') {
    let target = tab;
    if (!target?.id) {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      target = t;
    }
    if (!target || typeof target.id !== 'number') {
      await flashRefused();
      return;
    }
    // The shortcut grants activeTab: keep a thumbnail of what is being archived (if enabled; never blocks long).
    await Promise.race([thumbs.captureTab(target.id, { viaActiveTab: true }).catch(() => null), new Promise((r) => setTimeout(r, 1500))]);
    const res = await archiveTab(target.id, false, 'Archivada con el atajo de teclado');
    if (res.done.length === 0) await flashRefused();
  }
}

// ------------------------------------------------------------------ messages

async function handleMessage(msg: unknown, sender: chrome.runtime.MessageSender): Promise<Envelope<unknown>> {
  try {
    if (sender?.id && sender.id !== chrome.runtime.id) return { ok: false, error: 'Remitente no autorizado' };
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
      return { ok: false, error: 'Solicitud inválida' };
    }
    await ready();
    const data = await handleRequest(msg as Request);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ in-flight tracking (tests / diagnostics)

const inFlight = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  p.catch((e) => console.warn('[fangio] handler failed', e)).finally(() => inFlight.delete(p));
  return p;
}

/** Resolves when init, every running handler and the event queue are settled. */
export async function whenIdle(): Promise<void> {
  await ready().catch(() => {});
  for (let i = 0; i < 50; i++) {
    await tracker.flushNow().catch(() => {});
    if (inFlight.size === 0) break;
    await Promise.allSettled([...inFlight]);
  }
  await tracker.flushNow().catch(() => {});
}

/** Tests: simulate the worker being killed (timers and handlers of this instance stop). */
export function __killForTests(): void {
  rt.killed = true;
  if (badgeTimer) clearTimeout(badgeTimer);
}

// ------------------------------------------------------------------ listeners (synchronous, top level)

chrome.tabs.onCreated.addListener((tab) => tracker.onTabCreated(tab));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  tracker.onTabUpdated(tabId, info, tab);
  thumbs.onThumbTabUpdated(tabId, info, tab);
});
chrome.tabs.onActivated.addListener((info) => {
  tracker.onTabActivated(info);
  thumbs.onThumbTabActivated(info);
});
chrome.tabs.onRemoved.addListener((tabId, info) => tracker.onTabRemoved(tabId, info));
chrome.tabs.onReplaced.addListener((added, removed) => tracker.onTabReplaced(added, removed));
chrome.tabs.onAttached.addListener((tabId) => tracker.onTabMoved(tabId));
chrome.tabs.onDetached.addListener((tabId) => tracker.onTabMoved(tabId));
chrome.runtime.onInstalled.addListener(() => {
  void track(ready().then(ensureAlarms));
});
chrome.runtime.onStartup.addListener(() => {
  void track(
    (async () => {
      await ready();
      const s = await markStartup();
      await scheduleStartupSweep(s.startupAt);
      await ensureAlarms();
    })(),
  );
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void track(handleMessage(msg, sender)).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  void track(handleAlarm(alarm));
});
chrome.commands?.onCommand.addListener((command, tab) => {
  void track(handleCommand(command, tab));
});
