// Minimal Chrome DevTools Protocol client over the browser websocket (flattened
// sessions). Unlike Playwright's connectOverCDP it does NOT auto-attach to every
// tab, which matters with ~800 tabs open.

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) {
          try { l(msg); } catch { /* ignore */ }
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: CDP connection closed`));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`CDP connect failed: ${e.message ?? e}`)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId, timeoutMs = 120000) {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP connection closed`));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Subscribe to events: fn(msg) with msg.method, msg.params, msg.sessionId. Returns unsubscribe. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitEvent(pred, timeoutMs = 30000, label = 'CDP event') {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => {
        if (pred(m)) {
          off();
          clearTimeout(t);
          resolve(m);
        }
      });
      const t = setTimeout(() => {
        off();
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** Serializes fn + arg into an expression evaluated with awaitPromise/returnByValue. */
export function callExpr(fn, arg) {
  return `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
}

export async function evaluate(cdp, sessionId, fn, arg, timeoutMs = 300000) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression: callExpr(fn, arg), awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
    timeoutMs,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`Evaluation failed: ${d.exception?.description ?? d.text}`);
  }
  return r.result?.value;
}
