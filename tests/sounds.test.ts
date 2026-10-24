import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { brokenSounds, relinkSounds, soundStatus } from "../src/sounds.ts";
import { Store } from "../src/store/db.ts";
import type { Theme } from "../src/domain/types.ts";

/**
 * Surviving a console migration.
 *
 * Ringtone ids are per-console, so moving Protect to a different NVR breaks
 * every custom sound at once. These are the rules for putting them back.
 */

const tone = (id: string, name: string) =>
  ({ id, name, size: 1, isDefault: false, nvrMac: "x", modelKey: "ringtone" }) as never;

function theme(id: string, sound?: string, soundName?: string): Theme {
  return {
    id,
    name: id,
    image: "hash",
    sound,
    soundName,
    priority: 0,
    enabled: true,
    rules: [{}],
    devices: [],
  };
}

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

describe("spotting what broke", () => {
  it("reports a theme whose ringtone id no longer exists", () => {
    const themes = [theme("halloween", "old-id", "The Haunted Mansion")];
    const broken = brokenSounds(soundStatus(themes, [tone("new-id", "Traditional")]));

    assert.equal(broken.length, 1);
    assert.equal(broken[0].theme.id, "halloween");
    // The point of remembering the name: the UI can say what it wanted.
    assert.equal(broken[0].theme.soundName, "The Haunted Mansion");
  });

  it("leaves a theme alone when its id still resolves", () => {
    const themes = [theme("xmas", "live-id", "Elf - SANTA!")];
    assert.deepEqual(brokenSounds(soundStatus(themes, [tone("live-id", "Elf - SANTA!")])), []);
  });

  it("ignores themes with no sound at all", () => {
    assert.deepEqual(soundStatus([theme("plain")], []), []);
  });
});

describe("re-linking after a migration", () => {
  it("re-points a broken theme at a ringtone of the same name", () => {
    store.upsertTheme(theme("stitch_hi", "dead-id", "stitch_music"));
    const relinked = relinkSounds(store, store.themes(), [tone("fresh-id", "stitch_music")]);

    assert.deepEqual(relinked, [
      { themeId: "stitch_hi", name: "stitch_music", from: "dead-id", to: "fresh-id" },
    ]);
    assert.equal(store.themes()[0].sound, "fresh-id");
  });

  it("matches a name that was retyped with different case or spacing", () => {
    store.upsertTheme(theme("xmas", "dead-id", "Elf - SANTA!"));
    relinkSounds(store, store.themes(), [tone("fresh", "elf -  santa!")]);
    assert.equal(store.themes()[0].sound, "fresh");
  });

  it("does nothing when no ringtone has that name yet", () => {
    // The audio has not been re-uploaded. Leaving it broken and visible
    // beats silently attaching the wrong sound.
    store.upsertTheme(theme("halloween", "dead-id", "The Haunted Mansion"));
    assert.deepEqual(relinkSounds(store, store.themes(), [tone("x", "Traditional")]), []);
    assert.equal(store.themes()[0].sound, "dead-id");
  });

  it("never re-points a theme whose id still works", () => {
    // Two ringtones can share a name. While the id resolves it is the
    // authoritative answer, and re-pointing would silently change the sound.
    store.upsertTheme(theme("xmas", "live-id", "Elf - SANTA!"));
    const relinked = relinkSounds(store, store.themes(), [
      tone("live-id", "Elf - SANTA!"),
      tone("impostor", "Elf - SANTA!"),
    ]);
    assert.deepEqual(relinked, []);
    assert.equal(store.themes()[0].sound, "live-id");
  });

  it("cannot help a theme that never recorded a name", () => {
    // Themes written before soundName existed. Nothing to match on, so they
    // stay broken rather than being guessed at.
    store.upsertTheme(theme("legacy", "dead-id", undefined));
    assert.deepEqual(relinkSounds(store, store.themes(), [tone("fresh", "stitch_music")]), []);
  });

  it("records the name as the console spells it, not as it was remembered", () => {
    store.upsertTheme(theme("xmas", "dead", "elf - santa!"));
    relinkSounds(store, store.themes(), [tone("fresh", "Elf - SANTA!")]);
    assert.equal(store.themes()[0].soundName, "Elf - SANTA!");
  });

  it("handles several at once and leaves the rest untouched", () => {
    store.upsertTheme(theme("a", "dead-a", "One"));
    store.upsertTheme(theme("b", "dead-b", "Two"));
    store.upsertTheme(theme("c", "live-c", "Three"));
    store.upsertTheme(theme("d"));

    const relinked = relinkSounds(store, store.themes(), [
      tone("new-a", "One"),
      tone("live-c", "Three"),
    ]);

    assert.deepEqual(relinked.map((r) => r.themeId), ["a"]);
    const byId = new Map(store.themes().map((t) => [t.id, t]));
    assert.equal(byId.get("a")!.sound, "new-a");
    assert.equal(byId.get("b")!.sound, "dead-b", "no candidate, so left visibly broken");
    assert.equal(byId.get("c")!.sound, "live-c");
    assert.equal(byId.get("d")!.sound, undefined);
  });
});
