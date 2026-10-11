// "Group in Chrome": puts the open tabs of some records into a native tab group per
// window (Chrome cannot group tabs of different windows). Only organizes tabs: records,
// states and the action log are not touched, and nothing is closed or moved across windows.

import { getRecordsByIds } from './db';
import { getSession } from './session';

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

const MAX_GROUP_TITLE = 80;

export function cleanGroupTitle(title: unknown): string {
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_TITLE) : '';
}

export async function groupTabs(
  recordIds: readonly string[],
  title: string,
  color?: string,
): Promise<{ grouped: number; windows: number; skipped: number }> {
  const name = cleanGroupTitle(title);
  if (!name) throw new Error('Escribí un nombre para el grupo');
  if (!chrome.tabGroups || !chrome.tabs.group) throw new Error('Este navegador no permite agrupar pestañas');
  const col = GROUP_COLORS.includes(color as GroupColor) ? (color as GroupColor) : undefined;
  const sid = (await getSession()).sessionId;
  const recs = await getRecordsByIds(recordIds);
  const byWindow = new Map<number, number[]>();
  let skipped = 0;
  for (const r of recs.values()) {
    if (r.state !== 'open' || !r.live || r.live.sessionId !== sid) {
      skipped++;
      continue;
    }
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(r.live.tabId);
    } catch {
      skipped++;
      continue;
    }
    // Pinned tabs cannot live in a group; never unpin on the user's behalf.
    if (tab.pinned || tab.incognito || tab.url !== r.url) {
      skipped++;
      continue;
    }
    const list = byWindow.get(tab.windowId);
    if (list) list.push(tab.id!);
    else byWindow.set(tab.windowId, [tab.id!]);
  }
  skipped += recordIds.length - recs.size;
  let grouped = 0;
  for (const [windowId, tabIds] of byWindow) {
    // Reuse a group with the same title in that window instead of creating a twin.
    const existing = (await chrome.tabGroups.query({ windowId, title: name }).catch(() => []))[0];
    const groupId = existing
      ? await chrome.tabs.group({ groupId: existing.id, tabIds: tabIds as [number, ...number[]] })
      : await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: name, ...(col ? { color: col } : {}) });
    grouped += tabIds.length;
  }
  return { grouped, windows: byWindow.size, skipped };
}
