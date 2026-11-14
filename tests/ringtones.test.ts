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

const files = {
  async read(hash: string) {
    return hash === "missing" ? null : { sound: { name: `sound ${hash}` }, bytes: new Uint8Array([1]) };
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
    await assert.rejects(() => c.ensure("b"), /none of them is one Doorman can remove/);
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
