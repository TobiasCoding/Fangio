# Fangio architecture

Reference document for the code. Types live in `src/shared/types.ts`, the message protocol
in `src/shared/messages.ts`, constants in `src/shared/constants.ts` and the default settings
in `src/shared/settings.ts`.

## Principles

1. **Integrity before tidiness.** No tab is closed unless its reference has been written
   and confirmed in IndexedDB (`readwrite` transaction with `durability: 'strict'`, waiting
   for `tx.done`). When in doubt, the tab stays open.
2. **Stable identity.** Each reference has `id = crypto.randomUUID()`. Browser tab/window
   ids are only stored inside `live` / `pendingClose`, together with `sessionId`, and are
   never used as keys.
3. **Idempotence and resumption.** Multi-phase operations (close, reopen) are recorded in
   the `ops` journal before they take effect. The background service can die on any line;
   on wake-up, `resumeOps()` + `reconcile()` complete or roll back without losing or
   duplicating records.
4. **Protections take precedence.** Protected, pinned, active, selected (highlighted), with
   current or recent audio, excluded site, incognito, the extension's own pages and
   untrackable URLs are never closed automatically. A manual action on a protected record
   is rejected unless `force: true` (the UI asks for explicit confirmation and unprotects).
5. **Nothing leaves the computer.** No backend. The only optional network request is the
   daily releases check on `api.github.com` (sends no user data; can be turned off in the
   settings). Contextual analysis, thumbnails and the optional AI (Chrome's Gemini Nano)
   run on the device.

## States

| State | Meaning | Tab |
|---|---|---|
| `open` | Exists in the browser and has a saved reference | Yes (current `live`) |
| `archived` | Keeps link and context without a tab | No |
| `trash` | Discarded, recoverable until permanently deleted | No |

`protected`, `pending` (marked as to-do), `tags`, `project` and `note` are attributes
independent of the state. Reopening an archived record reuses the same `id`
(state → `open`, new `live`, `reopenCount++`); archiving it again keeps the `id`.

### Transitions

- New (trackable) tab → `open` record (`source: 'tracked'`, `openedAt` only if it was
  created after the startup grace period).
- Installation → *snapshot* of all existing tabs as `open` (`source: 'install-snapshot'`,
  `importedAt = now`, `openedAt` unknown). This is already a backup: from the first second
  all URLs are in the database.
- Archive (manual, import or rule) → safe close pipeline → `archived`.
- Send to trash: if open, the same pipeline with `targetState: 'trash'`; if archived, a
  state change.
- The user closes a tab (`onRemoved` with `isWindowClosing: false`) → `trash` with reason
  "Cerrada por el usuario" (closed by the user) and `implicitCloseAt`.
- A window (`isWindowClosing: true`) or the browser is closed → **nothing changes** in the
  event. The later reconciliation archives (`window-closed`) `open` records without a tab
  once the grace period has passed. That way a browser close followed by a session restore
  relinks the same references.
- Restore (`trash` → `archived`). Permanent deletion only from `trash`.

### Relinking (avoids duplicates)

When an unlinked trackable tab appears, Fangio looks, in this order, for:
1. An `open` record whose `live.tabId` matches, with the same URL (extension reload: tab
   ids are still valid even if `sessionId` changes).
2. A record with `pendingClose` and the same URL (interrupted close; the tab survived).
3. An `open` record with no current link and the exact same URL; ties are broken by
   proximity of (`origin.windowOrdinal`, `origin.index`).
4. A record with `implicitCloseAt` within the last `REBIND_WINDOW_MS` and the same URL
   (Ctrl+Shift+T, "reopen closed window"). Action `rebind`.
4b. Only during the startup grace period of a new session: a record closed by a Fangio
   operation (`archived`/`trash`) at most `RESTORED_AFTER_CLOSE_WINDOW_MS` (10 min)
   **before** the session started, with the same URL. This is the case of the browser
   restoring tabs we had just closed because it went down (crash, power cut) before saving
   the session: the reference is reused instead of being duplicated. Action `rebind`.
5. If nothing matches → new record.

Outside rule 4b, explicitly archived records are never relinked: two identical tabs are not
assumed to share state (see Duplicates).

## Close pipeline (archive / trash)

    Save → confirm write → revalidate → close → record result

1. **Journal**: `OpJournal{kind:'close', items:[{recordId, tabId, status:'pending'}]}` is
   written.
2. **Save**: in batches (`WRITE_BATCH_SIZE`), each record is updated with the tab's fresh
   data (`chrome.tabs.get`) and `pendingClose{opId, tabId, sessionId, expectedUrl,
   targetState}`. `tx.done` is awaited with strict durability. If the write fails, the item
   is left `failed` and **the tab is not touched**.
3. **Revalidate** right before closing: `chrome.tabs.get(tabId)` must exist, the URL must
   be identical to `expectedUrl`, and the tab must still be eligible (for automatic actions
   and the initial import: not active, not pinned, no audio, site not excluded, not
   protected, etc.; for manual actions: not protected unless `force`). Automatic decisions
   carry the evaluated URL (`CloseItem.expectedUrl`): if the tab now shows another one, it
   is skipped. The record is also reread: it must keep the same `pendingClose.opId`. If
   anything changed → `skipped` and `pendingClose` is cleared. A forced action on a
   protected record that ends up skipped or failing gives it its protection back.
4. **Close** with `chrome.tabs.remove` in batches of `CLOSE_BATCH_SIZE`. Each batch queries
   the tabs again and drops those that no longer show the expected URL ("La URL cambió
   antes de cerrar", i.e. the URL changed before closing: they stay open and `pendingClose`
   is cleared). Query + safeguard + `remove` of each batch run under a global mutex, so two
   concurrent operations cannot together leave the browser empty. If the batch fails, tabs
   are retried one by one to isolate the error. If closing would leave the browser without
   any normal tab, a new empty tab is created first.
5. **Record result**: `state = targetState`, `archivedAt`/`trashedAt`, `live = null`,
   `pendingClose = null`, items `done`, an entry in the action log with reason and `before`
   for undo. The `onRemoved` handler recognizes tabs with `pendingClose` (or in the
   in-memory set of closes in progress) and doesn't treat them as "closed by the user".

Recovery after an interruption (`resumeOps` on wake-up and in the maintenance alarm):
- `pending` item (nothing written yet): marked `skipped` (the tab stays open).
- Record with `pendingClose` whose tab still exists with the same URL: **aborted**
  (`pendingClose` is cleared, it stays `open`). The rule will evaluate it again; we never
  close blindly after an interruption.
- Record with `pendingClose` whose tab no longer exists (or a different session and no tab
  with that URL after the startup grace): completed to `targetState`.

## Reopening

`OpJournal{kind:'reopen'}`; concurrency limited by `reopenConcurrency`.
Per item: mark `creating` (persisted) → record expected URL in memory →
`chrome.tabs.create({url, active:false, windowId})` → link `live` and `state:'open'` →
`done`. Fangio waits for `status === 'complete'` or `REOPEN_LOAD_TIMEOUT_MS` before
releasing the slot; if the reopen is a bulk one and `discardAfterBulkReopen` is set,
background tabs are discarded (`chrome.tabs.discard`) after loading. With `restoreGroups`,
tabs are regrouped by `origin.groupTitle` in the target window.
Resumption: `creating` items without a `tabId` → if an unlinked tab with that URL exists it
is linked; otherwise it is created. Two tabs are never created for the same item in the same
session.

## Event tracking (tracker)

Listeners are registered **synchronously at the top level** of `background/index.ts` (an
MV3 requirement). High-volume events (`onUpdated` for title/favicon/audio) are accumulated
in memory and flushed with a debounce (`EVENT_FLUSH_MS`) in a single transaction. Losing a
flush because the worker is terminated is not serious: periodic reconciliation resyncs
titles and URLs. Critical state changes are never deferred.

- `onCreated` / `onUpdated(url)` → create or relink (see above), or update the URL (the
  previous one goes to `previousUrls`).
- `onActivated` → `lastAccessedAt = now`.
- New tab with an `openerTabId` of a linked tab → `openerId` = id of the source record
  (followed link / "open in new tab"). Only set when the record is created; it is a signal
  for contextual analysis.
- `onUpdated(audible)` → `lastAudibleAt`.
- `onRemoved` → see transitions.
- `onReplaced` → move `live.tabId`. `onAttached`/`onDetached` → update `live.windowId`.

Trackable URLs: `http:`, `https:`, `file:`, `ftp:`. `chrome://newtab`, `about:blank`, the
extension's own pages and other internal URLs don't create records (they don't count toward
the open-tab target). Incognito tabs are ignored completely.

## Session and reconciliation

`sessionId` lives in `chrome.storage.session` (cleared when the browser restarts or the
extension reloads). `onStartup` saves `startupAt` and schedules `ALARM_STARTUP_SWEEP`; that
alarm runs `resumeOps()` (resolves the interrupted closes that were deferred by the grace
period) and then `reconcile()`.
`reconcile()` (on worker start if more than 5 min have passed since the last one, in the
maintenance alarm and manually):
1. Lists tabs (`chrome.tabs.query({})`, excluding incognito).
2. Links/updates according to the relinking table.
3. `open` records without a tab: within `STARTUP_GRACE_MS` of startup they are not touched;
   otherwise → `archived` with reason "No encontrada (ventana cerrada o sesión no
   restaurada)" (not found: window closed or session not restored; action
   `window-closed`). Never to `trash`, never deleted.
4. Resolves orphaned `pendingClose` entries (see pipeline).
The planning function is pure (`planReconcile`) and covered by tests.

## Automatic rules

Only with `automationEnabled` (off until the user enables it after the import). Alarm
`ALARM_AUTOMATION` every `checkIntervalMinutes`. `evaluateRules()` is pure: it receives
tabs, records, settings and `now`, and returns a `RulePreview`. The UI shows exactly that
preview before enabling.

`idleMinutes = (now - max(record.lastAccessedAt, tab.lastAccessed)) / 60000`.

Evaluation order per open tab:
1. Blocks (`BlockReason`): if there is any → `keep` with an explanation. They always take
   precedence.
2. An enabled exact-URL rule that matches with `idleMinutes >= afterMinutes` → its action.
3. Inactivity: `idleArchiveHours > 0` and `idleMinutes >= idleArchiveHours*60` → `archive`.
4. Target: if more than `targetOpenTabs` remain open (counting every trackable tab, even
   blocked ones), the oldest by last access with `idleMinutes >= targetMinIdleMinutes` are
   archived until the target is reached. Recently viewed tabs are kept even if the target is
   exceeded (`recently-viewed`).
5. Cap `maxAutoClosePerRun` (most idle first); `capped` indicates it.

Each automatic action is recorded with its reason, e.g. "Archivada automáticamente: sin
consultar hace 26 h (inactividad > 24 h)" (archived automatically: not viewed for 26 h,
inactivity > 24 h).

## Duplicates

References with an **identical** URL (exact string comparison) are grouped in the
Duplicados (Duplicates) view. "Fusionar" (Merge, manual) keeps the chosen record and adds to
it: union of tags, concatenated notes, `pending`/`protected` by OR, minimum creation date,
maximum last access, `mergedFrom`. The others go to `trash` with reason "Fusionada en …"
(merged into …; recoverable, undo available). An open record cannot be merged into another
(it is rejected: it must be archived first).

The only automatic merge is the `dedupeArchived` rule (on by default; `core/duplicates.ts`,
`planArchivedDedupe` + `dedupeArchived`): in each group of `archived` records with an
identical URL, those with no data of their own (`note`, `tags`, `project`, `pending`,
`protected`) are merged with `planMerge` into the one that is kept (the most recently used
with data; if none has data, the most recently used). It never touches records with data,
open ones, busy ones or ones with `pendingClose`. It runs after archiving (manual, shortcut,
import wizard, rules run by hand and the automation alarm), after a JSON import and during
maintenance. It leaves a single `merge` action with `auto: true`, which can be undone (with
the rule on, restored copies are merged again on the next pass: to keep them, the rule must
be turned off).

Importing JSON from another installation (a different ID, as when moving from v1.1.0 to
v1.1.1): a record that was `open` in the backup and whose URL is open here under another id
is joined to that open record (`foldIntoOpen`): it keeps the id, state and tab, and gains
tags, note, marks, dates and history.

## Trash and permanent deletion

An explicit policy separate from archiving: `trashRetentionDays` (30 by default; 0 = never).
The maintenance alarm deletes only `trash` records with `trashedAt < now - retention`, and
leaves a `purge` entry in the log (not undoable). As a safeguard against clock jumps, it
deletes nothing if any `trashedAt` is in the future (the clock went back) and never more than
500 per run (oldest first). The `purge` and `emptyTrash` messages require
`confirm: 'ELIMINAR'` (a safeguard against accidental messages; the panel sends it without
asking the user: Delete and "Eliminar definitivamente" don't ask for confirmation, "Vaciar
papelera" asks for a simple confirmation).

## Action log and undo

Each mutation writes an `ActionEntry` with reason and `before`. Undo:
- `archive`/`trash` of open tabs → they are reopened (limited concurrency).
- `trash` of archived records, `restore`, `update`, `merge`, `user-closed`,
  `window-closed` → the fields in `before` are restored.
- `purge` cannot be undone (only from a JSON backup).
Log retention: `logRetentionDays`.

## Persistence (IndexedDB `fangio`, version 2)

- `records` (keyPath `id`): indexes `state`, `url`, `domain`, `tags` (multiEntry),
  `updatedAt`.
- `actions` (keyPath `id`): index `at`.
- `ops` (keyPath `id`): operations journal.
- `kv` (keyPath `key`): `settings`, `lastAutoRun`, `updateInfo`, `meta`.
- `thumbs` (keyPath `id` = record id, index `at`; since version 2): `ThumbEntry` thumbnails
  (320 px WebP as an `ArrayBuffer`). Relaxed durability (they are recaptured). They are
  deleted in the same transaction as the record's permanent deletion; maintenance removes
  orphans and the oldest above `MAX_THUMBNAILS` (3000). Never exported.
- The 1 → 2 migration only adds the `thumbs` store (additive, records untouched).
`unlimitedStorage` is requested so the archive is not evicted. Future migrations are done in
`onupgradeneeded` without data loss.

## Export / import

Versioned JSON `ExportFileV1` (`format: 'fangio-export'`, `schemaVersion: 1`). On import,
each record is validated (only http/https/file/ftp URLs, bounded lengths; action log entries
are filtered by field and are never undoable); records imported in the `open` state become
`archived` (they have no tab) and `trash` ones get `trashedAt = now` (retention counts from
the import); merge by `id` (the higher `updatedAt` wins, but an open record or one with a
close in progress keeps its URL, state and link; the losing URL goes to `previousUrls`);
nothing is ever deleted on import. Reopening rejects untrackable URLs. HTML in Netscape
bookmarks format (importable in any browser) is also exported as a recovery path
independent of the extension.

## Thumbnails (optional, off by default)

`core/thumbs.ts`. With `settings.thumbnails`, when a tab stays visible and loaded for
`THUMB_SETTLE_MS` (1.5 s), `chrome.tabs.captureVisibleTab` takes what the user is already
seeing, it is reduced to 320 px (`createImageBitmap` + `OffscreenCanvas`, WebP) and saved
under the record id. Safeguards, all mandatory: automatic capture only with the optional
`<all_urls>` permission granted by the user (the popup and the archive shortcut use the
`activeTab` grant); http(s) only; never incognito, excluded sites, `thumbnailExclusions` or
sensitive URLs (login, account, payments, parameters with credentials); the tab must still
be active and on the same URL after the capture; at most 2 captures per second; recaptured
only if the URL changed or `THUMB_REFRESH_MS` (15 min) has passed. Turning the option off
gives the optional permission back.

## Contextual analysis (Temas view)

Pure engine in `core/context/` (details and research in [CONTEXT.md](CONTEXT.md)): title,
search query and URL features; TF-IDF; per-pair weight = lexical × two-scale temporal kernel
+ opener tab + Chrome group + project; Louvain communities; c-TF-IDF names. It runs in a
dedicated *worker* (`context-worker.js`) from the panel, on the filtered references (at most
8000, those with the most recent activity). It only uses instants of real activity
(`openedAt`, `lastAccessedAt`), never dates of bulk operations. Actions on a suggestion use
the existing messages (`updateRecords`, `archive`, `reopen`) plus `groupTabs` (Chrome group
per window; doesn't close, doesn't move between windows, ignores pinned tabs). AI naming:
optional, with Chrome's Prompt API (Gemini Nano on the device).

## Interface

- `dashboard.html` (full tab): four views of the same filtered set (virtualized List,
  configurable Cards (minimal by default; optional thumbnail, size, fields and colors),
  Timeline by day and work session, suggested Topics), search (title, URL, note), filters
  (status, domain, tags, project, to-dos, protected), chronological order, per-item and bulk
  actions, initial import wizard, rules with preview, duplicates, trash, log with undo,
  backup. It reads IndexedDB directly; mutates via messages; listens on `BroadcastChannel`.
- `popup.html`: current tab (archive, protect, to-do, note, tags), counters, open panel.
- Shortcuts (`commands`): open panel, archive current tab.

## Permissions

`tabs` (tab URL/title), `tabGroups` (source group title/color), `storage`
(`storage.session`), `alarms`, `unlimitedStorage`, `favicon` (icons from the browser cache
via `/_favicon/` without visiting sites), `activeTab` (thumbnail of the tab where the popup
is opened or the shortcut is used; no warning). **Optional** host permission `<all_urls>`:
only requested when automatic thumbnails are enabled and only used for
`captureVisibleTab`. No content scripts: page content is never read or modified.
The manifest doesn't include `key` (the Chrome Web Store rejects it): from the store, the ID
is set by the store; unpacked, the ID depends on the folder, and the updaters replace the
files in the same folder to keep it. Moving the folder changes the ID and leaves the
database behind: the JSON backup must be exported and imported (the import joins open
records by URL).

## Known limitations

- Keeping URL and title doesn't recover forms, drafts or internal app state.
- The timeline before installation is unknown (empty `openedAt`).
- `tab.lastAccessed` after a browser restart may reflect the restore.
- Uninstalling ("Remove") the extension deletes its IndexedDB: export first. Reloading or
  updating doesn't delete data.
