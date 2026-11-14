/**
 * The doorbell's ring sound slots, treated as a cache over the sound library.
 *
 * Images are uploaded once and kept forever, because animations are
 * uncapped. Ringtones are capped - and the first time the slots filled up,
 * a new sound was simply refused with an empty-bodied 400 and the app had
 * no way to help. So a library sound is uploaded when a theme needs it, and
 * when there is no room, the least recently used sound Doorman put there is
 * removed first. It can always come back: the file is in the library.
 *
 * What is never removed, because nothing could put it back:
 *
 *   - stock sounds
 *   - sounds Doorman did not upload - added through Protect, or before
 *     0.8.0 - since there is no copy of them anywhere else
 *   - whatever a doorbell is playing right now, or the default sound, which
 *     the caller supplies as `keep`
 *
 * Churn is bounded by the schedule rather than by anything here: a theme's
 * sound is uploaded only when it is not already on the controller, which is
 * at most once per doorbell per day and in practice far less.
 */
import { MAX_RINGTONES, ProtectError } from "./device/private.ts";
import type { Ringtone } from "./device/private.ts";
import { isLibraryRef, libraryHash } from "./sounds.ts";
import type { Store } from "./store/db.ts";

/** The slice of the private API this needs, so tests can stand in for it. */
export interface RingtoneHost {
  ringtones(): Promise<Ringtone[]>;
  uploadRingtone(bytes: Uint8Array, name: string): Promise<Ringtone>;
  deleteRingtone(id: string): Promise<void>;
}

export interface SoundFiles {
  read(hash: string): Promise<{ sound: { name: string }; bytes: Uint8Array } | null>;
}

export interface Ensured {
  ringtoneId: string;
  /** False when it was already on the controller. */
  uploaded: boolean;
  /** Names removed from the controller to make room, for the log. */
  evicted: string[];
}

export class RingtoneCache {
  readonly #store: Store;
  readonly #host: RingtoneHost;
  readonly #files: SoundFiles;
  readonly #keep: () => Promise<Set<string>>;
  readonly #limit: number;
  readonly #now: () => Date;

  constructor(options: {
    store: Store;
    host: RingtoneHost;
    files: SoundFiles;
    /** Ringtone ids that must not be removed: playing now, or the default. */
    keep: () => Promise<Set<string>>;
    limit?: number;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#host = options.host;
    this.#files = options.files;
    this.#keep = options.keep;
    this.#limit = options.limit ?? MAX_RINGTONES;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Forget manifest entries whose ringtone has gone - deleted in Protect,
   * or every one of them after a migration to a new console. Leaving them
   * would hand out an id that resolves to nothing, and Protect answers
   * that by quietly playing its own default.
   */
  reconcile(live: Ringtone[]): void {
    const ids = new Set(live.map((r) => r.id));
    for (const record of this.#store.ringtoneRecords()) {
      if (!ids.has(record.ringtoneId)) this.#store.forgetRingtone(record.hash);
    }
  }

  /** The ringtone id for a library sound, uploading it - and making room - if needed. */
  async ensure(hash: string): Promise<Ensured> {
    const at = this.#now().toISOString();
    const live = await this.#host.ringtones();
    this.reconcile(live);

    const known = this.#store.ringtoneFor(hash);
    if (known) {
      this.#store.touchRingtone(hash, at);
      return { ringtoneId: known.ringtoneId, uploaded: false, evicted: [] };
    }

    const file = await this.#files.read(hash);
    if (!file) throw new Error(`sound ${hash.slice(0, 12)} is missing from the library`);

    const evicted: string[] = [];
    if (live.length >= this.#limit) evicted.push(await this.#evict(live));

    let uploaded: Ringtone;
    try {
      uploaded = await this.#host.uploadRingtone(file.bytes, file.sound.name);
    } catch (error) {
      // A bare 400 is how a full controller answers, and its real limit may
      // be lower than the one counted above - so make room once and retry.
      // Only for a 400: deleting a sound because the network blipped would
      // be destroying something to fix nothing. And only once, so a sound
      // Protect rejects for some other reason cannot empty the cache.
      if (!(error instanceof ProtectError) || error.status !== 400 || evicted.length > 0) {
        throw error;
      }
      try {
        evicted.push(await this.#evict(await this.#host.ringtones()));
      } catch {
        throw new Error(
          "Protect refused the sound without saying why, and there is nothing Doorman " +
            "can remove to make room - its slots are probably full of stock sounds and " +
            "ones added outside Doorman. Delete one on the Sounds tab.",
        );
      }
      uploaded = await this.#host.uploadRingtone(file.bytes, file.sound.name);
    }

    this.#store.recordRingtone({
      hash,
      ringtoneId: uploaded.id,
      name: uploaded.name ?? file.sound.name,
      uploadedAt: at,
      lastUsed: at,
    });
    return { ringtoneId: uploaded.id, uploaded: true, evicted };
  }

  /**
   * Take a library sound off the controller, for when it is being deleted
   * from the library. Leaves it where it is - and says so - if a doorbell is
   * playing it or it is the default, since removing it would change what a
   * visitor hears with nothing to put back.
   */
  async release(hash: string): Promise<"removed" | "kept" | "absent"> {
    const record = this.#store.ringtoneFor(hash);
    if (!record) return "absent";
    if ((await this.#keep()).has(record.ringtoneId)) return "kept";
    const live = await this.#host.ringtones();
    if (live.some((r) => r.id === record.ringtoneId)) await this.#host.deleteRingtone(record.ringtoneId);
    this.#store.forgetRingtone(hash);
    return "removed";
  }

  /** Remove the least recently used sound that is safe to remove. */
  async #evict(live: Ringtone[]): Promise<string> {
    const keep = await this.#keep();
    // Oldest first - ringtoneRecords is ordered by last use.
    for (const record of this.#store.ringtoneRecords()) {
      const tone = live.find((r) => r.id === record.ringtoneId);
      if (!tone || tone.isDefault || keep.has(tone.id)) continue;
      await this.#host.deleteRingtone(tone.id);
      this.#store.forgetRingtone(record.hash);
      return tone.name;
    }
    throw new Error(
      `The doorbell's ${this.#limit} ring sound slots are full, and none of them is ` +
        "one Doorman can remove - they are stock sounds, ones added outside Doorman, " +
        "or playing right now. Delete one on the Sounds tab.",
    );
  }
}

/**
 * The cache as the daemon and the CLI build it, so the two cannot disagree
 * about what is safe to remove.
 *
 * `keep` is worked out when room is needed, not when this is built: what a
 * doorbell is playing changes all day, and the default can be changed in
 * Settings while this runs.
 */
export function createRingtoneCache(options: {
  store: Store;
  host: RingtoneHost;
  files: SoundFiles;
  /** What each doorbell is playing now. A failed read is null, not a throw. */
  playing: () => Promise<Array<string | null>>;
  defaultSound: () => string | undefined;
}): RingtoneCache {
  const { store } = options;
  return new RingtoneCache({
    store,
    host: options.host,
    files: options.files,
    keep: async () => {
      const keep = new Set<string>();
      for (const id of await options.playing()) if (id) keep.add(id);
      const fallback = options.defaultSound();
      if (fallback) {
        const id = isLibraryRef(fallback) ? store.ringtoneFor(libraryHash(fallback))?.ringtoneId : fallback;
        if (id) keep.add(id);
      }
      return keep;
    },
  });
}
