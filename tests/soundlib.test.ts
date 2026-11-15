import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SoundLibrary, soundFilename } from "../src/media/soundlib.ts";

/**
 * The sound library on disk. What matters is that nothing in it is ever
 * silently replaced: a theme may be pointing at what is already there.
 */

const mp3 = (text: string) => new Uint8Array(Buffer.from(`ID3${text}`));

let dir: string;
let library: SoundLibrary;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doorman-sounds-"));
  library = new SoundLibrary(dir);
});
afterEach(() => rm(dir, { recursive: true }));

describe("sound library", () => {
  it("keeps the name readable, minus what a filesystem minds", () => {
    assert.equal(soundFilename("  Elf: Santa/Claus?  "), "Elf Santa Claus.mp3");
    assert.equal(soundFilename("..hidden"), "hidden.mp3");
    assert.throws(() => soundFilename("   "), /Give the sound a name/);
  });

  it("recognises the same sound under any name", async () => {
    const first = await library.add(mp3("ho ho"), "Santa");
    const again = await library.add(mp3("ho ho"), "Santa again");
    assert.equal(again.duplicate, true);
    assert.equal(again.sound.hash, first.sound.hash);
    assert.equal((await library.list()).length, 1);
  });

  it("will not overwrite a different sound that has the name", async () => {
    await library.add(mp3("ho ho"), "Santa");
    await assert.rejects(() => library.add(mp3("different"), "santa"), /already a sound called/);
  });

  it("ignores what is not an MP3, and macOS's dot-files", async () => {
    await library.add(mp3("x"), "real");
    await writeFile(join(dir, "._real.mp3"), "not audio");
    await writeFile(join(dir, "notes.txt"), "hello");
    assert.deepEqual((await library.list()).map((s) => s.name), ["real"]);
  });

  it("finds and removes by content hash", async () => {
    const { sound } = await library.add(mp3("x"), "gone soon");
    assert.equal((await library.read(sound.hash))?.sound.name, "gone soon");
    await library.remove(sound.hash);
    assert.equal(await library.find(sound.hash), null);
  });
});

describe("renaming", () => {
  it("changes the name and keeps the hash every theme points at", async () => {
    const { sound } = await library.add(mp3("x"), "old name");
    const renamed = await library.rename(sound.hash, "New: name");
    assert.equal(renamed.name, "New name");
    assert.equal(renamed.hash, sound.hash);
    assert.deepEqual((await library.list()).map((s) => s.name), ["New name"]);
  });

  it("refuses a name another sound has", async () => {
    await library.add(mp3("a"), "taken");
    const { sound } = await library.add(mp3("b"), "mine");
    await assert.rejects(() => library.rename(sound.hash, "Taken"), /already a sound called "taken"/);
  });
});
