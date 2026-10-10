// Read-only inspection of Fangio's state (evaluated inside Fangio's service worker)
// and the global invariants asserted after every scenario.
import { FANGIO_ID, sleep } from './browser.mjs';

export const TRACKABLE = /^(https?|file|ftp):/i;

/**
 * Snapshot of tabs + Fangio's IndexedDB (never creates the DB if it does not exist).
 * target: a launched browser (evaluates in Fangio's service worker) or a Fangio PageDriver
 * (used when the service worker cannot start, e.g. right after a hard kill).
 */
export function readState(target, { actions = true } = {}) {
  const ev = typeof target.eval === 'function' ? target : target.ext(FANGIO_ID);
  return ev.eval(async (withActions) => {
    const tabs = (await chrome.tabs.query({})).map((t) => ({
      id: t.id, windowId: t.windowId, index: t.index, url: t.url || t.pendingUrl || '', title: t.title,
      pinned: t.pinned, active: t.active, audible: !!t.audible, discarded: t.discarded, status: t.status, groupId: t.groupId,
    }));
    const sess = await chrome.storage.session.get(['sessionId', 'startupAt']);
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'fangio')) return { noDb: true, tabs, sess, records: [], ops: [], actions: [] };
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fangio');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (store) =>
      new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const [recs, ops, acts, kv] = await Promise.all([all('records'), all('ops'), withActions ? all('actions') : [], all('kv')]);
    db.close();
    const settings = kv.find((x) => x.key === 'settings')?.value;
    return {
      tabs,
      sess,
      settings,
      records: recs.map((r) => ({
        id: r.id, url: r.url, title: r.title, state: r.state, source: r.source, protected: r.protected, origin: r.origin,
        live: r.live, pendingClose: r.pendingClose ? { opId: r.pendingClose.opId, tabId: r.pendingClose.tabId } : null,
        lastReason: r.lastReason, implicitCloseAt: r.implicitCloseAt, createdAt: r.createdAt, archivedAt: r.archivedAt,
        trashedAt: r.trashedAt, mergedFrom: r.mergedFrom, rev: r.rev, reopenCount: r.reopenCount, favIconUrl: r.favIconUrl,
      })),
      ops: ops.map((o) => ({ id: o.id, kind: o.kind, finished: o.finished, createdAt: o.createdAt, items: o.items.map((i) => i.status) })),
      actions: acts.map((a) => ({ id: a.id, at: a.at, kind: a.kind, auto: a.auto, reason: a.reason, ruleId: a.ruleId, n: a.recordIds.length,
        recordIds: a.recordIds, undoable: a.undoable, undoneAt: a.undoneAt, skipped: a.skipped?.length ?? 0, failed: a.failed?.length ?? 0 })),
    };
  }, actions, 300000);
}

/** Cheap fingerprint used to wait until Fangio stops writing. */
function fingerprint(b) {
  return b.ext(FANGIO_ID).eval(async () => {
    const dbs = await indexedDB.databases();
    const tabs = await chrome.tabs.query({});
    if (!dbs.some((d) => d.name === 'fangio')) return `nodb|${tabs.length}`;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fangio');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const recs = await new Promise((res) => {
      const r = db.transaction('records').objectStore('records').getAll();
      r.onsuccess = () => res(r.result);
    });
    db.close();
    let rev = 0;
    let open = 0;
    let pend = 0;
    for (const r of recs) {
      rev += r.rev;
      if (r.state === 'open') open++;
      if (r.pendingClose) pend++;
    }
    return `${recs.length}|${rev}|${open}|${pend}|${tabs.length}`;
  });
}

/** Waits until two consecutive fingerprints (interval apart) are equal. Returns elapsed ms. */
export async function waitSettled(b, { interval = 1500, timeout = 180000 } = {}) {
  const t0 = Date.now();
  let prev = await fingerprint(b);
  for (;;) {
    await sleep(interval);
    const cur = await fingerprint(b);
    if (cur === prev) return Date.now() - t0;
    prev = cur;
    if (Date.now() - t0 > timeout) throw new Error(`Fangio did not settle within ${timeout} ms (${cur})`);
  }
}

/**
 * Global invariants.
 *  original: [{url}] trackable tabs that existed before Fangio was installed.
 *  testCreated: URLs of tabs the test itself created afterwards (allowed extra records).
 */
export function checkInvariants(original, st, { testCreated = [], allowDeferredPending = false } = {}) {
  const problems = [];
  const warnings = [];
  const sid = st.sess?.sessionId;
  const openTabs = st.tabs.filter((t) => TRACKABLE.test(t.url));
  const tabUrls = new Set(openTabs.map((t) => t.url));
  const recUrls = new Map();
  for (const r of st.records) recUrls.set(r.url, (recUrls.get(r.url) ?? 0) + 1);

  // 1. no reference lost
  const lost = original.filter((o) => !tabUrls.has(o.url) && !recUrls.has(o.url));
  if (lost.length) problems.push(`${lost.length} original URLs have neither an open tab nor a record: ${lost.slice(0, 5).map((x) => x.url).join(', ')}`);

  // 2. no record inflation (global and per URL)
  const limit = original.length + testCreated.length;
  if (st.records.length > limit) problems.push(`records ${st.records.length} > original tabs ${original.length} + test-created ${testCreated.length}`);
  const allowed = new Map();
  for (const o of [...original, ...testCreated.map((url) => ({ url }))]) allowed.set(o.url, (allowed.get(o.url) ?? 0) + 1);
  const inflated = [...recUrls].filter(([u, n]) => n > (allowed.get(u) ?? 0));
  if (inflated.length) problems.push(`${inflated.length} URLs have more records than tab instances ever existed: ${inflated.slice(0, 5).map(([u, n]) => `${u}×${n}`).join(', ')}`);

  // 3. every open trackable tab has exactly one bound record
  const boundBy = new Map();
  for (const r of st.records) {
    if (r.state === 'open' && r.live && r.live.sessionId === sid) {
      boundBy.set(r.live.tabId, [...(boundBy.get(r.live.tabId) ?? []), r.id]);
    }
  }
  // During the startup grace Fangio deliberately leaves tabs whose URL belongs to an unresolved
  // interrupted close (pendingClose of a deferred op) unbound, to avoid duplicates.
  const pendingUrls = new Set(st.records.filter((r) => r.pendingClose).map((r) => r.url));
  const deferredTabs = allowDeferredPending ? openTabs.filter((t) => !boundBy.has(t.id) && pendingUrls.has(t.url)) : [];
  if (deferredTabs.length) warnings.push(`${deferredTabs.length} open tabs left unbound on purpose (URL owned by a deferred interrupted close)`);
  const unbound = openTabs.filter((t) => !boundBy.has(t.id) && !deferredTabs.includes(t));
  const multi = openTabs.filter((t) => (boundBy.get(t.id) ?? []).length > 1);
  if (unbound.length) problems.push(`${unbound.length} open tabs without a bound record: ${unbound.slice(0, 5).map((t) => t.url).join(', ')}`);
  if (multi.length) problems.push(`${multi.length} tabs bound to more than one record`);
  const tabIds = new Set(st.tabs.map((t) => t.id));
  const stale = st.records.filter((r) => r.state === 'open' && r.live?.sessionId === sid && !tabIds.has(r.live.tabId));
  if (stale.length) warnings.push(`${stale.length} open records bound to a tab that no longer exists`);
  const pend = st.records.filter((r) => r.pendingClose);
  if (pend.length) warnings.push(`${pend.length} records still carry pendingClose`);
  const unboundOpen = st.records.filter((r) => r.state === 'open' && !(r.live && r.live.sessionId === sid));
  if (unboundOpen.length) warnings.push(`${unboundOpen.length} open records not bound in this session (deferred by startup grace?)`);

  const by = (k) => st.records.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: {
      originalTabs: original.length,
      openTrackableTabs: openTabs.length,
      allTabs: st.tabs.length,
      records: st.records.length,
      byState: by('state'),
      bySource: by('source'),
      lost: lost.length,
      unbound: unbound.length,
      deferredTabs: deferredTabs.length,
      pendingClose: pend.length,
      inflatedUrls: inflated.length,
    },
  };
}
