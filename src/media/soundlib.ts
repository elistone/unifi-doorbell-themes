/**
 * Ring sounds kept by Doorman itself, so the doorbell's slots can be a cache.
 *
 * The controller holds only a dozen ringtones, so a library that lived only
 * there filled up and then refused every new sound with an empty 400. Kept
 * on disk instead, a sound can be removed from the controller to make room
 * and uploaded again the day a theme needs it - and a Protect migration,
 * which invalidates every ringtone id at once, costs nothing: the file is
 * still here.
 *
 * Lives in a `sounds/` folder inside the media library, so whatever already
 * backs up the GIFs backs these up too. The image scanner only reads the top
 * level, so the folder is invisible to it.
 *
 * MP3 only, because everything arrives through the editor, which writes
 * MP3 - so the bytes uploaded are what the upload claims they are.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBytes } from "../apply.ts";
import { FileHashes } from "./hashes.ts";

export interface LibrarySound {
  hash: string;
  /** What it is called on the doorbell: the filename without `.mp3`. */
  name: string;
  filename: string;
  bytes: number;
}

/**
 * A filename from a name someone typed. Kept readable, because this folder
 * is something a person may open in a file manager to find a sound.
 */
export function soundFilename(name: string): string {
  const stem = name
    .trim()
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 60);
  if (!stem) throw new Error("Give the sound a name.");
  return `${stem}.mp3`;
}

export class SoundLibrary {
  readonly dir: string;
  readonly #hashes = new FileHashes();

  constructor(dir: string) {
    this.dir = dir;
  }

  async list(): Promise<LibrarySound[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const sounds: LibrarySound[] = [];
    const seen: string[] = [];
    for (const filename of names) {
      // Dotfiles include macOS's `._name.mp3` forks, which are not audio.
      if (filename.startsWith(".") || !filename.toLowerCase().endsWith(".mp3")) continue;
      const path = join(this.dir, filename);
      seen.push(path);
      const { hash, bytes } = await this.#hashes.of(path);
      sounds.push({ hash, name: filename.slice(0, -4), filename, bytes });
    }
    this.#hashes.keepOnly(seen);
    return sounds.sort((a, b) => a.name.localeCompare(b.name));
  }

  async find(hash: string): Promise<LibrarySound | null> {
    return (await this.list()).find((s) => s.hash === hash) ?? null;
  }

  async read(hash: string): Promise<{ sound: LibrarySound; bytes: Uint8Array } | null> {
    const sound = await this.find(hash);
    if (!sound) return null;
    return { sound, bytes: new Uint8Array(await readFile(join(this.dir, sound.filename))) };
  }

  /**
   * Add a sound under a name.
   *
   * The same bytes already here are the same sound whatever they are called,
   * so that answers with the existing one rather than a second copy. A
   * different sound wanting a name already taken is refused, not
   * overwritten: a theme may be pointing at the one already there.
   */
  async add(bytes: Uint8Array, name: string): Promise<{ sound: LibrarySound; duplicate: boolean }> {
    const filename = soundFilename(name);
    const hash = hashBytes(bytes);
    const existing = await this.list();

    const same = existing.find((s) => s.hash === hash);
    if (same) return { sound: same, duplicate: true };
    if (existing.some((s) => s.filename.toLowerCase() === filename.toLowerCase())) {
      throw new Error(`There is already a sound called "${filename.slice(0, -4)}". Choose another name.`);
    }

    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, filename), bytes);
    return {
      sound: { hash, name: filename.slice(0, -4), filename, bytes: bytes.byteLength },
      duplicate: false,
    };
  }

  /**
   * Give a sound a new name. The content - and so the hash every theme
   * points at - is untouched, which is what makes renaming safe.
   */
  async rename(hash: string, name: string): Promise<LibrarySound> {
    const filename = soundFilename(name);
    const existing = await this.list();
    const sound = existing.find((s) => s.hash === hash);
    if (!sound) throw new Error("That sound is not in the library.");
    if (sound.filename === filename) return sound;
    // Case-only renames are the sound itself on a case-insensitive disk.
    const clash = existing.find((s) => s.hash !== hash && s.filename.toLowerCase() === filename.toLowerCase());
    if (clash) throw new Error(`There is already a sound called "${clash.name}". Choose another name.`);
    await rename(join(this.dir, sound.filename), join(this.dir, filename));
    return { ...sound, name: filename.slice(0, -4), filename };
  }

  async remove(hash: string): Promise<LibrarySound | null> {
    const sound = await this.find(hash);
    if (sound) await unlink(join(this.dir, sound.filename));
    return sound;
  }
}
