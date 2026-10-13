# Testing Fangio

This document explains how to run the unit tests and the end-to-end (e2e) suite in a real
browser, what each scenario covers, the results **measured** in a specific run and the known
limitations. Measured numbers are kept separate from estimates.

## Unit tests

```bash
npm ci
npm run typecheck      # tsc -p . --noEmit
npm test               # vitest run (fake chrome.* + fake-indexeddb)
```

They cover the pure logic and the whole background service against a fake `chrome.*`
(`tests/helpers/fakeChrome.ts`): close pipeline, interruptions at every phase
(`testHooks.checkpoint`), browser restarts, rules, duplicates, backups, protections.

## E2E tests in a real browser

```bash
npm run build                    # the harness also builds before starting (--no-build skips it)
npm run test:e2e                 # all scenarios, 820 tabs (~17 min on the measured machine)
node e2e/run.mjs --list          # list of scenarios
node e2e/run.mjs --only s1,s2 --tabs 200
node e2e/run.mjs --only s4 --tabs 400 --kill-at middle
node e2e/run.mjs --quick         # skips the grace-period waits (3 min) in S3/S4
```

Options: `--only <ids>` (dependencies are added automatically: S2 needs S1, etc.),
`--tabs N` (820 by default), `--headed` (real off-screen windows), `--quick`,
`--keep-profiles`, `--no-build`, `--kill-at early,middle,late`.

Requirements: Node ≥ 20 and Playwright's Chromium downloaded
(`npx playwright install chromium`; the full browser is needed, not the *headless shell*,
because extensions don't work in the latter). Tested on Windows; the memory measurement
(S8) uses `Win32_Process` and only works on Windows.

Results: `e2e/.results/<date>/results.json` (and `e2e/.results/latest.json`). Temporary
profiles: `e2e/.profiles/` (deleted at the end unless `--keep-profiles`). Both are in
`.gitignore`. **The harness never uses the user's Chrome or profile**: it launches
Playwright's Chromium with its own `--user-data-dir`.

### How it works

- `e2e/lib/server.mjs`: local HTTP server on `127.0.0.1` (random port) with pages
  `/p/<n>?q=..` ("Página n"), `/` (for the exact-URL rule), `/audio` (looping tone) and a
  favicon.
- `e2e/helper-ext/`: a **test** extension (not distributed) with `tabs`/`tabGroups`
  permissions that creates the tabs in batches, groups/pins them, and records tab events (to
  measure reopen concurrency from outside Fangio).
- `e2e/lib/fixtures.mjs`: builds the "user's browser": N tabs in 4 windows (50/30/15/5 %), 4
  pinned, 3 groups ("Trabajo", "Lectura", "Compras"), exact duplicates, near-duplicates
  (`?q=a`, `?q=b`, `#sec`), 3 `/` tabs, 4 tabs on `localhost` (excluded site), 1 tab with
  audio. Then it **restarts** the browser: session restore leaves the vast majority of tabs
  **unloaded** (like a real long-lived profile). That profile is used as a template (copied)
  in S1 and S4.
- `e2e/lib/cdp.mjs`, `browser.mjs`, `page.mjs`: Chromium is launched as a child process (so
  its PID is known and the whole tree can be killed) and driven through **direct CDP**.
  Playwright is only used to locate the binary: `connectOverCDP` attaches to every tab and
  with ~800 tabs exceeds its timeout. The UI is driven with real input events
  (`Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`).
- Reading state: **read-only** code is evaluated in Fangio's service worker (or in a Fangio
  page if the worker doesn't start): `chrome.tabs.query`, `storage.session` and the `fangio`
  IndexedDB (only if it already exists: the harness never creates the database).
- Installing with existing tabs: the method that worked → **CDP `Extensions.loadUnpacked`**
  on the running browser (requires `--enable-unsafe-extension-debugging`). Chromium doesn't
  persist those extensions across restarts, so relaunches load the same `dist/` with
  `--load-extension` (the manifest has no `key`: the id depends on the folder, and since it
  is the same `dist/` the id and the IndexedDB are the same; the harness discovers it at
  runtime by looking for the service worker whose manifest is named "Fangio").

### Global invariants (after each scenario)

1. Every URL of the original tabs has an open tab with that exact URL **or** a record with
   that exact URL (in any state).
2. No inflation: records ≤ original tabs + tabs created by the test; and per URL, records ≤
   tab instances with that URL.
3. Every open trackable tab has **exactly one** `open` record linked in the current session.
   (In S4, within the grace period, unlinked tabs are deliberately allowed when their URL
   belongs to an interrupted close that is still deferred; they are reported separately.)

## Scenarios and full-run results

Full run: `npm run test:e2e` (820 tabs, without `--quick`), 2026-10-10, total duration
≈ 16.5 min. **9/9 PASS** (80 checks, 0 failed). Before the fixes, S4 had failed (see
"Bugs found and fixed").

| # | Scenario | What it verifies | Result |
|---|---|---|---|
| S1 | Install with existing tabs | Fangio is loaded (CDP `Extensions.loadUnpacked`) into a browser that already has 820 tabs in 4 windows (pinned, groups, audio, almost all unloaded). One `open` record per tab (`install-snapshot`), exact duplicates with separate records, group titles in `origin`, an `install-snapshot` entry in the log | PASS |
| S2 | Import wizard through the UI | `#/importar`: the preview count matches the real protections (pinned/active/audio/excluded site are kept); 3 rows are protected with the checkbox; "Confirmar" → "Aplicar"; only the expected tabs stay open; archived records keep URL, title, window/index and group; the browser is never left without tabs; undoable action | PASS |
| S9 | Duplicates | Identical URL → separate records (S1); "Fusionar en este" in `#/duplicados` (the others go to the trash, nothing is deleted); "Deshacer" from `#/registro` restores states and `mergedFrom` | PASS |
| S5 | Reopen 50 from the UI | Keyboard selection (Shift+↓ ×49) in "Archivadas" → "Reabrir" → confirmation; the concurrency observed from another extension never exceeds `reopenConcurrency`; the same ids become `open`; re-archiving and "Deshacer" keep ids; no new records | PASS |
| S3 | Browser restart | Orderly shutdown (CDP `Browser.close`) and relaunch with session restore: archive intact (same ids/URLs), restored tabs relinked to the **same** ids, no new records; records of a window closed before the restart stay `open` during the grace period and only afterwards are archived (`window-closed`), never to the trash; the panel loads | PASS |
| S4 | Hard kill during a bulk archive | Archive all 820 and kill the process tree (`taskkill /F /T`) at 3 moments (journal written / 50 % closed / 95 % closed); relaunch; no losses or duplicates; journal resumed/aborted according to the spec | PASS (after fixing 2 bugs) |
| S6 | Automation | Target 15, exact-URL rule `http://127.0.0.1:<port>/` → trash after 0 min, cap of 20 per run, 2 protected, 2 pinned, 2 on an excluded site; preview = result; protections never closed; cap respected; `/?model=x` and `/#frag` don't match the rule; reasons recorded per rule | PASS |
| S7 | UI scale (10,000 records) | Import a synthetic JSON backup from `#/copias` (real file input), panel load, search latency, virtualized scrolling with a real wheel to the end, JSON export (real download) and round trip (reimport: 0 new, 0 updated) | PASS |
| S8 | Resources | Process tree memory at each phase, Fangio's extension process, panel JS heap | PASS (informational) |

## MEASURED numbers

**Machine:** Intel Core i7-12700K (12 cores / 20 threads), 32 GB of RAM, Windows 11 Pro.
**Browser:** Chromium 156.0.8078.4 from Playwright 1.64 (`chromium-1248`), `--headless=new`,
fake audio output (`--disable-audio-output`). A single run on this machine; other machines
(and stable Chrome) will give other values. Wall-clock times measured from the harness
(they include CDP and polling latency, typically 10–100 ms).

| Measurement | Value |
|---|---|
| Create the template (820 tabs, load + discard) / restore it | 26.7 s / 7.8 s |
| S1: `Extensions.loadUnpacked` | 67 ms |
| S1: install → 820 linked `open` records | **391 ms** |
| S2: import preview visible (820 rows) | 255 ms |
| S2: "Aplicar" → "Importación lista" (805 archived + 3 protected) | **9.7 s** (≈ 83 tabs/s) |
| S2: Fangio idle after applying | +1.5 s |
| S5: reopen 50 → all linked / operation finished | 2.1 s / 2.2 s |
| S5: maximum tabs loading at once (`reopenConcurrency` = 3) | 3 |
| S5: re-archive 50 / undo (reopens 50) | 0.6 s / 2.0 s |
| S3: orderly shutdown / relaunch until tabs are present / Fangio idle | 0.6 s / 0.5 s / +1.6 s |
| S3: panel loaded after restart | 90 ms |
| S3: startup sweep (closed window → `archived`) | 185 s after startup (180 s grace + 5 s) |
| S6: preview / run (20 closes) | 4 ms / 211 ms |
| S7: import 10,000 records from `#/copias` | 1.1 s |
| S7: load of the `#/lista` panel with 10,001 records (3 reloads) | 251 / 236 / 344 ms |
| S7: search until the list changes (includes a 120 ms debounce): exact / broad (2,500) / no results | 164 / 150 / 153 ms |
| S7: wheel scroll to the end of 9,501 rows | max. 40 rows in the DOM; largest gap between frames 34 ms |
| S7: panel JS heap with 10,001 records | 19 MB |
| S7: export JSON (5.5 MB, real download) / reimport the same file | 0.7 s / 1.6 s |

### S4 — hard kill (820 tabs)

| Kill moment | First start after the kill | Next start, within the grace period | After the grace period (sweep) |
|---|---|---|---|
| *early*: 145 ms after sending "archive 820", journal written, 0 closed | 820 tabs restored; Fangio's worker doesn't start (see Limitations); data intact | 820 records with `pendingClose`, 820 deliberately unlinked tabs (deferred) | **820 open** (close aborted: the tabs remain), 0 pending, 0 duplicates |
| *middle*: 6.4 s, 425 closed | the browser restored 683 tabs (including 288 that were already closed) | 129 with deferred `pendingClose` | **683 open** (same ids) + **137 archived**; 0 losses, 0 duplicates |
| *late*: 10.3 s, 800 closed | the browser restored 451 | 359 with deferred `pendingClose` | **451 open** + **369 archived**; 0 losses, 0 duplicates |

In an earlier run with 400 tabs, the *late* kill came **after** the final write (400
archived, no `pendingClose`) and the browser still restored 141 of those tabs: with the
rule 4b fix they were relinked to the same 141 records (without the fix: 368 duplicate
records in the same scenario).

### S8 — Chromium process tree memory

| Phase | Processes | Working set | Private |
|---|---|---|---|
| 820 tabs restored (5 loaded, the rest `unloaded`), without Fangio | 14 | 1,224 MB | 892 MB |
| After the install snapshot | 19 | 1,492 MB | 1,019 MB |
| Before archiving (panel open) | 22 | 1,701 MB | 1,133 MB |
| After archiving 805 | 25 | 1,810 MB | 1,171 MB |
| After restarting with 15 open tabs | 12 | 799 MB | 503 MB |

- Fangio's extension process (service worker) after the 820-tab snapshot: **72 MB** working
  set; with the panel open it reached ~110 MB (59 MB private). Panel JS heap with ~820
  records: 3.9 MB.
- Archiving did **not** lower memory during the session: the closed tabs were already
  unloaded (`unloaded` from session restore; not `discarded`) and, meanwhile, Chromium kept
  loading restored tabs in the background (7 → 17 renderers). The savings show up on the
  next start: 799 MB with 15 tabs versus 1.2–1.8 GB with 820.
- The sum of working sets double-counts shared pages; "Private" is more representative.
- When **creating** the template, loading and then discarding 820 tabs without a process
  limit left ~820 renderers alive (~17 GB private): `chrome.tabs.discard` didn't free the
  processes in this build. That is why the template is built with
  `--renderer-process-limit=6` and restarted.

## Views and contextual analysis (v1.1)

```bash
npm run test:e2e:views           # builds, ~1 min; screenshots in e2e/.results/views/
node e2e/views.mjs --headed --no-build
```

Isolated browser like the main suite (Playwright's Chromium, temporary profile). All host
names resolve to a local HTTPS server (`--host-resolver-rules`, a disposable self-signed
certificate created with `openssl`, `--ignore-certificate-errors`): "google.com",
"chatgpt.com" or "react.dev" are local test pages and **nothing goes out to the network**
(HTTPS because those domains are HSTS-preloaded). The extension is loaded from a copy of
`dist/` with the optional `<all_urls>` permission already granted, because the browser's
permission dialog can't be accepted through automation.

Scenario: 14 tabs opened one by one and viewed for 2.7 s each — a Google search about React
hooks followed by a ChatGPT conversation and three sites (opened from the search, with
`openerTabId`), a bike search with a shop, a blog and a video, three pages about Lisbon, and
noise (weather, a recipe).

Measured result (Chromium 156, i7-12700K, Windows 11): **14/14 checks**.

| Check | Result |
|---|---|
| Records and opener tab | 14/14 records; correct `openerId` on the 3 tabs opened from the search |
| Real thumbnails | 14 WebP captures at 320 px (≈2.5 KB on these simple pages; real pages weigh more) |
| Cards | Minimal by default (no image or colors); with thumbnail and colors enabled in "Diseño de tarjetas", 14 cards with thumbnails; after "Borrar todas las miniaturas", generated posters |
| Timeline | day and session rows |
| Topics | 3 groups: "Hooks · useEffect · React" (search + ChatGPT + 3 sites, path starting at the search), "Bicicleta · rodado · MTB" (search + shop + blog + video), "Lisboa" (3); weather and recipe outside any group |
| Analysis | 3–8 ms for 14 references in the *worker*; 10,000 synthetic references ≈0.2 s (unit test in Node) |
| Group in Chrome | native tab group with the topic's 5 tabs |
| Reglas → Miniaturas | the toggle reflects the saved setting and doesn't warn about a missing permission |

After the v1.1 changes (database migration to version 2, `openerId`, thumbnail listeners)
the main suite passed in full again: `node e2e/run.mjs --tabs 200 --quick` → **9/9
scenarios**.

Not covered: the real permission dialog, Chrome's built-in AI (Gemini Nano is not in
Playwright's Chromium; the code detects its absence and hides the button) and topics with
thousands of real references.

## ESTIMATES (not measured)

- On stable Chrome 155 with a real profile, times should be of the same order: the dominant
  cost of a bulk archive is `chrome.tabs.remove` in batches of 25 plus the `strict` writes
  (≈ 80–100 tabs/s here). With a slower disk or antivirus scanning IndexedDB it may be 2–5×
  slower. Not measured.
- Memory with **loaded** tabs (not the measured case): each renderer of a real page uses
  tens to hundreds of MB; there, archiving does free memory immediately.

## Bugs found and fixed

1. **The startup sweep didn't resolve deferred interrupted closes**
   (`src/background/index.ts`). After a kill, on waking within the grace period
   `resumeOps()` defers the interrupted close (tabs are still being restored) and marks it as
   active; the 3-minute sweep only called `reconcile()`, which leaves active operations alone.
   Measured result (S4 *middle*, 400 tabs): after the grace period there were still 400
   records with `pendingClose` and 376 **untracked** tabs, until the maintenance alarm (up to
   15 min) or a worker restart. Fix: the sweep runs `resumeOps()` and then `reconcile()`.
   Test: `tests/crashRecovery.test.ts` ("a close interrupted by a crash … is completed by
   the startup sweep").
2. **Mass duplicates when the browser restores just-archived tabs**
   (`src/core/reconcile.ts`, `src/shared/constants.ts`). If the browser goes down a few
   seconds after a bulk archive, its session file still has the tabs and restores them;
   since the records were `archived` (explicit close), a new record was created per tab (S4
   *late*, 400 tabs: 768 records for 400 tabs). Fix: relinking rule **4b**, only during the
   startup grace period of a new session and only for records closed by Fangio at most
   10 min (`RESTORED_AFTER_CLOSE_WINDOW_MS`) **before** the session started: the record is
   reused (action `rebind`). An archive done in the current session is never relinked.
   Tests: `tests/crashRecovery.test.ts` (3 cases). Documented in `docs/ARCHITECTURE.md`.

Both fixes were validated again in a real browser (S4 with 400 and with 820 tabs).

## Findings that are not Fangio bugs

- **After a hard kill, the extension's service worker doesn't start in the next session**
  (Chromium 156, extensions loaded with `--load-extension`; also reproduced with a minimal
  test extension, both classic and module). The extension's pages open, but
  `chrome.runtime.sendMessage` fails with "Receiving end does not exist". On the following
  start it works again. Meanwhile Fangio tracks nothing (there is no loss: no tab is closed
  and the data stays intact; the reconciliation on the next start brings everything up to
  date). It could not be checked whether the same happens with an unpacked extension
  installed from `chrome://extensions` in stable Chrome (see Limitations). S4 detects it,
  reports it (`serviceWorkerStartsAfterCrash: false`) and restarts the browser normally.
- When relaunching after a kill, the browser restored tabs Fangio had already closed (288 of
  425 in *middle*): Chromium's session file is saved with a delay. Fangio relinks them to
  their records (rule 2 if the close hadn't finished; rule 4b if it had).
- `chrome.tabs.discard` in this build doesn't terminate the renderer process of freshly
  loaded tabs (see S8).
- Restored background tabs don't play audio until they are shown once (Chromium defers
  media); the harness activates the audio tab for an instant.

## Limitations (what this suite does NOT cover)

- **Playwright's Chromium 156, not stable Chrome 155** nor the user's real profile. Session
  restore, discard and worker lifecycle behavior may differ.
- **Session restore of a real profile with 800 tabs** of real sites (heavy pages, logins,
  `beforeunload`): not tested. The test pages are minimal and local.
- **Persistent installation**: Chromium doesn't persist extensions loaded through CDP; after
  a restart `--load-extension` is used. "Load unpacked" from `chrome://extensions` and
  updating with `update.ps1` were not tested.
- **Headless**: windows are `--headless=new`. The UI is driven with real input events via
  CDP, but visual appearance, real OS focus, global keyboard shortcuts (`commands`) and the
  action popup were not validated.
- **Audio**: tested with fake audio output (`--disable-audio-output`): `audible=true` is
  reported and the audio protection holds (S2). Not tested with a real audio device or
  `audioGraceMinutes` (recent audio) in a real browser.
- **`file://`, `ftp://`**, incognito, split-view tabs, popup/PWA windows and `chrome://`
  were not tested in a real browser (only in the unit tests).
- **Real automation alarms** (every `checkIntervalMinutes`) and the 15-minute maintenance
  alarm were not waited for: S6 uses `runRulesNow`. An old `lastAccessed` was not
  simulated; `targetMinIdleMinutes = 0` and `idleArchiveHours = 0` were used.
- **Worker lifecycle**: the harness attaches to the service worker through CDP to read
  state, and with DevTools attached Chromium doesn't terminate it after 30 s idle. Worker
  terminations in the middle of an operation are covered in the unit tests
  (`tests/interruption.test.ts`), not here; the hard kills (S4) are real.
- A single run per scenario: there are no statistics (percentiles) for the times.
- The memory measurement is Windows-only (`Win32_Process`).
