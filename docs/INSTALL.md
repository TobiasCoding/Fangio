# Installing, updating and uninstalling Fangio

Fangio is distributed as an **unpacked extension** from the
[GitHub releases](https://github.com/TobiasCoding/Fangio/releases). It works on Chrome 121
or later and on other Chromium browsers (Edge, Brave, Vivaldi, Opera…; the extensions page
has a different name, for example `edge://extensions`).

> [!WARNING]
> **Removing the extension deletes its database.** Reloading or updating it doesn't delete
> anything. Before uninstalling, moving the folder or switching profiles, export a backup
> from **Panel → Copias → Exportar JSON** (Backups → Export JSON).

## Installation

### Option A: release zip (any system)

1. Go to the [latest release](https://github.com/TobiasCoding/Fangio/releases/latest) and
   download `fangio-vX.Y.Z.zip` (and, if you want to verify it, `SHA256SUMS.txt`).
2. Verify the checksum (optional, recommended):
   - Windows (PowerShell): `(Get-FileHash .\fangio-vX.Y.Z.zip -Algorithm SHA256).Hash`
     and compare it with the value in `SHA256SUMS.txt` (case-insensitive).
   - Linux: `sha256sum -c SHA256SUMS.txt` · macOS: `shasum -a 256 -c SHA256SUMS.txt`.
3. Extract the zip into a **permanent folder** (the files go directly into it, next to
   `manifest.json`). Suggestions:
   - Windows: `%LOCALAPPDATA%\Fangio\extension`
   - Linux: `~/.local/share/fangio/extension`
   - macOS: `~/Library/Application Support/Fangio/extension`

   Don't use Downloads, the Desktop or temporary or synced folders: Chrome loads the
   extension from that folder every time it starts.
4. Open `chrome://extensions`.
5. Turn on **Developer mode** (toggle at the top right).
6. Click **Load unpacked** and choose the folder from step 3.
7. Pin Fangio to the toolbar: extensions menu (puzzle-piece icon) → pin.

### Option B: `install.ps1` (Windows)

Open PowerShell (no need to run it as administrator) and run:

```powershell
irm https://raw.githubusercontent.com/TobiasCoding/Fangio/main/scripts/install.ps1 | iex
```

Or download [`scripts/install.ps1`](../scripts/install.ps1) and run it as a file, which
lets you choose the folder or version:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallDir "$env:USERPROFILE\Apps\Fangio"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 1.0.0
```

The script queries the latest release, downloads the zip and `SHA256SUMS.txt`, **verifies
the SHA-256**, checks that the package is Fangio and copies it to
`%LOCALAPPDATA%\Fangio\extension` (by default). It copies the path to the clipboard and
shows you steps 4 to 7 of option A. If Fangio was already installed in that folder, it runs
the updater instead. It never touches browser profiles.

## First start

On installation, Fangio records all open tabs and opens the import wizard. Export a JSON
backup before archiving anything. See [First use](../README.md#first-use).

## Updating

1. When there is a new version, the Fangio panel shows a notice (the daily check can be
   turned off in the settings; you can also watch the releases page).
2. Run the updater that is **inside the installed folder**:
   - **Windows**: double-click `update.cmd`, or from PowerShell:
     `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Fangio\extension\update.ps1"`
   - **Linux / macOS**: `bash ~/.local/share/fangio/extension/update.sh`
     (needs `curl`, `unzip` and `sha256sum` or `shasum`).
3. In `chrome://extensions` click **Reload** on Fangio's card, or use the **Recargar
   extensión** (Reload extension) button in the panel's notice. **Your data is kept.**

What the updater does, step by step:

1. Reads the installed version (`VERSION` / `manifest.json`) and queries
   `https://api.github.com/repos/TobiasCoding/Fangio/releases/latest`.
2. If there is a newer version, it downloads `fangio-vX.Y.Z.zip` and `SHA256SUMS.txt` to a
   temporary folder and **verifies the SHA-256**. If it doesn't match, nothing is installed.
3. Extracts the zip and checks that the new `manifest.json` is Fangio's and of that
   version. The new files go into **the same folder**: an unpacked extension's ID depends on
   its folder, so the extension (and its database) stays the same.
4. Moves the current files to a sibling backup folder, copies the new ones and, if anything
   fails, restores the previous ones. When done, the previous version is left in
   `<folder>.previous` (for example `...\Fangio\extension.previous`).
5. It never touches your browser profile: Fangio's database lives there and is not
   modified.

Options: `-Force` / `--force` reinstalls the same version; `-Version X.Y.Z` /
`--version X.Y.Z` installs a specific version (useful for rolling back; if you downgrade,
export a JSON backup first); `-InstallDir` / `--install-dir` sets the folder if you run the
script from somewhere else.

### Rolling back to the previous version

Run the updater with `-Version X.Y.Z` (or `--version X.Y.Z`), or swap the contents of the
folder with those of `<folder>.previous` and click **Reload**.

### Why it doesn't update itself

Chrome Web Store extensions update themselves. Fangio is not published there and, outside
the store, Chrome offers no automatic update path for regular Windows or macOS users:

- The official documentation recognizes only two distribution mechanisms: the Chrome Web
  Store and self-hosting. On Windows and macOS, self-hosted extensions can only be installed
  through **enterprise policies** (managed computers), and unpacked extensions are meant for
  loading trusted code during development.
  Source: [Distribute your extension](https://developer.chrome.com/docs/extensions/how-to/distribute).
- Linux is the only platform where extensions hosted outside the store can be installed (a
  signed `.crx` with an `update_url` that Chrome checks every few hours).
  Source: [Self-host for Linux](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux).
- Since Chrome 33 (Windows) and 44 (macOS), external installs from a local `.crx` are not
  allowed, and on those platforms the `update_url` of the alternative installation methods
  must point to the Chrome Web Store.
  Source: [Use alternative installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).
- An extension loaded with **Load unpacked** has no update mechanism: Chrome uses the files
  in the folder as they are and rereads them when you click **Reload**.

That is why Fangio's loop is: daily notice inside the extension → local updater that
replaces the files in a verified way → **Reload**. Since the folder doesn't change, neither
does the extension ID: the reloaded version is the same extension and keeps its database.
(Installed from the Chrome Web Store, the store updates it and none of this is needed.)

### Moving from v1.1.0 (or earlier) to v1.1.1

Up to v1.1.0 the manifest had a `key` that fixed the ID. v1.1.1 no longer has it, so **it
is a different extension with a different database** and the v1.1.0 updater refuses to
install it ("the key doesn't match"). To move over without losing anything:

1. In the old version: **Panel → Copias → Exportar copia JSON** (Backups → Export JSON
   backup).
2. Remove the old version in `chrome://extensions` (or leave it disabled until you have
   checked the new one).
3. Install v1.1.1 (unpacked, with `install.ps1`, or from the Chrome Web Store).
4. In the new one: **Copias → Importar JSON** (Backups → Import JSON) with the file from
   step 1. Tabs that are still open are joined to their record (no duplicates) and get their
   notes, tags and dates back.

## Uninstalling, moving or switching computers

1. **Export a JSON backup** (Panel → Copias). Optionally, the bookmarks HTML too.
2. Uninstall: **Remove** in `chrome://extensions` (this **deletes the database**), then
   delete the install folder and `<folder>.previous`.
3. To move the folder, or switch to another computer or profile: install in the new
   location and import the JSON backup in **Copias → Importar JSON**. Don't move the folder
   of a loaded extension without exporting first.

## Troubleshooting

- **"Manifest file is missing or unreadable"**: you chose a folder one level too high or
  too low; it must be the one that contains `manifest.json`.
- **The extension stopped loading after moving or deleting the folder**: Chrome can't find
  it. Put it back in place and click **Reload**.
- **Chrome shows a warning about extensions in developer mode**: this is normal for
  unpacked extensions; you can dismiss it.
- **PowerShell says running scripts is disabled**: use `update.cmd` or
  `powershell -NoProfile -ExecutionPolicy Bypass -File ...` (it only affects that command).
- **The v1.1.0 updater says the key doesn't match** when moving to v1.1.1: this is expected
  (v1.1.1 no longer has a `key`). Follow the steps in
  [Moving from v1.1.0 (or earlier) to v1.1.1](#moving-from-v110-or-earlier-to-v111).
