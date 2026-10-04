# Doorman

Scheduling, grouping and randomisation for **UniFi G4 Doorbell Pro** welcome
images and ring sounds.

Protect lets you set a welcome image and a ring sound. It will not let you pair
them, rotate them, or change them by date — so the Christmas GIF goes up in
December and comes down in March, because changing it is a chore.

Doorman adds:

- **Themes** — one image and one sound, kept together
- **Schedules** — date windows, weekdays, times of day, with priorities
- **Rotation** — a different theme each day, randomly or in sequence

## Status

**Working, and running on real hardware daily.** Images and sounds are both
proven; the scheduler, the web UI and an Ansible deployment are built. It is
still young enough that you should read [docs/DESIGN.md](docs/DESIGN.md)
before trusting it with anything you care about.

## What you need, honestly

This is published in the hope it is useful, **not supported**. Before you start:

- A **G4 Doorbell Pro**. The Doorbell Lite has no screen. The G6 Entry Pro's
  touchscreen may or may not work the same way — nobody has checked.
- **Protect 6.1 or later.**
- An **API key** for the welcome images — Protect → Settings → Control Plane →
  Integrations.
- A **UniFi OS admin login**, if you want custom ring sounds. Images need only
  the API key; sound uses Protect's private API, which wants a real account.

## Getting started

Nothing here writes to the doorbell until you tell it to, and every step can
be undone.

### 1. Get the three things it needs

**An API key.** In Protect: *Settings → Control Plane → Integrations → Create
API Key*. This is enough for welcome images on their own.

**The controller address.** The IP or hostname of your UniFi OS console, for
example `192.168.1.1`. Not the doorbell's own address — the doorbell is
reached through the console.

**A UniFi OS admin login**, only if you want to change the ring sound. Images
need just the API key. Sound uses Protect's private API, which wants a real
account. Leave it out and everything else still works.

### 2. Check it can talk to your doorbell

```bash
git clone https://github.com/elistone/unifi-doorbell-themes.git doorman
cd doorman
cp .env.example .env
$EDITOR .env          # fill in PROTECT_HOST and PROTECT_API_KEY

node --env-file=.env src/cli/probe.ts
```

Nothing is installed, because there is nothing to install — no dependencies
and no build step. You need **Node 23.6 or newer** (24 is what ships in the
container) and **ffmpeg** on your `PATH` if you want the GIF checker.

`probe` changes nothing. It prints your Protect version and every camera that
can display an image:

```
Protect 7.2.105

Cameras that can display an image:
  6489eedb0237c203e400ce18  Front Doorbell (UVC G4 Doorbell Pro)
      state=CONNECTED  showing=nothing
```

**Copy that id into `PROTECT_CAMERA_ID` in your `.env`.** It is taken
explicitly rather than discovered: the public API does not expose which
cameras have a screen, and guessing from the model name is how you end up
sending images to something that cannot show them.

If `probe` fails here, stop — nothing else will work until it does. See
[Troubleshooting](#troubleshooting).

### 3. Start it

```bash
mkdir -p data media
node --env-file=.env src/cli/serve.ts
```

Then open <http://localhost:8080>. It will ask you to **create an account** —
there is no default username or password, on purpose.

### 4. Add some GIFs and a theme

Drop GIFs into `media/`, or upload them from the **Images** tab. Then make a
theme on the **Themes** tab: pick an image, optionally a sound, and say when
it applies.

Until at least one theme exists the scheduler does nothing at all and reports
`no theme is eligible`, which is correct rather than broken — it will not
touch a doorbell you have not configured.

Check your work on the **Calendar** tab before waiting for December.

## More than one doorbell

Doorman drives as many as you have. Add them in **Settings → Doorbells**,
where they are discovered from the controller and given a name you choose —
"Front door" reads better on a theme than `6489eedb0237c203e400ce18`.

Each doorbell **rotates independently**: two of them sharing the same themes
will show different GIFs on the same day, because the random choice is seeded
by the date *and* the doorbell. It stays deterministic, so the calendar still
predicts a year ahead for each one.

A theme can be restricted to particular doorbells with **Applies to** in the
theme editor. Leaving it empty means **every** doorbell, which is the default
on purpose: adding a second doorbell must not silently unschedule the first,
and themes written before you had two keep working untouched.

Removing a doorbell keeps its themes and history. A theme that applied *only*
to it is **disabled** rather than quietly spread across the others — the one
case where "no doorbells" would otherwise flip from "just that one" to "all
of them".

### From the command line

`probe` reports which cameras are configured as doorbells and — more
usefully — which configured doorbells the controller no longer has, since
that one fails every roll with no other symptom.

```bash
node src/cli/themes.ts devices                      # list them
node src/cli/themes.ts devices add <camera-id> "Front door"
node src/cli/themes.ts devices rename "Front door" "Porch"
node src/cli/themes.ts devices disable "Porch"
node src/cli/themes.ts devices remove "Porch"

# Scope a theme, by name or id
node src/cli/themes.ts add --id xmas --image Elf_santa.gif \
     --dates 12-01..12-26 --doorbells "Front door,Back door"
```

Omitting `--doorbells` means every doorbell, matching the UI. An ambiguous
name is an error rather than a guess — silently scoping a theme to the wrong
door is not a mistake you notice until the wrong GIF is on the wrong door.

## Running it for real

### Docker

The container has ffmpeg already, which the GIF tools need.

```bash
docker build -t doorman .

docker run -d --name doorman   --restart unless-stopped   -p 8080:8080   -v "$PWD/data:/data"   -v "$PWD/media:/media"   --env-file .env   doorman
```

Both volumes matter. `/data` is the database — themes, accounts and the
record of what has already been uploaded. `/media` is your GIF library, and
it is the half that cannot be recreated: a theme takes a minute to rebuild, a
GIF somebody made for Halloween does not.

**Pin a release rather than building `main`.** Tags are what releases are cut
as, and rolling back is then a name you can read:

```bash
git checkout v0.2.1 && docker build -t doorman:v0.2.1 .
```

### systemd, without Docker

```ini
# /etc/systemd/system/doorman.service
[Unit]
Description=Doorman
After=network-online.target

[Service]
Type=simple
User=doorman
WorkingDirectory=/opt/doorman
EnvironmentFile=/opt/doorman/.env
Environment=DOORMAN_DB=/opt/doorman/data/doorman.sqlite
Environment=DOORMAN_MEDIA=/opt/doorman/media
ExecStart=/usr/bin/node src/cli/serve.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Ansible

The deployment this was written for lives in a separate repo and is not
required, but it is a worked example: it builds the image from a pinned tag
on the host, mounts both volumes, puts it behind Traefik and backs up the
database and media library nightly.

## Configuration

Everything is an environment variable. Only the first three are required.

| Variable | Default | What it does |
|---|---|---|
| `PROTECT_HOST` | — | **Required.** UniFi OS console address. |
| `PROTECT_API_KEY` | — | **Required.** Protect → Settings → Control Plane → Integrations. |
| `PROTECT_CAMERA_ID` | — | The first doorbell, adopted on first run. From `probe`. Optional once any doorbell exists — after that they live in the database and are managed in Settings. |
| `PROTECT_ADMIN_USER` | — | UniFi OS login. Needed for ring sounds and for deleting assets. |
| `PROTECT_ADMIN_PASS` | — | As above. Without both, images still work. |
| `PORT` | `8080` | HTTP port. |
| `DOORMAN_DB` | `data/doorman.sqlite` | Database file. |
| `DOORMAN_MEDIA` | `media` | GIF library directory. |
| `DOORMAN_ROLL_HOUR` | `4` | Local hour to change theme. 4am: nobody is at the door. Overridable in Settings. |
| `DOORMAN_TICK_SECONDS` | `300` | How often to notice the date changed. |
| `DOORMAN_DEFAULT_RINGTONE` | — | Ringtone id for themes that name none. Without it, a theme with no sound keeps whatever the last one set — so one seasonal sound leaks into the rotation forever. Overridable in Settings. |
| `DOORMAN_SECURE_COOKIES` | `false` | Set `true` when something in front terminates TLS. |
| `NOTIFY_URL` | — | Pinged on apply, failure and stall. `{status}` and `{msg}` are substituted. |
| `NOTIFY_METHOD` | `POST` | |
| `PROTECT_INSECURE_TLS` | `true` | Consoles ship a self-signed certificate. Set `false` if yours has a real one. |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | If they are not on `PATH`. |

## Behind a reverse proxy

Doorman authenticates for itself, so it does not need a second password in
front of it. Point your proxy at the port and set `DOORMAN_SECURE_COOKIES=true`
so the session cookie carries `Secure` — the app only ever speaks plain HTTP
and cannot detect TLS on its own.

Leave `/health` reachable if you monitor it; it is the one route that answers
without a session, and its **status code** is the signal (503 means nothing
has applied in 25 hours).

## What to back up

- **`media/`** — the irreplaceable half.
- **the database** — themes, your account, and the record of what has already
  been uploaded to the NVR.

Stop the container before copying the database. SQLite runs in WAL mode, and
copying it while it is being written gives you a file that looks fine until
the day you restore it.

## Troubleshooting

**`probe` says the version is too old.** Welcome-image upload arrived in
Protect 6.1.

**`probe` finds no cameras that can display an image.** The doorbell needs a
screen. The G4 Doorbell Pro is the proven one; the Lite has no screen.

**A GIF is rejected on upload.** Protect rebuilds every GIF into a 240×240
sprite sheet and enforces 1 MB on *that*, not on your file. Frame count is
what decides. The **Images** tab predicts it per file, and offers to shrink
anything that will not fit. Nothing is lost — it writes a new file.

**The ring sound never changes.** Ring sounds need `PROTECT_ADMIN_USER` and
`PROTECT_ADMIN_PASS`; with only an API key the image half works alone. The
**Now** tab says `no admin credentials` when that is the reason.

**Everything works, but nothing happens.** With no theme eligible the
scheduler deliberately leaves the doorbell alone. Check the **Calendar** tab.

**You are locked out.** Five failed sign-ins lock an account for a minute;
that clears on its own, and a restart clears it immediately.

If you have genuinely lost the password, delete the account and the UI offers
first-run setup again. Your themes, images and history are untouched:

```bash
# Running from source
node -e 'const {DatabaseSync}=require("node:sqlite");
new DatabaseSync("data/doorman.sqlite").exec("DELETE FROM users; DELETE FROM sessions;")'

# In the container
docker exec doorman node -e 'const {DatabaseSync}=require("node:sqlite");
new DatabaseSync("/data/doorman.sqlite").exec("DELETE FROM users; DELETE FROM sessions;")'
```

(There is no `sqlite3` binary in the image — `node:sqlite` is built in, which
is why the database needs no driver in the first place.)

## About the sound half

Both halves work over HTTP. **No SSH, no recovery codes, no re-applying after
a reboot** — which is what every other project in this space has to do.

The doorbell's own speaker honours `speakerSettings.ringtoneId`, so changing
what a visitor hears is one API call. This was established by experiment
rather than documentation: no library implements it, and the reasonable
reading of the API is that a camera's `ringtoneId` drives a *paired chime*.
On a system with no chime at all, setting it and pressing the button played
the chosen sound at the door.

The cost is that sound lives on Protect's **private** API rather than the
documented one, so it needs a **UniFi OS admin login** as well as the API key,
and it is the half likely to break when Ubiquiti ships a major Protect
release. Images stay on the official API precisely so that only half the app
is exposed to that.

One asymmetry worth knowing: **images are uncapped, sounds are limited to 12**
on the controller. So the image library can grow freely, and the sound library
needs evicting when it fills.

## How it decides

Several themes can be eligible at once. The one that applies is chosen by:

1. **Eligibility** — a theme is eligible when any of its rules matches now. A
   rule is a date window, a set of weekdays, a time of day, or a combination;
   everything in one rule must match.
2. **Priority** — the highest priority among eligible themes wins outright.
   This is what makes "Christmas beats Friday evening" work without ordering
   anything by hand. (25 December 2026 is a Friday.)
3. **Selection** — if several tie at the top, one is picked per day, either
   randomly or in rotation.

Random is seeded by the date, not by chance: the same day always gives the same
answer, so a dry run predicts exactly what the scheduler will do.

Date windows wrap, so `12-20` to `01-05` means what you would expect. So do time
windows: `22:00` to `06:00` crosses midnight.

## Trying it without waiting for Christmas

```bash
node src/cli/probe.ts                                   # will this work at all?
node src/cli/run.ts --dry-run                           # what would happen now
node src/cli/run.ts --dry-run --at 2026-12-24T18:00     # what happens on Christmas Eve
node src/cli/run.ts                                     # do it
```

`--at` only works alongside `--dry-run`: applying a theme for a pretend time
would set the wrong thing right now.

A dry run genuinely changes nothing — including not uploading. That matters
more than it sounds, because a Protect upload is permanent and cannot be
deleted without admin credentials.

## The UI

**First run asks you to create an account.** There is no default username or
password, deliberately — a default credential that nobody is forced to change
is the same as no credential at all. Passwords are scrypt-hashed and sessions
are HttpOnly, SameSite=Strict cookies holding a random token, of which only a
digest is stored.

Everything except `/health` and the login itself needs that session, so the
service can sit behind a reverse proxy without a second password in front of
it. If something terminates TLS for you, set `DOORMAN_SECURE_COOKIES=true` so
the session cookie carries `Secure` — the app only ever speaks plain HTTP and
cannot work that out for itself.

Browse to the service on its port and you get the whole thing: what is on the
doorbell right now, a theme editor, the image library with a per-file verdict
on whether Protect will accept it, ring sounds, and a **calendar preview** of
what would show on each of the next N days.

The calendar runs the same `decide()` the scheduler runs, so it is a real
answer to "will Christmas actually win?" rather than a guess.

Everything the UI does goes through the same functions the CLI uses. The UI is
a client of the application, never a second implementation of it — the moment
the button and the cron job can disagree about what "apply" means, one of them
is wrong and nobody can tell which.

## Development

**Node 23.6 or newer.** There is no build step and no dependencies — Node
strips the TypeScript itself, and does so without a flag only from 23.6. The
container ships 24.

```bash
npm test              # 121 tests
npm run check         # tests + the import check below
```

The scheduling logic is a pure function of configuration and a timestamp,
with no I/O anywhere near it. That is deliberate: it is where essentially
every bug will be, and it means "what happens on 24 December 2027" is
answerable in a millisecond rather than by waiting.

### Continuous integration

Two workflows, in [`.github/workflows/`](.github/workflows):

- **CI** runs on every push to `main` and every pull request against it:
  the test suite, an import check, and a Docker build.
- **Release** runs when a `v*` tag is pushed. It re-runs the tests, refuses
  if the tag disagrees with `package.json`, and publishes a GitHub release
  whose notes are the matching CHANGELOG section.

`scripts/check-imports.mjs` verifies every relative import in `src/` resolves.
That exists because of a real bug: an unanchored `.gitignore` rule kept
`src/media/` out of every commit, so two CLIs shipped without the module they
import while every local run passed. Against a fresh checkout that cannot
happen quietly — a file that was never committed is not there to resolve to.

### Releases

Versions are tags, and tags are what deployments pin to:

```bash
scripts/release.sh minor      # 0.1.0 -> 0.2.0, runs the tests, commits, tags
git push origin main --follow-tags
```

Then set `doorman_version: "v0.2.0"` wherever you deploy from. A tag rather
than a commit SHA, so a rollback is a name you can read and reason about
instead of seven hex digits you have to look up.

The script refuses to tag a dirty tree or a branch other than `main`: a tag
pointing at uncommitted work is a deployment nobody can reproduce, and you
find out only when you try.

Write changes into the `## Unreleased` section of
[CHANGELOG.md](CHANGELOG.md) as you make them — the release script promotes
that section to the new version, and the release workflow publishes it as the
GitHub release notes. Reconstructing a changelog from `git log` at release
time produces a list of commits, not a list of things that matter.

## Prior art

Worth knowing about, and worth using instead if they fit better:

- [`kapowaz/doorbell-tool`](https://github.com/kapowaz/doorbell-tool) — the best
  sprite-sheet generator, plus chime sounds, over SSH. No scheduling.
- [`ChrisHansenTech/doorbell-mqtt-unifi`](https://chrishansen.tech/posts/doorbell-mqtt-unifi-release/)
  — profiles pairing an animation with a sound, with drift detection and fast
  re-apply. Scheduling is delegated to Home Assistant.
- [`uiprotect`](https://github.com/uilibs/uiprotect) — the Python library that
  wraps the official API properly.

Home Assistant's UniFi Protect integration supports doorbell **text** but not
images, which has been [asked for](https://github.com/orgs/home-assistant/discussions/2490)
for over a year.

## Licence

MIT.
