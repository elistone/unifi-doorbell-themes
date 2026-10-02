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

export interface Theme {
  id: string;
  name: string;
  /** Content hash of the image. Resolved to an uploaded asset name elsewhere. */
  image: string;
  /** Content hash of the sound. May be absent while the sound layer is unproven. */
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
