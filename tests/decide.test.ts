import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decide } from "../src/domain/decide.ts";
import type { Config, Rule, Theme } from "../src/domain/types.ts";

/**
 * Every bug this project will realistically ship lives in `decide`. None of it
 * involves a doorbell, and waiting until December to find out whether the
 * Christmas rule works is not a test strategy.
 */

function theme(id: string, priority: number, rules: Rule[], extra: Partial<Theme> = {}): Theme {
  return { id, name: id, image: `${id}.gif`, priority, rules, enabled: true, ...extra };
}

/** Local time, because the scheduler reasons in the household's timezone. */
function at(iso: string): Date {
  return new Date(iso);
}

const always: Rule = {};

describe("eligibility", () => {
  it("picks nothing when no theme matches", () => {
    const config: Config = { themes: [theme("xmas", 0, [{ dateWindow: { from: "12-01", to: "12-26" } }])], selection: "random" };
    const d = decide(config, at("2026-06-15T12:00:00"));
    assert.equal(d.theme, null);
    assert.match(d.reason, /no theme is eligible/);
  });

  it("ignores disabled themes", () => {
    const config: Config = { themes: [theme("off", 0, [always], { enabled: false })], selection: "random" };
    assert.equal(decide(config, at("2026-06-15T12:00:00")).theme, null);
  });

  it("treats a theme with no rules as never eligible, not always", () => {
    // An empty rules array is almost always a half-finished theme rather than
    // an intentional fallback. A fallback is written as `rules: [{}]`.
    const config: Config = { themes: [theme("empty", 0, [])], selection: "random" };
    assert.equal(decide(config, at("2026-06-15T12:00:00")).theme, null);
  });

  it("treats an empty rule object as always eligible", () => {
    const config: Config = { themes: [theme("fallback", 0, [always])], selection: "random" };
    assert.equal(decide(config, at("2026-06-15T12:00:00")).theme?.id, "fallback");
  });
});

describe("date windows", () => {
  const xmas = theme("xmas", 0, [{ dateWindow: { from: "12-01", to: "12-26" } }]);
  const config: Config = { themes: [xmas], selection: "random" };

  it("matches inside the window", () => {
    assert.equal(decide(config, at("2026-12-10T12:00:00")).theme?.id, "xmas");
  });

  it("includes both endpoints", () => {
    assert.equal(decide(config, at("2026-12-01T00:00:00")).theme?.id, "xmas");
    assert.equal(decide(config, at("2026-12-26T23:59:00")).theme?.id, "xmas");
  });

  it("excludes the day either side", () => {
    assert.equal(decide(config, at("2026-11-30T23:59:00")).theme, null);
    assert.equal(decide(config, at("2026-12-27T00:00:00")).theme, null);
  });

  it("wraps across the new year", () => {
    // The case everyone gets wrong.
    const newYear: Config = {
      themes: [theme("festive", 0, [{ dateWindow: { from: "12-20", to: "01-05" } }])],
      selection: "random",
    };
    assert.equal(decide(newYear, at("2026-12-25T12:00:00")).theme?.id, "festive");
    assert.equal(decide(newYear, at("2027-01-02T12:00:00")).theme?.id, "festive");
    assert.equal(decide(newYear, at("2026-12-19T12:00:00")).theme, null);
    assert.equal(decide(newYear, at("2027-01-06T12:00:00")).theme, null);
  });

  it("handles a single-day window", () => {
    const halloween: Config = {
      themes: [theme("halloween", 0, [{ dateWindow: { from: "10-31", to: "10-31" } }])],
      selection: "random",
    };
    assert.equal(decide(halloween, at("2026-10-31T12:00:00")).theme?.id, "halloween");
    assert.equal(decide(halloween, at("2026-10-30T12:00:00")).theme, null);
  });

  it("survives a leap day", () => {
    const feb: Config = {
      themes: [theme("feb", 0, [{ dateWindow: { from: "02-01", to: "02-29" } }])],
      selection: "random",
    };
    assert.equal(decide(feb, at("2028-02-29T12:00:00")).theme?.id, "feb");
  });

  it("rejects a malformed window loudly rather than silently never matching", () => {
    const bad: Config = {
      themes: [theme("bad", 0, [{ dateWindow: { from: "Dec 1", to: "12-26" } }])],
      selection: "random",
    };
    assert.throws(() => decide(bad, at("2026-12-10T12:00:00")), /must be MM-DD/);
  });
});

describe("weekdays", () => {
  const friday: Config = {
    themes: [theme("friday", 0, [{ weekdays: [5] }])],
    selection: "random",
  };

  it("matches the named day", () => {
    assert.equal(decide(friday, at("2026-10-02T18:00:00")).theme?.id, "friday"); // a Friday
  });

  it("does not match other days", () => {
    assert.equal(decide(friday, at("2026-10-03T18:00:00")).theme, null); // Saturday
  });

  it("handles Sunday as 0", () => {
    const weekend: Config = {
      themes: [theme("weekend", 0, [{ weekdays: [0, 6] }])],
      selection: "random",
    };
    assert.equal(decide(weekend, at("2026-10-04T12:00:00")).theme?.id, "weekend"); // Sunday
  });
});

describe("time of day", () => {
  it("matches inside the window", () => {
    const evening: Config = {
      themes: [theme("evening", 0, [{ timeOfDay: { from: "18:00", to: "22:00" } }])],
      selection: "random",
    };
    assert.equal(decide(evening, at("2026-06-15T19:30:00")).theme?.id, "evening");
    assert.equal(decide(evening, at("2026-06-15T17:59:00")).theme, null);
  });

  it("wraps past midnight", () => {
    const night: Config = {
      themes: [theme("night", 0, [{ timeOfDay: { from: "22:00", to: "06:00" } }])],
      selection: "random",
    };
    assert.equal(decide(night, at("2026-06-15T23:30:00")).theme?.id, "night");
    assert.equal(decide(night, at("2026-06-15T02:00:00")).theme?.id, "night");
    assert.equal(decide(night, at("2026-06-15T12:00:00")).theme, null);
  });
});

describe("combining conditions", () => {
  it("ANDs every condition in one rule", () => {
    const config: Config = {
      themes: [
        theme("xmasEve", 0, [
          { dateWindow: { from: "12-24", to: "12-24" }, timeOfDay: { from: "16:00", to: "23:59" } },
        ]),
      ],
      selection: "random",
    };
    assert.equal(decide(config, at("2026-12-24T18:00:00")).theme?.id, "xmasEve");
    assert.equal(decide(config, at("2026-12-24T09:00:00")).theme, null); // right day, wrong time
    assert.equal(decide(config, at("2026-12-23T18:00:00")).theme, null); // right time, wrong day
  });

  it("ORs across rules on the same theme", () => {
    const config: Config = {
      themes: [
        theme("spooky", 0, [
          { dateWindow: { from: "10-31", to: "10-31" } },
          { dateWindow: { from: "12-25", to: "12-25" } },
        ]),
      ],
      selection: "random",
    };
    assert.equal(decide(config, at("2026-10-31T12:00:00")).theme?.id, "spooky");
    assert.equal(decide(config, at("2026-12-25T12:00:00")).theme?.id, "spooky");
    assert.equal(decide(config, at("2026-11-15T12:00:00")).theme, null);
  });
});

describe("priority", () => {
  it("excludes lower priorities entirely", () => {
    const config: Config = {
      themes: [
        theme("friday", 1, [{ weekdays: [5] }]),
        theme("xmas", 10, [{ dateWindow: { from: "12-01", to: "12-26" } }]),
      ],
      selection: "random",
    };
    // 25 Dec 2026 is a Friday - exactly the collision that ruins Christmas.
    const d = decide(config, at("2026-12-25T18:00:00"));
    assert.equal(d.theme?.id, "xmas");
    assert.match(d.reason, /beat friday/);
  });

  it("falls back when the higher priority is out of season", () => {
    const config: Config = {
      themes: [
        theme("friday", 1, [{ weekdays: [5] }]),
        theme("xmas", 10, [{ dateWindow: { from: "12-01", to: "12-26" } }]),
      ],
      selection: "random",
    };
    assert.equal(decide(config, at("2026-10-02T18:00:00")).theme?.id, "friday");
  });

  it("explains itself in the reason", () => {
    const config: Config = { themes: [theme("solo", 3, [always])], selection: "random" };
    assert.match(decide(config, at("2026-06-15T12:00:00")).reason, /solo \(priority 3, only candidate\)/);
  });
});

describe("random selection", () => {
  const config: Config = {
    themes: [theme("a", 0, [always]), theme("b", 0, [always]), theme("c", 0, [always])],
    selection: "random",
  };

  it("is stable for a whole day, so a dry run predicts the real apply", () => {
    const morning = decide(config, at("2026-06-15T06:00:00")).theme?.id;
    const evening = decide(config, at("2026-06-15T22:00:00")).theme?.id;
    assert.equal(morning, evening);
  });

  it("does not depend on the order themes are listed in", () => {
    const reversed: Config = { ...config, themes: [...config.themes].reverse() };
    assert.equal(
      decide(config, at("2026-06-15T12:00:00")).theme?.id,
      decide(reversed, at("2026-06-15T12:00:00")).theme?.id,
    );
  });

  it("actually varies across days rather than sticking on one theme", () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      const date = at(`2026-06-${String(day).padStart(2, "0")}T12:00:00`);
      seen.add(decide(config, date).theme!.id);
    }
    assert.equal(seen.size, 3, `expected all three over 28 days, saw ${[...seen].join(",")}`);
  });

  it("leaves the cursor alone", () => {
    const cursor = { someKey: 7 };
    assert.deepEqual(decide(config, at("2026-06-15T12:00:00"), cursor).cursor, cursor);
  });
});

describe("sequential selection", () => {
  const config: Config = {
    themes: [theme("a", 0, [always]), theme("b", 0, [always]), theme("c", 0, [always])],
    selection: "sequential",
  };

  it("advances one step at a time and wraps", () => {
    const now = at("2026-06-15T12:00:00");
    let cursor = {};
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = decide(config, now, cursor);
      order.push(d.theme!.id);
      cursor = d.cursor;
    }
    assert.deepEqual(order, ["a", "b", "c", "a"]);
  });

  it("keeps separate rotations for different candidate sets", () => {
    // A seasonal set rotating must not scramble the everyday set's position.
    const mixed: Config = {
      themes: [
        theme("a", 0, [{ dateWindow: { from: "01-01", to: "12-31" } }]),
        theme("b", 0, [{ dateWindow: { from: "01-01", to: "12-31" } }]),
        theme("x", 5, [{ dateWindow: { from: "12-01", to: "12-26" } }]),
        theme("y", 5, [{ dateWindow: { from: "12-01", to: "12-26" } }]),
      ],
      selection: "sequential",
    };
    let cursor = {};
    cursor = decide(mixed, at("2026-06-15T12:00:00"), cursor).cursor; // a
    cursor = decide(mixed, at("2026-12-10T12:00:00"), cursor).cursor; // x
    const backToEveryday = decide(mixed, at("2026-06-16T12:00:00"), cursor);
    assert.equal(backToEveryday.theme?.id, "b", "the everyday rotation should resume, not restart");
  });
});
