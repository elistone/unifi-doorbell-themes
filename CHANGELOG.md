# Changelog

Versions are the thing deployments pin to — `doorman_version` in the homelab
repo is a tag from this file, not a commit SHA.

## Unreleased

### Fixed

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
