import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseRange } from "../src/web/range.ts";

/**
 * Byte ranges. Without them a browser cannot seek in audio, and the sound
 * editor played every selection from the very start.
 */

describe("byte ranges", () => {
  it("sends everything when no range is asked for", () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange("bytes=-", 100), null);
    assert.equal(parseRange("items=0-5", 100), null);
  });

  it("reads an open-ended range, which is what a seek sends", () => {
    assert.deepEqual(parseRange("bytes=40-", 100), { start: 40, end: 99 });
  });

  it("reads a closed range, and stops at the end of the file", () => {
    assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  });

  it("reads a suffix as the last bytes", () => {
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  });

  it("refuses a range past the end", () => {
    assert.equal(parseRange("bytes=100-", 100), "invalid");
    assert.equal(parseRange("bytes=50-10", 100), "invalid");
  });
});
