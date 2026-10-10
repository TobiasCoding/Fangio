// Pure URL helpers. No chrome.* access at import time (usable from UI pages and tests).

import { MAX_FAVICON_URL_LENGTH } from '../shared/constants';

const TRACKABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:']);

/** http, https, file and ftp URLs. chrome://, about:, chrome-extension://, data:, etc. are not trackable. */
export function isTrackableUrl(url: string | undefined | null): url is string {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return TRACKABLE_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

/** True for chrome-extension:// URLs of this extension (or of any extension when extensionId is unknown). */
export function isExtensionPage(url: string | undefined | null, extensionId?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('chrome-extension://')) return false;
  if (!extensionId) return true;
  return url.startsWith(`chrome-extension://${extensionId}/`);
}

/** Lowercased hostname without a leading "www.". Empty string when there is no host (file:, invalid). */
export function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/**
 * Canonical form used ONLY for comparisons with user-typed rule URLs:
 * new URL(x).href (lowercases scheme/host, adds "/" to an empty path).
 * Never strips path, query or fragment. Returns null for unparsable input.
 */
export function canonicalUrl(url: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return new URL(url.trim()).href;
  } catch {
    return null;
  }
}

/**
 * Site exclusion patterns:
 *  - "docs.google.com" matches that host or any subdomain of it.
 *  - "*.zoom.us" matches zoom.us and any subdomain.
 * A pattern may also be written as a URL (https://host/...) - only its host is used.
 */
export function matchesSiteExclusion(url: string, patterns: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    let p = raw.trim().toLowerCase();
    if (!p) continue;
    if (p.includes('://')) {
      try {
        p = new URL(p).hostname;
      } catch {
        continue;
      }
    }
    p = p.replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (p.startsWith('*.')) p = p.slice(2);
    if (p.startsWith('.')) p = p.slice(1);
    if (!p) continue;
    if (host === p || host.endsWith('.' + p)) return true;
  }
  return false;
}

/** Only http(s) favicon URLs up to MAX_FAVICON_URL_LENGTH; anything else (data:, chrome:, empty) -> undefined. */
export function sanitizeFavicon(url?: string | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  if (url.length > MAX_FAVICON_URL_LENGTH) return undefined;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return url;
}

/** Trimmed, lowercased, unique, sorted, without empty values. */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (v) out.add(v.slice(0, 100));
  }
  return [...out].sort();
}

/** URL a tab currently shows: the committed url, or the pending one while it has not committed yet. */
export function tabUrl(tab: { url?: string | undefined; pendingUrl?: string | undefined } | undefined | null): string {
  if (!tab) return '';
  return tab.url || tab.pendingUrl || '';
}
