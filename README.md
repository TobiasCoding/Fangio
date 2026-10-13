<p align="center"><img src="static/icons/icon128.png" width="96" height="96" alt="Fangio"></p>

<h1 align="center">Fangio</h1>

<p align="center">
  Archive tabs in a local database, close them safely and get them back fast.<br>
  Extension for Chrome and Chromium browsers (Manifest V3). No servers, no accounts.
</p>

<p align="center">
  <a href="https://github.com/TobiasCoding/Fangio/actions/workflows/ci.yml"><img src="https://github.com/TobiasCoding/Fangio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/TobiasCoding/Fangio/releases/latest"><img src="https://img.shields.io/github/v/release/TobiasCoding/Fangio?label=version" alt="Latest version"></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license"></a>
</p>

> [!WARNING]
> **Clicking "Remove" on the extension in `chrome://extensions` deletes its entire database.**
> Before uninstalling, export a backup from **Panel → Copias → Exportar JSON**.
> Reloading or updating the extension does **not** delete anything.

> [!NOTE]
> Fangio's interface is in Spanish. UI labels are quoted verbatim in this documentation,
> with an English translation in parentheses the first time they appear.

## Contents

- [What it is](#what-it-is)
- [Safety guarantees](#safety-guarantees)
- [Installation](#installation)
- [First use](#first-use)
- [Daily use](#daily-use)
- [Views and suggested topics](#views-and-suggested-topics)
- [Automatic rules and the 15-tab target](#automatic-rules-and-the-15-tab-target)
- [Duplicates](#duplicates)
- [Trash and permanent deletion](#trash-and-permanent-deletion)
- [Log and undo](#log-and-undo)
- [Backup and restore](#backup-and-restore)
- [Updates](#updates)
- [Permissions](#permissions)
- [Privacy](#privacy)
- [Limitations](#limitations)
- [Development](#development)
- [Publishing a version](#publishing-a-version)
- [Verification results](#verification-results)

## What it is

Fangio is for people who live with dozens (or hundreds) of tabs open "just in case".
From the moment you install it, every tab is recorded in a local database (IndexedDB,
inside your browser profile) with its URL, title, window, group and dates. That way you can
close tabs without fear: the reference is saved and you reopen it with one click.

- **Archive** a tab: it is closed, and its link and context are kept.
- **Search** everything archived by title, URL or note, with filters by domain, tags,
  project and status.
- **Automate** (optional) closing inactive tabs down to a target number of open tabs,
  always with a preview and respecting the protections.
- **View** what is saved as a list, cards with thumbnails, a session timeline or
  **suggested topics**: groups Fangio builds on its own, on your computer, by relating what
  you searched for, what you discussed with an AI and the sites you opened around the same
  time.
- **Recover** anything: trash, a log with undo, and backups.

## Safety guarantees

The golden rule is **integrity before tidiness**: when in doubt, the tab stays open.

### How a tab is closed

Every close (manual, from the import wizard or from a rule) always follows this order:

1. **Save**: the reference is written with the tab's fresh data.
2. **Confirm**: Fangio waits for IndexedDB to confirm the write (strict durability). If the
   write fails, the tab is not touched.
3. **Revalidate**: right before closing, Fangio checks that the tab still exists, that it
   has **exactly the same URL** and that it is still eligible. If anything changed, it is
   skipped.
4. **Close** the tab (in batches; if a batch fails, tabs are retried one by one).
5. **Record** the result in the action log, with its reason and the information needed to
   undo it.

Operations are written to a journal before they take effect: if the browser or the
background service is interrupted halfway, on restart they are completed or rolled back
without losing or duplicating records, and nothing is ever closed "blindly".

### Protections

Protections **always take precedence** over automatic rules. These tabs are never closed
automatically:

- tabs you protected, pinned tabs, and active or selected tabs;
- tabs playing audio or that played audio recently;
- tabs on excluded sites (by default Meet, Docs, Zoom, Teams, Slack, Figma, WhatsApp Web,
  Gmail and Outlook: editors, calls and chats with work in progress);
- incognito tabs (Fangio neither sees nor stores them), internal browser pages and the
  extension's own pages.

A manual action on a protected tab asks for explicit confirmation.

### Nothing leaves your computer

There is no backend, no accounts and no telemetry. Everything lives in your browser
profile. The only network request is optional: a daily query to GitHub's public releases
API to tell you when a new version is available (see [Privacy](#privacy)).

### What it does **not** guarantee

Saving the URL and title does **not** save the state of the page. When you reopen an
archived tab you do **not** get back:

- half-filled forms or unsaved drafts;
- the internal state of web apps (position in a video, filters, open chats, sessions that
  expired);
- content that changed or no longer exists on the site.

That is why sites where work tends to be in progress are excluded from automation by
default. If a tab has something unsaved, protect it or save before archiving.

## Installation

Fangio is distributed as an **unpacked extension** from the
[GitHub releases](https://github.com/TobiasCoding/Fangio/releases/latest) (it is not in the
Chrome Web Store). It requires Chrome 121 or later (Edge, Brave and other Chromium browsers
also work). The full guide, with troubleshooting, is in [docs/INSTALL.md](docs/INSTALL.md).

### Option A: download the zip

1. Download `fangio-vX.Y.Z.zip` from the [latest release](https://github.com/TobiasCoding/Fangio/releases/latest).
2. Extract it into a **permanent folder**, for example `%LOCALAPPDATA%\Fangio\extension`
   on Windows or `~/.local/share/fangio/extension` on Linux. Don't use Downloads or a
   temporary folder: Chrome loads the extension from there every time it starts.
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and choose the folder where you extracted the zip (the one that
   contains `manifest.json`).
6. Pin the Fangio icon to the toolbar (extensions menu, puzzle-piece icon).

Optional: verify the download with the release's `SHA256SUMS.txt`
(`Get-FileHash fangio-vX.Y.Z.zip` in PowerShell or `sha256sum -c SHA256SUMS.txt`).

### Option B: install script (Windows)

In PowerShell (no administrator rights needed):

```powershell
irm https://raw.githubusercontent.com/TobiasCoding/Fangio/main/scripts/install.ps1 | iex
```

It downloads the latest release, verifies its SHA-256 and places it in
`%LOCALAPPDATA%\Fangio\extension` (or in the folder you pass with `-InstallDir` if you run
it as a file). Then follow steps 3 to 6 of option A.

## First use

As soon as it is installed, Fangio records **all** open tabs: from the very first second you
already have a copy of their URLs. Nothing is closed until you decide so.

1. Open the panel (`Alt+Shift+F` or the button in the popup). The first time, the
   **import wizard** opens (**Importar** section).
2. **Export a JSON backup first.** The wizard offers it before touching anything.
3. **Review** the list: protect what must not be closed, mark to-dos, add tags.
4. **Archive** what you don't need open. Each tab goes through the
   [safe close](#how-a-tab-is-closed).
5. If you want, **turn on automation** in **Reglas** (Rules): before enabling it you will
   see an exact preview of what it would close and why. It is off by default.

## Daily use

- **Panel** (`Alt+Shift+F`): list of all references (open, archived and in the trash),
  sorted chronologically, with per-item or bulk actions (archive, reopen, protect, tag,
  move to trash…).
- **Search** by title, URL and note, and **filters** by status, domain, tags, project,
  to-dos and protected.
- **To-dos** (*pendientes*): mark what you need to read or do; they have their own filter.
- **Tags, projects and notes**: organize references without depending on folders.
- **Reopen**: tabs are reopened a few at a time (so the computer is not overloaded), in the
  background, and regrouped if they belonged to a group.
- **Popup** (toolbar icon): actions on the current tab (archive, protect, mark as to-do,
  note and tags), counters and a shortcut to the panel.
- **Keyboard shortcuts** (change them in `chrome://extensions/shortcuts`):

  | Shortcut | Action |
  |---|---|
  | `Alt+Shift+F` | Open the panel |
  | `Alt+Shift+A` | Archive the current tab |

Closing a tab by hand (with the X or `Ctrl+W`) sends it to the **trash** with the reason
"Cerrada por el usuario" (closed by the user), so you can recover it. Closing a window or
the browser changes nothing: if the session is restored, the references are linked again;
if not, they stay **archived** (they are never deleted).

## Views and suggested topics

At the top right of the panel you choose how to view the same filtered set. Search,
filters, selection and actions work the same in all of them.

- **Lista** (List): compact and fast, with keyboard shortcuts.
- **Tarjetas** (Cards): one compact card per reference (icon and site, title, marks and date
  in a single block). By default it is minimal, with no image or colors; with **Diseño de
  tarjetas** (Card design) you choose whether to show the **thumbnail** (if you enabled
  thumbnails), the size (compact or comfortable), the site, the date, the full URL, the marks
  and tags, the status and per-site colors. The choice is remembered in this browser.
- **Línea de tiempo** (Timeline): grouped by day and by **work session** (activity with no
  breaks longer than 45 minutes), with an hourly activity histogram. Clicking the checkbox of
  a day or a session selects all its references (for example, to archive "yesterday
  afternoon's session"). The date used follows **Orden** (Sort).
- **Temas** (Topics): automatically suggested groups. Fangio relates references that share
  words (in the title, in what you searched for on Google, Bing, YouTube or Mercado Libre, or
  in the URL) and weights them by **closeness in time**: a search, a ChatGPT conversation
  about the same thing and the sites you read right after end up together, even if they are
  on different domains. The tab you opened another one from, the Chrome tab group and the
  project also count. Each topic shows the **path** (search → AI chat → sites), the shared
  terms and their affinity, and lets you **select it**, assign it a **project** or **tag**,
  create a **Chrome tab group** with the open ones, reopen it, archive it or dismiss the
  suggestion. Everything is computed on your computer; the research and the algorithm are in
  [docs/CONTEXT.md](docs/CONTEXT.md).
- **Name with local AI** (optional): if your Chrome ships its built-in model (Gemini Nano)
  and your computer supports it, Fangio can use it to give topics natural names ("Comprar
  bicicleta rodado 29", i.e. "Buy a 29-inch bike") and flag titles that don't fit. It runs
  on the device; if the model is not downloaded, Chrome downloads it once after you confirm.

### Thumbnails

Off by default. Turn them on in **Reglas → Miniaturas de páginas** (Rules → Page
thumbnails). Fangio saves a 320 px capture of the page you are looking at (only the visible
tab, after it finishes loading), only on your computer and **not** included in JSON
backups. It never captures incognito tabs, excluded sites, the sites you add to "No
capturar estos sitios" (Don't capture these sites), or login, account or payment pages. To
capture automatically, Chrome asks you for the optional site access permission (see
[Permissions](#permissions)); if you don't grant it, thumbnails are only taken when you
open the popup or archive with the keyboard shortcut.

## Automatic rules and the 15-tab target

Automation is **off** until you enable it in **Reglas** (Rules). When it is on, every few
minutes (5 by default) it evaluates the open tabs in this order:

1. **Protections**: if any applies, the tab stays. They always win.
2. **Exact-URL rules**: for example, the ChatGPT, Instagram or Google home page unused for
   60 minutes goes to the trash. You can edit them, disable them or add others.
3. **Inactivity**: whatever you haven't looked at in 24 hours is archived (configurable;
   0 = never).
4. **Open-tab target** (15 by default): if there are more, the tabs you haven't looked at
   for the longest time (with at least 60 minutes unused) are archived until the target is
   reached. Tabs you looked at recently stay even if that exceeds the target.
5. **Per-run cap** (50 by default): it never closes more than that at once.

The rules screen shows the exact **preview** (what it would do with each tab and why)
before you enable or change anything. Each automatic close is recorded in the log with its
reason, for example: "Archivada automáticamente: sin consultar hace 26 h (inactividad
> 24 h)" (Archived automatically: not viewed for 26 h, inactivity > 24 h).

## Duplicates

The **Duplicados** (Duplicates) view groups references with **exactly the same URL**. You
pick which one to keep and **Fusionar** (Merge) adds to it the tags, notes, to-do/protected
marks and dates of the others, which go to the trash (recoverable, with undo). An open tab
is not merged into another one: archive it first.

**Archived-duplicates rule** (on by default, in **Reglas**): if two or more **archived**
references have the identical URL and **no data of their own** (note, tags, project, to-do
or protected), Fangio keeps a single one (the one with data or, failing that, the most
recently used) and sends the rest to the trash. References with data are never merged
automatically. It applies when archiving, when importing and during periodic maintenance.
To get the copies back, disable the rule and then undo the merge from **Registro** (Log);
with the rule enabled they are merged again.

## Trash and permanent deletion

Archiving is **not** deleting. The trash is a separate intermediate step:

- The trash receives tabs you close by hand, tabs you send there explicitly and tabs
  handled by rules configured with that action.
- From the trash you can **restore** (back to archived) at any time.
- **Automatic permanent deletion**: whatever has been in the trash for more than **30 days**
  is deleted (configurable; **0 = never**). It only affects the trash, never archived items.
- **Delete** on the reference you clicked (the one in the detail pane) or on the selection:
  if it is not in the trash, it goes to the trash (and its tab is closed if it was open); if
  it is already in the trash, it is **permanently deleted**. No confirmations: the first can
  be undone from the notification or from Registro; the second cannot be undone. On Mac,
  `Cmd+Backspace`.
- **Eliminar definitivamente** (Delete permanently, button) doesn't ask for confirmation
  either; **Vaciar papelera** (Empty trash) asks for a simple confirmation because it
  affects everything in it.

## Log and undo

Every change (archive, reopen, edit, merge, restore, automatic closes…) is recorded in the
**Registro** (Log) with date and reason, and almost everything can be **undone**: closed
tabs are reopened and data changes are reverted. The only exception is permanent deletion,
which can only be recovered from a JSON backup. The log is kept for 90 days (configurable).

## Backup and restore

In **Copias** (Backups):

- **Exportar JSON** (Export JSON): full, versioned backup (references, settings and the
  latest log entries). This is the format for restoring into Fangio.
- **Exportar HTML de marcadores** (Export bookmarks HTML): standard format any browser can
  import. It works as a lifeline independent of Fangio.
- **Importar JSON** (Import JSON): validates each record and **merges** with what you
  already have (by id; the most recently edited version wins). It never deletes anything.
  Whatever was open in the backup is imported as archived.

Recommendation: export a JSON backup regularly (the panel reminds you) and always before
uninstalling, moving the folder or switching computers.

## Updates

Chrome **cannot update on its own** an unpacked extension or one distributed outside the
Chrome Web Store: on Windows and macOS external extensions are only allowed through
enterprise policies, and unpacked extensions are never updated automatically (details and
sources in [docs/INSTALL.md](docs/INSTALL.md#why-it-doesnt-update-itself)). Therefore:

1. Fangio checks once a day whether there is a new version (you can turn this off) and
   shows you a notice in the panel.
2. You run the updater that is **inside the installed folder**:
   - Windows: double-click `update.cmd` (or run `update.ps1` from PowerShell).
   - Linux/macOS: `bash update.sh`.

   It downloads the release, verifies its SHA-256, checks that it is Fangio, saves the
   previous version in `<folder>.previous` and replaces the files (if anything fails, it
   restores the previous one).
3. You click **Reload** in `chrome://extensions` (or **Recargar extensión** in the panel's
   notice). **Your data is kept.**

## Permissions

Fangio asks only for what it needs and **does not inject scripts into pages**: it never
reads or modifies their content. The only host permission is **optional** and stays off
until you enable automatic thumbnails.

| Permission | What for |
|---|---|
| `tabs` | Read the URL and title of tabs, and open, close or discard them. |
| `tabGroups` | Remember the title and color of the source group and regroup when reopening. |
| `storage` | Data for the current browser session (`storage.session`). |
| `alarms` | Periodic tasks: rules, maintenance and the daily version check. |
| `unlimitedStorage` | Keep the browser from evicting the local database for lack of space. |
| `favicon` | Show site icons from the browser cache, without visiting the sites. |
| `activeTab` | Take the thumbnail of the tab where you open the popup or use the archive shortcut (no warning). |
| `<all_urls>` (**optional**) | Only if you enable automatic thumbnails: capture the visible tab with `captureVisibleTab`. Chrome shows it as "Read and change all your data on all websites"; Fangio uses it for nothing else and gives it back when you turn the option off. |

Since v1.1.1 the manifest does **not** include `key` (the Chrome Web Store rejects it).
Installed from the store, Fangio has the ID the store assigns and updates itself. Loaded
unpacked, Chrome gives it an ID that depends on the folder: the updater replaces the files
in that same folder, so the ID and the database are kept. **Don't move the folder** without
exporting a JSON backup first (see [Installation](docs/INSTALL.md)).

## Privacy

- Everything is stored locally in your browser profile. There are no servers, accounts,
  analytics or telemetry.
- The **only** network request is optional: once a day Fangio queries
  `https://api.github.com/repos/TobiasCoding/Fangio/releases/latest` to find out whether
  there is a new version. It sends none of your data (as with any request, GitHub sees your
  IP address). It can be turned off in the settings.
- The install and update scripts only talk to GitHub and only write to the extension
  folder.

More details in [PRIVACY.md](PRIVACY.md).

## Limitations

- Keeping the URL and title does not recover forms, drafts or the internal state of web
  apps (see [What it does not guarantee](#what-it-does-not-guarantee)).
- History before installation is unknown: tabs that were already open have no opening
  date.
- After restarting the browser, the "last accessed" date of some tabs may reflect the
  session restore rather than your actual last use.
- Incognito tabs are ignored completely.
- There is no sync between computers: to take your data to another computer, export and
  import a JSON backup.
- Since it is not in the Chrome Web Store, updates require the manual step described in
  [Updates](#updates), and Chrome may show warnings about extensions in developer mode.
- **Removing the extension deletes its database.** Export first.

## Development

Requirements: Node.js 20 or later (CI uses Node 24) and npm.

```bash
npm ci               # install exact dependencies
npm run build        # compile into dist/ (not minified, so it can be audited)
npm run dev          # compile and recompile on save (alias: build:watch)
npm run typecheck    # TypeScript without emitting
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests with Playwright
npm run test:e2e:views  # e2e for views, thumbnails and topics (requires openssl)
npm run check        # typecheck + test + build
npm run package      # build + release/fangio-vX.Y.Z.zip + SHA256SUMS.txt
npm run icons        # regenerate the PNGs in static/icons/
```

To try it, load the `dist/` folder with **Load unpacked** and click **Reload** in
`chrome://extensions` after each build. The architecture and design decisions are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Layout: `src/background` (service worker), `src/core` (logic and database), `src/ui`
(panel and popup with Preact), `src/shared` (types and constants), `static` (manifest and
icons), `scripts` (build, packaging, publishing, installation and update), `tests` and
`e2e`.

## Publishing a version

```bash
# 1. Describe the changes in the [Unreleased] section of CHANGELOG.md and commit.
# 2. From main, with a clean tree:
npm run release -- patch     # or minor, major, or an X.Y.Z version
# 3. Publish:
git push origin main --follow-tags
```

`npm run release` runs the typecheck and tests, bumps the version in `package.json` and
`package-lock.json`, moves the changelog notes into the new version, builds, and creates
the commit `release: vX.Y.Z` and the tag `vX.Y.Z`. When the tag reaches GitHub, Actions
verifies everything again, packages the zip and publishes the release with its notes and
its `SHA256SUMS.txt`. Details in [docs/RELEASING.md](docs/RELEASING.md).

## Verification results

Summary (full details, methodology and limitations in [docs/TESTING.md](docs/TESTING.md)):

- **Unit tests:** 143/143 (persistence, interruptions, rules, protections, duplicates,
  import/export, storage failures, 800+ records, topic engine, database migration,
  thumbnails).
- **Views and topics in a real browser:** 14/14 checks (real thumbnails, search → ChatGPT
  → sites groups, Chrome group created). See
  [docs/TESTING.md](docs/TESTING.md#views-and-contextual-analysis-v11).
- **End-to-end tests in an isolated real browser** (Playwright's Chromium 156, temporary
  profile, never the user's browser): **9/9 scenarios with 820 tabs** across 4 windows
  (pinned, groups, duplicates, audio).

**Measured** numbers (i7-12700K, 32 GB, Windows 11, a single run):

| Operation | Result |
|---|---|
| Snapshot on install with 820 open tabs | 820 records in 391 ms, no duplicates |
| Import wizard: archive 805 tabs | 9.7 s, 0 failures; pinned/active/audio/excluded stay open |
| Kill the browser (taskkill) in the middle of the bulk close | 0 lost references, 0 duplicates, at every point tested |
| Restart | same identifiers, archive intact |
| Reopen 50 | 2.1 s, never more than 3 loading at once |
| Panel with 10,000 records | loads in 236–344 ms, search ~150 ms, ≤ 40 rows in the DOM |
| Browser memory | 1.22 GB with 820 tabs → 0.80 GB after restarting with 15 |

Not covered yet: stable Chrome with a real profile, the popup and keyboard shortcuts in
headed mode, and real alarm timings. See the limitations section in
[docs/TESTING.md](docs/TESTING.md).

## Security and license

- To report a vulnerability, follow [SECURITY.md](SECURITY.md).
- Fangio is free software under the [GPL-3.0](LICENSE.txt) license.
