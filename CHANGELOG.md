# Changelog

Versions are the thing deployments pin to — `doorman_version` in the homelab
repo is a tag from this file, not a commit SHA.

## Unreleased

### Added

- **Every tab has its own address** - `/themes`, `/images`, `/sounds`,
  `/calendar`, `/history`, `/settings`. Back and Forward move between tabs,
  the nav items are real links (middle-click or Cmd/Ctrl-click opens one in
  a new browser tab), and a tab can be bookmarked. Old `#sounds`-style
  links still work. The browser tab's title names the page, as in
  "Sounds · Doorman".
- **Zoom in the sound editor.** The + and − buttons, Ctrl/⌘ + scroll or a
  trackpad pinch zoom around the pointer; **Selection** zooms to what is
  selected and **All** shows the whole sound. Zoomed in, the server decodes
  just that stretch again, so the gaps between words are sharp rather than
  the overview stretched. A strip underneath shows the whole sound with
  where you are boxed; drag it, or scroll sideways, to move. Playback turns
  the page as it runs off the edge. Arrow keys on a handle move it in finer
  steps the further in you are.
- The waveform is taller and drawn to the sound's loudest moment, so quiet
  recordings and the silences in them show clearly. Each handle shows its
  time, and a ruler along the bottom shows where you are.

### Changed

- **The sound editor is simpler.** Play controls and zoom sit above the
  waveform, then Start, End and the fades in one row, then the name.
  Volume levelling and "Put it on the doorbell now" are under More
  options. **Hear the result** sits next to Add to library. Space plays
  the selection.

### Fixed

- **Playing a selection played from the very start.** Sounds being trimmed
  were served without byte ranges, and without those Chrome cannot seek an
  audio file, so every jump to a point snapped back to zero. Library
  sounds on the Sounds tab are served the same way now too.
- **A ring sound that could not be set no longer shows as a green toast.**
  The image being right made the result "unchanged", which read as
  success. The toast now leads with "ring sound NOT set" and shows in red.

## 0.11.1 - 2026-11-15

### Fixed

- **Apply now puts a library sound on the doorbell.** The button skipped the
  ring sound cache that the 04:00 roll uses, so a theme whose sound is in the
  library changed its picture but left the ringtone alone, still pointing
  at one that no longer existed, and gave no reason. A sound that is skipped
  now always says why.

## 0.11.0 - 2026-11-15

### Added

- **Rename library sounds** in place on the Sounds tab. Themes point at a
  sound's content, so nothing breaks, and the name they show follows. A
  copy already on the doorbell keeps its old name there until it is next
  uploaded - Protect has no rename.
- **Replace…** on a sound that has no copy in the library opens Find a
  sound searching for it by name. Saving the replacement moves its themes
  and the default onto the library sound and deletes the old copy from the
  doorbell - or links it, if a doorbell is playing it at that moment.
  Unlike adopting, this does not assume the two are the same audio.
- **Themes pointing at a ringtone the console no longer has** - after a
  Protect migration - are re-linked to a library sound with the name they
  remember, as soon as one is there.

## 0.10.0 - 2026-11-15

### Added

- **Adopting sounds added through Protect.** Protect cannot hand a sound's
  audio back, so a sound uploaded there had no copy anywhere Doorman could
  restore it from, and was never removed to make room - which is how a
  console fills up with sounds Doorman cannot touch. Add the original file
  to the library under the same name and the two are linked: no second
  upload, and from then on Doorman may remove it to make room and put it
  back later. Themes and the default naming it by id move over to the
  library sound as it is adopted. The Sounds tab marks the sounds that
  still have no copy.
- **Doorman learns how many ring sounds the console really holds.** A live
  console refused an upload at 10, not 12. Once a refusal is shown to be
  about room (the retry after making room works), that number is
  remembered and room is made before uploading from then on.
- Every removal of a ring sound is logged, with what it made room for.

### Fixed

- **A doorbell could be left pointing at a ring sound that no longer
  existed**, and Apply now could not repair it. When a theme's sound cannot
  be put on, the default sound now plays instead, rather than the doorbell
  keeping one Protect has replaced with a hidden fallback.
- **Delete on the Sounds tab removed the sound a doorbell was playing.** It
  now refuses that, and the default, and refuses outright if it cannot
  tell what a doorbell is playing. Deleting one of Doorman's own copies
  says it stays in the library.
- **The cache would make room even when it could not read what the
  doorbells were playing**, treating "unknown" as "nothing". It now
  removes nothing in that case. It also never removes a ringtone a theme
  still names by id, which nothing could bring back.

## 0.9.0 - 2026-11-15

### Added

- **A waveform in the sound editor.** Drag handles to set the start and
  end, or nudge them with the arrow keys (Shift for a second at a time);
  the number fields stay, and follow along. Click anywhere on the waveform
  to play from there, or play just the selection, with a cursor that moves
  as it plays. The waveform is drawn by the server with ffmpeg, so it works
  for YouTube's WebM audio in browsers that cannot decode it themselves.
- **Fade in and fade out**, up to five seconds each, drawn on the waveform
  as the shape they give the sound.

## 0.8.0 - 2026-11-14

### Added

- **A sound library.** Ring sounds are kept by Doorman in `media/sounds/`,
  so there can be as many as you like, and the doorbell's dozen slots
  become a cache: a theme's sound is uploaded when the theme needs it, and
  when the slots are full the least recently used sound Doorman put there
  is removed first. Stock sounds, ones added through Protect, whatever a
  doorbell is playing and the default are never removed.
- Imported and uploaded sounds go into the library through the trim editor,
  with an option to put them on the doorbell straight away. The Sounds tab
  lists the library with listen, put-on-doorbell and delete.
- Sound pickers offer library sounds first, then what is only on the
  doorbell.
- The history says when a sound was uploaded and what was removed to make
  room.

### Fixed

- **Adding a sound failed with a bare 500** when the controller was full -
  Protect answers with an empty 400, and its real limit can be below the
  12 Doorman counted. A 400 now makes room and retries once, and when
  nothing can be removed the error says what to do.

### Changed

- **Upload sound** opens the trim editor and adds to the library, rather
  than sending the file straight to the controller.
- Themes using sounds already on the controller are unchanged; those sounds
  are listed as "only on the doorbell" and are never removed automatically.

## 0.7.1 - 2026-11-14

### Fixed

- **Add to library and Add to doorbell could never be clicked.** Both
  buttons were left disabled in the page from an earlier design where
  Preview had to come first, and nothing ever enabled them. They now work
  straight away, rendering the preview on the way if you skipped it.

## 0.7.0 - 2026-11-14

### Added

- **Find a GIF** without leaving the app: search Giphy, or paste a link to
  a GIF or a Giphy page. An editor crops it to a square, trims the start
  and end, and writes a 240×240 GIF capped at the frame count that always
  fits — so imports never need **Shrink**. **Crop** on a library tile opens
  the same editor on a GIF already there, writing a new copy.
- **Find a sound**: search Freesound (licence and author shown), or paste
  a link to an audio file. Trim it, preview it, and it is uploaded as a
  real MP3 with its loudness evened out to match the other ring sounds.
- **Audio from YouTube links**, when `yt-dlp` is installed. Off by
  default, and opt-in in Docker with `--build-arg WITH_YTDLP=true` —
  downloading from YouTube is against its terms, and `yt-dlp` has to be
  kept up to date.
- `GIPHY_API_KEY` and `FREESOUND_API_KEY`, both optional. Without one that
  search is not offered; pasting a link works either way.
- Imports wait in `staging/` beside the database while they are edited,
  not in the media library, and are swept after a day.

## 0.6.1 - 2026-10-24

## 0.6.0 - 2026-10-24

### Added

- **Themes remember the ring sound's name, not just its id.** Ringtone ids
  are issued per console, so migrating Protect to a different NVR
  invalidated every custom one at once and left themes pointing at nothing
  with no record of what they had wanted — the id alone cannot tell you
  which sound to re-upload.
- The Sounds tab now explains which themes are broken and what each wanted,
  and offers a **Re-link** button once the audio exists again under the
  same name. `themes.ts sounds` and `themes.ts sounds relink` do the same
  from the command line.
- Re-linking only ever touches a theme whose id does *not* resolve. A theme
  pointing at a live ringtone is left alone even if another shares its
  name, because while the id works it is the authoritative answer.

## 0.5.1 - 2026-10-24

### Fixed

- **`run.ts` was never made device-aware.** Left unchanged when doorbells
  moved into the database in 0.4.0, it passed no device to `apply()`, so
  the fallback id `"default"` was used — a different random seed from the
  scheduler, picking a different theme from the same schedule, and writing
  its rotation cursor and history under a doorbell that does not exist.
  Nothing failed; the CLI and the daemon just quietly disagreed. It now
  covers every enabled doorbell, or one named with `--device`.
- A test now reads every `apply()` call site and fails if one does not say
  which doorbell it means. Node strips types rather than checking them, so
  making the field required would not have caught this.

## 0.5.0 - 2026-10-04

### Added

- `themes.ts devices` — list, add, rename, enable, disable and remove
  doorbells from the command line, referring to them by name or by id.
  Adding one checks the controller actually has that camera, so a typo is
  an error now rather than a doorbell that silently fails every roll.
- `themes.ts add --doorbells "Front,Back"` scopes a theme. Omitted means
  every doorbell, matching the UI. An ambiguous name is rejected rather
  than guessed.
- `themes.ts list` shows which doorbells each theme applies to, once there
  is more than one.
- `probe` marks which discovered cameras are already configured, and warns
  about **configured doorbells the controller no longer has** — the case
  that otherwise fails every roll with no other symptom.
- Icons throughout the UI: the nav, the action buttons and the doorbell
  rows. Inline SVG that inherits the current text colour, so one copy
  works on light, dark and the selected tab. Below 860px the nav labels
  give way to icons alone rather than wrapping to a second row.

## 0.4.0 - 2026-10-04

### Added

- **More than one doorbell.** Doorbells are now rows in the database with
  names you choose, managed in a new **Settings** tab: discover them from
  the controller, rename, disable or remove. `PROTECT_CAMERA_ID` becomes
  the bootstrap for the first one, so a headless install is unchanged.
- **Themes can be scoped to doorbells** with *Applies to*. Empty means
  every doorbell — the default that stops adding a second one silently
  unscheduling the first.
- Each doorbell rotates **independently**: the random pick is seeded by the
  date and the doorbell, so two doors sharing a library do not show the
  same GIF every day. Still deterministic, so the calendar preview is still
  exact.
- The dashboard shows a card per doorbell, each with its own Apply button;
  the calendar has a doorbell picker; history records which one.
- **Settings** also holds the selection mode, the hour themes change, and
  the default ring sound. Each falls back to its environment variable and
  says which it is currently using.

### Changed

- Rotation state — the cursor, what was last set, the audit trail — is now
  per doorbell. Images are still uploaded once and shared, because the
  asset lives on the NVR that all of them read from.
- A roll only counts as done when every doorbell succeeded, so a partial
  failure stays retryable instead of leaving one door on yesterday.
- **Your existing rotation will pick a different GIF today.** The device id
  is part of the random seed now, which changes the sequence once. The
  schedule and every theme are untouched.

## 0.3.1 - 2026-10-04

### Fixed

- The calendar container still carried `class="cal"`, so the month sections
  were laid out as items in a seven-column grid — each month squeezed to a
  seventh of the width with the text wrapping one letter per line.
- The per-month badge said "seasonal" while counting any prioritised theme,
  including a Friday-night one. It says "scheduled" now.

## 0.3.0 - 2026-10-04

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
