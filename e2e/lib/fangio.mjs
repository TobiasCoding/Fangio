// Fangio-specific helpers shared by scenarios: install, dashboard, messages, waits.
import { FANGIO_ID, helperId, launchBrowser, loadUnpacked, sleep, waitFor } from './browser.mjs';
import { readState, TRACKABLE } from './checks.mjs';
import { processTree } from './mem.mjs';

export const FANGIO = FANGIO_ID;
export const DASH = `chrome-extension://${FANGIO_ID}/dashboard.html`;

/** Sends a Request to Fangio's background from a Fangio page (same path the UI uses). */
export async function sendMsg(page, msg, timeoutMs = 600000) {
  const env = await page.eval((m) => chrome.runtime.sendMessage(m), msg, timeoutMs);
  if (!env || !env.ok) throw new Error(`Fangio ${msg.type} failed: ${env?.error ?? 'no response'}`);
  return env.data;
}

/** Fire-and-forget message (used before a hard kill). */
export function sendNoWait(page, msg) {
  return page.eval((m) => {
    void chrome.runtime.sendMessage(m).catch(() => {});
    return true;
  }, msg);
}

export async function openDashboard(b, hash = '#/lista') {
  const page = await b.openPage(`${DASH}${hash}`);
  await page.front();
  await page.waitFor(() => document.readyState === 'complete' && !!document.querySelector('.topbar'), undefined, {
    timeout: 60000,
    label: 'dashboard topbar',
  });
  return page;
}

/** Launches a copy of the template (helper only, or helper + Fangio via --load-extension) and waits for the restored tabs. */
export async function launchProfile(ctx, profileDir, { withFangio = false, restore = true, expectTabs } = {}) {
  const loadExtensions = [ctx.helperPath, ...(withFangio ? [ctx.dist] : [])];
  const b = await launchBrowser({ profileDir, loadExtensions, restore, headless: ctx.headless });
  const helper = b.ext(await helperId(b));
  if (expectTabs) {
    await waitFor(async () => (await helper.eval(async () => (await chrome.tabs.query({})).length)) >= expectTabs, {
      timeout: 120000,
      interval: 500,
      label: `${expectTabs} restored tabs`,
    });
  }
  return { b, helper };
}

/**
 * Makes the audio tab play. Session restore leaves it unloaded and Chrome defers media in
 * never-shown background tabs, so it is shown briefly and the previous active tab restored.
 */
export async function wakeAudio(helper) {
  const info = await helper.eval(async () => {
    const tabs = await chrome.tabs.query({});
    const a = tabs.find((t) => (t.url || '').endsWith('/audio'));
    if (!a) return null;
    const prev = tabs.find((t) => t.windowId === a.windowId && t.active);
    return { id: a.id, prev: prev?.id };
  });
  if (!info) return false;
  await helper.eval((tabId) => chrome.tabs.update(tabId, { active: true }), info.id);
  let ok = true;
  try {
    await waitFor(async () => helper.eval(async (tabId) => (await chrome.tabs.get(tabId)).audible, info.id), { timeout: 15000, interval: 300, label: 'audible' });
  } catch {
    ok = false;
  }
  if (info.prev && info.prev !== info.id) await helper.eval((tabId) => chrome.tabs.update(tabId, { active: true }), info.prev);
  return ok;
}

export async function trackableTabs(helper) {
  const snap = await helper.eval(() => helper.snapshot());
  return { snap, tabs: snap.tabs.filter((t) => TRACKABLE.test(t.url)) };
}

/**
 * Installs Fangio into the RUNNING browser (CDP Extensions.loadUnpacked) and measures
 * the install snapshot until every trackable tab has an 'open' record.
 */
export async function installAndSnapshot(ctx, b, expected) {
  const t0 = Date.now();
  const id = await loadUnpacked(b, ctx.dist);
  const loadMs = Date.now() - t0;
  let polls = 0;
  const st = await waitFor(
    async () => {
      polls++;
      const s = await readState(b, { actions: false });
      const bound = s.records.filter((r) => r.state === 'open' && r.live).length;
      return bound >= expected ? s : null;
    },
    { timeout: 300000, interval: 100, label: `install snapshot of ${expected} tabs` },
  );
  return { id, loadMs, snapshotMs: Date.now() - t0, polls, state: st };
}

export function mem(b, label, ctx) {
  const m = processTree(b.pid);
  const entry = { label, at: new Date().toISOString(), ...m.summary };
  ctx.memory.push(entry);
  ctx.log(`  memory [${label}]: ${m.summary.processes} procs, WS ${m.summary.workingSetMB} MB, private ${m.summary.privateMB} MB`);
  return { ...entry, procs: m.procs };
}

export const extensionPids = (m) => new Set(m.procs.filter((p) => p.type === 'extension').map((p) => p.pid));

/** Parses Spanish formatted integers ("10.000" -> 10000). */
export const num = (s) => Number((String(s).match(/[\d.]+/)?.[0] ?? 'NaN').replace(/\./g, ''));

export { sleep, waitFor };

/** Collects named assertions for a scenario result. */
export function checker() {
  const checks = [];
  const c = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) } : {}) });
    return !!ok;
  };
  c.list = checks;
  c.invariants = (label, inv) => {
    c(`invariants after ${label}`, inv.ok, inv.ok ? JSON.stringify(inv.stats) : inv.problems.join(' | '));
    return inv;
  };
  return c;
}
