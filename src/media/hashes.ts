/**
 * Content hashes of files on disk, worked out once per version of a file.
 *
 * Everything in the library is addressed by content hash, and working those
 * out meant reading every file in full: 33 GIFs came to 50MB read and hashed
 * on every request for the Now page, Themes and Images alike. A file's size
 * and modification time are a stat away, and any edit, copy-over or upload
 * changes at least one of them, so the hash is only worked out again when
 * they do.
 */
import { readFile, stat } from "node:fs/promises";
import { hashBytes } from "../apply.ts";

export class FileHashes {
  readonly #known = new Map<string, { stamp: string; hash: string; bytes: number }>();

  /** The hash and size of the file at `path`, read only if it has changed. */
  async of(path: string): Promise<{ hash: string; bytes: number }> {
    const info = await stat(path);
    const stamp = `${info.size}:${info.mtimeMs}`;
    const known = this.#known.get(path);
    if (known?.stamp === stamp) return known;

    const hash = hashBytes(await readFile(path));
    const entry = { stamp, hash, bytes: info.size };
    this.#known.set(path, entry);
    return entry;
  }

  /** Forget files that are no longer there, so the map cannot grow forever. */
  keepOnly(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const path of this.#known.keys()) if (!keep.has(path)) this.#known.delete(path);
  }
}
