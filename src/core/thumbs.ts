// Optional page thumbnails for the cards view (off by default).
//
// How: when a tab has been visible and loaded for THUMB_SETTLE_MS, chrome.tabs.captureVisibleTab
// takes a screenshot of what the user is already looking at; it is downscaled to THUMB_W px
// (WebP) and stored in the "thumbs" store under the record id. Nothing leaves the device and
// thumbnails are never included in JSON exports.
//
// Privacy guards (all must pass): feature enabled; automatic capture only with the optional
// "<all_urls>" host permission granted by the user (the popup and the archive shortcut use
// the activeTab grant instead); http(s) only; never incognito; never site exclusions,
// thumbnail exclusions or sensitive-looking URLs (login, payments, account, tokens);
// the tab must still be active and show the same URL after the capture.

import { MAX_THUMBNAILS, THUMB_MAX_H, THUMB_REFRESH_MS, THUMB_SETTLE_MS, THUMB_W } from '../shared/constants';
import type { Settings, ThumbEntry } from '../shared/types';
import { deleteThumbs, getAllRecordIds, getRecordsByState, getSettings, getThumb, getThumbIds, pruneThumbs, putThumb } from './db';
import { broadcast, rt } from './runtime';
import { getSession } from './session';
import { isTrackableUrl, matchesSiteExclusion, tabUrl } from './url';

export const ALL_URLS = '<all_urls>';

const SENSITIVE_RE =
  /(^|[./_-])(log-?in|sign-?in|sign-?up|logon|auth|oauth2?|sso|accounts?|password|passwd|checkout|payments?|billing|wallet|bank|banking|homebanking|2fa|mfa|otp|verify)([./_?#-]|$)/i;

/** Why a URL must not be captured (Spanish, shown in the UI), or null when it may be. */
export function thumbBlockReason(url: string, s: Pick<Settings, 'siteExclusions' | 'thumbnailExclusions'>): string | null {
  if (!/^https?:\/\//i.test(url)) return 'Sólo se capturan páginas web (http/https)';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'URL inválida';
  }
  if (matchesSiteExclusion(url, s.siteExclusions)) return 'Sitio excluido';
  if (matchesSiteExclusion(url, s.thumbnailExclusions)) return 'Sitio excluido de las miniaturas';
  if (SENSITIVE_RE.test(u.hostname + u.pathname)) return 'Página sensible (inicio de sesión, cuenta o pagos)';
  if (/[?&#](token|code|session|sid|auth|key|password)=/i.test(u.search + u.hash)) return 'La URL lleva credenciales temporales';
  return null;
}

/** True when there is no thumbnail, it shows another URL, or it is older than THUMB_REFRESH_MS. */
export function needsCapture(existing: Pick<ThumbEntry, 'url' | 'at'> | undefined, url: string, now: number): boolean {
  if (!existing) return true;
  if (existing.url !== url) return true;
  return now - existing.at >= THUMB_REFRESH_MS;
}

export async function hasHostAccess(): Promise<boolean> {
  try {
    return !!(await chrome.permissions?.contains({ origins: [ALL_URLS] }));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ scheduling (event entry points are synchronous)

const timers = new Map<number, ReturnType<typeof setTimeout>>(); // windowId -> timer
let chain: Promise<unknown> = Promise.resolve();
let lastCaptureAt = 0;

function schedule(windowId: number, tabId: number): void {
  if (rt.killed) return;
  const prev = timers.get(windowId);
  if (prev) clearTimeout(prev);
  timers.set(
    windowId,
    setTimeout(() => {
      timers.delete(windowId);
      chain = chain.then(() => captureTab(tabId).catch(() => undefined));
    }, THUMB_SETTLE_MS),
  );
}

export function onThumbTabActivated(info: { tabId: number; windowId: number }): void {
  schedule(info.windowId, info.tabId);
}

export function onThumbTabUpdated(tabId: number, info: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab): void {
  if (info.status === 'complete' && tab?.active && !tab.incognito) schedule(tab.windowId, tabId);
}

export function __resetThumbsForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  chain = Promise.resolve();
  lastCaptureAt = 0;
}

// ------------------------------------------------------------------ capture

export interface CaptureResult {
  captured: boolean;
  reason?: string;
}

const no = (reason: string): CaptureResult => ({ captured: false, reason });

/**
 * Captures the tab if it is the visible tab of its window and every guard passes.
 * viaActiveTab: the user just invoked the extension on this tab (popup / shortcut), so the
 * activeTab grant allows the capture without the optional host permission.
 */
export async function captureTab(tabId: number, opts: { viaActiveTab?: boolean } = {}): Promise<CaptureResult> {
  const s = await getSettings();
  if (!s.thumbnails) return no('Las miniaturas están desactivadas');
  if (!opts.viaActiveTab && !(await hasHostAccess())) return no('Falta el permiso para capturar automáticamente');
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return no('La pestaña ya no existe');
  }
  if (tab.incognito) return no('Incógnito');
  if (!tab.active) return no('La pestaña no está visible');
  if (tab.status !== 'complete') return no('La página todavía está cargando');
  const url = tabUrl(tab);
  if (!isTrackableUrl(url)) return no('Página no rastreable');
  const block = thumbBlockReason(url, s);
  if (block) return no(block);
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized') return no('La ventana está minimizada');
  } catch {
    return no('La ventana ya no existe');
  }
  const sid = (await getSession()).sessionId;
  const rec = (await getRecordsByState('open')).find((r) => r.live?.sessionId === sid && r.live.tabId === tabId);
  if (!rec || rec.url !== url) return no('La pestaña no tiene referencia guardada');
  if (!needsCapture(await getThumb(rec.id), url, Date.now())) return no('Ya tiene una miniatura reciente');

  // captureVisibleTab is limited to 2 calls per second per extension.
  const wait = lastCaptureAt + 600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
  } catch (e) {
    return no(e instanceof Error ? e.message : 'No se pudo capturar');
  }
  // What we captured must still be this tab with this URL.
  const after = await chrome.tabs.get(tabId).catch(() => null);
  if (!after || !after.active || after.windowId !== tab.windowId || tabUrl(after) !== url) return no('La pestaña cambió durante la captura');

  const img = await downscale(dataUrl);
  await putThumb({ id: rec.id, url, at: Date.now(), ...img });
  broadcast({ type: 'thumbs', ids: [rec.id] });
  return { captured: true };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/jpeg';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** THUMB_W px wide, top of the page when it is taller than THUMB_MAX_H; WebP (JPEG fallback). */
async function downscale(dataUrl: string): Promise<Pick<ThumbEntry, 'w' | 'h' | 'type' | 'data'>> {
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl), { resizeWidth: THUMB_W, resizeQuality: 'high' });
  const w = bmp.width;
  const h = Math.min(THUMB_MAX_H, bmp.height);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas no disponible');
  ctx.drawImage(bmp, 0, 0, w, h, 0, 0, w, h);
  bmp.close();
  let out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
  if (out.type !== 'image/webp') out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
  return { w, h, type: out.type, data: await out.arrayBuffer() };
}

// ------------------------------------------------------------------ maintenance

/** Orphans (record purged) and the oldest captures above MAX_THUMBNAILS. */
export async function pruneThumbnails(): Promise<number> {
  const ids = new Set(await getAllRecordIds());
  return pruneThumbs(MAX_THUMBNAILS, ids);
}

/** Deletes every thumbnail (user action). Returns how many. */
export async function clearThumbnails(): Promise<number> {
  const ids = await getThumbIds();
  await deleteThumbs(ids);
  if (ids.length) broadcast({ type: 'thumbs', ids: [] });
  return ids.length;
}
