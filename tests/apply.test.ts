import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { adopt, apply, ensureUploaded, reconcile } from "../src/apply.ts";
import type { AssetSource, ImageDevice } from "../src/apply.ts";
import { Store } from "../src/store/db.ts";
import type { Theme } from "../src/domain/types.ts";

/**
 * The orchestration, against fakes. The device adapter itself is tested by
 * pressing a doorbell; what is worth testing here is the logic around it -
 * upload-once, skip-if-unchanged, drift reporting, and what happens when the
 * NVR says no.
 */

class FakeDevice implements ImageDevice {
  showing: string | null = null;
  writes = 0;
  failNext: string | null = null;

  async currentImage() {
    return this.showing;
  }

  async showImage(assetName: string) {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    this.showing = assetName;
    this.writes++;
  }
}

class FakeSource implements AssetSource {
  uploads = 0;
  remote = new Set<string>();
  files = new Map<string, { bytes: Uint8Array; filename: string; mimeType: string }>();
  rejectUpload: string | null = null;
  #next = 0;

  add(hash: string, filename = `${hash}.gif`) {
    this.files.set(hash, { bytes: new Uint8Array([1, 2, 3]), filename, mimeType: "image/gif" });
  }

  async read(hash: string) {
    return this.files.get(hash) ?? null;
  }

  async upload(_bytes: Uint8Array, _filename: string, _mimeType: string) {
    if (this.rejectUpload) {
      const message = this.rejectUpload;
      this.rejectUpload = null;
      throw new Error(message);
    }
    this.uploads++;
    const name = `asset-${++this.#next}.png`;
    this.remote.add(name);
    this.originalNames.set(name, `${_filename}.png`);
    return { name, size: 1234 };
  }

  originalNames = new Map<string, string>();

  async listRemote() {
    return [...this.remote].map((name) => ({
      name,
      originalName: this.originalNames.get(name) ?? name,
    }));
  }

  async localFiles() {
    return new Map([...this.files].map(([hash, f]) => [hash, f.filename]));
  }
}

function theme(id: string, image: string, overrides: Partial<Theme> = {}): Theme {
  return {
    id,
    name: id,
    image,
    priority: 0,
    enabled: true,
    rules: [{}], // always eligible
    ...overrides,
  };
}

let store: Store;
let device: FakeDevice;
let source: FakeSource;
const now = new Date("2026-06-15T09:00:00");

beforeEach(() => {
  store = new Store(":memory:");
  device = new FakeDevice();
  source = new FakeSource();
});

describe("upload-once", () => {
  it("uploads the first time it sees a hash and never again", async () => {
    source.add("hash-a");
    const first = await ensureUploaded(store, source, "hash-a");
    const second = await ensureUploaded(store, source, "hash-a");
    assert.equal(first, second);
    assert.equal(source.uploads, 1, "the same bytes must never upload twice");
  });

  it("survives a restart, because the manifest is persisted not cached", async () => {
    source.add("hash-a");
    const name = await ensureUploaded(store, source, "hash-a");
    // A fresh Store over the same handle would be a different test; what
    // matters here is that the lookup goes through storage, not memory.
    assert.equal(store.asset("hash-a")?.assetName, name);
    assert.equal(await ensureUploaded(store, source, "hash-a"), name);
    assert.equal(source.uploads, 1);
  });

  it("fails clearly when the media file has gone missing", async () => {
    await assert.rejects(
      () => ensureUploaded(store, source, "hash-gone"),
      /missing from the library/,
    );
  });
});

describe("apply", () => {
  it("sets the image and records why", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));

    const result = await apply(store, device, source, now);
    assert.equal(result.outcome, "applied");
    assert.equal(result.themeId, "everyday");
    assert.equal(device.showing, result.assetName);
    assert.match(result.reason, /everyday/);

    const [latest] = store.recentApplies(1);
    assert.equal(latest?.outcome, "applied");
    assert.match(latest!.reason, /everyday/);
  });

  it("does not write when the device already shows the right thing", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));

    await apply(store, device, source, now);
    assert.equal(device.writes, 1);

    // Every write is a call to an undocumented API on consumer hardware. The
    // second run must be a no-op, not a reassertion.
    const again = await apply(store, device, source, now);
    assert.equal(again.outcome, "unchanged");
    assert.equal(device.writes, 1);
  });

  it("writes anyway when skipUnchanged is off", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));
    await apply(store, device, source, now);
    await apply(store, device, source, now, { skipUnchanged: false });
    assert.equal(device.writes, 2);
  });

  it("does nothing at all on a dry run, once the asset is known", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));
    await apply(store, device, source, now); // upload it for real first
    device.showing = null; // pretend the device was reset, so there is work to do

    const before = store.recentApplies().length;
    const result = await apply(store, device, source, now, { dryRun: true });
    assert.equal(result.outcome, "dry-run");
    assert.match(result.reason, /would set/);
    assert.equal(device.writes, 1, "still only the one real write");
    assert.equal(device.showing, null);
    assert.equal(
      store.recentApplies().length,
      before,
      "a dry run must not pollute the audit trail",
    );
  });

  it("predicts which theme the real apply will choose", async () => {
    source.add("a");
    source.add("b");
    source.add("c");
    for (const id of ["a", "b", "c"]) store.upsertTheme(theme(id, id));

    // Before anything is uploaded, the asset name is genuinely unknowable -
    // Protect mints it server-side. The theme choice is still predictable,
    // and that is the part a person is asking about.
    const predicted = await apply(store, device, source, now, { dryRun: true });
    const actual = await apply(store, device, source, now);
    assert.equal(actual.themeId, predicted.themeId, "a dry run that lies is worse than none");

    // Once the asset exists, the prediction is exact.
    device.showing = null;
    const second = await apply(store, device, source, now, { dryRun: true });
    assert.equal(second.assetName, actual.assetName);
  });

  it("reports nothing to do rather than inventing something", async () => {
    store.upsertTheme(
      theme("xmas", "hash-a", { rules: [{ dateWindow: { from: "12-01", to: "12-26" } }] }),
    );
    const result = await apply(store, device, source, now); // June
    assert.equal(result.outcome, "no-theme");
    assert.equal(device.writes, 0);
  });
});

describe("drift", () => {
  it("reports when the device was changed behind our back", async () => {
    source.add("hash-a");
    source.add("hash-b");
    store.upsertTheme(theme("everyday", "hash-a"));
    await apply(store, device, source, now);

    // Someone sets a message through the Protect app.
    device.showing = "set-by-hand.png";

    store.upsertTheme(theme("everyday", "hash-b"));
    const result = await apply(store, device, source, now);
    assert.deepEqual(result.drift, { expected: "asset-1.png", found: "set-by-hand.png" });
    assert.equal(result.outcome, "applied", "drift is reported, not a reason to refuse");
  });

  it("does not report drift on the very first run", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));
    const result = await apply(store, device, source, now);
    assert.equal(result.drift, undefined, "nothing was expected yet, so nothing drifted");
  });
});

describe("failure", () => {
  it("records an upload rejection with the reason, and leaves the device alone", async () => {
    source.add("hash-a");
    source.rejectUpload = "POST /files/animations failed with 413";
    store.upsertTheme(theme("everyday", "hash-a"));

    const result = await apply(store, device, source, now);
    assert.equal(result.outcome, "failed");
    assert.match(result.reason, /413/);
    assert.equal(device.writes, 0);
    assert.equal(store.recentApplies(1)[0]?.outcome, "failed");
  });

  it("does not advance the rotation cursor when the write failed", async () => {
    source.add("a");
    source.add("b");
    store.setSelection("sequential");
    for (const id of ["a", "b"]) store.upsertTheme(theme(id, id));

    device.failNext = "the doorbell is offline";
    const failed = await apply(store, device, source, now);
    assert.equal(failed.outcome, "failed");

    // A failed apply that still advanced the cursor would silently skip a
    // theme's turn in the rotation.
    const next = await apply(store, device, source, now);
    assert.equal(next.themeId, failed.themeId, "the same theme should be retried");
  });

  it("never lets a notifier failure break the apply", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));
    const notifier = { send: async () => { throw new Error("webhook down"); } };
    const result = await apply(store, device, source, now, {}, notifier);
    assert.equal(result.outcome, "applied");
    assert.equal(device.showing, result.assetName);
  });
});

describe("reconciling the manifest with the NVR", () => {
  it("forgets assets the NVR no longer has, so we stop handing out dead names", async () => {
    source.add("hash-a");
    source.add("hash-b");
    await ensureUploaded(store, source, "hash-a");
    await ensureUploaded(store, source, "hash-b");

    // Someone deletes one through Protect's own UI.
    source.remote.delete("asset-1.png");

    const dropped = await reconcile(store, source);
    assert.deepEqual(dropped, ["asset-1.png"]);
    assert.equal(store.asset("hash-a"), null);
    assert.ok(store.asset("hash-b"), "the surviving asset must be left alone");
  });

  it("re-uploads only what was actually lost", async () => {
    source.add("hash-a");
    await ensureUploaded(store, source, "hash-a");
    source.remote.clear();
    await reconcile(store, source);
    await ensureUploaded(store, source, "hash-a");
    assert.equal(source.uploads, 2);
  });
});

describe("a dry run must change nothing, anywhere", () => {
  it("does not upload an asset it has never seen", async () => {
    // Uploads to Protect are permanent and cannot be deleted without admin
    // credentials, so a dry run that uploads is a dry run that litters.
    source.add("never-seen");
    store.upsertTheme(theme("new", "never-seen"));

    const result = await apply(store, device, source, now, { dryRun: true });
    assert.equal(source.uploads, 0, "a dry run must not upload");
    assert.equal(result.outcome, "dry-run");
    assert.match(result.reason, /would upload/);
    assert.equal(store.asset("never-seen"), null, "nor record one");
  });

  it("still predicts accurately once the asset is known", async () => {
    source.add("hash-a");
    store.upsertTheme(theme("everyday", "hash-a"));
    await apply(store, device, source, now);
    const uploadsAfterReal = source.uploads;

    const dry = await apply(store, device, source, now, { dryRun: true });
    assert.equal(source.uploads, uploadsAfterReal);
    assert.equal(dry.assetName, device.showing);
  });
});

class FakeSound {
  current: string | null = null;
  writes = 0;
  failNext = false;
  async currentRingtone() { return this.current; }
  async setRingtone(id: string) {
    if (this.failNext) { this.failNext = false; throw new Error("private API said no"); }
    this.current = id;
    this.writes++;
  }
}

describe("sound", () => {
  it("sets the ringtone alongside the image", async () => {
    source.add("hash-a");
    const sound = new FakeSound();
    store.upsertTheme({ ...theme("xmas", "hash-a"), sound: "ringtone-elf" });

    const result = await apply(store, device, source, now, {}, undefined, sound);
    assert.equal(result.outcome, "applied");
    assert.equal(result.sound, "applied");
    assert.equal(sound.current, "ringtone-elf");
  });

  it("does not rewrite a ringtone that is already set", async () => {
    source.add("hash-a");
    const sound = new FakeSound();
    sound.current = "ringtone-elf";
    store.upsertTheme({ ...theme("xmas", "hash-a"), sound: "ringtone-elf" });

    const result = await apply(store, device, source, now, {}, undefined, sound);
    assert.equal(result.sound, "unchanged");
    assert.equal(sound.writes, 0);
  });

  it("leaves the ring sound alone when a theme names none", async () => {
    source.add("hash-a");
    const sound = new FakeSound();
    sound.current = "whatever-was-there";
    store.upsertTheme(theme("images-only", "hash-a"));

    const result = await apply(store, device, source, now, {}, undefined, sound);
    assert.equal(result.outcome, "applied");
    assert.equal(result.sound, undefined);
    assert.equal(sound.current, "whatever-was-there", "an imageless theme must not clear the sound");
  });

  it("still applies the image when the sound half fails", async () => {
    // Sound lives on the private API, which breaks between Protect releases.
    // A doorbell showing the right picture with the wrong chime beats one
    // stuck on December's GIF in March.
    source.add("hash-a");
    const sound = new FakeSound();
    sound.failNext = true;
    store.upsertTheme({ ...theme("xmas", "hash-a"), sound: "ringtone-elf" });

    const result = await apply(store, device, source, now, {}, undefined, sound);
    assert.equal(result.outcome, "applied", "the image must still go up");
    assert.equal(result.sound, "failed");
    assert.equal(device.showing, result.assetName);
    assert.match(result.reason, /ringtone failed/);
  });

  it("reports the theme named a sound but no sound device was configured", async () => {
    // Images-only installs have no admin credentials, so this is normal.
    source.add("hash-a");
    store.upsertTheme({ ...theme("xmas", "hash-a"), sound: "ringtone-elf" });
    const result = await apply(store, device, source, now);
    assert.equal(result.outcome, "applied");
    assert.equal(result.sound, "skipped");
  });
});


describe("adopting what is already on the NVR", () => {
  it("claims a matching asset instead of uploading a duplicate", async () => {
    // Everyone installing this already has images on their doorbell - that is
    // why they want something better. Re-uploading the lot on first run is a
    // real cost, and it happened on the first live run.
    source.add("hash-a", "dancing-bones.gif");
    source.remote.add("existing-asset.png");
    source.originalNames.set("existing-asset.png", "dancing-bones.gif.png");

    const claimed = await adopt(store, source);
    assert.deepEqual(claimed, [{ filename: "dancing-bones.gif", assetName: "existing-asset.png" }]);
    assert.equal(store.asset("hash-a")?.assetName, "existing-asset.png");

    await ensureUploaded(store, source, "hash-a");
    assert.equal(source.uploads, 0, "an adopted asset must never be uploaded");
  });

  it("ignores the .gif preview and claims the sprite", async () => {
    source.add("hash-a", "stitch_hi.gif");
    source.remote.add("sprite.png");
    source.remote.add("sprite.png.gif");
    source.originalNames.set("sprite.png", "stitch_hi.gif.png");
    source.originalNames.set("sprite.png.gif", "stitch_hi.gif.png");

    const claimed = await adopt(store, source);
    assert.equal(claimed[0]?.assetName, "sprite.png", "the preview is not the asset to display");
  });

  it("leaves already-known assets alone", async () => {
    source.add("hash-a", "x.gif");
    await ensureUploaded(store, source, "hash-a");
    const before = store.asset("hash-a")!.assetName;
    source.remote.add("other.png");
    source.originalNames.set("other.png", "x.gif.png");
    assert.deepEqual(await adopt(store, source), []);
    assert.equal(store.asset("hash-a")?.assetName, before);
  });

  it("adopts nothing when no name matches", async () => {
    source.add("hash-a", "unique.gif");
    source.remote.add("unrelated.png");
    source.originalNames.set("unrelated.png", "something-else.gif.png");
    assert.deepEqual(await adopt(store, source), []);
  });
});
