import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseProbe } from "../src/media/analyse.ts";

/**
 * The parser gets real tests because the first version of it was positional,
 * and silently reported durations as frame counts - which made a library of
 * 98-frame GIFs look entirely safe.
 */
describe("ffprobe output parsing", () => {
  it("reads fields by name, not position", () => {
    // Real output. Note ffprobe put duration BEFORE nb_read_frames, which is
    // not the order it was asked for - that is the whole bug.
    const stdout = ["width=335", "height=335", "duration=2.760000", "nb_read_frames=23"].join("\n");
    const f = parseProbe(stdout);
    assert.equal(f.width, "335");
    assert.equal(f.nb_read_frames, "23", "frames must not pick up the duration");
    assert.equal(f.duration, "2.760000");
  });

  it("survives ffmpeg reordering the fields", () => {
    const reordered = ["nb_read_frames=98", "width=250", "duration=4.9", "height=250"].join("\n");
    const f = parseProbe(reordered);
    assert.equal(f.nb_read_frames, "98");
    assert.equal(f.width, "250");
  });

  it("copes with N/A, which ffprobe emits for some GIFs", () => {
    const f = parseProbe(["width=300", "duration=N/A", "nb_read_frames=61"].join("\n"));
    assert.equal(f.nb_read_frames, "61");
    assert.ok(Number.isNaN(Number(f.duration)), "N/A must not silently become 0");
  });

  it("ignores blank lines and stray whitespace", () => {
    const f = parseProbe("\n  width=240  \n\nnb_read_frames=10\n");
    assert.equal(f.width, "240");
    assert.equal(f.nb_read_frames, "10");
  });
});
