/**
 * The dashboard's numbers: what the scheduler did each day, and which
 * themes the doorbells actually showed.
 *
 * Pure, so the bucketing - local days, empty days included - is tested
 * without a database. Days are the household's local days, the same ones
 * the scheduler rolls on, not UTC.
 */

export interface ApplyRow {
  at: string;
  themeId: string | null;
  outcome: string;
}

export interface ActivityDay {
  date: string;
  /** The doorbell was changed to something new. */
  changed: number;
  /** Already showing the right thing. */
  unchanged: number;
  /** Nothing was eligible, so the doorbell was left alone. */
  noTheme: number;
  failed: number;
}

export const localDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** The first moment of the oldest day in a window of `days` ending today. */
export function windowStart(days: number, now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days - 1));
  return start;
}

/**
 * One entry per day, oldest first, with every day present - a chart with
 * gaps where nothing ran would hide exactly the days worth noticing.
 * Dry runs change nothing and are left out.
 */
export function activityByDay(rows: ApplyRow[], days: number, now: Date): ActivityDay[] {
  const start = windowStart(days, now);
  const out: ActivityDay[] = [];
  const byDate = new Map<string, ActivityDay>();
  for (let i = 0; i < days; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const entry = { date: localDateKey(day), changed: 0, unchanged: 0, noTheme: 0, failed: 0 };
    out.push(entry);
    byDate.set(entry.date, entry);
  }
  for (const row of rows) {
    const entry = byDate.get(localDateKey(new Date(row.at)));
    if (!entry) continue;
    if (row.outcome === "applied") entry.changed++;
    else if (row.outcome === "unchanged") entry.unchanged++;
    else if (row.outcome === "no-theme") entry.noTheme++;
    else if (row.outcome === "failed") entry.failed++;
  }
  return out;
}

/** How often each theme was put up or kept up, most first. */
export function themeShare(rows: ApplyRow[]): Array<{ themeId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.themeId || (row.outcome !== "applied" && row.outcome !== "unchanged")) continue;
    counts.set(row.themeId, (counts.get(row.themeId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([themeId, count]) => ({ themeId, count }))
    .sort((a, b) => b.count - a.count || a.themeId.localeCompare(b.themeId));
}
