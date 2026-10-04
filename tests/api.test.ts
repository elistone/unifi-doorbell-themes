import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { HttpError, createApi } from "../src/web/api.ts";
import type { AssetSource, ImageDevice } from "../src/apply.ts";
import { Store } from "../src/store/db.ts";

/**
 * The API routes, against fakes.
 *
 * What is worth testing here is the translation layer the UI depends on:
 * filenames in, content hashes out; the calendar actually running the same
 * decide() the scheduler runs; and the filename guard, which is the one
 * place user input reaches the filesystem.
 */

class FakeDevice implements ImageDevice {
  showing: string | null = null;
  async currentImage() {
    return this.showing;
  }
  async showImage(name: string) {
    this.showing = name;
  }
}

class FakeSource implements AssetSource {
  files = new Map<string, string>();
  add(hash: string, filename: string) {
    this.files.set(hash, filename);
  }
  async read(hash: string) {
    const filename = this.files.get(hash);
    return filename ? { bytes: new Uint8Array([1]), filename, mimeType: "image/gif" } : null;
  }
  async upload() {
    return { name: "asset-1.png", size: 1 };
  }
  async listRemote() {
    return [];
  }
  async localFiles() {
    return new Map(this.files);
  }
}

let store: Store;
let source: FakeSource;
let api: ReturnType<typeof createApi>;

/** The routes take (req, url); only the url matters for everything but a body. */
const url = (path: string) => new URL(path, "http://localhost");

function withJson(body: unknown) {
  // Enough of an IncomingMessage for readJson: an async iterable of chunks.
  const chunks = [Buffer.from(JSON.stringify(body))];
  return { [Symbol.asyncIterator]: () => chunks.values(), headers: {} } as never;
}

beforeEach(() => {
  store = new Store(":memory:");
  source = new FakeSource();
  source.add("hash-xmas", "elf.gif");
  source.add("hash-everyday", "stitch.gif");
  // Two doorbells, because every interesting case here is about scoping.
  store.upsertDevice({ id: "front", name: "Front door", enabled: true, position: 0 });
  store.upsertDevice({ id: "back", name: "Back door", enabled: true, position: 1 });
  api = createApi({
    store,
    source,
    imageDeviceFor: () => new FakeDevice(),
    soundDeviceFor: () => undefined,
    protect: { displayCapableCameras: async () => [] } as never,
    mediaDir: "media",
    cacheDir: "/tmp/doorman-test-thumbs",
    protectVersion: "7.2.105",
  } as never);
});

describe("themes", () => {
  it("accepts a filename and stores the content hash", async () => {
    const saved = await api.routes["PUT /api/themes"](
      withJson({ id: "xmas", name: "Christmas", filename: "elf.gif", priority: 10 }),
      url("/api/themes"),
    );
    assert.equal((saved as { image: string }).image, "hash-xmas");

    // Stored against the hash, so renaming the GIF cannot orphan the theme.
    assert.equal(store.themes()[0].image, "hash-xmas");
  });

  it("refuses a filename that is not in the library", async () => {
    await assert.rejects(
      () =>
        api.routes["PUT /api/themes"](
          withJson({ id: "x", filename: "not-here.gif" }),
          url("/api/themes"),
        ),
      /not in the media library/,
    );
  });

  it("gives a theme with no rules one that always matches", async () => {
    // A theme with zero rules can never be eligible, which looks like a bug
    // rather than a choice - the UI must not be able to create one.
    await api.routes["PUT /api/themes"](
      withJson({ id: "x", filename: "elf.gif", rules: [] }),
      url("/api/themes"),
    );
    assert.deepEqual(store.themes()[0].rules, [{}]);
  });

  it("reports a theme whose image has left the library", async () => {
    store.upsertTheme({
      id: "ghost", name: "Ghost", image: "hash-gone",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    const themes = (await api.routes["GET /api/themes"](
      undefined as never,
      url("/api/themes"),
    )) as Array<{ missing: boolean }>;
    assert.equal(themes[0].missing, true);
  });

  it("deletes by id", async () => {
    store.upsertTheme({
      id: "x", name: "X", image: "hash-xmas",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    await api.routes["DELETE /api/themes"](undefined as never, url("/api/themes?id=x"));
    assert.equal(store.themes().length, 0);
  });
});

describe("calendar", () => {
  it("previews the real decision for each day, not an approximation", async () => {
    store.upsertTheme({
      id: "xmas", name: "Christmas", image: "hash-xmas", priority: 10,
      enabled: true, rules: [{ dateWindow: { from: "12-01", to: "12-26" } }], devices: [],
    });
    store.upsertTheme({
      id: "everyday", name: "Everyday", image: "hash-everyday", priority: 0,
      enabled: true, rules: [{}], devices: [],
    });

    const { days } = (await api.routes["GET /api/calendar"](
      undefined as never,
      url("/api/calendar?from=2026-11-29&days=5"),
    )) as { days: Array<{ date: string; themeId: string | null }> };

    assert.deepEqual(
      days.map((d) => [d.date, d.themeId]),
      [
        ["2026-11-29", "everyday"],
        ["2026-11-30", "everyday"],
        ["2026-12-01", "xmas"],
        ["2026-12-02", "xmas"],
        ["2026-12-03", "xmas"],
      ],
      "priority must exclude the everyday rotation for the whole window",
    );
  });

  it("resolves the image filename so the UI can show a thumbnail", async () => {
    store.upsertTheme({
      id: "e", name: "E", image: "hash-everyday",
      priority: 0, enabled: true, rules: [{}], devices: [],
    });
    const { days } = (await api.routes["GET /api/calendar"](
      undefined as never,
      url("/api/calendar?from=2026-06-01&days=1"),
    )) as { days: Array<{ filename: string | null }> };
    assert.equal(days[0].filename, "stitch.gif");
  });

  it("rejects a date it cannot parse rather than silently starting today", async () => {
    await assert.rejects(
      () => api.routes["GET /api/calendar"](undefined as never, url("/api/calendar?from=soon")),
      /not a YYYY-MM-DD date/,
    );
  });
});

describe("filename safety", () => {
  // The media directory is addressed by name, so this is the one place user
  // input reaches the filesystem.
  const bad = ["../secrets", "a/b.gif", "..", ".hidden.gif", "", "/etc/passwd"];

  for (const name of bad) {
    it(`refuses ${JSON.stringify(name)}`, async () => {
      await assert.rejects(
        () =>
          api.routes["DELETE /api/media"](
            undefined as never,
            url(`/api/media?filename=${encodeURIComponent(name)}`),
          ),
        (error: unknown) => error instanceof HttpError && error.status === 400,
      );
    });
  }
});

describe("ring sounds without admin credentials", () => {
  it("says so rather than failing obscurely", async () => {
    // Images work without them, which is the whole reason sound is optional.
    await assert.rejects(
      () => api.routes["GET /api/ringtones"](undefined as never, url("/api/ringtones")),
      /admin credentials/,
    );
  });
});
