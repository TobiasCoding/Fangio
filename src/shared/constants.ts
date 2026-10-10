export const DB_NAME = 'fangio';
export const DB_VERSION = 1;

/** Object stores. */
export const STORE_RECORDS = 'records'; // keyPath id; indexes: state, url, domain, tags(multiEntry), updatedAt
export const STORE_ACTIONS = 'actions'; // keyPath id; index: at
export const STORE_OPS = 'ops'; // keyPath id; index: finished (stored as 0/1 in field finishedFlag)
export const STORE_KV = 'kv'; // keyPath key; { key: 'settings', value: Settings } etc.

export const MAX_FAVICON_URL_LENGTH = 2048;
export const MAX_PREVIOUS_URLS = 10;
export const MAX_TITLE_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 20000;

/** Records that left 'open' implicitly can be re-bound to a reappearing identical URL within this window. */
export const REBIND_WINDOW_MS = 30 * 60 * 1000;
/** After browser startup, unbound open records are not archived before this grace period (tabs still restoring). */
export const STARTUP_GRACE_MS = 3 * 60 * 1000;
/** Debounce for coalescing tab events into IndexedDB writes. */
export const EVENT_FLUSH_MS = 1000;
/** Tabs closed per chrome.tabs.remove call in bulk closes. */
export const CLOSE_BATCH_SIZE = 25;
/** Records saved per IndexedDB transaction in bulk writes. */
export const WRITE_BATCH_SIZE = 200;
/** Timeout waiting for a reopened tab to finish loading before moving on. */
export const REOPEN_LOAD_TIMEOUT_MS = 15000;

export const ALARM_AUTOMATION = 'fangio-automation';
export const ALARM_MAINTENANCE = 'fangio-maintenance'; // reconcile + purge trash + prune log + resume ops (every 15 min)
export const ALARM_UPDATE_CHECK = 'fangio-update-check'; // daily
export const ALARM_STARTUP_SWEEP = 'fangio-startup-sweep'; // one-shot after STARTUP_GRACE_MS

export const GITHUB_REPO = 'TobiasCoding/Fangio';
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;
