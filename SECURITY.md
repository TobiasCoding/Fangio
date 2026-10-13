# Security policy

## Supported versions

Only the **latest published version** in
[Releases](https://github.com/TobiasCoding/Fangio/releases/latest) receives security fixes.
Update with `update.cmd` / `update.ps1` / `update.sh` (see
[docs/INSTALL.md](docs/INSTALL.md#updating)).

## How to report a vulnerability

**Don't open a public issue.** Use GitHub's private reporting:

1. Go to the repository's [**Security**](https://github.com/TobiasCoding/Fangio/security)
   tab.
2. Click **Report a vulnerability** and fill in the form.

If you can, include: Fangio and browser versions, operating system, steps to reproduce,
expected impact and a minimal proof of concept. Please don't include real personal data
(for example, your own tab export).

What you can expect:

- Acknowledgement within 7 days.
- An initial assessment and a plan within 30 days.
- Credit in the release notes of the fixed version, if you wish.

## Scope

Of particular interest:

- Data loss or corruption (tabs closed without a saved reference, records deleted outside
  the trash policy).
- Data leaks: any path through which information about your tabs leaves the computer.
- Code execution or injection in the panel or the popup (for example, through malicious
  titles, URLs or import files).
- The `install.ps1`, `update.ps1` and `update.sh` scripts: integrity verification (SHA-256
  and manifest name), path handling and rollback on failure.
- The publishing pipeline (`.github/workflows/`).

Out of scope: issues that require prior access to the computer or to the browser profile
with user permissions, and the limitations documented in the README.

## Threat model, in short

- Fangio has no server or accounts; the data lives in IndexedDB inside the profile.
- It has no content scripts, and its only host permission is optional (automatic
  thumbnails); the CSP of its pages only allows its own scripts (`script-src 'self'`).
- Releases are built in GitHub Actions from the tag, unminified, and published with their
  SHA-256. The updaters verify that checksum and that the downloaded manifest is Fangio's.
- The checksum is downloaded from the same release as the zip: it protects against
  corrupted or incomplete downloads, not against a compromise of the project's GitHub
  account.
