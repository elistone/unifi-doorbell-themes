import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { ProtectError } from "../src/device/private.ts";
import type { Ringtone } from "../src/device/private.ts";
import { RingtoneCache } from "../src/ringtones.ts";
import type { RingtoneHost } from "../src/ringtones.ts";
import { Store } from "../src/store/db.ts";

/**
 * The ring sound slots as a cache. What matters most here is what is NEVER
 * removed: a stock sound, one Doorman has no copy of, or the one playing -
 * each of those is gone for good once deleted.
 */

/**
 * A controller with a slot limit, which refuses past it the way Protect
 * does: an empty-bodied 400. `realLimit` can be set below the limit the
 * cache believes in, which is the case that bit in production.
 */
class FakeController implements RingtoneHost {
  tones: Ringtone[] = [];
  deleted: string[] = [];
  uploads = 0;
  realLimit = 12;
  #next = 1;

  add(name: string, isDefault = false): Ringtone {
    const tone = { id: `id-${this.#next++}`, name, isDefault, size: 1 };
    this.tones.push(tone);
    return tone;
  }
  async ringtones() {
    return [...this.tones];
  }
  async uploadRingtone(_bytes: Uint8Array, name: string) {
    if (this.tones.length >= this.realLimit) {
      throw new ProtectError(400, "POST /ringtones failed with 400: ");
    }
    this.uploads++;
    return this.add(name);
  }
  async deleteRingtone(id: string) {
    this.deleted.push(id);
    this.tones = this.tones.filter((t) => t.id !== id);
  }
}

/**
 * The library. Any hash reads as "sound <hash>", which is all most tests
 * need; `named` lists sounds by a chosen name, for adoption.
 */
const named = new Map<string, string>();
const files = {
  async read(hash: string) {
    if (hash === "missing") return null;
    return { sound: { name: named.get(hash) ?? `sound ${hash}` }, bytes: new Uint8Array([1]) };
  },
  async list() {
    return [...named].map(([hash, name]) => ({ hash, name }));
  },
};

let store: Store;
let controller: FakeController;
let keep: Set<string>;
let clock: number;

function cache(limit = 12) {
  return new RingtoneCache({
    store,
    host: controller,
    files,
    keep: async () => keep,
    limit,
    // Each call a minute later, so "least recently used" is unambiguous.
    now: () => new Date(Date.UTC(2026, 10, 14, 12, clock++)),
  });
}

/** Fill the controller: four stock, then the given library hashes via the cache. */
async function fill(c: RingtoneCache, hashes: string[]) {
  for (const name of ["Default", "Chime", "Bell", "Ding"]) controller.add(name, true);
  for (const hash of hashes) await c.ensure(hash);
}

beforeEach(() => {
  named.clear();
  store = new Store(":memory:");
  controller = new FakeController();
  keep = new Set();
  clock = 0;
});

describe("ring sound cache", () => {
  it("uploads a sound once, and reuses it after", async () => {
    const c = cache();
    const first = await c.ensure("a");
    const second = await c.ensure("a");
    assert.equal(first.uploaded, true);
    assert.equal(second.uploaded, false);
    assert.equal(second.ringtoneId, first.ringtoneId);
    assert.equal(controller.uploads, 1);
  });

  it("uploads again when the ringtone was deleted behind its back", async () => {
    // Someone deleted it in Protect, or Protect moved to a new console.
    const c = cache();
    const { ringtoneId } = await c.ensure("a");
    await controller.deleteRingtone(ringtoneId);
    const again = await c.ensure("a");
    assert.equal(again.uploaded, true);
    assert.notEqual(again.ringtoneId, ringtoneId);
  });

  it("makes room by removing the least recently used", async () => {
    const c = cache(8);
    await fill(c, ["a", "b", "c", "d"]); // 8 of 8
    await c.ensure("a"); // a is now the most recent; b is the oldest

    const result = await c.ensure("e");
    assert.deepEqual(result.evicted, ["sound b"]);
    assert.ok(!controller.tones.some((t) => t.name === "sound b"));
    assert.equal(store.ringtoneFor("b"), null, "the manifest forgets what it removed");
  });

  it("never removes a stock sound or one it has no copy of", async () => {
    const c = cache(6);
    for (const name of ["Default", "Chime", "Bell", "Ding"]) controller.add(name, true);
    controller.add("uploaded by hand in Protect"); // 5 of 6, nothing Doorman owns
    const { ringtoneId: a } = await c.ensure("a"); // 6 of 6

    await c.ensure("b");
    assert.deepEqual(controller.deleted, [a], "only its own sound is a candidate");
    assert.ok(controller.tones.some((t) => t.name === "uploaded by hand in Protect"));
    assert.equal(controller.tones.filter((t) => t.isDefault).length, 4);
  });

  it("never removes what a doorbell is playing", async () => {
    const c = cache(6);
    await fill(c, ["a", "b"]); // 6 of 6; a is the oldest
    keep = new Set([store.ringtoneFor("a")!.ringtoneId]);

    const result = await c.ensure("c");
    assert.deepEqual(result.evicted, ["sound b"], "skips the playing one, takes the next oldest");
  });

  it("says plainly when there is nothing it may remove", async () => {
    const c = cache(5);
    await fill(c, ["a"]); // 5 of 5
    keep = new Set([store.ringtoneFor("a")!.ringtoneId]);
    await assert.rejects(() => c.ensure("b"), /none of its sounds is one Doorman can remove/);
    assert.deepEqual(controller.deleted, []);
  });

  it("copes with a real limit lower than the one it counts", async () => {
    // What happened in production: Doorman counted fewer than 12 and
    // uploaded, and Protect answered with an empty 400 anyway.
    const c = cache(12);
    await fill(c, ["a", "b"]); // 6 tones
    controller.realLimit = 6;

    const result = await c.ensure("c");
    assert.equal(result.uploaded, true);
    assert.deepEqual(result.evicted, ["sound a"]);
  });

  it("retries only once, so a sound Protect dislikes cannot empty the cache", async () => {
    const c = cache(12);
    await fill(c, ["a", "b", "c"]);
    controller.realLimit = 0; // refuses everything

    await assert.rejects(() => c.ensure("d"), ProtectError);
    assert.equal(controller.deleted.length, 1);
  });

  it("removes nothing when the failure is not Protect saying no", async () => {
    const c = cache(12);
    await fill(c, ["a"]);
    controller.uploadRingtone = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    await assert.rejects(() => c.ensure("b"), /timeout/);
    assert.deepEqual(controller.deleted, []);
  });

  it("fails clearly when the file has left the library", async () => {
    await assert.rejects(() => cache().ensure("missing"), /missing from the library/);
  });
});

describe("what the daemon keeps", () => {
  it("protects every doorbell's current sound and the default, library or not", async () => {
    const { createRingtoneCache } = await import("../src/ringtones.ts");
    const c = createRingtoneCache({
      store,
      host: controller,
      files,
      playing: async () => [null, "front-playing"],
      defaultSound: () => "library:stitch",
    });
    for (const name of ["Default", "Chime", "Bell", "Ding"]) controller.add(name, true);
    const stitch = await c.ensure("stitch");
    const front = controller.add("front"); // stands in for front-playing below
    front.id = "front-playing";
    for (const hash of ["a", "b", "c", "d", "e", "f"]) await c.ensure(hash); // 12 of 12

    // Force "front-playing" and stitch to be the oldest Doorman-managed entries.
    store.recordRingtone({ hash: "front", ringtoneId: "front-playing", name: "front", uploadedAt: "2000", lastUsed: "2000" });
    store.touchRingtone("stitch", "2000");

    const result = await c.ensure("g");
    assert.deepEqual(result.evicted, ["sound a"], "skipped the playing sound and the default");
    assert.ok(controller.tones.some((t) => t.id === stitch.ringtoneId));
    assert.ok(controller.tones.some((t) => t.id === "front-playing"));
  });
});

describe("adopting sounds added through Protect", () => {
  it("links a library sound to a same-named one already there, instead of uploading", async () => {
    const c = cache();
    const elf = controller.add("Elf - SANTA!");
    named.set("elf", "elf - santa!");

    const result = await c.ensure("elf");
    assert.equal(result.ringtoneId, elf.id);
    assert.equal(result.uploaded, false);
    assert.equal(controller.uploads, 0, "no duplicate in a slot");
  });

  it("moves themes and the default off the ringtone id, so removing it cannot break them", async () => {
    const elf = controller.add("Elf - SANTA!");
    store.upsertTheme({
      id: "christmas", name: "Christmas", image: "h", sound: elf.id, soundName: "Elf - SANTA!",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    store.setSetting("defaultRingtone", elf.id);
    named.set("elf", "Elf - SANTA!");

    const adopted = await cache().adopt(await controller.ringtones());
    assert.deepEqual(adopted, ["Elf - SANTA!"]);
    assert.equal(store.themes()[0]!.sound, "library:elf");
    assert.equal(store.setting("defaultRingtone"), "library:elf");
  });

  it("makes an adopted sound one it may remove to make room", async () => {
    const c = cache(6);
    for (const name of ["Default", "Chime", "Bell", "Ding"]) controller.add(name, true);
    controller.add("Schitt's Creek");
    controller.add("Stranger Things");
    named.set("schitt", "schitt's creek"); // the original, added to the library

    const result = await c.ensure("new");
    assert.deepEqual(result.evicted, ["Schitt's Creek"]);
    assert.ok(controller.tones.some((t) => t.name === "Stranger Things"), "the one with no copy stays");
  });

  it("names the sounds that need a copy, when they are all that is left", async () => {
    const c = cache(5);
    for (const name of ["Default", "Chime", "Bell", "Ding"]) controller.add(name, true);
    controller.add("Stranger Things");
    await assert.rejects(() => c.ensure("new"), /"Stranger Things" has no copy in the library/);
  });
});

describe("the real limit", () => {
  it("is learned from a refusal, so next time room is made before uploading", async () => {
    const c = cache(12);
    await fill(c, ["a", "b"]); // 6 tones
    controller.realLimit = 6;

    await c.ensure("c"); // refused at 6, makes room, retries
    assert.equal(c.limit, 6);

    let refusals = 0;
    const upload = controller.uploadRingtone.bind(controller);
    controller.uploadRingtone = async (bytes, name) => {
      try {
        return await upload(bytes, name);
      } catch (error) {
        refusals++;
        throw error;
      }
    };
    await c.ensure("d");
    assert.equal(refusals, 0, "made room first instead of being refused again");
  });

  it("is not learned when the retry fails too - that was the file, not the room", async () => {
    const c = cache(12);
    await fill(c, ["a", "b"]);
    controller.realLimit = 0;
    await assert.rejects(() => c.ensure("c"));
    assert.equal(c.limit, 12);
  });
});

describe("removing safely", () => {
  it("removes nothing when it cannot tell what is playing", async () => {
    const c = new RingtoneCache({
      store, host: controller, files, limit: 6,
      keep: async () => { throw new Error("speaker settings timed out"); },
    });
    await fill(c, ["a", "b"]);
    await assert.rejects(() => c.ensure("c"), /could not check what the doorbells are playing/i);
    assert.deepEqual(controller.deleted, []);
  });

  it("never removes a ringtone a theme still names by id", async () => {
    const { createRingtoneCache } = await import("../src/ringtones.ts");
    const c = createRingtoneCache({
      store, host: controller, files, playing: async () => [], defaultSound: () => undefined,
    });
    for (const name of ["Default", "Chime", "Bell", "Ding"]) controller.add(name, true);
    for (const hash of ["a", "b", "c", "d", "e", "f", "g", "h"]) await c.ensure(hash); // 12 of 12
    store.upsertTheme({
      id: "t", name: "T", image: "h", sound: store.ringtoneFor("a")!.ringtoneId,
      priority: 0, enabled: true, rules: [{}], devices: [],
    });

    const result = await c.ensure("i");
    assert.deepEqual(result.evicted, ["sound b"], "skipped a, which a theme names by id");
  });

  it("logs every removal", async () => {
    const lines: string[] = [];
    const c = new RingtoneCache({ store, host: controller, files, limit: 6, keep: async () => new Set(), log: (m) => lines.push(m) });
    await fill(c, ["a", "b"]);
    await c.ensure("c");
    assert.match(lines.join("\n"), /removed "sound a" .* to make room for "sound c"/);
  });
});

describe("replacing a sound that has no copy", () => {
  it("moves themes and the default to the replacement, and deletes the old copy", async () => {
    const old = controller.add("Haunted Mansion");
    store.upsertTheme({
      id: "halloween", name: "Halloween", image: "h", sound: old.id, soundName: "Haunted Mansion",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    store.setSetting("defaultRingtone", old.id);
    named.set("mansion", "Haunted Mansion (found again)");

    const outcome = await cache().replace(old.id, "mansion");
    assert.equal(outcome, "removed");
    assert.deepEqual(controller.deleted, [old.id]);
    assert.equal(store.themes()[0]!.sound, "library:mansion");
    assert.equal(store.themes()[0]!.soundName, "Haunted Mansion (found again)");
    assert.equal(store.setting("defaultRingtone"), "library:mansion");
  });

  it("links rather than deletes the one a doorbell is playing", async () => {
    const old = controller.add("Haunted Mansion");
    keep = new Set([old.id]);
    named.set("mansion", "Haunted Mansion");
    assert.equal(await cache().replace(old.id, "mansion"), "linked");
    assert.deepEqual(controller.deleted, []);
    assert.equal(store.ringtoneFor("mansion")?.ringtoneId, old.id);
  });
});

describe("themes pointing at a ringtone the console no longer has", () => {
  it("are re-linked to a library sound of the name they remember", async () => {
    store.upsertTheme({
      id: "stitch_hi", name: "Stitch", image: "h", sound: "69c6b92602b95703e419be84", soundName: "stitch_music",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    named.set("stitch", "Stitch_Music");

    const relinked = await cache().relinkBroken(await controller.ringtones());
    assert.deepEqual(relinked, ["Stitch"]);
    assert.equal(store.themes()[0]!.sound, "library:stitch");
  });

  it("leave a theme alone while its ringtone still exists", async () => {
    const live = controller.add("stitch_music");
    store.upsertTheme({
      id: "stitch_hi", name: "Stitch", image: "h", sound: live.id, soundName: "stitch_music",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    named.set("stitch", "something else");
    assert.deepEqual(await cache().relinkBroken(await controller.ringtones()), []);
    assert.equal(store.themes()[0]!.sound, live.id);
  });
});
