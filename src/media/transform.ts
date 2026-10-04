import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SPRITE_LIMIT_BYTES, analyseGif } from "./analyse.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";

/**
 * Making a GIF fit.
 *
 * There is really only one lever that matters, and it is worth being blunt
 * about that rather than offering a panel of sliders:
 *
 *   The sprite is frames laid side by side. Halve the frames, halve the
 *   sprite. Nothing else comes close.
 *
 * Resolution is not a lever at all - every frame is scaled to 240x240 by the
 * controller regardless, so a 1080p source and a 300px source produce
 * identical sprites. Colour depth is not one either: the controller quantises
 * to 32 colours itself, so pre-quantising changes almost nothing.
 *
 * That leaves dropping frames and trimming length, which are the same
 * operation viewed from either end.
 */

export interface TransformResult {
  outputPath: string;
  framesBefore: number;
  framesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Keep every Nth frame, so the animation plays at the same speed over the
 * same duration but with fewer, longer-held frames.
 *
 * Preferred over trimming because it keeps the whole gag - a doorbell
 * animation usually has a beat at the end, and cutting the last second to
 * save space throws away the punchline.
 */
export async function reduceFrames(
  input: string,
  output: string,
  targetFrames: number,
): Promise<TransformResult> {
  const before = await analyseGif(input, 0);
  if (targetFrames >= before.frames) {
    throw new Error(
      `${input} already has only ${before.frames} frames; asked to reduce to ${targetFrames}`,
    );
  }

  // select every Nth frame, then restamp timestamps so the result plays over
  // the original duration rather than N times faster.
  const step = Math.ceil(before.frames / targetFrames);
  const fps = before.durationSeconds > 0 ? targetFrames / before.durationSeconds : 10;

  await run(FFMPEG, [
    "-y", "-v", "error",
    "-i", input,
    "-vf", `select='not(mod(n\\,${step}))',setpts=N/${fps.toFixed(4)}/TB,fps=${fps.toFixed(4)}`,
    "-loop", "0",
    output,
  ]);

  const after = await analyseGif(output, 0);
  const { size: bytesAfter } = await stat(output);
  const { size: bytesBefore } = await stat(input);
  return {
    outputPath: output,
    framesBefore: before.frames,
    framesAfter: after.frames,
    bytesBefore,
    bytesAfter,
  };
}

/** Keep only the first N seconds. */
export async function trim(input: string, output: string, seconds: number): Promise<TransformResult> {
  const before = await analyseGif(input, 0);
  await run(FFMPEG, ["-y", "-v", "error", "-t", String(seconds), "-i", input, "-loop", "0", output]);
  const after = await analyseGif(output, 0);
  return {
    outputPath: output,
    framesBefore: before.frames,
    framesAfter: after.frames,
    bytesBefore: (await stat(input)).size,
    bytesAfter: (await stat(output)).size,
  };
}

/**
 * Reduce a GIF until it should fit, using the conservative estimate.
 *
 * Deliberately aims at the pessimistic bound rather than the typical one. The
 * cost of aiming low is a slightly choppier animation; the cost of aiming
 * high is a rejected upload and another round trip, and the person doing this
 * is already annoyed that their GIF did not work.
 */
export async function fitToLimit(input: string, output: string): Promise<TransformResult> {
  const analysis = await analyseGif(input, (await stat(input)).size);
  if (analysis.verdict === "safe") {
    throw new Error(`${input} already fits - ${analysis.frames} frames`);
  }
  return reduceFrames(input, output, analysis.safeFrameCount);
}

async function stat(path: string): Promise<{ size: number }> {
  const { stat: fsStat } = await import("node:fs/promises");
  return fsStat(path);
}

export { SPRITE_LIMIT_BYTES };
