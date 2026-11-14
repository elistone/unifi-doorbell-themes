/**
 * Somewhere for a file to wait while it is being cropped or trimmed.
 *
 * Kept out of the media library on purpose: that directory is the
 * irreplaceable half of a backup, and every GIF someone looked at and
 * decided against would otherwise end up in it. Staged files are derived
 * and disposable, so they live beside the thumbnail cache and are swept
 * after a day.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Long enough to leave an editor open over lunch. */
const KEEP_MS = 24 * 3_600_000;

/**
 * The id is the filename, and it is the one thing the browser hands back,
 * so it is checked against exactly the shape this class mints. Nothing
 * else - no `..`, no slash, no other extension - can name a file here.
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(gif|mp3|m4a|webm|opus|ogg|wav|aac|flac)$/;

export const EXTENSION_TYPES: Record<string, string> = {
  gif: "image/gif",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  webm: "audio/webm",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
};

export class Staging {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static isId(id: string): boolean {
    return ID_PATTERN.test(id);
  }

  /** A fresh id with the given extension, for something to write into. */
  async reserve(extension: string): Promise<{ id: string; path: string }> {
    await mkdir(this.dir, { recursive: true });
    void this.sweep();
    const id = `${randomUUID()}.${extension}`;
    if (!Staging.isId(id)) throw new Error(`.${extension} files cannot be staged.`);
    return { id, path: join(this.dir, id) };
  }

  async put(bytes: Uint8Array, extension: string): Promise<string> {
    const { id, path } = await this.reserve(extension);
    await writeFile(path, bytes);
    return id;
  }

  /** The path for an id, or null for anything that is not one. */
  path(id: string): string | null {
    return Staging.isId(id) ? join(this.dir, id) : null;
  }

  typeOf(id: string): string {
    return EXTENSION_TYPES[id.slice(id.lastIndexOf(".") + 1)] ?? "application/octet-stream";
  }

  /**
   * Remove anything older than a day. Best effort, and run in the
   * background on each new file rather than on a timer, so an install
   * that never imports anything never touches the directory.
   */
  async sweep(now = Date.now()): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!Staging.isId(name)) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > KEEP_MS) await unlink(path).catch(() => {});
    }
  }
}
