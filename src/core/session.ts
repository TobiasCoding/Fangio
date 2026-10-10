// Browser-session identity. sessionId lives in chrome.storage.session, which is
// cleared on browser restart and on extension reload/update/disable, so a new
// sessionId means "tab ids from before may be invalid" and starts a grace period
// during which unmatched open records are not archived.

export interface SessionInfo {
  sessionId: string;
  /** Start of the current session (browser startup or extension load). */
  startupAt: number;
  /** True when this worker instance created the session (new browser run / extension reload / install). */
  isNew: boolean;
}

let cached: Promise<SessionInfo> | null = null;

export function getSession(): Promise<SessionInfo> {
  if (!cached) {
    cached = (async () => {
      const got = (await chrome.storage.session.get(['sessionId', 'startupAt'])) as {
        sessionId?: unknown;
        startupAt?: unknown;
      };
      if (typeof got.sessionId === 'string' && got.sessionId) {
        return {
          sessionId: got.sessionId,
          startupAt: typeof got.startupAt === 'number' ? got.startupAt : Date.now(),
          isNew: false,
        };
      }
      const info = { sessionId: crypto.randomUUID(), startupAt: Date.now() };
      await chrome.storage.session.set(info);
      return { ...info, isNew: true };
    })();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

export async function getSessionId(): Promise<string> {
  return (await getSession()).sessionId;
}

/** chrome.runtime.onStartup: restart the grace period. */
export async function markStartup(): Promise<SessionInfo> {
  const s = await getSession();
  const startupAt = Date.now();
  await chrome.storage.session.set({ startupAt });
  const next = { ...s, startupAt };
  cached = Promise.resolve(next);
  return next;
}

export function __resetSessionForTests(): void {
  cached = null;
}
