# Releasing Fangio

Maintainer guide. Summary: **a `vX.Y.Z` tag on `main` = a release**.

## Versioning

- Semantic versioning `X.Y.Z` (no suffixes: Chrome only accepts numbers in `version`).
  - `patch`: fixes without visible behavior changes.
  - `minor`: new compatible features; lossless database migrations.
  - `major`: incompatible changes (for example, a new export format).
- The single source of truth is `version` in `package.json`. `static/manifest.json` has
  `"version": "0.0.0"` as a placeholder: `scripts/build.mjs` injects the real version into
  `dist/manifest.json` and writes `dist/VERSION` (read by the updaters).
- Every relevant change is noted in the `## [Unreleased]` section of `CHANGELOG.md`
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format) in the same PR.

## Normal flow

```bash
git switch main && git pull
npm ci
npm run release -- patch     # or minor | major | X.Y.Z
git push origin main --follow-tags
```

`scripts/release.mjs`:

1. Requires the `main` branch, a clean tree, a tag that doesn't exist yet and notes in
   `[Unreleased]`.
2. Runs `npm run typecheck` and `npm test` on the clean tree.
3. Updates `package.json` and `package-lock.json`, moves the notes to
   `## [X.Y.Z] - YYYY-MM-DD`, updates the comparison links and runs `npm run build` (which
   fails if the version is not `X.Y.Z`). If anything fails, it restores the three files.
4. Creates the commit `release: vX.Y.Z` and the annotated tag `vX.Y.Z`.
5. Prints (doesn't run) `git push origin main --follow-tags`.

When it receives the tag, `.github/workflows/release.yml`:

1. Checks that the tag is exactly `v` + `package.json.version` (otherwise it fails).
2. `npm ci`, typecheck, tests, `npm run package` with `SOURCE_DATE_EPOCH` = the commit date
   (reproducible zip).
3. Creates the release with `gh release create` (CLI preinstalled on the runners,
   authenticated with `GITHUB_TOKEN`), marks it as *latest* and attaches `fangio-vX.Y.Z.zip`
   and `SHA256SUMS.txt`. The notes come from the `CHANGELOG.md` section (via
   `scripts/changelog-notes.mjs`) plus a footer with instructions and the SHA-256; if there
   is no section, it uses `--generate-notes`.

Installed extensions detect the release in their daily query to `/releases/latest`, and
`update.ps1` / `update.sh` install it.

## First version (1.0.0)

`package.json` is already at `1.0.0` and `CHANGELOG.md` already has its section. When given
the **current** version, the script only verifies, builds and tags (no version commit):

```bash
npm run release -- 1.0.0
git push origin main --follow-tags
```

## Release contents

`npm run package` (= `npm run build` + `scripts/package.mjs`) generates in `release/`:

- `fangio-vX.Y.Z.zip`: the contents of `dist/` at the root of the zip (`manifest.json`,
  `background.js`, `dashboard.*`, `popup.*`, `icons/`, `VERSION`, `update.ps1`,
  `update.cmd`, `update.sh`). JavaScript **unminified** and without *sourcemaps*, so anyone
  can audit what runs.
- `SHA256SUMS.txt`: `sha256sum` format (`<hash>  fangio-vX.Y.Z.zip`).

The zip is built without dependencies (`zlib` deflate, CRC-32, UTF-8 names). To inspect it:
`unzip -l release/fangio-vX.Y.Z.zip` or `Expand-Archive` in PowerShell.

## If something goes wrong

- **The workflow failed before creating the release**: fix it on `main`, delete the tag
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`) and publish again with a new
  version (preferred) or the same one.
- **The release went out with a problem**: don't replace files of a published release
  (users verify the SHA-256). Publish a new `patch` version.
- **The tag doesn't match `package.json`**: the workflow fails on purpose. Always use
  `npm run release`.

## Testing the installers locally

`install.ps1`, `update.ps1` and `update.sh` accept the `FANGIO_RELEASES_API` environment
variable (for testing only) to point to a local server that mimics
`https://api.github.com/repos/TobiasCoding/Fangio/releases` (routes `/latest` and
`/tags/vX.Y.Z`, with `assets[].name` and `assets[].browser_download_url`). That way you can
test installation, updating, SHA-256 verification and rollback on failure without
publishing anything. Syntax check:

```powershell
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw scripts/update.ps1), [ref]$null)
```

```bash
bash -n scripts/update.sh
```

The `.ps1` files are kept in pure ASCII (accents are written as `\uXXXX`), because Windows
PowerShell 5.1 reads BOM-less scripts with the ANSI code page.

## Continuous integration

- `.github/workflows/ci.yml`: on every push to `main` and every PR it runs `npm ci`,
  typecheck, tests and build, and uploads `dist/` as an artifact. Permissions:
  `contents: read`.
- `.github/workflows/release.yml`: described above. Permissions: `contents: write`.
- `.github/dependabot.yml`: weekly npm and GitHub Actions updates.

## Extension ID (no `key`)

Since v1.1.1 `static/manifest.json` does **not** have a `key`: the Chrome Web Store rejects
packages that include it, and the same release zip works for the store and for unpacked
installs. `npm run build` fails if someone adds it back.

- From the store, the ID is assigned by the store and updates are automatic (Fangio doesn't
  query GitHub or show the `update.ps1` notice if it detects `update_url` in the installed
  manifest).
- Unpacked, the ID depends on the folder. The updaters (`update.*`) replace the files in the
  same folder, so the ID and the database are kept.
- Up to v1.1.0 the ID was `domaedkeecbijcmbcjcfpjeabbdcmefb` (fixed by the `key`). Moving
  from that version to v1.1.1 requires exporting and importing the JSON backup (see
  INSTALL.md).

No private key (`*.pem`) or `*.crx` may be committed (they are in `.gitignore`).

## Recommended repository settings

- *Settings → Actions → General*: allow GitHub Actions. The workflows declare their own
  permissions, so the token's default can stay "read-only".
- *Settings → Security*: enable **Private vulnerability reporting** (used by
  [SECURITY.md](../SECURITY.md)) and Dependabot alerts.
- `main` branch protection (PR + green CI) and a rule restricting who can create `v*`
  tags.
