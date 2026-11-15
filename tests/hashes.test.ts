import { strict as assert } from "node:assert";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileHashes } from "../src/media/hashes.ts";

/**
 * Hashing each file once per version of it, rather than on every request.
 * What matters is that a changed file is never answered with its old hash.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doorman-hashes-"));
});
afterEach(() => rm(dir, { recursive: true }));

describe("file hashes", () => {
  it("hashes a file again when it is replaced, even at the same size", async () => {
    const path = join(dir, "a.gif");
    const hashes = new FileHashes();
    await writeFile(path, "GIF89a-one");
    const first = await hashes.of(path);

    await writeFile(path, "GIF89a-two");
    // Pin the time forward, so the test does not depend on the clock ticking
    // between two writes.
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    const second = await hashes.of(path);

    assert.notEqual(second.hash, first.hash);
    assert.equal(second.bytes, first.bytes);
  });

  it("does not read an unchanged file again", async () => {
    const path = join(dir, "a.gif");
    const hashes = new FileHashes();
    await writeFile(path, "GIF89a-one");
    const when = new Date(Date.now() - 60_000);
    await utimes(path, when, when);
    const first = await hashes.of(path);

    // Different bytes behind the same size and time: only a re-read would
    // notice, so getting the old hash back proves there was none.
    await writeFile(path, "GIF89a-two");
    await utimes(path, when, when);
    assert.equal((await hashes.of(path)).hash, first.hash);
  });
});
