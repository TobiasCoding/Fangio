// Shared data contract for Fangio. Every module (background, UI, tests) imports
// these types; changing them requires a DB schema migration (see core/db.ts) and
// an export-format version bump (see core/backup.ts).

/** Lifecycle state of a reference. Protection, tags and projects are independent attributes. */
export type RecordState = 'open' | 'archived' | 'trash';

/** How a record entered the database. */
export type RecordSource =
  | 'install-snapshot' // tab that already existed when the extension was installed (chronology unknown)
  | 'tracked' // tab first seen after install (opened, restored or navigated to a trackable URL)
  | 'json-import' // restored from a JSON backup
  | 'manual'; // created explicitly by the user (reserved)

/**
 * Ephemeral link between a record and a browser tab. Browser tab ids are NOT
 * persistent identifiers: they are only meaningful inside `sessionId` (one
 * browser run / one extension load). The record id is the stable identity.
 */
export interface LiveBinding {
  tabId: number;
  windowId: number;
  /** Value of chrome.storage.session `sessionId` when the binding was made. */
  sessionId: string;
  boundAt: number;
}

/**
 * Written BEFORE a tab is closed (phase 1 of the close pipeline). If the
 * service worker dies between "saved" and "closed", reconciliation uses this
 * marker to finish or abort the operation without losing or duplicating data.
 */
export interface PendingClose {
  opId: string;
  tabId: number;
  sessionId: string;
  /** Exact URL that was saved; the tab is only closed if it still shows this URL. */
  expectedUrl: string;
  /** State the record must reach once the tab is closed. */
  targetState: 'archived' | 'trash';
  reason: string;
  at: number;
}

/** Where the tab lived when it was captured. Window ids are ephemeral; ordinal is informative. */
export interface TabOrigin {
  /** 1-based ordinal of the window among normal windows at capture time (informative). */
  windowOrdinal?: number;
  /** Tab index inside its window at capture time. */
  index?: number;
  groupTitle?: string;
  /** chrome.tabGroups.Color value ('grey' | 'blue' | ...). */
  groupColor?: string;
}

export interface TabRecord {
  /** Stable identifier (crypto.randomUUID()). Never derived from browser tab ids. */
  id: string;
  /** Exact URL as reported by the browser. Never normalized, never stripped of params/fragments. */
  url: string;
  title: string;
  /** Only http(s) favicon URLs up to MAX_FAVICON_URL_LENGTH chars; data: URIs are dropped. */
  favIconUrl?: string;
  /** Lowercased hostname without a leading "www." (derived from url, used for filters). */
  domain: string;

  state: RecordState;
  protected: boolean;
  /** "Pendiente" marker (starred to-do). */
  pending: boolean;
  /** Normalized tags (trimmed, lowercased, unique, sorted). */
  tags: string[];
  /** Optional project name (free text, trimmed). Empty string = none. */
  project: string;
  /** Optional note: why this was saved. */
  note: string;

  source: RecordSource;
  // ---- dates (epoch ms). Undefined = unknown. ----
  /** When the record was created in the DB. */
  createdAt: number;
  /** Only for install-snapshot / json-import: when it was imported. */
  importedAt?: number;
  /** When the tab was opened. Only known for tabs created after install. */
  openedAt?: number;
  /** Last time the user viewed the tab (max of tab.lastAccessed and our onActivated tracking). */
  lastAccessedAt?: number;
  /** Last time the tab was audible. */
  lastAudibleAt?: number;
  archivedAt?: number;
  trashedAt?: number;
  /** Last time the record went back to 'open' via reopen/restore. */
  reopenedAt?: number;
  updatedAt: number;

  origin: TabOrigin;
  /** Previous URLs of this record when the bound tab navigated away (most recent first, capped). */
  previousUrls: string[];
  reopenCount: number;
  /** Ids of records merged into this one (duplicates merge). */
  mergedFrom: string[];
  /** Record of the tab this one was opened from (link followed / opener tab), when known. Context signal. */
  openerId?: string;

  /** Present while the record is linked to a tab. Stale if sessionId differs from the current one. */
  live: LiveBinding | null;
  /** Present only between phase 1 (saved) and phase 4 (result registered) of a close. */
  pendingClose: PendingClose | null;
  /**
   * Set when the record left 'open' implicitly (user closed the tab, window closed,
   * tab not found). Allows re-binding if the same URL reappears shortly after
   * (Ctrl+Shift+T, window restore) instead of creating a duplicate.
   */
  implicitCloseAt?: number;
  /** Human-readable reason of the last state change (shown in the UI, Spanish). */
  lastReason?: string;
  /** Monotonic revision, incremented on every write. */
  rev: number;
}

// ---------------------------------------------------------------- settings

export type UrlRuleAction = 'trash' | 'archive';

/**
 * Exact-URL cleanup rule. `url` is compared against the tab URL after
 * canonical parsing only (new URL(x).href: lowercases scheme/host, adds a
 * slash to an empty path). Paths, query strings and fragments are NOT
 * stripped, so https://chatgpt.com/ does not match https://chatgpt.com/c/123,
 * nor https://chatgpt.com/?model=x, nor https://chatgpt.com/#x.
 */
export interface UrlRule {
  id: string;
  enabled: boolean;
  url: string;
  action: UrlRuleAction;
  /** Minimum minutes without being viewed before the rule applies. */
  afterMinutes: number;
  label?: string;
}

export interface Settings {
  schemaVersion: 1;
  /** Master switch for automatic actions (alarms). Off until the user enables it after the first import. */
  automationEnabled: boolean;
  /** Orientative target of open tabs. Protections and activity take precedence. */
  targetOpenTabs: number;
  /** Archive tabs not viewed for this many hours, regardless of target. 0 = disabled. */
  idleArchiveHours: number;
  /** A tab viewed within this many minutes is never auto-archived to meet the target. */
  targetMinIdleMinutes: number;
  /** A tab audible within this many minutes is never auto-closed. */
  audioGraceMinutes: number;
  /** Period of the automation alarm in minutes (>= 1). */
  checkIntervalMinutes: number;
  /** Safety cap: maximum tabs closed by a single automatic run. */
  maxAutoClosePerRun: number;
  /** Host patterns never auto-closed: docs.google.com (exact host or any subdomain), *.zoom.us (subdomains + apex). */
  siteExclusions: string[];
  urlRules: UrlRule[];
  /** Records in trash older than this are permanently deleted by the purge alarm. 0 = never auto-purge. */
  trashRetentionDays: number;
  /** Max concurrent tab creations when reopening several records. */
  reopenConcurrency: number;
  /** When reopening more than reopenConcurrency tabs, discard (unload) background ones after they load. */
  discardAfterBulkReopen: boolean;
  /** When reopening, put the tab back into a group with the original title/color (in the target window). */
  restoreGroups: boolean;
  /**
   * Rule: archived records with the identical URL and no data of their own (note, tags, project,
   * pending, protected) are merged so only one remains; the redundant ones go to the trash.
   */
  dedupeArchived: boolean;
  /** Daily check of GitHub releases (no user data is sent). */
  updateCheck: boolean;
  /** Action log entries older than this are pruned. */
  logRetentionDays: number;
  /**
   * Save a small screenshot of each page while you look at it (cards view). Off by default;
   * automatic capture also needs the optional "<all_urls>" host permission granted by the user.
   */
  thumbnails: boolean;
  /** Host patterns never captured as thumbnails (on top of siteExclusions and sensitive URLs). */
  thumbnailExclusions: string[];
  /** Epoch ms of the last JSON/HTML export made by the user (reminder in the UI). */
  lastBackupAt?: number;
  /** Set once the initial import wizard was completed (or skipped). */
  onboardingDone: boolean;
}

// ---------------------------------------------------------------- action log

export type ActionKind =
  | 'install-snapshot'
  | 'archive'
  | 'trash'
  | 'reopen'
  | 'restore' // trash -> archived
  | 'purge' // permanent deletion
  | 'update' // protect / pending / tags / note / project / title
  | 'merge'
  | 'user-closed' // user closed tabs -> trash
  | 'window-closed' // tabs missing after their window closed / not restored -> archived
  | 'rebind' // implicitly closed record came back (Ctrl+Shift+T, restore)
  | 'import-json'
  | 'settings'
  | 'undo';

/** Snapshot of the fields a record had before an action, used by undo. */
export type RecordPatch = Partial<
  Pick<
    TabRecord,
    'state' | 'protected' | 'pending' | 'tags' | 'project' | 'note' | 'title' | 'archivedAt' | 'trashedAt' | 'lastReason'
    // Added (backward compatible) so undo can restore merges and implicit closes:
    | 'implicitCloseAt' | 'mergedFrom' | 'createdAt' | 'openedAt' | 'lastAccessedAt'
  >
>;

export interface ActionEntry {
  id: string;
  at: number;
  kind: ActionKind;
  /** True when triggered by automation (alarm / rule), false when triggered by the user. */
  auto: boolean;
  /** Explanation shown to the user, in Spanish. E.g. Sin consultar hace 26 h (regla: inactividad mayor a 24 h). */
  reason: string;
  ruleId?: string;
  recordIds: string[];
  /** Per-record state before the action (only what undo needs). */
  before?: Record<string, RecordPatch>;
  undoable: boolean;
  undoneAt?: number;
  /** For kind undo: the action that was undone. */
  undoOf?: string;
  /** Items skipped with their reason (protected, changed URL, ...). */
  skipped?: { recordId?: string; tabId?: number; reason: string }[];
  failed?: { recordId?: string; tabId?: number; error: string }[];
}

// ---------------------------------------------------------------- operation journal

export type OpKind = 'close' | 'reopen';

export type OpItemStatus = 'pending' | 'saved' | 'creating' | 'done' | 'skipped' | 'failed';

export interface OpItem {
  recordId: string;
  tabId?: number;
  status: OpItemStatus;
  error?: string;
}

/** Persisted journal of a multi-step operation, so it can be resumed or rolled back after an interruption. */
export interface OpJournal {
  id: string;
  kind: OpKind;
  createdAt: number;
  updatedAt: number;
  auto: boolean;
  reason: string;
  ruleId?: string;
  /** For close: state to reach. */
  targetState?: 'archived' | 'trash';
  /** For reopen: window to open in (ephemeral; ignored after browser restart). */
  windowId?: number;
  /** Session in which the op started (added, optional: older journals lack it). */
  sessionId?: string;
  items: OpItem[];
  finished: boolean;
  /** Action log entry written when finished. */
  actionId?: string;
}

// ---------------------------------------------------------------- rules / preview

export type DecisionAction = 'archive' | 'trash' | 'keep';

/** Why a tab cannot be auto-closed. */
export type BlockReason =
  | 'protected'
  | 'pinned'
  | 'active'
  | 'highlighted'
  | 'audible'
  | 'recent-audio'
  | 'site-excluded'
  | 'incognito'
  | 'extension-page'
  | 'untrackable-url'
  | 'recently-viewed'
  | 'pending-operation';

export interface RuleDecision {
  recordId: string;
  tabId: number;
  url: string;
  title: string;
  action: DecisionAction;
  /** Spanish explanation of the decision. */
  reason: string;
  /** 'idle' | 'target' | a UrlRule id */
  ruleId?: string;
  /** Present when action is keep because of protections. */
  blockedBy?: BlockReason[];
  idleMinutes: number;
}

export interface RulePreview {
  at: number;
  openCount: number;
  target: number;
  /** Open count after applying the decisions. */
  projectedOpenCount: number;
  decisions: RuleDecision[];
  /** True if the per-run safety cap truncated the list. */
  capped: boolean;
}

// ---------------------------------------------------------------- import wizard

export interface ImportCandidate {
  recordId: string;
  tabId: number;
  windowOrdinal: number;
  index: number;
  url: string;
  title: string;
  favIconUrl?: string;
  domain: string;
  pinned: boolean;
  active: boolean;
  audible: boolean;
  discarded: boolean;
  protected: boolean;
  groupTitle?: string;
  lastAccessedAt?: number;
  /** Number of open tabs with the identical URL (1 = unique). */
  duplicateCount: number;
  /** Suggested action: archive, trash (matched URL rule) or keep (blocked). */
  suggested: DecisionAction;
  blockedBy: BlockReason[];
  reason: string;
}

// ---------------------------------------------------------------- export format

export const EXPORT_FORMAT = 'fangio-export';
export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportFileV1 {
  format: typeof EXPORT_FORMAT;
  schemaVersion: 1;
  exportedAt: number;
  appVersion: string;
  /** Records without ephemeral fields (live/pendingClose are always null in exports). */
  records: TabRecord[];
  settings: Settings;
  /** Optional, last entries of the action log. */
  actions?: ActionEntry[];
}

export interface ImportJsonResult {
  added: number;
  updated: number;
  unchanged: number;
  rejected: { index: number; error: string }[];
}

// ---------------------------------------------------------------- status

/** Downscaled screenshot of a page (store "thumbs", key = record id). Never exported in backups. */
export interface ThumbEntry {
  id: string;
  /** URL the page showed when captured. */
  url: string;
  at: number;
  w: number;
  h: number;
  /** MIME type of data (image/webp or image/jpeg). */
  type: string;
  data: ArrayBuffer;
}

export interface StatusInfo {
  version: string;
  counts: { open: number; archived: number; trash: number; protected: number; pending: number; total: number };
  automationEnabled: boolean;
  lastAutoRunAt?: number;
  lastAutoRunSummary?: string;
  runningOps: number;
  update?: { latest: string; url: string; checkedAt: number } | null;
  lastBackupAt?: number;
  onboardingDone: boolean;
}
