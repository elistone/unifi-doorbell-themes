# Doorman — design

Scheduling, grouping and randomisation for UniFi G4 Doorbell Pro welcome
images and ring sounds. The things Protect's own UI will not do.

## Why this exists

Protect lets you set a welcome image and a ring sound. It will not let you
pair them, rotate them, or change them by date. So the Christmas GIF goes up
in December and comes down in March, because changing it is a chore.

What is missing, concretely:

- no pairing — "this image **with** this sound" is not a thing Protect models
- no rotation or randomisation
- no scheduling, so seasonal content is a manual job twice a year
- the upload UI discourages having a library at all

## Is it possible? Yes, with one caveat

Verified against a live controller and against Protect's own backend source.

**Images — yes, cleanly, through the official Integration API.**

```
POST  /proxy/protect/integration/v1/files/animations      (multipart; gif/jpeg/png)
PATCH /proxy/protect/integration/v1/cameras/{id}
      {"lcdMessage": {"type":"IMAGE", "text":"<returned name>", "resetAt": null}}
```

Documented, versioned, API-key authenticated. Ubiquiti has only added to this
surface — v6.1 to v7.2 gained 30 paths and removed none.

**Sound — yes, but only via SSH if you want the ring itself to be your audio.**

This is the caveat and it is structural, not a gap someone will fill. The
doorbell's chime is produced *on the device* by `ubnt_sounds_leds`, fired by
the firmware state `RING_BUTTON_PRESSED`. No controller round trip is
involved. Anything pushed over the network therefore arrives **after** it —
about 1–2 seconds, including roughly 0.9s of speaker warm-up.

There *is* an official network route (`POST /v1/cameras/{id}/talkback-session`,
which Home Assistant ships as a `media_player` entity) and it works. It just
cannot be the ring sound. Silencing the stock chime does not rescue it either:
you get silence, then a gap, then audio, and the visitor does not know the
button worked.

So: **ring replacement needs SSH.** The persistence problem is tractable —
write to `/var/etc/persistent/sounds` and both the file and `ubnt_sounds_leds.conf`
survive reboot. What does not survive is Protect reasserting its own state when
the doorbell reconnects, which needs a drift check and an automatic re-apply.

## Settled decisions

| Decision | Choice |
|---|---|
| Shape | Headless core first, UI as a client of it — not bolted through it |
| Theme model | `{name, image, sound, when}` — one image, one sound, designed so sets are additive |
| Scheduling | Fixed date windows, weekly recurrence, time-of-day; integer priority, last match wins |
| Rotation | Daily roll, with sequential rotation available per theme. No per-ring for v1 |
| Failure mode | Sticky — last state persists; never auto-revert. Report loudly instead |
| Distribution | Published, not supported. Narrow, honest claim |
| Repo | Separate public repo; homelab deploys it like any other service |
| Process | Long-running container, `restart_policy: unless-stopped` |
| Storage | SQLite for config and state, media on disk |
| Configuration | Env vars for connection and secrets; everything else in the database |
| Notifications | Generic configurable HTTP hook — not Uptime Kuma specific |
| Stack | Node/TypeScript. Thin client written against the OpenAPI spec, no library |
| Device targeting | Explicit camera ID. Assert Protect ≥ 6.1 at startup |
| Asset lifecycle | Content-hash + manifest. Upload each asset exactly once, ever |
| Testing | Pure decision function gets real tests; device adapter tested by hand |

### Why upload-once, and not rotation-by-upload

Three facts decide this, all verified in Protect's backend source:

- **Overwrite is impossible.** Every upload mints a fresh UUIDv1 regardless of
  filename. `originalName` is stored for display and never consulted.
- **There is no cap.** `quantityLimits.animations` is `Number.POSITIVE_INFINITY`,
  and the function that enforces limits is never called on the animation path.
  Ringtones are capped at 12; animations are not capped at all.
- **Deletion exists but is undocumented and privileged.**
  `DELETE /proxy/protect/api/files/animations/<name>?ignoreFileExtension=true`
  is real — it is in the backend's `filesRouter` — but it sits on the private
  API, which needs a session cookie and CSRF token rather than an API key.

So rotation never uploads. Each unique asset is uploaded once, its returned
name cached against a content hash, and "rotating" is a `PATCH` pointing
`lcdMessage` at a different name already on the NVR. Twenty GIFs means twenty
uploads for the life of the install.

Two consequences worth remembering:

- **Set the new image before deleting the old one.** The doorbell caches the
  sprite locally.
- **Never SSH-delete an animation.** `doorbellSettings.customImages` is rebuilt
  from the PostgreSQL `files` table, not from the directory — removing the file
  leaves a permanent ghost entry that survives restarts. The API path cleans up
  both; the filesystem path does not.

A missing asset degrades gracefully: Protect resets `lcdMessage` and falls back
to the default rather than breaking.

### Size limits

The upload route accepts up to **10 MB**, processes the image server-side into
a 240×240 sprite sheet, and *then* enforces **under 1 MB on the processed
output**. So a 4 MB GIF may well succeed, and client-side validation against
1 MB would reject files that work.

**But the ceiling is not comfortable, and an early measurement here was
misleading.** A synthetic 60-frame test pattern compressed 243 KB → 83 KB,
which suggested real content would never come close. It does. Measured against
an existing library on the same NVR:

| Source | Stored sprite |
|---|---|
| `severance_marching_2.gif` | **995 KB** |
| `stranger_things_ahoy.gif` | **932 KB** |
| `dancing-bones.gif` | 396 KB |
| `stitch_hi.gif` | 246 KB |

Within half a percent of rejection. Real video has far more entropy than a
test card. So **upload failure is a normal case, not an edge case** — the
error needs to say which file, what size it came out at, and what to do
(fewer frames, smaller palette). Transcoding moves from "only if necessary"
to "probably necessary".

A GIF upload produces **two** assets: the `.png` sprite and a `.png.gif`
preview. Only the sprite is size-checked — one preview on that NVR is 1294 KB,
comfortably over the limit the sprite must respect.

## Open — proceeding on these defaults, say if any is wrong

| Question | Default |
|---|---|
| UI scope | Minimum + first-run setup (paste API key, pick camera from a list, test connection) |
| Backup | Both: a homelab `backup-doorman.sh`, and an in-app export/import |
| Display ownership | Advisory — a manual change in Protect sticks until the next roll; UI shows the drift |
| Library deletion | Optional, behind a flag, needs separately-configured admin credentials |
| Sound route | Ring replacement via SSH, with talkback as a documented fallback |
| Build on `doorbell-mqtt-unifi`? | **No — standalone, informed by it.** The weakest of these defaults |
| Publishing | Publish, claiming G4 Doorbell Pro + SSH only |

The `doorbell-mqtt-unifi` call deserves its reasoning recorded, because the
recommendation went the other way. That project already pairs an animation with
a `RING_BUTTON_PRESSED` sound, applies it over IPC in under two seconds, and
does SHA-256 drift detection with automatic re-apply. That is the hard part,
already debugged against real firmware.

Standing against it: it is a C service, it needs an MQTT broker that this estate
does not run, and it would put the riskiest layer of the project behind a
single-maintainer dependency. Writing the device layer in Node — informed by
what they proved works — keeps it one container and one language.

Revisit this if the SSH layer turns out to be a slog.

## Architecture

```
  ┌────────────┐
  │     UI     │  client of the API, not a layer in it
  └──────┬─────┘
         │ HTTP
  ┌──────┴─────────────────────────────────────────┐
  │                     core                        │
  │                                                 │
  │  decide(config, now) -> Theme                   │  pure. no I/O. all the tests
  │                                                 │
  │  apply(theme)                                   │  one callable operation
  │    ├── images  -> Integration API  (API key)    │  documented, stable
  │    └── sounds  -> SSH + drift re-apply          │  undocumented, fragile
  └─────────────────────────────────────────────────┘
         │                    │
    SQLite + media       G4 Doorbell Pro
```

The seam that matters is `decide()`. Everything that will actually be buggy —
date windows, priority ties, rotation cursors, what happens at midnight on 31
December — is a pure function of config and a timestamp. It gets real tests,
because "what will this do on 24 December 2027" has to be answerable in a
millisecond rather than by waiting.

`apply()` is the single callable operation. The daemon calls it on a timer; the
UI calls it for a manual override; a dry run calls it and prints. That gives a
manual trigger, a preview and a test entry point without any extra machinery.

## Build order

1. **`decide()` and its tests.** No hardware, no network, all the risk.
2. **Integration API client** — upload, list, set `lcdMessage`. Images working
   end to end on real hardware.
3. **Three hardware experiments** (below) before committing to a sound design.
4. **Sound layer**, shaped by what those experiments return.
5. **Scheduler daemon** wrapping `apply()`.
6. **UI.**
7. **Ansible deployment** into the homelab.

## Experiments to run first

In order of how much they would save:

1. **`PATCH` the camera's `speakerSettings.ringtoneId`** (private API) and press
   the button. Nobody has tested whether the doorbell's own speaker honours it.
   If it does, the entire SSH layer disappears and step 4 becomes a config
   change. Worth doing before writing any sound code.
2. **Upload a deliberately large GIF** and find the real ceiling on the
   processed output.
3. **Set `ringVolume` to 0** and confirm it is silent rather than quiet.

All three need an API key: Protect → Settings → Control Plane → Integrations.

## Risks

**The private API breaks at roughly every major Protect release.** 4.0 removed
default doorbell messages; 4.0.21 introduced `IMAGE` and broke every strict
client; 5.0 significantly changed chime behaviour. The official API has been
additive by comparison. Everything that can use the official surface should.

**The SSH layer is the fragile half**, and it is the half the headline feature
depends on. If it becomes a treadmill, the fallback is images-only plus
talkback announcements — a smaller product, but one built entirely on
documented endpoints.

**Model support is narrow.** G4 Doorbell Pro is the only model with proven
tooling. Doorbell Lite has no screen. G6 Entry Pro's touchscreen may or may not
consume `lcdMessage`; nobody has checked.

## Prior art

| Project | Does | Gap |
|---|---|---|
| `kapowaz/doorbell-tool` | Sprite generation, ~48 screens, chime sounds. SSH | No scheduling, no daemon |
| `ChrisHansenTech/doorbell-mqtt-unifi` | Profiles pairing animation + sound, IPC, drift detection | SSH-based, G4 Pro only, scheduling delegated to Home Assistant |
| `bdini13/unifi-announcer` | TTS to chimes; camera speakers recently and experimentally | Audio only, validated on one non-doorbell camera |
| Home Assistant `unifiprotect` | LCD **text**, `media_player` for talkback | No image support at all, a long-standing request |
| `uiprotect` | `upload_file_public`, `set_lcd_message_public` | A library, not an app. No scheduling |

**Nothing schedules or randomises welcome images over the official API.** That
is the gap this fills.
