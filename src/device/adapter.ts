import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AssetSource, ImageDevice } from "../apply.ts";
import { hashBytes } from "../apply.ts";
import type { Protect } from "./protect.ts";

/**
 * The real adapters, joining the testable core to the hardware.
 *
 * Kept deliberately thin. Everything here is exercised by pressing a doorbell
 * rather than by a test suite, so the less decision-making it contains the
 * better - anything with a branch worth testing belongs on the other side of
 * the port, in apply.ts.
 */

export class ProtectImageDevice implements ImageDevice {
  readonly #protect: Protect;
  readonly #cameraId: string;

  constructor(protect: Protect, cameraId: string) {
    this.#protect = protect;
    this.#cameraId = cameraId;
  }

  async currentImage(): Promise<string | null> {
    const message = await this.#protect.currentMessage(this.#cameraId);
    // Only an IMAGE message counts as "showing an asset". A text message or
    // DO_NOT_DISTURB means someone has taken the screen over by hand, which
    // should read as drift rather than as the wrong image.
    return message?.type === "IMAGE" ? (message.text ?? null) : null;
  }

  async showImage(assetName: string): Promise<void> {
    await this.#protect.showImage(this.#cameraId, assetName);
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * Media on disk, addressed by content hash.
 *
 * Hashing the bytes rather than trusting filenames is what makes upload-once
 * safe: renaming a file must not cause a re-upload, and two copies of the
 * same GIF under different names must not become two assets on the NVR.
 */
export class DirectoryAssetSource implements AssetSource {
  readonly #directory: string;
  readonly #protect: Protect;
  #index: Map<string, string> | null = null;

  constructor(directory: string, protect: Protect) {
    this.#directory = directory;
    this.#protect = protect;
  }

  /** Hash every supported file in the media directory. */
  async index(): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    const entries = await readdir(this.#directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!(extname(entry.name).toLowerCase() in MIME_BY_EXTENSION)) continue;
      const bytes = await readFile(join(this.#directory, entry.name));
      index.set(hashBytes(bytes), entry.name);
    }
    this.#index = index;
    return index;
  }

  async read(hash: string) {
    // Re-index on a miss before giving up: media is added while the daemon is
    // running, and a stale index would report a file the user can plainly see
    // as missing.
    let filename = (this.#index ?? (await this.index())).get(hash);
    if (!filename) filename = (await this.index()).get(hash);
    if (!filename) return null;

    const bytes = await readFile(join(this.#directory, filename));
    return {
      bytes: new Uint8Array(bytes),
      filename,
      mimeType: MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream",
    };
  }

  async upload(bytes: Uint8Array, filename: string, mimeType: string) {
    const asset = await this.#protect.uploadAnimation(bytes, filename, mimeType);
    return { name: asset.name, size: asset.size };
  }

  async listRemote(): Promise<string[]> {
    return (await this.#protect.animations()).map((a) => a.name);
  }
}
