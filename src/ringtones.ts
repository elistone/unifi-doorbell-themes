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
 *   - sounds with no copy in the library - added through Protect, or before
 *     0.8.0 - since Protect offers no way to download them back. Adding the
 *     original file to the library under the same name ADOPTS such a sound
 *     (see `adopt`), and from then on it is as removable as any other.
 *   - whatever a doorbell is playing right now, the default sound, and any
 *     ringtone a theme still names by id, which the caller supplies as
 *     `keep` - and if it cannot find out what is playing, nothing at all
 *
 * Churn is bounded by the schedule rather than by anything here: a theme's
 * sound is uploaded only when it is not already on the controller, which is
 * at most once per doorbell per day and in practice far less.
 */
import { MAX_RINGTONES, ProtectError } from "./device/private.ts";
import type { Ringtone } from "./device/private.ts";
import { isLibraryRef, libraryHash, libraryRef } from "./sounds.ts";
import type { Store } from "./store/db.ts";

/** The slice of the private API this needs, so tests can stand in for it. */
export interface RingtoneHost {
  ringtones(): Promise<Ringtone[]>;
  uploadRingtone(bytes: Uint8Array, name: string): Promise<Ringtone>;
  deleteRingtone(id: string): Promise<void>;
}

export interface SoundFiles {
  read(hash: string): Promise<{ sound: { name: string }; bytes: Uint8Array } | null>;
  list(): Promise<Array<{ hash: string; name: string }>>;
}

export interface Ensured {
  ringtoneId: string;
  /** False when it was already on the controller. */
  uploaded: boolean;
  /** Names removed from the controller to make room, for the log. */
  evicted: string[];
}

/**
 * Compared case- and space-insensitively, the same as re-linking does:
 * "Elf - SANTA!" in Protect and "elf - santa!.mp3" in the library are the
 * same sound to the person who named them both.
 */
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** Where the learned limit is kept - see `ensure`. */
const LEARNED_LIMIT = "ringtoneLimit";

export class RingtoneCache {
  readonly #store: Store;
  readonly #host: RingtoneHost;
  readonly #files: SoundFiles;
  readonly #keep: () => Promise<Set<string>>;
  readonly #limit: number;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;

  constructor(options: {
    store: Store;
    host: RingtoneHost;
    files: SoundFiles;
    /**
     * Ringtone ids that must not be removed. Throwing means "cannot tell",
     * and then nothing is removed.
     */
    keep: () => Promise<Set<string>>;
    limit?: number;
    now?: () => Date;
    /** Every removal goes through here, so a vanished sound is never a mystery. */
    log?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#host = options.host;
    this.#files = options.files;
    this.#keep = options.keep;
    this.#limit = options.limit ?? MAX_RINGTONES;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
  }

  /**
   * How many ringtones the controller will really hold.
   *
   * Protect's documented cap is 12, but a live console refused an upload
   * with 10 present - most likely counting a built-in sound it does not
   * list. So the number that actually caused a refusal is remembered, and
   * room is made BEFORE uploading from then on rather than after a failure.
   */
  get limit(): number {
    const learned = Number(this.#store.setting(LEARNED_LIMIT));
    return Number.isInteger(learned) && learned > 0 ? Math.min(learned, this.#limit) : this.#limit;
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

  /**
   * Claim sounds already on the controller that the library has a copy of,
   * matched by name. Returns the names adopted.
   *
   * This is how a sound added through Protect becomes one Doorman can
   * manage: Protect cannot hand its audio back, so the person adds the
   * original file to the library under the same name, and the two are
   * linked here - no second upload, no duplicate in a slot.
   *
   * Themes and the default that named the ringtone by id are moved onto the
   * library sound as they are adopted. Left on the id, they would break the
   * first time the cache removed it to make room, with nothing to put back.
   */
  async adopt(live: Ringtone[]): Promise<string[]> {
    const owned = new Set(this.#store.ringtoneRecords().map((r) => r.ringtoneId));
    const unowned = live.filter((r) => !r.isDefault && !owned.has(r.id));
    if (unowned.length === 0) return [];

    const at = this.#now().toISOString();
    const adopted: string[] = [];
    for (const sound of await this.#files.list()) {
      if (this.#store.ringtoneFor(sound.hash)) continue;
      const match = unowned.find((r) => nameKey(r.name) === nameKey(sound.name) && !owned.has(r.id));
      if (!match) continue;

      this.#store.recordRingtone({ hash: sound.hash, ringtoneId: match.id, name: match.name, uploadedAt: at, lastUsed: at });
      owned.add(match.id);
      const ref = libraryRef(sound.hash);
      for (const theme of this.#store.themes()) {
        if (theme.sound === match.id) this.#store.upsertTheme({ ...theme, sound: ref, soundName: sound.name });
      }
      if (this.#store.setting("defaultRingtone") === match.id) this.#store.setSetting("defaultRingtone", ref);
      this.#log(`adopted "${match.name}" (${match.id}) as a library sound`);
      adopted.push(match.name);
    }
    return adopted;
  }

  /**
   * Re-point themes whose ringtone id no longer exists at a library sound
   * of the name they remember. Returns the theme names re-pointed.
   *
   * The library's version of relinkSounds: after a Protect migration the
   * old ids are gone for good, and a sound with the remembered name in the
   * library is a better answer than waiting for one to appear on the
   * controller - it can be uploaded whenever it is needed.
   */
  async relinkBroken(live: Ringtone[]): Promise<string[]> {
    const ids = new Set(live.map((r) => r.id));
    const broken = this.#store
      .themes()
      .filter((t) => t.sound && !isLibraryRef(t.sound) && !ids.has(t.sound) && t.soundName);
    if (broken.length === 0) return [];

    const byName = new Map((await this.#files.list()).map((s) => [nameKey(s.name), s]));
    const relinked: string[] = [];
    for (const theme of broken) {
      const sound = byName.get(nameKey(theme.soundName!));
      if (!sound) continue;
      this.#store.upsertTheme({ ...theme, sound: libraryRef(sound.hash), soundName: sound.name });
      this.#log(`theme "${theme.name}" re-linked from missing ringtone ${theme.sound} to library sound "${sound.name}"`);
      relinked.push(theme.name);
    }
    return relinked;
  }

  /**
   * Swap a sound that exists only on the controller for a library sound
   * found to replace it - typically the same clip found again, since
   * Protect cannot hand the original back.
   *
   * Unlike adopting, this does not trust that the two are the same audio:
   * themes and the default move to the library sound, and the old copy is
   * deleted so the new one is what gets uploaded. Unless a doorbell is
   * playing it right now - then it is linked instead, and stays until the
   * cache next needs the room. Removing it would leave that doorbell
   * pointing at nothing.
   */
  async replace(ringtoneId: string, hash: string): Promise<"removed" | "linked"> {
    const ref = libraryRef(hash);
    const sound = (await this.#files.list()).find((s) => s.hash === hash);
    for (const theme of this.#store.themes()) {
      if (theme.sound === ringtoneId) this.#store.upsertTheme({ ...theme, sound: ref, soundName: sound?.name ?? theme.soundName });
    }
    if (this.#store.setting("defaultRingtone") === ringtoneId) this.#store.setSetting("defaultRingtone", ref);

    // Asked after the move, so themes no longer pin it by id - only what is
    // playing, or a deployment's own default, still can.
    const live = await this.#host.ringtones();
    const tone = live.find((r) => r.id === ringtoneId);
    if (!tone) return "removed";
    const at = this.#now().toISOString();
    if ((await this.#keep()).has(ringtoneId)) {
      this.#store.recordRingtone({ hash, ringtoneId, name: tone.name, uploadedAt: at, lastUsed: at });
      this.#log(`linked "${tone.name}" (${ringtoneId}) to its replacement - playing, so kept for now`);
      return "linked";
    }
    await this.#host.deleteRingtone(ringtoneId);
    this.#log(`removed "${tone.name}" (${ringtoneId}) - replaced by library sound "${sound?.name ?? hash.slice(0, 12)}"`);
    return "removed";
  }

  /** The ringtone id for a library sound, uploading it - and making room - if needed. */
  async ensure(hash: string): Promise<Ensured> {
    const at = this.#now().toISOString();
    let live = await this.#host.ringtones();
    this.reconcile(live);
    await this.adopt(live);
    await this.relinkBroken(live);

    const known = this.#store.ringtoneFor(hash);
    if (known) {
      this.#store.touchRingtone(hash, at);
      return { ringtoneId: known.ringtoneId, uploaded: false, evicted: [] };
    }

    const file = await this.#files.read(hash);
    if (!file) throw new Error(`sound ${hash.slice(0, 12)} is missing from the library`);

    const evicted: string[] = [];
    while (live.length >= this.limit) {
      evicted.push(await this.#evict(live, file.sound.name));
      live = await this.#host.ringtones();
    }

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
      const refusedAt = live.length;
      evicted.push(await this.#evict(live, file.sound.name));
      uploaded = await this.#host.uploadRingtone(file.bytes, file.sound.name);
      // Learned only now the retry has worked, which is what shows the
      // refusal was about room and not about the file.
      this.#store.setSetting(LEARNED_LIMIT, String(refusedAt));
      this.#log(`Protect holds ${refusedAt} ring sounds at most, not ${this.#limit} - remembered`);
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
    if (live.some((r) => r.id === record.ringtoneId)) {
      await this.#host.deleteRingtone(record.ringtoneId);
      this.#log(`removed "${record.name}" (${record.ringtoneId}) - deleted from the library`);
    }
    this.#store.forgetRingtone(hash);
    return "removed";
  }

  /** Remove the least recently used sound that is safe to remove. */
  async #evict(live: Ringtone[], forName: string): Promise<string> {
    let keep: Set<string>;
    try {
      keep = await this.#keep();
    } catch (error) {
      // Not knowing what is playing is not permission to guess.
      throw new Error(
        `Could not check what the doorbells are playing, so nothing was removed to make room ` +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    // Oldest first - ringtoneRecords is ordered by last use.
    for (const record of this.#store.ringtoneRecords()) {
      const tone = live.find((r) => r.id === record.ringtoneId);
      if (!tone || tone.isDefault || keep.has(tone.id)) continue;
      await this.#host.deleteRingtone(tone.id);
      this.#store.forgetRingtone(record.hash);
      this.#log(`removed "${tone.name}" (${tone.id}) to make room for "${forName}" - still in the library`);
      return tone.name;
    }

    const noCopy = live.filter((r) => !r.isDefault && !this.#store.ringtoneRecords().some((x) => x.ringtoneId === r.id));
    throw new Error(
      `The doorbell is full (${live.length} of ${this.limit}), and none of its sounds is one Doorman can ` +
        "remove and put back." +
        (noCopy.length > 0
          ? ` ${noCopy.map((r) => `"${r.name}"`).join(", ")} ${noCopy.length === 1 ? "has" : "have"} no copy in the ` +
            "library - add the original file to the library under the same name and Doorman can manage it, " +
            "or delete one on the Sounds tab."
          : " Everything there is a stock sound or playing right now."),
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
  /**
   * What each doorbell is playing now. Let a failed read THROW: a doorbell
   * whose sound could not be read might be playing anything, so the cache
   * must then remove nothing rather than guess.
   */
  playing: () => Promise<Array<string | null>>;
  defaultSound: () => string | undefined;
  log?: (message: string) => void;
}): RingtoneCache {
  const { store } = options;
  const idOf = (ref: string | undefined) =>
    !ref ? undefined : isLibraryRef(ref) ? store.ringtoneFor(libraryHash(ref))?.ringtoneId : ref;

  return new RingtoneCache({
    store,
    host: options.host,
    files: options.files,
    log: options.log,
    keep: async () => {
      const keep = new Set<string>();
      for (const id of await options.playing()) if (id) keep.add(id);
      const fallback = idOf(options.defaultSound());
      if (fallback) keep.add(fallback);
      // A theme naming a ringtone by id has nothing to bring it back with.
      for (const theme of store.themes()) {
        if (theme.sound && !isLibraryRef(theme.sound)) keep.add(theme.sound);
      }
      return keep;
    },
  });
}
