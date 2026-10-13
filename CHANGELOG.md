# Changelog

All notable changes to Fangio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/). Each version's notes are also published on
the [releases](https://github.com/TobiasCoding/Fangio/releases) page.

## [Unreleased]

## [1.1.1] - 2026-10-13

### Important: updating from v1.1.0

The manifest no longer has a `key` (the Chrome Web Store rejects packages that include it).
To the browser, v1.1.1 is **a different extension with a different database**, and the
v1.1.0 updater refuses to install it ("the key doesn't match"). To move over without losing
anything: **export a JSON backup** in the old version (Panel → Copias), install v1.1.1 and
**import** that backup. Tabs that are still open are joined to their record instead of being
duplicated. From v1.1.1 on, `update.*` works across versions again (as long as you don't move
the folder).

### Added

- **Delete** removes without asking: the reference in the detail pane (or the selection) goes
  to the trash, closing its tab if it is open; if it was already in the trash, it is
  permanently deleted. On Mac, `Cmd+Backspace`.
- **Archived-duplicates rule** (on by default, in Reglas): of several archived references
  with the identical URL and no data of their own (note, tags, project, to-do or protected),
  only one is kept; the rest go to the trash. References with data are left alone. To get
  the copies back: disable the rule and undo from Registro.
- **Card design** (*Diseño de tarjetas*): choose the image (none / thumbnail), size
  (compact / comfortable) and what to show (site, date, URL, marks and tags, status,
  per-site colors).
- Importing a JSON backup from another installation joins the records that were open with
  the same URLs open here (keeping notes, tags, marks and dates).

### Changed

- **Cards** redesigned: a single compact block (icon and site, title, marks and date),
  minimal by default, with no image or colors.
- Deleting is simpler: you no longer have to type `ELIMINAR`. "Eliminar definitivamente"
  (Delete permanently) and "Papelera" (Trash) don't ask for confirmation; "Vaciar papelera"
  (Empty trash) asks for a simple confirmation.
- When installed from the Chrome Web Store, Fangio doesn't query GitHub or show the
  `update.ps1` notice (the store updates it).
- `install.ps1`, `update.ps1` and `update.sh` recognize Fangio by the manifest name (no
  longer by the `key`) and keep installing into the same folder.

### Fixed

- The "Eliminadas" (Deleted) notification no longer offers "Deshacer" (Undo) (permanent
  deletion cannot be undone).
- `update.ps1` / `update.cmd` couldn't find the installed folder when run with Windows
  PowerShell 5.1 (`$PSScriptRoot` is empty as a parameter's default value) and asked for
  `-InstallDir`. They now use the script's folder.
- `update.cmd` launched from PowerShell 7 failed with "Get-FileHash is not recognized":
  Windows PowerShell inherited PowerShell 7's module path. `update.cmd`, `update.ps1` and
  `install.ps1` now use only Windows PowerShell's modules.

## [1.1.0] - 2026-10-11

### Added

- **List views**: List, **Cards** (page thumbnail or a poster generated from the site's color
  and icon), **Timeline** (by day and by work session, with an hourly activity histogram and
  selection of a whole day or session) and **Topics**. All of them share search, filters,
  selection and actions.
- **Suggested topics**: local contextual analysis that groups related references even when
  they come from different sites, combining shared words (titles, what you searched for on
  Google/Bing/YouTube/Mercado Libre and words in the URL), closeness in time and structure
  (opener tab, Chrome tab group, project). It shows the path (search → AI chat → sites), the
  shared terms and the affinity, and lets you select, assign a project, tag, create a Chrome
  tab group, reopen, archive or dismiss the suggestion. Research and design in
  `docs/CONTEXT.md`.
- **Name with local AI** (optional): uses the Gemini Nano model built into Chrome, on the
  device, to name groups and flag titles that don't belong. It only appears if the browser
  and the computer support it.
- **Page thumbnails** (optional, off by default): reduced capture of the visible tab, stored
  only locally, never in backups. Its own exclusions, a filter for sensitive pages and a
  button to delete them.
- The **opener tab** of each new tab is recorded (`openerId`) and included in JSON backups.

### Changed

- Database version 2 (additive migration: new `thumbs` store; records don't change).
- Permissions: adds `activeTab` (no warning) and the **optional** host permission
  `<all_urls>`, which is only requested when automatic thumbnails are enabled.

## [1.0.0] - 2026-10-10

First public version.

### Added

- Local tab archive in IndexedDB: every open tab is recorded from installation on (initial
  snapshot of all windows) and updated with every change.
- Five-step safe close: save → confirm write → revalidate → close → record. If anything
  doesn't match, the tab stays open.
- Protections that always take precedence: protected, pinned, active and selected tabs,
  tabs with audio, excluded sites, incognito and internal pages.
- Full panel with search (title, URL and note), filters (status, domain, tags, project,
  to-dos, protected), a virtualized list and bulk actions.
- Popup for the current tab: archive, protect, mark as to-do, note and tags.
- Keyboard shortcuts: `Alt+Shift+F` opens the panel and `Alt+Shift+A` archives the current
  tab.
- Initial import wizard with a backup first.
- Automatic rules (off by default) with a preview: inactivity, open-tab target (15 by
  default) and exact-URL rules.
- Duplicates view with manual merge.
- Trash with configurable permanent deletion (30 days by default; 0 = never).
- Action log with undo.
- Backups: versioned JSON export and lossless import, and HTML export in bookmarks format.
- Optional new-version notice (daily query to GitHub's releases API) and the
  `install.ps1`, `update.ps1` / `update.cmd` and `update.sh` scripts to install and update
  the extension folder.

[Unreleased]: https://github.com/TobiasCoding/Fangio/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/TobiasCoding/Fangio/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/TobiasCoding/Fangio/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/TobiasCoding/Fangio/releases/tag/v1.0.0
