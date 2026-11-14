/**
 * Cropping, trimming and converting, so a GIF or a sound found on the web
 * can go straight onto the doorbell without a trip through another tool.
 *
 * The argument builders are pure and exported because they are where the
 * arithmetic lives - frame rates, crop bounds, cut points - and ffmpeg is
 * not installed everywhere the tests run. The functions that actually call
 * ffmpeg are thin wrappers around them.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALWAYS_SAFE_FRAMES, analyseGif, parseProbe } from "./analyse.ts";
import type { GifAnalysis } from "./analyse.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";

/**
 * The doorbell's screen. The controller scales every frame to this anyway,
 * so rendering any larger only makes the upload bigger and slower.
 */
export const SCREEN = 240;

/** A square, in source pixels. Square because the screen is. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

export interface GifEdit {
  crop?: Crop;
  /** Seconds from the start of the source. */
  start?: number;
  end?: number;
}

export interface GifSource {
  width: number;
  height: number;
  frames: number;
  durationSeconds: number;
}

/**
 * The largest square that fits, centred. What you get if you crop nothing,
 * which beats letting the controller squash a wide GIF into a square.
 */
export function centreCrop(width: number, height: number): Crop {
  const size = Math.min(width, height);
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size };
}

/**
 * Pull a requested crop back inside the frame.
 *
 * The crop box is dragged around in a browser at whatever scale the image
 * happens to be displayed, so rounding can put it a pixel or two outside
 * the source. ffmpeg refuses a crop larger than the frame outright, which
 * would turn a sloppy drag into a failed render.
 */
export function clampCrop(crop: Crop, width: number, height: number): Crop {
  const size = Math.max(1, Math.min(Math.round(crop.size), width, height));
  const x = Math.min(Math.max(0, Math.round(crop.x)), width - size);
  const y = Math.min(Math.max(0, Math.round(crop.y)), height - size);
  return { x, y, size };
}

/** A start/end pair kept inside the clip and the right way round. */
export function clampWindow(
  start: number | undefined,
  end: number | undefined,
  duration: number,
): { start: number; end: number } {
  const total = duration > 0 ? duration : 0;
  const s = Math.min(Math.max(0, Number.isFinite(start) ? start! : 0), total);
  const e = Math.min(Math.max(0, Number.isFinite(end) ? end! : total), total);
  if (e - s < 0.1) throw new Error("The clip is shorter than a tenth of a second - move the end later.");
  return { start: s, end: e };
}

/**
 * The frame rate that keeps the result under the always-fits frame count.
 *
 * Never raises the source rate: a 10fps GIF stays 10fps rather than having
 * frames invented. Only lowers it when the trimmed clip would otherwise
 * hold more frames than are guaranteed to fit, and then by holding each
 * frame longer rather than cutting the end off, for the same reason
 * `reduceFrames` does - the punchline is usually last.
 */
export function targetFps(source: GifSource, seconds: number): number {
  const sourceFps =
    source.durationSeconds > 0 && source.frames > 1 ? source.frames / source.durationSeconds : 10;
  const ceiling = ALWAYS_SAFE_FRAMES / seconds;
  return Math.min(sourceFps, ceiling);
}

export function gifEditArgs(input: string, output: string, edit: GifEdit, source: GifSource): string[] {
  const crop = clampCrop(edit.crop ?? centreCrop(source.width, source.height), source.width, source.height);

  // A still GIF has no duration to trim and no frame rate to lower, so it
  // is only cropped. Anything else gets the window and the rate cap.
  const timing: string[] = [];
  if (source.durationSeconds > 0 && source.frames > 1) {
    const { start, end } = clampWindow(edit.start, edit.end, source.durationSeconds);
    timing.push(
      `trim=start=${start.toFixed(3)}:end=${end.toFixed(3)}`,
      "setpts=PTS-STARTPTS",
      `fps=${targetFps(source, end - start).toFixed(4)}`,
    );
  }

  // Timing first, so frames that are about to be dropped are never
  // cropped or scaled.
  const chain = [
    ...timing,
    `crop=${crop.size}:${crop.size}:${crop.x}:${crop.y}`,
    `scale=${SCREEN}:${SCREEN}:flags=lanczos`,
  ].join(",");

  // A palette built from this clip rather than a generic one. The
  // controller quantises again to 32 colours, but a good 256-colour start
  // is what makes the preview here look like what was chosen.
  const graph =
    `${chain},split[a][b];` +
    "[a]palettegen=stats_mode=diff[p];" +
    "[b][p]paletteuse=dither=bayer:bayer_scale=3";

  return [
    "-y", "-v", "error",
    "-i", input,
    "-filter_complex", graph,
    // The fps filter can round up by one frame. A hard cap costs at most
    // the final frame and guarantees the promise in the name.
    "-frames:v", String(ALWAYS_SAFE_FRAMES),
    "-loop", "0",
    output,
  ];
}

export async function renderGif(input: string, output: string, edit: GifEdit): Promise<GifAnalysis> {
  const source = await analyseGif(input, 0);
  await run(FFMPEG, gifEditArgs(input, output, edit, source));
  const { stat } = await import("node:fs/promises");
  return analyseGif(output, (await stat(output)).size);
}

// ------------------------------------------------------------------- audio

export interface AudioEdit {
  start?: number;
  end?: number;
  /**
   * Bring the clip to a common loudness. On by default, because sounds
   * found in different places arrive at wildly different levels, and the
   * doorbell has one volume setting for all of them.
   */
  normalise?: boolean;
}

/** Short enough to stop the cut clicking, too short to hear as a fade. */
const EDGE_FADE_SECONDS = 0.03;

export function audioEditArgs(input: string, output: string, edit: AudioEdit, duration: number): string[] {
  const { start, end } = clampWindow(edit.start, edit.end, duration);
  const length = end - start;

  const filters = [
    `atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
    // EBU R128 at -16 LUFS, the usual target for speech and alerts.
    ...(edit.normalise === false ? [] : ["loudnorm=I=-16:TP=-1.5:LRA=11"]),
    `afade=t=in:st=0:d=${EDGE_FADE_SECONDS}`,
    `afade=t=out:st=${Math.max(0, length - EDGE_FADE_SECONDS).toFixed(3)}:d=${EDGE_FADE_SECONDS}`,
  ];

  return [
    "-y", "-v", "error",
    "-i", input,
    "-vn",
    "-af", filters.join(","),
    // One speaker, so stereo is twice the bytes for nothing. loudnorm
    // resamples internally to 192kHz, so the rate has to be set back.
    "-ac", "1",
    "-ar", "44100",
    "-codec:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    output,
  ];
}

export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1",
    path,
  ]);
  const duration = Number(parseProbe(stdout).duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("That file has no audio ffmpeg can read.");
  }
  return duration;
}

export async function renderAudio(
  input: string,
  output: string,
  edit: AudioEdit,
): Promise<{ durationSeconds: number; bytes: number }> {
  await run(FFMPEG, audioEditArgs(input, output, edit, await probeDuration(input)));
  const { stat } = await import("node:fs/promises");
  return { durationSeconds: await probeDuration(output), bytes: (await stat(output)).size };
}
