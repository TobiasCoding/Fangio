// Optional daily check of the latest GitHub release. Sends no user data and
// never throws into callers.

import { GITHUB_RELEASES_API, GITHUB_RELEASES_PAGE } from '../shared/constants';
import type { StatusInfo } from '../shared/types';
import { getKv, getSettings, setKv } from './db';

export interface UpdateInfo {
  latest: string;
  url: string;
  checkedAt: number;
  current: string;
  newer: boolean;
}

function parse(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
}

/** >0 if a > b, <0 if a < b, 0 if equal or unparsable. "v1.2.3" accepted; prereleases sort before releases. */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function toStatus(info: UpdateInfo | undefined, current: string): StatusInfo['update'] {
  if (!info) return null;
  // Re-evaluate against the running version (the extension may have been updated since).
  if (compareSemver(info.latest, current) <= 0) return null;
  return { latest: info.latest, url: info.url, checkedAt: info.checkedAt };
}

function currentVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

export async function getStoredUpdate(): Promise<StatusInfo['update']> {
  try {
    return toStatus(await getKv<UpdateInfo>('updateInfo'), currentVersion());
  } catch {
    return null;
  }
}

/** Only when settings.updateCheck (or force = explicit user click). */
export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<StatusInfo['update']> {
  try {
    const settings = await getSettings();
    if (!settings.updateCheck && !opts.force) return await getStoredUpdate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(GITHUB_RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return await getStoredUpdate();
    const j = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof j.tag_name !== 'string' || !parse(j.tag_name)) return await getStoredUpdate();
    const url =
      typeof j.html_url === 'string' && j.html_url.startsWith('https://github.com/') ? j.html_url : GITHUB_RELEASES_PAGE;
    const current = currentVersion();
    const info: UpdateInfo = {
      latest: j.tag_name.replace(/^v/, ''),
      url,
      checkedAt: Date.now(),
      current,
      newer: compareSemver(j.tag_name, current) > 0,
    };
    await setKv('updateInfo', info);
    return toStatus(info, current);
  } catch {
    try {
      return await getStoredUpdate();
    } catch {
      return null;
    }
  }
}
