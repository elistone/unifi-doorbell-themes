import { strict as assert } from "node:assert";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_REMOTE_BYTES, directGifUrl, download, importLink, parseLink, sniff, ytdlpArgs } from "../src/media/remote.ts";
import { FreesoundSearch, GiphySearch, licenceLabel } from "../src/media/search.ts";
import { Staging } from "../src/media/staging.ts";

/**
 * Bringing files in from the web. Everything here runs against fake
 * responses - the providers are rate limited, and a test suite that fails
 * when Giphy is down is testing Giphy.
 */

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const GIF = bytes("GIF89a\x01\x00\x01\x00");

function fakeFetch(body: Uint8Array | string | object, init: ResponseInit = {}) {
  const seen: string[] = [];
  const impl = (async (input: string | URL) => {
    seen.push(String(input));
    const payload =
      body instanceof Uint8Array || typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload as BodyInit, init);
  }) as typeof fetch;
  return { impl, seen };
}

describe("sniffing", () => {
  const cases: Array<[string, Uint8Array, string | null]> = [
    ["GIF", GIF, "gif"],
    ["MP3 with a tag", bytes("ID3\x04\x00"), "mp3"],
    ["bare MP3 frame", new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "mp3"],
    ["ADTS AAC", new Uint8Array([0xff, 0xf1, 0x50, 0x80]), "aac"],
    ["Ogg", bytes("OggS\x00"), "ogg"],
    ["WAV", bytes("RIFF\x00\x00\x00\x00WAVE"), "wav"],
    ["M4A", bytes("\x00\x00\x00\x20ftypM4A "), "m4a"],
    ["WebM", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), "webm"],
    ["an HTML page", bytes("<!doctype html>"), null],
  ];
  for (const [label, input, expected] of cases) {
    it(`recognises ${label}`, () => assert.equal(sniff(input), expected));
  }
});

describe("links", () => {
  it("turns a Giphy page into the GIF on it", () => {
    // What people copy from the address bar is the page, not the image.
    assert.equal(
      directGifUrl(new URL("https://giphy.com/gifs/hello-wave-3o7TKSjRrfIPjeiVyM")).href,
      "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif",
    );
    const direct = new URL("https://example.com/a.gif");
    assert.equal(directGifUrl(direct), direct);
  });

  it("refuses anything but http and https", () => {
    assert.throws(() => parseLink("file:///etc/passwd"), /http and https/);
    assert.throws(() => parseLink("not a link"), /not a link/);
  });

  it("stops downloading at the limit rather than after it", async () => {
    const { impl } = fakeFetch(new Uint8Array(MAX_REMOTE_BYTES + 1));
    await assert.rejects(() => download(new URL("https://example.com/big.gif"), impl), /larger than 20MB/);
  });

  it("never lets a link be read as a yt-dlp option", () => {
    const args = ytdlpArgs(new URL("https://youtu.be/x"), "/tmp/out.%(ext)s");
    assert.equal(args.at(-2), "--", "the link must follow the end-of-options marker");
    assert.equal(args.at(-1), "https://youtu.be/x");
  });
});

describe("importing a link", () => {
  it("stages a GIF under a fresh id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doorman-staging-"));
    try {
      const staging = new Staging(dir);
      const id = await importLink("https://example.com/hi.gif", "gif", staging, fakeFetch(GIF).impl);
      assert.ok(Staging.isId(id));
      assert.ok(id.endsWith(".gif"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("says what to do when a GIF link is really a web page", async () => {
    const staging = new Staging(join(tmpdir(), "doorman-unused"));
    await assert.rejects(
      () => importLink("https://example.com/page", "gif", staging, fakeFetch("<!doctype html>").impl),
      /copy the image address/,
    );
  });
});

describe("staging", () => {
  it("only accepts ids of the shape it mints", () => {
    for (const bad of ["../doorman.sqlite", "x.gif", "0".repeat(36) + ".gif", "/etc/passwd"]) {
      assert.equal(new Staging("/tmp").path(bad), null, bad);
    }
  });

  it("sweeps files older than a day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doorman-staging-"));
    try {
      const staging = new Staging(dir);
      const old = await staging.put(GIF, "gif");
      const fresh = await staging.put(GIF, "gif");
      const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
      await utimes(join(dir, old), twoDaysAgo, twoDaysAgo);
      // Something staging did not make is left alone, whatever its age.
      await writeFile(join(dir, "keep-me.txt"), "x");
      await utimes(join(dir, "keep-me.txt"), twoDaysAgo, twoDaysAgo);

      await staging.sweep();
      const { readdir } = await import("node:fs/promises");
      const left = await readdir(dir);
      assert.ok(!left.includes(old));
      assert.ok(left.includes(fresh));
      assert.ok(left.includes("keep-me.txt"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("Giphy", () => {
  it("returns small previews to browse and full GIFs to import", async () => {
    const { impl, seen } = fakeFetch({
      data: [
        {
          id: "abc",
          title: "Hello GIF",
          url: "https://giphy.com/gifs/abc",
          images: {
            fixed_width: { url: "https://media/small.gif" },
            original: { url: "https://media/full.gif", width: "480", height: "270", size: "900000" },
          },
        },
      ],
      pagination: { total_count: 100, count: 1, offset: 0 },
    });
    const page = await new GiphySearch({ apiKey: "k", fetch: impl }).search("hello");
    assert.equal(page.results[0]!.previewUrl, "https://media/small.gif");
    assert.equal(page.results[0]!.url, "https://media/full.gif");
    assert.equal(page.next, 1);
    // A doorbell is public-facing.
    assert.match(seen[0]!, /rating=pg\b/);
  });

  it("takes the downsized copy when the original is enormous", async () => {
    const { impl } = fakeFetch({
      data: [
        {
          id: "big",
          images: {
            fixed_width: { url: "https://media/small.gif" },
            original: { url: "https://media/huge.gif", size: String(40 * 1024 * 1024) },
            downsized_large: { url: "https://media/smaller.gif", size: "4000000" },
          },
        },
      ],
      pagination: { total_count: 1, count: 1, offset: 0 },
    });
    const page = await new GiphySearch({ apiKey: "k", fetch: impl }).search("x");
    assert.equal(page.results[0]!.url, "https://media/smaller.gif");
    assert.equal(page.next, null);
  });

  it("explains a refused key instead of a bare status", async () => {
    const { impl } = fakeFetch({}, { status: 403 });
    await assert.rejects(() => new GiphySearch({ apiKey: "bad", fetch: impl }).search("x"), /API key/);
  });
});

describe("Freesound", () => {
  it("uses the MP3 preview and shows the licence", async () => {
    const { impl, seen } = fakeFetch({
      results: [
        {
          id: 42,
          name: "ding dong.wav",
          duration: 2.5,
          previews: { "preview-hq-mp3": "https://cdn/42-hq.mp3" },
          license: "http://creativecommons.org/licenses/by/4.0/",
          username: "someone",
          url: "https://freesound.org/s/42/",
        },
      ],
      next: "https://freesound.org/apiv2/search/text/?page=2",
    });
    const page = await new FreesoundSearch({ apiKey: "k", fetch: impl }).search("doorbell");
    assert.equal(page.results[0]!.previewUrl, "https://cdn/42-hq.mp3");
    assert.equal(page.results[0]!.licence, "CC BY");
    assert.equal(page.next, 2);
    // Long recordings are filtered out at the source.
    assert.equal(new URL(seen[0]!).searchParams.get("filter"), "duration:[0 TO 30]");
  });

  it("names the licences people need to know about", () => {
    assert.equal(licenceLabel("http://creativecommons.org/publicdomain/zero/1.0/"), "CC0");
    assert.equal(licenceLabel("https://creativecommons.org/licenses/by-nc/4.0/"), "CC BY-NC");
  });
});
