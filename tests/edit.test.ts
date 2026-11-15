import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ALWAYS_SAFE_FRAMES } from "../src/media/analyse.ts";
import {
  MAX_FADE_SECONDS,
  audioEditArgs,
  peaksOf,
  centreCrop,
  clampCrop,
  clampWindow,
  gifEditArgs,
  targetFps,
} from "../src/media/edit.ts";

/**
 * The arithmetic behind the editor. ffmpeg itself is not run here - it is
 * not installed everywhere the tests are - so what is checked is that the
 * right numbers reach it.
 */

const filterOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

describe("crop", () => {
  it("defaults to the largest centred square", () => {
    assert.deepEqual(centreCrop(480, 270), { x: 105, y: 0, size: 270 });
    assert.deepEqual(centreCrop(200, 300), { x: 0, y: 50, size: 200 });
  });

  it("pulls a box dragged past the edge back inside the frame", () => {
    // Browser rounding at display scale can land a pixel or two outside,
    // and ffmpeg refuses a crop bigger than the frame outright.
    assert.deepEqual(clampCrop({ x: 302.6, y: -1, size: 200 }, 480, 270), { x: 280, y: 0, size: 200 });
    assert.deepEqual(clampCrop({ x: 0, y: 0, size: 999 }, 480, 270), { x: 0, y: 0, size: 270 });
  });
});

describe("trim window", () => {
  it("keeps the window inside the clip", () => {
    assert.deepEqual(clampWindow(-2, 99, 5), { start: 0, end: 5 });
    assert.deepEqual(clampWindow(undefined, undefined, 3.2), { start: 0, end: 3.2 });
  });

  it("refuses a window too short to be anything", () => {
    assert.throws(() => clampWindow(4, 4, 5), /shorter than a tenth/);
    assert.throws(() => clampWindow(4, 2, 5), /shorter than a tenth/);
  });
});

describe("frame rate", () => {
  const source = { width: 480, height: 270, frames: 100, durationSeconds: 4 };

  it("never invents frames the source does not have", () => {
    // 25fps source, 1 second kept: 25 frames, well under the cap.
    assert.equal(targetFps(source, 1), 25);
  });

  it("lowers the rate just enough to fit, over the whole window", () => {
    const fps = targetFps(source, 4);
    assert.ok(fps * 4 <= ALWAYS_SAFE_FRAMES + 1e-9, `${fps * 4} frames would not always fit`);
    assert.ok(fps * 4 > ALWAYS_SAFE_FRAMES - 1, "should not throw away more than it must");
  });
});

describe("GIF arguments", () => {
  const source = { width: 480, height: 270, frames: 100, durationSeconds: 4 };

  it("trims, then crops, then scales to the screen", () => {
    const args = gifEditArgs("in.gif", "out.gif", { crop: { x: 10, y: 0, size: 270 }, start: 1, end: 3 }, source);
    const graph = filterOf(args, "-filter_complex");
    const order = ["trim=start=1.000:end=3.000", "fps=", "crop=270:270:10:0", "scale=240:240"].map((f) =>
      graph.indexOf(f),
    );
    assert.ok(order.every((i) => i >= 0), graph);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "filters out of order");
  });

  it("caps the frame count hard, so the promise holds even if fps rounds up", () => {
    const args = gifEditArgs("in.gif", "out.gif", {}, source);
    assert.equal(filterOf(args, "-frames:v"), String(ALWAYS_SAFE_FRAMES));
  });

  it("crops a still GIF without trying to trim it", () => {
    // A single-frame GIF reports no duration; trimming it would throw.
    const args = gifEditArgs("in.gif", "out.gif", {}, { width: 300, height: 200, frames: 1, durationSeconds: 0 });
    const graph = filterOf(args, "-filter_complex");
    assert.ok(!graph.includes("trim="), graph);
    assert.ok(graph.includes("crop=200:200:50:0"), graph);
  });
});

describe("audio arguments", () => {
  it("cuts, normalises and writes a real MP3", () => {
    const args = audioEditArgs("in.webm", "out.mp3", { start: 2, end: 6 }, 30);
    const filters = filterOf(args, "-af");
    assert.ok(filters.startsWith("atrim=start=2.000:end=6.000"), filters);
    assert.ok(filters.includes("loudnorm"), filters);
    assert.equal(filterOf(args, "-codec:a"), "libmp3lame");
    assert.equal(filterOf(args, "-f"), "mp3");
  });

  it("fades out at the end of the clip, not the end of the source", () => {
    const filters = filterOf(audioEditArgs("in.mp3", "out.mp3", { start: 2, end: 6 }, 30), "-af");
    assert.ok(filters.includes("afade=t=out:st=3.970"), filters);
  });

  it("leaves the level alone when asked to", () => {
    const filters = filterOf(audioEditArgs("in.mp3", "out.mp3", { normalise: false }, 5), "-af");
    assert.ok(!filters.includes("loudnorm"), filters);
  });
});

describe("fades", () => {
  const filters = (edit: object) => filterOf(audioEditArgs("in.mp3", "out.mp3", { start: 0, end: 10, ...edit }, 30), "-af");

  it("fades in and out over what was asked", () => {
    const f = filters({ fadeIn: 1.5, fadeOut: 2 });
    assert.ok(f.includes("afade=t=in:st=0:d=1.500"), f);
    assert.ok(f.includes("afade=t=out:st=8.000:d=2.000"), f);
  });

  it("keeps the click-stopping edge when no fade is asked for", () => {
    assert.ok(filters({ fadeIn: 0 }).includes("afade=t=in:st=0:d=0.030"));
  });

  it("caps a fade, and never lets it outlast the clip", () => {
    assert.ok(filters({ fadeIn: 60 }).includes(`afade=t=in:st=0:d=${MAX_FADE_SECONDS.toFixed(3)}`));
    const short = filterOf(audioEditArgs("in.mp3", "out.mp3", { start: 0, end: 2, fadeOut: 4 }, 30), "-af");
    assert.ok(short.includes("afade=t=out:st=0.000:d=2.000"), short);
  });

  it("treats nonsense as no fade rather than failing the render", () => {
    assert.ok(filters({ fadeIn: "lots" }).includes("afade=t=in:st=0:d=0.030"));
  });
});

describe("waveform peaks", () => {
  it("gives the quietest and loudest sample of each slice", () => {
    const samples = new Int16Array([0, 16384, -16384, 0, 32767, -32768, 0, 0]);
    assert.deepEqual(peaksOf(samples, 2), [-0.5, 0.5, -1, 1]);
  });

  it("copes with more slices than samples", () => {
    const peaks = peaksOf(new Int16Array([32767]), 4);
    assert.equal(peaks.length, 8);
    assert.ok(peaks.every((v) => Number.isFinite(v)));
  });

  it("returns nothing for silence of no length", () => {
    assert.deepEqual(peaksOf(new Int16Array(0), 10), []);
  });
});
