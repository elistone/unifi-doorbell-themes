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
   * Ringtone id on the NVR, e.g. "6933fcd40050f903e46e1a88".
   *
   * An id rather than a content hash, which is the opposite of how `image`
   * works, and the asymmetry is forced by the device: animations are
   * uncapped so each one can be uploaded once and kept forever, but
   * ringtones are capped at 12. A local sound library larger than that
   * would mean uploading and evicting on every rotation - churn against an
   * undocumented endpoint, to save a few hundred KB on a terabyte NVR.
   *
   * So sounds are chosen from what is already on the controller, and
   * uploading a new one is a deliberate act rather than a side effect of
   * scheduling. Omit it and the theme leaves the ring sound alone.
   */
  sound?: string;
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
