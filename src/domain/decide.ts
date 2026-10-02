import type {
  Config,
  Cursor,
  DateWindow,
  Decision,
  Rule,
  Theme,
  TimeWindow,
} from "./types.ts";

/**
 * Which theme applies right now.
 *
 * Pure: config and an instant in, a decision out. No clock, no network, no
 * database. Every scheduling bug this project will ever have lives in here,
 * and this is the only way to ask "what happens on 24 December 2027" without
 * waiting until then.
 */
export function decide(config: Config, now: Date, cursor: Cursor = {}): Decision {
  const eligible = config.themes.filter(
    (t) => t.enabled && t.rules.some((r) => ruleMatches(r, now)),
  );

  if (eligible.length === 0) {
    return { theme: null, reason: "no theme is eligible", cursor };
  }

  // Priority excludes rather than orders. A lower-priority theme is not a
  // candidate at all when a higher one matches, which is what makes the
  // Christmas-beats-Friday case work without hand-ordering the list.
  const top = Math.max(...eligible.map((t) => t.priority));
  const beaten = eligible.filter((t) => t.priority < top);
  const candidates = eligible
    .filter((t) => t.priority === top)
    // Sort for determinism: the input order of themes must not change the
    // outcome, or the same config in a different row order picks differently.
    .sort((a, b) => a.id.localeCompare(b.id));

  const beatenNote = beaten.length
    ? `, beat ${beaten.map((t) => t.name).join(", ")}`
    : "";

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      theme: only,
      reason: `${only.name} (priority ${top}, only candidate${beatenNote})`,
      cursor,
    };
  }

  const key = candidates.map((t) => t.id).join("|");

  if (config.selection === "sequential") {
    const at = cursor[key] ?? 0;
    const picked = candidates[at % candidates.length]!;
    return {
      theme: picked,
      reason:
        `${picked.name} (priority ${top}, ${at % candidates.length + 1} of ` +
        `${candidates.length} in rotation${beatenNote})`,
      cursor: { ...cursor, [key]: (at + 1) % candidates.length },
    };
  }

  // Seeded by the local date, so the choice is stable for the whole day and a
  // dry run predicts exactly what the daemon will do.
  const day = localDateKey(now);
  const index = hash(`${day}:${key}`) % candidates.length;
  const picked = candidates[index]!;
  return {
    theme: picked,
    reason:
      `${picked.name} (priority ${top}, ${index + 1} of ${candidates.length} ` +
      `candidates, random seeded ${day}${beatenNote})`,
    cursor,
  };
}

function ruleMatches(rule: Rule, now: Date): boolean {
  if (rule.dateWindow && !inDateWindow(rule.dateWindow, now)) return false;
  if (rule.weekdays && !rule.weekdays.includes(now.getDay())) return false;
  if (rule.timeOfDay && !inTimeWindow(rule.timeOfDay, now)) return false;
  return true;
}

/**
 * Year-agnostic date windows, which means they can wrap: 12-20 to 01-05 is a
 * perfectly reasonable thing to want and is the case everyone gets wrong.
 */
function inDateWindow(window: DateWindow, now: Date): boolean {
  const today = monthDay(now.getMonth() + 1, now.getDate());
  const from = parseMonthDay(window.from);
  const to = parseMonthDay(window.to);
  return from <= to
    ? today >= from && today <= to
    : today >= from || today <= to; // wraps the new year
}

/** Same wrapping problem, same shape: 21:00 to 06:00 crosses midnight. */
function inTimeWindow(window: TimeWindow, now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const from = parseHourMinute(window.from);
  const to = parseHourMinute(window.to);
  return from <= to
    ? minutes >= from && minutes <= to
    : minutes >= from || minutes <= to;
}

function monthDay(month: number, day: number): number {
  return month * 100 + day;
}

function parseMonthDay(value: string): number {
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`date must be MM-DD, got "${value}"`);
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`month out of range in "${value}"`);
  if (day < 1 || day > 31) throw new Error(`day out of range in "${value}"`);
  return monthDay(month, day);
}

function parseHourMinute(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`time must be HH:MM, got "${value}"`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) throw new Error(`hour out of range in "${value}"`);
  if (minute > 59) throw new Error(`minute out of range in "${value}"`);
  return hour * 60 + minute;
}

/** Local date, not UTC: "today" means the household's today. */
function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** FNV-1a. Not for security - just a stable spread with no dependency. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export type { Theme };
