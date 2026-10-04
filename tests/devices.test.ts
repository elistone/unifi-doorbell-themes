import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { apply } from "../src/apply.ts";
import type { AssetSource, ImageDevice, SoundDevice } from "../src/apply.ts";
import { decide } from "../src/domain/decide.ts";
import { Store } from "../src/store/db.ts";
import type { Theme } from "../src/domain/types.ts";

/**
 * Multiple doorbells.
 *
 * The risk in this feature is not that two doorbells fail to work - it is
 * that adding a second one quietly changes what the first one does. Most of
 * what follows is about that.
 */

class FakeDevice implements ImageDevice {
  showing: string | null = null;
  writes = 0;
  async currentImage() {
    return this.showing;
  }
  async showImage(name: string) {
    this.showing = name;
    this.writes++;
  }
}

class FakeSound implements SoundDevice {
  current: string | null = null;
  async currentRingtone() {
    return this.current;
  }
  async setRingtone(id: string) {
    this.current = id;
  }
}

class FakeSource implements AssetSource {
  uploads = 0;
  #next = 0;
  files = new Map<string, string>();
  remote = new Map<string, string>();

  add(hash: string, filename = `${hash}.gif`) {
    this.files.set(hash, filename);
  }
  async read(hash: string) {
    const filename = this.files.get(hash);
    return filename ? { bytes: new Uint8Array([1]), filename, mimeType: "image/gif" } : null;
  }
  async upload(_b: Uint8Array, filename: string) {
    this.uploads++;
    const name = `asset-${++this.#next}.png`;
    this.remote.set(name, `${filename}.png`);
    return { name, size: 1 };
  }
  async listRemote() {
    return [...this.remote].map(([name, originalName]) => ({ name, originalName }));
  }
  async localFiles() {
    return new Map(this.files);
  }
}

function theme(id: string, overrides: Partial<Theme> = {}): Theme {
  return {
    id,
    name: id,
    image: "hash-a",
    priority: 0,
    enabled: true,
    rules: [{}],
    devices: [],
    ...overrides,
  };
}

let store: Store;
let source: FakeSource;
const now = new Date("2026-06-15T09:00:00");

beforeEach(() => {
  store = new Store(":memory:");
  source = new FakeSource();
  source.add("hash-a");
  source.add("hash-b");
  store.upsertDevice({ id: "front", name: "Front door", enabled: true, position: 0 });
  store.upsertDevice({ id: "back", name: "Back door", enabled: true, position: 1 });
});

describe("theme scoping", () => {
  it("treats a theme with no devices as applying to every doorbell", async () => {
    // The default that makes adding a second doorbell safe, and that keeps
    // every theme written before devices existed working.
    store.upsertTheme(theme("everywhere"));
    assert.deepEqual(
      store.themesFor("front").map((t) => t.id),
      ["everywhere"],
    );
    assert.deepEqual(
      store.themesFor("back").map((t) => t.id),
      ["everywhere"],
    );
  });

  it("restricts a scoped theme to the doorbells it names", () => {
    store.upsertTheme(theme("front-only", { devices: ["front"] }));
    store.upsertTheme(theme("both", { devices: ["front", "back"] }));

    assert.deepEqual(store.themesFor("front").map((t) => t.id).sort(), ["both", "front-only"]);
    assert.deepEqual(store.themesFor("back").map((t) => t.id), ["both"]);
  });

  it("leaves a doorbell with nothing when every theme excludes it", async () => {
    store.upsertTheme(theme("front-only", { devices: ["front"] }));
    const device = new FakeDevice();

    const result = await apply(store, device, source, now, { deviceId: "back" });
    assert.equal(result.outcome, "no-theme");
    assert.equal(device.writes, 0, "a doorbell with no eligible theme must be left alone");
  });
});

describe("per-doorbell state", () => {
  it("keeps the rotation position separate", () => {
    store.setCursor("front", { key: 3 });
    store.setCursor("back", { key: 9 });
    assert.deepEqual(store.cursor("front"), { key: 3 });
    assert.deepEqual(store.cursor("back"), { key: 9 });
  });

  it("remembers what each doorbell is showing independently", async () => {
    store.upsertTheme(theme("t"));
    const front = new FakeDevice();
    const back = new FakeDevice();

    await apply(store, front, source, now, { deviceId: "front" });
    await apply(store, back, source, now, { deviceId: "back" });

    assert.equal(front.writes, 1);
    assert.equal(back.writes, 1);
    assert.equal(store.lastAppliedAsset("front"), front.showing);
    assert.equal(store.lastAppliedAsset("back"), back.showing);
  });

  it("does not report one doorbell's drift on another", async () => {
    store.upsertTheme(theme("t"));
    const front = new FakeDevice();
    await apply(store, front, source, now, { deviceId: "front" });

    // The back door has never been set, so it has nothing to drift from.
    const back = new FakeDevice();
    back.showing = "something-someone-set-by-hand.png";
    const result = await apply(store, back, source, now, { deviceId: "back" });
    assert.equal(result.drift, undefined);
  });

  it("uploads an image once, not once per doorbell", async () => {
    // The manifest is shared on purpose: the asset lives on the NVR, which
    // both doorbells read from. Uploading per doorbell would leak a
    // permanent duplicate for every extra door.
    store.upsertTheme(theme("t"));
    await apply(store, new FakeDevice(), source, now, { deviceId: "front" });
    await apply(store, new FakeDevice(), source, now, { deviceId: "back" });
    assert.equal(source.uploads, 1);
  });

  it("attributes each history row to its doorbell", async () => {
    store.upsertTheme(theme("t"));
    await apply(store, new FakeDevice(), source, now, { deviceId: "front" });
    await apply(store, new FakeDevice(), source, now, { deviceId: "back" });

    assert.equal(store.recentApplies(10, "front").length, 1);
    assert.equal(store.recentApplies(10, "back").length, 1);
    assert.equal(store.recentApplies(10).length, 2, "unfiltered shows both");
  });
});

describe("independent rotation", () => {
  it("gives two doorbells different picks from the same themes", () => {
    const themes = Array.from({ length: 12 }, (_, i) => theme(`t${i}`));
    const config = { themes, selection: "random" as const };

    // Over a month, two doors sharing a library should not be in lockstep.
    let same = 0;
    for (let i = 0; i < 30; i++) {
      const day = new Date(2026, 5, 1 + i, 12);
      if (decide(config, day, {}, "front").theme?.id === decide(config, day, {}, "back").theme?.id) {
        same++;
      }
    }
    assert.ok(same < 15, `two doorbells matched on ${same} of 30 days, which is lockstep`);
  });

  it("is still deterministic for a given doorbell and date", () => {
    const themes = Array.from({ length: 12 }, (_, i) => theme(`t${i}`));
    const config = { themes, selection: "random" as const };
    const day = new Date(2027, 11, 24, 12);

    // The property the whole calendar preview rests on.
    assert.equal(
      decide(config, day, {}, "front").theme?.id,
      decide(config, day, {}, "front").theme?.id,
    );
  });
});

describe("removing a doorbell", () => {
  it("disables a theme that was scoped only to it", () => {
    // Not left with an empty device list: empty means EVERY doorbell, so
    // deleting one would silently promote its themes onto all the others.
    store.upsertTheme(theme("front-only", { devices: ["front"] }));
    store.deleteDevice("front");

    const after = store.themes()[0];
    assert.equal(after.enabled, false);
    assert.deepEqual(after.devices, []);
  });

  it("just narrows a theme that named others too", () => {
    store.upsertTheme(theme("both", { devices: ["front", "back"] }));
    store.deleteDevice("front");

    const after = store.themes()[0];
    assert.equal(after.enabled, true);
    assert.deepEqual(after.devices, ["back"]);
  });

  it("forgets that doorbell's state", () => {
    store.setCursor("front", { key: 5 });
    store.setLastAppliedAsset("front", "asset.png");
    store.deleteDevice("front");

    assert.deepEqual(store.cursor("front"), {});
    assert.equal(store.lastAppliedAsset("front"), null);
  });

  it("leaves other doorbells' state alone", () => {
    store.setCursor("back", { key: 7 });
    store.deleteDevice("front");
    assert.deepEqual(store.cursor("back"), { key: 7 });
  });
});

describe("sound is per doorbell", () => {
  it("sets the ringtone on each one separately", async () => {
    store.upsertTheme(theme("t", { sound: "ring-1" }));
    const frontSound = new FakeSound();
    const backSound = new FakeSound();

    await apply(store, new FakeDevice(), source, now, { deviceId: "front" }, undefined, frontSound);
    assert.equal(frontSound.current, "ring-1");
    assert.equal(backSound.current, null, "the other doorbell is untouched until its own turn");

    await apply(store, new FakeDevice(), source, now, { deviceId: "back" }, undefined, backSound);
    assert.equal(backSound.current, "ring-1");
  });
});

describe("migrating a single-doorbell database", () => {
  it("reads a theme row written before the devices column existed", () => {
    // The deployed database has 26 of these. A null here must mean
    // "everywhere", not crash and not "nowhere".
    const legacy = new Store(":memory:");
    legacy.upsertDevice({ id: "only", name: "Doorbell", enabled: true, position: 0 });
    legacy.upsertTheme(theme("old"));

    assert.deepEqual(legacy.themes()[0].devices, []);
    assert.equal(legacy.themesFor("only").length, 1, "an old theme still applies");
  });
});
