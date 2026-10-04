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

Requires Node 22.6+. There is no build step and no dependencies — Node strips
the TypeScript itself.

```bash
npm test
```

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
that section to the new version. Reconstructing a changelog from `git log` at
release time produces a list of commits, not a list of things that matter.

The scheduling logic is a pure function of configuration and a timestamp, with
no I/O anywhere near it. That is deliberate: it is where essentially every bug
will be, and it means "what happens on 24 December 2027" is answerable in a
millisecond rather than by waiting.

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
