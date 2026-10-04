import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";

/**
 * Predicting whether Protect will accept a GIF.
 *
 * The controller enforces under 1MB on the sprite sheet it produces, not on
 * what you upload - so the useful question is "how big will the sprite be",
 * and that is not visible from the source file. A 1.2MB GIF and a 3.6MB GIF
 * from the same library produce sprites of 246KB and 932KB respectively;
 * source size predicts almost nothing.
 *
 * What the controller actually does, established by downloading a real sprite
 * and taking it apart:
 *
 *   - every frame scaled to 240x240
 *   - frames laid out horizontally in one strip (23 frames -> 5520x240)
 *   - quantised to a 32-COLOUR palette, not 256
 *   - written as an 8-bit colormap PNG
 *
 * Reproducing that locally with ffmpeg gets the dimensions exactly right but
 * overshoots the file size by ~50%, because their PNG encoder compresses
 * better than a stock one. Rather than chase that, the estimate below is
 * empirical: measured against five real source/stored pairs on a live NVR.
 */

/** The ceiling, enforced on the processed sprite. */
export const SPRITE_LIMIT_BYTES = 1_048_576;

/**
 * Bytes per frame, observed across a real library:
 *
 *   circle-of-life        43 frames   368KB    8,764 B/frame
 *   severance_marching    98 frames   995KB   10,397
 *   stitch_hi             23 frames   246KB   10,950
 *   dancing-bones         30 frames   396KB   13,517
 *   stranger_things_ahoy  61 frames   932KB   15,645
 *
 * A 1.8x spread, driven by visual complexity - flat animation compresses far
 * better than film footage. So a single number would be either useless or
 * dishonest; the range is the answer, and the gap between the two bounds is
 * where "upload it and see" is the only real test.
 */
const BYTES_PER_FRAME_BEST = 8_764;
const BYTES_PER_FRAME_WORST = 15_645;

/**
 * Thresholds are set by the OBSERVED EXTREMES, not the mean, and that
 * distinction matters.
 *
 * Using the mean (11,850) classified severance_marching's 98 frames as
 * "likely to fail" - when a 98-frame Severance GIF demonstrably stored at
 * 995KB and was accepted. Content that compresses better than average gets
 * wrongly condemned, and a checker that cries wolf stops being read.
 *
 * Bounding by the extremes gives three honest answers instead of one
 * confident guess:
 *
 *   <= 67 frames   even the worst-compressing content observed would fit
 *   68-119         depends on the picture; only the controller can say
 *   > 119          even the best-compressing content observed would not fit
 *
 * The middle band is wide on purpose. Pretending to know is worse than
 * saying "upload it and find out", especially now that a bad upload can be
 * deleted.
 */
const ALWAYS_SAFE_FRAMES = Math.floor(SPRITE_LIMIT_BYTES / BYTES_PER_FRAME_WORST);
const NEVER_FITS_FRAMES = Math.floor(SPRITE_LIMIT_BYTES / BYTES_PER_FRAME_BEST);

export type Verdict = "safe" | "borderline" | "likely-fails";

export interface GifAnalysis {
  path: string;
  sourceBytes: number;
  width: number;
  height: number;
  frames: number;
  durationSeconds: number;
  /** Frames the sprite would hold - identical to `frames`, kept explicit. */
  spriteWidth: number;
  estimateBest: number;
  estimateWorst: number;
  verdict: Verdict;
  /** Plain-language explanation, including what to do about it. */
  advice: string;
  /** Frames that fit regardless of content. */
  safeFrameCount: number;
}

/**
 * Parse ffprobe's key=value output.
 *
 * Pure, exported and tested, because the positional version of this was
 * wrong and the wrongness was invisible: ffprobe emits fields in ITS order,
 * not the order you ask for them, so `duration` arrived where
 * `nb_read_frames` was expected. Every GIF then reported its duration in
 * seconds as a frame count - 2.76 frames instead of 23 - and the checker
 * cheerfully declared a library of 98-frame GIFs safe.
 *
 * Reading by name costs nothing and cannot drift when ffmpeg reorders.
 */
export function parseProbe(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return fields;
}

export async function analyseGif(path: string, sourceBytes: number): Promise<GifAnalysis> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    // nk=0 keeps the keys, which is the whole point - see parseProbe.
    "-show_entries", "stream=width,height,nb_read_frames,duration",
    "-of", "default=nw=1",
    path,
  ]);

  const fields = parseProbe(stdout);
  const width = Number(fields.width);
  const height = Number(fields.height);
  const frames = Number(fields.nb_read_frames);
  const duration = Number(fields.duration);

  const frameCount = Number.isFinite(frames) && frames > 0 ? frames : 1;
  const estimateBest = frameCount * BYTES_PER_FRAME_BEST;
  const estimateWorst = frameCount * BYTES_PER_FRAME_WORST;

  let verdict: Verdict;
  let advice: string;
  if (frameCount <= ALWAYS_SAFE_FRAMES) {
    verdict = "safe";
    advice = `${frameCount} frames fits whatever the picture looks like.`;
  } else if (frameCount <= NEVER_FITS_FRAMES) {
    verdict = "borderline";
    advice =
      `${frameCount} frames is in the band where it depends on how complex ` +
      `the picture is - flat animation compresses far better than film. ` +
      `Upload it and see; if Protect rejects it, cut to ${ALWAYS_SAFE_FRAMES} ` +
      `frames, which always fits.`;
  } else {
    verdict = "likely-fails";
    advice =
      `${frameCount} frames is more than fits even for the most compressible ` +
      `content. Cut to ${ALWAYS_SAFE_FRAMES} frames ` +
      `(${Math.round((1 - ALWAYS_SAFE_FRAMES / frameCount) * 100)}% fewer).`;
  }

  return {
    path,
    sourceBytes,
    width: width ?? 0,
    height: height ?? 0,
    frames: frameCount,
    durationSeconds: Number.isFinite(duration) ? duration! : 0,
    spriteWidth: frameCount * 240,
    estimateBest,
    estimateWorst,
    verdict,
    advice,
    safeFrameCount: ALWAYS_SAFE_FRAMES,
  };
}
