/**
 * The domain model.
 *
 * A Theme pairs one image with one sound and says when it applies. That is
 * deliberately the smallest thing that solves the problem - Protect models
 * images and sounds separately and has no concept of them belonging together,
 * which is the gap this fills.
 *
 * Sets of images and sets of sounds are a plausible future, but tagging
 * systems are hard to design before you know what a real library looks like.
 */

/** A calendar window, year-agnostic. `12-01` to `12-26`. */
export interface DateWindow {
  /** MM-DD */
  from: string;
  /** MM-DD, inclusive */
  to: string;
}

/** A window within the day. `21:00` to `06:00` is valid and wraps midnight. */
export interface TimeWindow {
  /** HH:MM, 24h */
  from: string;
  /** HH:MM, 24h, inclusive of the minute */
  to: string;
}

/**
 * When a theme is eligible. Every condition present must match - they AND
 * together. A rule with no conditions at all matches always, which is how you
 * write a fallback theme.
 */
export interface Rule {
  dateWindow?: DateWindow;
  /** 0 = Sunday, 6 = Saturday. Matches if the day is in the list. */
  weekdays?: number[];
  timeOfDay?: TimeWindow;
}

/**
 * A doorbell.
 *
 * The id is Protect's camera id; the name is the user's. Protect calls it
 * "UVC G4 Doorbell Pro", which is useless when you have two of them - what
 * you want to read on a theme is "Front door".
 */
export interface Device {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
}

export interface Theme {
  id: string;
  name: string;
  /** Content hash of the image. Resolved to an uploaded asset name elsewhere. */
  image: string;
  /**
   * The ring sound: either a ringtone id on the NVR, e.g.
   * "6933fcd40050f903e46e1a88", or `library:<content hash>` for a sound in
   * Doorman's own library. See `libraryRef` in sounds.ts.
   *
   * Until 0.8.0 it could only be an id. Ringtones are capped, so a library
   * larger than the controller was rejected as "uploading and evicting on
   * every rotation". That kept the controller as the only library - and when
   * its slots filled, a new sound was refused with an empty 400 and nothing
   * could help. Treating the slots as a cache costs at most one upload when
   * a theme's sound is not already there, which the schedule makes rare,
   * and it survives a Protect migration for free. See ringtones.ts.
   *
   * Omit it and the theme falls back to the default sound.
   */
  sound?: string;

  /**
   * The ring sound's NAME, remembered alongside its id.
   *
   * Ringtone ids are per-console. Migrating Protect to a different NVR
   * invalidated every custom id at once and left five themes pointing at
   * nothing, with no record of what they had wanted - the id alone cannot
   * tell you which sound to re-upload.
   *
   * The id stays authoritative while it resolves; this is what lets a
   * theme be re-linked by name after a migration, and what lets the UI say
   * "wanted stitch_music" instead of a dead hex string.
   */
  soundName?: string;
  /**
   * Higher wins. Themes at a lower priority are not candidates at all when a
   * higher one matches - this is what makes "Christmas beats Friday evening"
   * expressible without ordering rules by hand.
   */
  priority: number;
  /** Eligible when ANY rule matches. No rules means never eligible. */
  rules: Rule[];
  enabled: boolean;

  /**
   * Which doorbells this may apply to.
   *
   * **Empty means every doorbell**, not none. That default is the whole
   * reason adding a second doorbell does not silently unschedule the
   * first, and it is what lets a theme written when there was only one
   * device keep working unchanged.
   */
  devices: string[];
}

/**
 * How to choose when several themes tie at the top priority.
 *
 * `random` is seeded by the date, not by Math.random: re-running the decision
 * on the same day must give the same answer, or a dry run would not predict
 * what the daemon actually does, and an idempotent apply would not be
 * idempotent.
 */
export type Selection = "random" | "sequential";

export interface Config {
  themes: Theme[];
  selection: Selection;
}

/**
 * Where `sequential` has got to, keyed by the candidate set so that a changing
 * set of eligible themes does not scramble an unrelated rotation.
 *
 * This is runtime state, not configuration - it is passed in and handed back
 * rather than mutated, which is what keeps `decide` pure.
 */
export type Cursor = Record<string, number>;

export interface Decision {
  /** Null when nothing is eligible. The caller leaves the device alone. */
  theme: Theme | null;
  /**
   * Why this theme, in words. Logged on every apply.
   *
   * "applied christmas" is useless at 8am; "christmas (priority 10, beat
   * friday-evening; 1 of 3 candidates, random seeded 2026-12-24)" is not.
   */
  reason: string;
  /** Pass back in next time. Unchanged unless a sequential pick advanced it. */
  cursor: Cursor;
}
