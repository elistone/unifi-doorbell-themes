import { test } from "node:test";
import assert from "node:assert/strict";
import { activityByDay, themeShare, windowStart } from "../src/web/stats.ts";

const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h).toISOString();

test("activity has every day in the window, oldest first, by local day", () => {
  const now = new Date(2026, 10, 15, 20);
  const days = activityByDay(
    [
      { at: at(2026, 11, 13), themeId: "a", outcome: "applied" },
      { at: at(2026, 11, 15, 0), themeId: "a", outcome: "unchanged" },
      { at: at(2026, 11, 15, 23), themeId: null, outcome: "no-theme" },
      { at: at(2026, 11, 15), themeId: "a", outcome: "failed" },
      { at: at(2026, 11, 15), themeId: "a", outcome: "dry-run" },
      { at: at(2026, 11, 1), themeId: "a", outcome: "applied" },
    ],
    3,
    now,
  );
  assert.deepEqual(days, [
    { date: "2026-11-13", changed: 1, unchanged: 0, noTheme: 0, failed: 0 },
    { date: "2026-11-14", changed: 0, unchanged: 0, noTheme: 0, failed: 0 },
    { date: "2026-11-15", changed: 0, unchanged: 1, noTheme: 1, failed: 1 },
  ]);
});

test("the window starts at local midnight of its first day", () => {
  const start = windowStart(30, new Date(2026, 10, 15, 20));
  assert.equal(start.getTime(), new Date(2026, 9, 17).getTime());
});

test("theme share counts only what was put up or kept up", () => {
  assert.deepEqual(
    themeShare([
      { at: "", themeId: "b", outcome: "applied" },
      { at: "", themeId: "a", outcome: "unchanged" },
      { at: "", themeId: "b", outcome: "unchanged" },
      { at: "", themeId: "a", outcome: "failed" },
      { at: "", themeId: null, outcome: "no-theme" },
    ]),
    [
      { themeId: "b", count: 2 },
      { themeId: "a", count: 1 },
    ],
  );
});
