// Test-only helper extension for the Fangio e2e harness. The harness evaluates
// globalThis.helper.* inside this service worker (via CDP). It never touches Fangio.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tab event log (used to observe reopen concurrency etc.)
const events = [];
let recording = false;
chrome.tabs.onCreated.addListener((t) => recording && events.push({ t: Date.now(), ev: 'created', id: t.id, url: t.pendingUrl || t.url || '' }));
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (!recording) return;
  if (info.status) events.push({ t: Date.now(), ev: 'status', id, status: info.status, url: tab.url || '' });
  if (info.discarded !== undefined) events.push({ t: Date.now(), ev: 'discarded', id, value: info.discarded });
});
chrome.tabs.onRemoved.addListener((id) => recording && events.push({ t: Date.now(), ev: 'removed', id }));

function waitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(on);
      clearTimeout(timer);
      resolve(v);
    };
    const on = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(on);
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && t.title && finish(true), () => finish(false));
  });
}

async function discardSafe(tabId) {
  try {
    const t = await chrome.tabs.discard(tabId);
    return t ? t.id : tabId;
  } catch {
    return tabId;
  }
}

/**
 * spec: { windows: [{ tabs: [{ url, pinned?, group?: {title,color}, keepLoaded? }] }] , concurrency }
 * The first tab of each window is its active tab (stays loaded). Others are created in the
 * background, waited until loaded (so title/favicon exist) and then discarded.
 */
async function build(spec) {
  const t0 = Date.now();
  const concurrency = spec.concurrency || 12;
  const [initial] = await chrome.tabs.query({});
  const out = { windows: [], loadTimeouts: 0 };
  for (let wi = 0; wi < spec.windows.length; wi++) {
    const ws = spec.windows[wi];
    let windowId;
    let firstId;
    if (wi === 0 && initial) {
      windowId = initial.windowId;
      firstId = initial.id;
      await chrome.tabs.update(firstId, { url: ws.tabs[0].url });
    } else {
      const w = await chrome.windows.create({ url: ws.tabs[0].url, focused: false });
      windowId = w.id;
      firstId = w.tabs[0].id;
    }
    if (!(await waitComplete(firstId, 15000))) out.loadTimeouts++;
    const created = new Array(ws.tabs.length);
    created[0] = firstId;
    // Create in order (keeps tab index == spec order), load + discard with a bounded pool.
    let next = 1;
    const inflight = new Set();
    const one = async (i) => {
      const ts = ws.tabs[i];
      const tab = await chrome.tabs.create({ windowId, url: ts.url, active: false, index: i });
      created[i] = tab.id;
      let ok = await waitComplete(tab.id, 20000);
      if (!ok) {
        out.loadTimeouts++;
        await chrome.tabs.reload(tab.id).catch(() => {});
        ok = await waitComplete(tab.id, 20000);
        if (!ok) out.loadFailures = (out.loadFailures || 0) + 1;
      }
      if (!ts.keepLoaded) created[i] = await discardSafe(tab.id);
    };
    while (next < ws.tabs.length || inflight.size) {
      while (next < ws.tabs.length && inflight.size < concurrency) {
        const p = one(next++).finally(() => inflight.delete(p));
        inflight.add(p);
        await sleep(2);
      }
      if (inflight.size) await Promise.race(inflight);
    }
    // groups
    const byGroup = new Map();
    ws.tabs.forEach((ts, i) => {
      if (ts.group) {
        const k = ts.group.title;
        if (!byGroup.has(k)) byGroup.set(k, { g: ts.group, ids: [] });
        byGroup.get(k).ids.push(created[i]);
      }
    });
    for (const { g, ids } of byGroup.values()) {
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: g.title, color: g.color });
    }
    // pinned last (pinning moves tabs to the front)
    for (let i = 0; i < ws.tabs.length; i++) if (ws.tabs[i].pinned) await chrome.tabs.update(created[i], { pinned: true });
    await chrome.tabs.update(firstId, { active: true });
    out.windows.push({ windowId, tabIds: created });
  }
  out.ms = Date.now() - t0;
  return out;
}

async function snapshot() {
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});
  const wins = await chrome.windows.getAll();
  return {
    tabs: tabs.map((t) => ({
      id: t.id, windowId: t.windowId, index: t.index, url: t.url || t.pendingUrl || '', title: t.title,
      pinned: t.pinned, active: t.active, audible: !!t.audible, discarded: t.discarded, status: t.status,
      groupId: t.groupId, lastAccessed: t.lastAccessed,
    })),
    groups: groups.map((g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color })),
    windows: wins.map((w) => ({ id: w.id, type: w.type })),
  };
}

globalThis.helper = {
  build,
  snapshot,
  startRecording() { events.length = 0; recording = true; return true; },
  stopRecording() { recording = false; return events.slice(); },
  async discardAll() {
    const tabs = await chrome.tabs.query({ active: false, discarded: false });
    let n = 0;
    for (const t of tabs) { if (t.audible) continue; await discardSafe(t.id); n++; }
    return n;
  },
  async closeWindow(windowId) { await chrome.windows.remove(windowId); return true; },
  async reload(tabId) { await chrome.tabs.reload(tabId); return true; },
  async removeTabs(ids) { await chrome.tabs.remove(ids); return true; },
  async createTab(url, windowId) { const t = await chrome.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) }); return t.id; },
  async setActive(tabId) { await chrome.tabs.update(tabId, { active: true }); return true; },
};
