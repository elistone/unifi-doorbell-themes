# Changelog

Versions are the thing deployments pin to — `doorman_version` in the homelab
repo is a tag from this file, not a commit SHA.

## Unreleased

### Added

- **Poster-frame thumbnails** for the image library and theme list, cached
  on disk and keyed by content hash — so a changed file is a different
  thumbnail and nothing needs invalidating. The Images tab was pulling
  47&nbsp;MB and decoding 31 animations at once. Hovering a tile still
  plays the real GIF, and the Now panel always does.
- Uploads are checked for the `GIF87a`/`GIF89a` header, not just a `.gif`
  on the end of the name, and served media carries
  `X-Content-Type-Options: nosniff`.

### Changed

- **The calendar is a calendar now.** Grouped by month with weekday
  columns, so the days line up the way a wall calendar does — the old flat
  run of cells could not answer "which day is that?", which is most of the
  point. Each day shows a thumbnail of what would appear, weekends are
  tinted, and seasonal themes stand out against the everyday rotation.
- Switching tabs scrolls back to the top. Arriving at a new tab already
  halfway down the previous one was disorienting on the two long ones.

## 0.2.2 - 2026-10-04

### Added

- **GitHub Actions.** CI runs the tests, an import check and a Docker build
  on every push to `main` and every pull request against it. A release
  workflow publishes a GitHub release when a `v*` tag is pushed, using the
  matching CHANGELOG section as the notes.
- `scripts/check-imports.mjs` verifies every relative import in `src/`
  resolves. Run against a fresh checkout it catches a file that exists
  locally but was never committed — the bug that shipped `check` and `fit`
  without the module they import.
- `scripts/changelog-for.mjs` extracts one version's section, so release
  notes and the changelog cannot drift apart.
- `npm run check` for tests plus the import check.
- The README now covers setup properly: getting the API key and camera id,
  running from source, Docker and systemd, every environment variable,
  reverse proxies, what to back up, and troubleshooting including how to
  recover a lost account.

### Fixed

- Workflow actions pinned to `@v5`; `@v4` targets Node 20, which GitHub
  has deprecated and now force-runs on 24 with a warning on every run.
- `engines.node` said `>=22.6`, which the project could not honour: Node
  only strips TypeScript without a flag from **23.6**, and nothing here
  passes one. Corrected, and the container already shipped 24.

## 0.2.1 - 2026-10-04

### Added

- A thin progress bar at the top of the page during any request, driven by
  a counter inside the one `api()` wrapper, so every call shows it without
  each caller remembering to. Indeterminate, because the server does not
  report progress and a bar that invents a percentage is a lie that always
  stalls at 90%.
- Skeleton placeholders for all six tabs, shaped like the content that is
  coming so the layout does not jump when it lands. The Images tab needed
  it most: ffprobe decodes every frame of every GIF to count them.
- A spinner on the page while the first `/api/session` call is in flight.
  On a cold container the page was blank long enough to look broken.
- Spinners on the sign-in, create-account, save-theme and change-password
  buttons, which also disable them against a double submit. Creating an
  account is the slowest of these by design — scrypt is deliberately slow.
- A render that fails now replaces its skeleton with an error, instead of
  shimmering forever and reading as "still loading".

### Changed

- The account-creation username field no longer suggests a name.

## 0.2.0 - 2026-10-04

### Added

- **Accounts.** Doorman now has its own login instead of relying on a shared
  credential at the reverse proxy. Passwords are scrypt-hashed; sessions are
  random tokens of which only a digest is stored, in an HttpOnly,
  SameSite=Strict cookie.
- **First-run setup.** With no account the UI offers to create one. There is
  deliberately no seeded default: a default credential nobody is forced to
  change is the same as no credential.
- Change password from the UI, which revokes every other session, and sign
  out, which revokes the current one server-side rather than just dropping
  the cookie locally.
- Repeated failed logins lock an account for a minute. Per account, so one
  under attack cannot lock out another.

### Changed

- Every route except `/health`, `/api/session`, `/api/setup`, `/api/login`
  and the login page's own assets now requires a session — the media
  thumbnails included.
- `/health` moved into the router's table, so there is one place routes live
  and the list of public ones can be read against it.

### Fixed

- The two **Upload** buttons were `<label class="btn">` and the stylesheet
  only matched `button.btn, a.btn`, so the most important action on the
  Images and Sounds tabs rendered as plain grey text. The button styles are
  element-agnostic now.
- Clicking the account icon called `show(undefined)` and hid every section,
  leaving a blank page behind the dialog — it sits in the nav and the tab
  wiring grabbed it.
- `scripts/release.sh` would happily add a second heading for a version the
  changelog already documented, which is exactly what happened cutting
  v0.1.0 by hand. It now refuses, and says to write notes under
  `## Unreleased`.

## 0.1.0 - 2026-10-04

The first tagged release, and the first with a web UI.

### Added

- **Web UI** at the service root. Six views: what is on the doorbell now,
  themes, the image library, ring sounds, a calendar preview, and history.
  No framework and no build step, same as the rest of the project.
- **Calendar preview** — what would show on each of the next N days, computed
  with the same `decide()` the scheduler runs. The answer to "will Christmas
  actually win?" without waiting until December.
- **JSON API** under `/api/`, which the UI is a client of. Themes, media,
  ring sounds, history, selection mode, and a manual apply.
- Image upload, delete, and in-place shrinking for GIFs too long to fit.
- Ring sound upload and delete, with the 12-slot cap enforced up front.
- `/health` now reports the running version.

### Fixed

- A theme with no sound of its own inherited the previous theme's ringtone,
  so one seasonal theme leaked its sound into the everyday rotation
  permanently. "No sound" now means the default one.
- The skip-unchanged path returned before reconciling the sound, which made
  a wrong ringtone unrepairable — every roll saw the right image and
  returned. This hid the fix above completely.
- Uploads had the same 30s timeout as a metadata read, but the NVR builds the
  sprite before replying. An 88-frame GIF timed out while succeeding
  server-side, leaving an asset nothing had a record of. Uploads get 300s.
- `src/media/` was excluded from every commit by an unanchored `.gitignore`
  rule, so `check` and `fit` shipped without the module they import.

## 0.0.1

Pre-release: the scheduler, the CLI, and the Ansible deployment. Tagged
retroactively as a rollback point for the first deployed build.
