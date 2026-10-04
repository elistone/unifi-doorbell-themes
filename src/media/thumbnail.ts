/**
 * Poster frames for the image library.
 *
 * The Images tab used to load every GIF at full size: 47MB for a 31-file
 * library, with 31 animations decoding at once. It was the only part of the
 * app that felt bad, and it got worse with every GIF added.
 *
 * One still frame per GIF, cached on disk and keyed by content hash. The
 * hash is what makes the cache correct for free - a changed file is a
 * different hash and so a different thumbnail, and nothing needs
 * invalidating. Where the animation is the point (the Now panel, and
 * hovering a tile) the real GIF is still served.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";

/**
 * Wide enough for a 190px tile on a 2x display, which is the largest place
 * a thumbnail is shown. Height follows the aspect ratio.
 */
const WIDTH = 384;

export class Thumbnailer {
  readonly #dir: string;

  constructor(cacheDir: string) {
    this.#dir = cacheDir;
  }

  path(hash: string): string {
    return join(this.#dir, `${hash}.jpg`);
  }

  /**
   * Return the cached thumbnail's path, generating it if it is not there.
   *
   * Concurrent requests for the same new thumbnail will each run ffmpeg and
   * write the same bytes to the same path. Harmless, and cheaper than a
   * lock: the second writer produces an identical file, and the cost is one
   * duplicated decode on the first ever view.
   */
  async ensure(hash: string, sourcePath: string): Promise<string> {
    const target = this.path(hash);
    try {
      await stat(target);
      return target;
    } catch {
      // Not cached yet.
    }

    await mkdir(this.#dir, { recursive: true });

    // `thumbnail` picks the most representative frame from a batch rather
    // than blindly taking the first, which on a lot of reaction GIFs is a
    // black frame or a title card.
    await run(FFMPEG, [
      "-v", "error",
      "-i", sourcePath,
      "-vf", `thumbnail,scale=${WIDTH}:-1:flags=lanczos`,
      "-frames:v", "1",
      "-q:v", "4",
      "-y",
      target,
    ]);

    return target;
  }
}
