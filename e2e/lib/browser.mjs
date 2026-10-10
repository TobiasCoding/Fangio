// Launches Playwright's Chromium build as a plain child process (so we own the PID and
// can hard-kill the whole tree) and drives it through a raw CDP connection (see cdp.mjs).
// Never touches the user's real browser: every launch uses an explicit --user-data-dir.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CDP, evaluate } from './cdp.mjs';
import { PageDriver } from './page.mjs';

export const FANGIO_ID = 'domaedkeecbijcmbcjcfpjeabbdcmefb';
const liveBrowsers = new Set();
/** Hard-kills every browser launched by this process (harness cleanup). */
export function killAll() {
  for (const b of liveBrowsers) b.kill();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chromiumPath() {
  return chromium.executablePath();
}

export function freshProfile(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function waitFor(fn, { timeout = 30000, interval = 200, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeout) throw new Error(`Timeout waiting for ${label} (${timeout} ms). Last: ${String(last?.message ?? last)}`);
    await sleep(interval);
  }
}

/** Handle to an extension service worker; (re)attaches lazily. */
class ExtHandle {
  constructor(b, extId) {
    this.b = b;
    this.extId = extId;
    this.sessionId = null;
    this.targetId = null;
  }
  async findTarget() {
    const { targetInfos } = await this.b.cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${this.extId}/`));
  }
  async attach(timeout = 30000) {
    const t = await waitFor(() => this.findTarget(), { timeout, interval: 100, label: `service worker of ${this.extId}` });
    const { sessionId } = await this.b.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = t.targetId;
    return sessionId;
  }
  async eval(fn, arg, timeoutMs) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.sessionId) await this.attach();
        return await evaluate(this.b.cdp, this.sessionId, fn, arg, timeoutMs);
      } catch (e) {
        const msg = String(e?.message);
        // Worker script still starting: globals not defined yet.
        if (/ReferenceError/.test(msg) && attempt < 40) {
          await sleep(250);
          continue;
        }
        if (attempt >= 4 || !/session|Target|closed|destroyed|context|No target|not found/i.test(msg) || /Evaluation failed/.test(msg)) throw e;
        this.sessionId = null;
        await sleep(300);
      }
    }
  }
}

/**
 * opts: { profileDir, headless=true, loadExtensions=[], restore=false, startUrl='about:blank', extraArgs=[], audioArgs }
 */
export async function launchBrowser(opts) {
  const { profileDir, headless = true, loadExtensions = [], restore = false, startUrl = 'about:blank', extraArgs = [] } = opts;
  const portFile = join(profileDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-search-engine-choice-screen',
    '--disable-features=DisableLoadExtensionCommandLineSwitch,Translate,MediaRouter,OptimizationHints',
    '--autoplay-policy=no-user-gesture-required',
    // Fake audio sink: tabs still report audible=true, nothing is played on the speakers.
    ...(opts.audioArgs ?? ['--disable-audio-output']),
    '--hide-crash-restore-bubble',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new'] : ['--window-position=-2600,40']),
    ...(loadExtensions.length ? [`--load-extension=${loadExtensions.join(',')}`] : []),
    ...(restore ? ['--restore-last-session'] : []),
    ...extraArgs,
    ...(restore ? [] : [startUrl]),
  ];
  const t0 = Date.now();
  const proc = spawn(chromiumPath(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 200000) stderr = stderr.slice(-100000);
  });
  let exited = false;
  proc.on('exit', () => {
    exited = true;
    liveBrowsers.delete(b);
  });
  let b;
  const wsUrl = await waitFor(
    () => {
      if (exited) throw new Error(`Chromium exited early:\n${stderr.slice(-2000)}`);
      if (!existsSync(portFile)) return null;
      const [p, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      return p && path ? `ws://127.0.0.1:${p}${path}` : null;
    },
    { timeout: 60000, interval: 100, label: 'DevToolsActivePort' },
  );
  const cdp = await CDP.connect(wsUrl);
  const exts = new Map();
  b = {
    proc,
    pid: proc.pid,
    cdp,
    profileDir,
    launchMs: Date.now() - t0,
    get exited() { return exited; },
    stderr: () => stderr,
    ext(extId) {
      if (!exts.has(extId)) exts.set(extId, new ExtHandle(b, extId));
      return exts.get(extId);
    },
    async targets() {
      return (await cdp.send('Target.getTargets')).targetInfos;
    },
    async version() {
      return (await cdp.send('Browser.getVersion')).product;
    },
    /** Opens a new tab (in the last focused window) and returns a PageDriver attached to it. */
    async openPage(url, { newWindow = false } = {}) {
      const { targetId } = await cdp.send('Target.createTarget', { url, newWindow, background: false });
      return PageDriver.attach(b, targetId);
    },
    async attachPage(pred, timeout = 30000) {
      const t = await waitFor(async () => (await b.targets()).find((x) => x.type === 'page' && pred(x.url)), { timeout, label: 'page target' });
      return PageDriver.attach(b, t.targetId);
    },
    /** Graceful: Browser.close over CDP (session is saved like a normal exit). */
    async close(timeout = 90000) {
      if (exited) return;
      try { await cdp.send('Browser.close', {}, undefined, 10000); } catch { /* connection drops while closing */ }
      await waitFor(() => exited, { timeout, label: 'browser exit' });
      cdp.close();
    },
    /** Hard kill of the whole process tree (like a crash / power cut). */
    kill() {
      if (exited) return;
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' }); }
      catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
      cdp.close();
    },
    async waitExit(timeout = 30000) { await waitFor(() => exited, { timeout, label: 'browser exit' }); },
  };
  if (!exited) liveBrowsers.add(b);
  return b;
}

/** CDP Extensions.loadUnpacked into the running browser. Returns the extension id. */
export async function loadUnpacked(b, path) {
  const r = await b.cdp.send('Extensions.loadUnpacked', { path });
  return r.id;
}

/** Finds the helper extension id (the one whose SW url ends with /bg.js). */
export async function helperId(b, timeout = 30000) {
  const t = await waitFor(async () => (await b.targets()).find((x) => x.type === 'service_worker' && x.url.endsWith('/bg.js')), {
    timeout,
    label: 'helper service worker',
  });
  return new URL(t.url).host;
}
