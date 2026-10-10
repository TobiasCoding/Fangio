// Drives one page (e.g. the Fangio dashboard) through raw CDP with REAL input events
// (Input.dispatchMouseEvent / dispatchKeyEvent / insertText), not synthetic DOM events.
import { evaluate } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = {
  ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Space: 32,
  End: 35, Home: 36, PageDown: 34, PageUp: 33, Tab: 9, Backspace: 8,
};
const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export class PageDriver {
  static async attach(b, targetId) {
    const { sessionId } = await b.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new PageDriver(b, targetId, sessionId);
    await b.cdp.send('Page.enable', {}, sessionId);
    await b.cdp.send('Runtime.enable', {}, sessionId);
    await b.cdp.send('Performance.enable', {}, sessionId).catch(() => {});
    return p;
  }
  constructor(b, targetId, sessionId) {
    this.b = b;
    this.cdp = b.cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
  eval(fn, arg, timeoutMs) {
    return evaluate(this.cdp, this.sessionId, fn, arg, timeoutMs);
  }
  async front() {
    await this.send('Page.bringToFront').catch(() => {});
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(100);
    await this.waitFor(() => document.readyState === 'complete', undefined, { label: `load ${url}` });
  }
  async reload() {
    await this.send('Page.reload', { ignoreCache: true });
    await sleep(200);
    await this.waitFor(() => document.readyState === 'complete', undefined, { label: 'reload' });
  }
  /** Polls fn(arg) in the page until truthy; returns the value. */
  async waitFor(fn, arg, { timeout = 30000, interval = 50, label = 'page condition' } = {}) {
    const t0 = Date.now();
    let last;
    for (;;) {
      try {
        last = await this.eval(fn, arg);
        if (last) return last;
      } catch (e) {
        last = e;
      }
      if (Date.now() - t0 > timeout) throw new Error(`Timeout (${timeout} ms) waiting for ${label}. Last: ${String(last?.message ?? last)}`);
      await sleep(interval);
    }
  }
  /** Center of the n-th element matching selector (optionally containing text), scrolled into view. */
  async locate(selector, { text, index = 0, exact = false } = {}) {
    return this.eval(
      ({ selector, text, index, exact }) => {
        let els = [...document.querySelectorAll(selector)];
        if (text !== undefined) els = els.filter((e) => (exact ? e.textContent.trim() === text : e.textContent.includes(text)));
        const el = els[index];
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: !!el.disabled };
      },
      { selector, text, index, exact },
    );
  }
  async locateWait(selector, opts = {}) {
    const t0 = Date.now();
    for (;;) {
      const loc = await this.locate(selector, opts);
      if (loc && loc.w > 0 && loc.h > 0) return loc;
      if (Date.now() - t0 > (opts.timeout ?? 15000)) throw new Error(`Element not found: ${selector} ${opts.text ?? ''}`);
      await sleep(50);
    }
  }
  async click(selector, opts = {}) {
    const loc = await this.locateWait(selector, opts);
    if (loc.disabled && !opts.allowDisabled) throw new Error(`Element is disabled: ${selector} ${opts.text ?? ''}`);
    await this.mouseClick(loc.x, loc.y, opts.modifiers);
    return loc;
  }
  async mouseClick(x, y, modifiers = []) {
    const m = modifiers.reduce((a, k) => a | MOD[k], 0);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: m });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: m });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: m });
  }
  async wheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }
  async type(text) {
    await this.send('Input.insertText', { text });
  }
  /** key: ArrowDown, Enter, Escape, Space, End... */
  async press(key, modifiers = []) {
    const m = modifiers.reduce((a, k) => a | MOD[k], 0);
    const code = KEYS[key];
    const domKey = key === 'Space' ? ' ' : key;
    const base = { key: domKey, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: m };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Space' || key === 'Enter') await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key === 'Enter' ? '\r' : ' ' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async setFiles(selector, files) {
    const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!r.result?.objectId) throw new Error(`No element for ${selector}`);
    await this.send('DOM.setFileInputFiles', { files, objectId: r.result.objectId });
  }
  text() {
    return this.eval(() => document.body.innerText);
  }
  async jsHeap() {
    const { metrics } = await this.send('Performance.getMetrics');
    const get = (n) => metrics.find((x) => x.name === n)?.value;
    return { usedJSHeap: get('JSHeapUsedSize'), totalJSHeap: get('JSHeapTotalSize'), nodes: get('Nodes') };
  }
  async close() {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
