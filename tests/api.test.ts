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

describe("stats", () => {
  it("counts each day's runs by outcome and names the themes shown", async () => {
    store.upsertTheme({
      id: "everyday", name: "Everyday", image: "hash-everyday", priority: 0,
      enabled: true, rules: [{}], devices: [],
    });
    const today = new Date();
    today.setHours(6, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    store.recordApply({ at: yesterday.toISOString(), deviceId: "front", themeId: "everyday", assetName: null, reason: "r", outcome: "applied" });
    store.recordApply({ at: today.toISOString(), deviceId: "front", themeId: "everyday", assetName: null, reason: "r", outcome: "unchanged" });
    store.recordApply({ at: today.toISOString(), deviceId: "back", themeId: null, assetName: null, reason: "r", outcome: "failed" });

    const all = (await api.routes["GET /api/stats"](undefined as never, url("/api/stats?days=2"))) as {
      days: Array<{ changed: number; unchanged: number; failed: number }>;
      themes: Array<{ themeId: string; name: string; count: number }>;
    };
    assert.deepEqual(
      all.days.map((d) => [d.changed, d.unchanged, d.failed]),
      [[1, 0, 0], [0, 1, 1]],
    );
    assert.deepEqual(all.themes, [{ themeId: "everyday", name: "Everyday", count: 2 }]);

    const front = (await api.routes["GET /api/stats"](undefined as never, url("/api/stats?days=2&device=front"))) as {
      days: Array<{ failed: number }>;
    };
    assert.equal(front.days[1].failed, 0, "another doorbell's failure is not this one's");
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

  it("skips a theme whose image Protect refused, as the scheduler will", async () => {
    store.upsertTheme({
      id: "xmas", name: "Christmas", image: "hash-xmas", priority: 10,
      enabled: true, rules: [{}], devices: [],
    });
    store.upsertTheme({
      id: "everyday", name: "Everyday", image: "hash-everyday", priority: 0,
      enabled: true, rules: [{}], devices: [],
    });
    store.markRefused({ hash: "hash-xmas", filename: "elf.gif", reason: "too big", refusedAt: "2026-11-21T05:00:00Z" });

    const calendar = async () =>
      ((await api.routes["GET /api/calendar"](
        undefined as never,
        url("/api/calendar?from=2026-06-01&days=1"),
      )) as { days: Array<{ themeId: string | null }> }).days[0].themeId;
    assert.equal(await calendar(), "everyday");

    // Try again puts it back.
    const cleared = (await api.routes["DELETE /api/media/refused"](
      undefined as never,
      url("/api/media/refused?filename=elf.gif"),
    )) as { cleared: boolean };
    assert.equal(cleared.cleared, true);
    assert.equal(await calendar(), "xmas");
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

describe("importing", () => {
  const post = (route: string, body: unknown) =>
    api.routes[route](withJson(body), url(route.split(" ")[1]!));

  it("offers no search without a key, and says which one", async () => {
    await assert.rejects(
      () => api.routes["GET /api/search/gifs"](undefined as never, url("/api/search/gifs?q=hi")),
      /GIPHY_API_KEY/,
    );
    await assert.rejects(
      () => api.routes["GET /api/search/sounds"](undefined as never, url("/api/search/sounds?q=hi")),
      /FREESOUND_API_KEY/,
    );
  });

  it("refuses an import id that is not one staging minted", async () => {
    // The id names a file, so it is the one input here that reaches disk.
    for (const id of ["../doorman.sqlite", "x.gif", undefined]) {
      await assert.rejects(
        () => post("POST /api/media/keep", { id, filename: "a.gif" }),
        (error: unknown) => error instanceof HttpError && error.status === 400,
      );
    }
  });

  it("says an import has expired rather than failing obscurely", async () => {
    await assert.rejects(
      () => post("POST /api/media/render", { id: "00000000-0000-4000-8000-000000000000.gif" }),
      /expired/,
    );
  });

  it("keeps a staged GIF in the library and will not overwrite a name", async () => {
    const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Staging } = await import("../src/media/staging.ts");

    const root = await mkdtemp(join(tmpdir(), "doorman-api-"));
    try {
      const mediaDir = join(root, "media");
      await mkdir(mediaDir);
      const staging = new Staging(join(root, "staging"));
      const local = createApi({
        store,
        source,
        imageDeviceFor: () => new FakeDevice(),
        soundDeviceFor: () => undefined,
        protect: { displayCapableCameras: async () => [] } as never,
        mediaDir,
        cacheDir: join(root, "thumbs"),
        stagingDir: staging.dir,
        protectVersion: "7.2.105",
      } as never);
      const keep = (body: unknown) => local.routes["POST /api/media/keep"](withJson(body), url("/api/media/keep"));

      const id = await staging.put(new Uint8Array(Buffer.from("GIF89a-one")), "gif");
      const kept = (await keep({ id, filename: "wave" })) as { filename: string };
      assert.equal(kept.filename, "wave.gif", "the extension is added when left off");

      // elf.gif is in the (fake) library already.
      const other = await staging.put(new Uint8Array(Buffer.from("GIF89a-two")), "gif");
      await assert.rejects(() => keep({ id: other, filename: "elf.gif" }), /already in the library/);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("keeps a sound in the library even with no way to reach the controller", async () => {
    // The library never fails because the doorbell is full - or absent.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Staging } = await import("../src/media/staging.ts");
    const { SoundLibrary } = await import("../src/media/soundlib.ts");

    const root = await mkdtemp(join(tmpdir(), "doorman-lib-"));
    try {
      const staging = new Staging(join(root, "staging"));
      const library = new SoundLibrary(join(root, "sounds"));
      const local = createApi({
        store,
        source,
        imageDeviceFor: () => new FakeDevice(),
        soundDeviceFor: () => undefined,
        protect: { displayCapableCameras: async () => [] } as never,
        mediaDir: "media",
        cacheDir: join(root, "thumbs"),
        stagingDir: staging.dir,
        soundLibrary: library,
        protectVersion: "7.2.105",
      } as never);
      const call = (route: string, body: unknown, path = route.split(" ")[1]!) =>
        local.routes[route](withJson(body), url(path));

      const id = await staging.put(new Uint8Array(Buffer.from("ID3-elf")), "mp3");
      const kept = (await call("POST /api/sounds/library", { id, name: "Elf: Santa!" })) as {
        ref: string; name: string; hash: string;
      };
      assert.equal(kept.name, "Elf Santa!", "characters a filesystem minds are dropped");
      assert.equal(kept.ref, `library:${kept.hash}`);

      // Asking for it on the doorbell too is where credentials matter.
      const again = await staging.put(new Uint8Array(Buffer.from("ID3-other")), "mp3");
      await assert.rejects(
        () => call("POST /api/sounds/library", { id: again, name: "other", upload: true }),
        /admin credentials/,
      );

      // In use by a theme: not deletable, like a GIF a theme shows.
      store.upsertTheme({
        id: "xmas", name: "Christmas", image: "hash-xmas", sound: kept.ref,
        priority: 0, enabled: true, rules: [{}], devices: [],
      });
      await assert.rejects(
        () => call("DELETE /api/sounds/library", {}, `/api/sounds/library?hash=${kept.hash}`),
        /Still used by Christmas/,
      );
      store.deleteTheme("xmas");
      const removed = (await call("DELETE /api/sounds/library", {}, `/api/sounds/library?hash=${kept.hash}`)) as {
        removed: string;
      };
      assert.equal(removed.removed, "Elf Santa!");
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

describe("deleting a ring sound on the Sounds tab", () => {
  function withSound(playing: string | Error) {
    const deleted: string[] = [];
    const local = createApi({
      store,
      source,
      imageDeviceFor: () => new FakeDevice(),
      soundDeviceFor: () => ({
        currentRingtone: async () => {
          if (playing instanceof Error) throw playing;
          return playing;
        },
        setRingtone: async () => {},
      }),
      priv: { deleteRingtone: async (id: string) => void deleted.push(id), ringtones: async () => [] },
      protect: { displayCapableCameras: async () => [] } as never,
      mediaDir: "media",
      cacheDir: "/tmp/doorman-test-thumbs",
      protectVersion: "7.2.105",
    } as never);
    const del = (id: string) =>
      local.routes["DELETE /api/ringtones"](undefined as never, url(`/api/ringtones?id=${id}`));
    return { del, deleted };
  }

  it("refuses the one a doorbell is playing - Protect would swap in a hidden sound", async () => {
    const { del, deleted } = withSound("tone-1");
    await assert.rejects(() => del("tone-1"), /Front door is playing it right now/);
    assert.deepEqual(deleted, []);
  });

  it("refuses when it cannot tell what is playing", async () => {
    const { del, deleted } = withSound(new Error("timeout"));
    await assert.rejects(() => del("tone-1"), /Could not check what Front door is playing/);
    assert.deepEqual(deleted, []);
  });

  it("deletes one nothing is playing", async () => {
    const { del, deleted } = withSound("tone-other");
    await del("tone-1");
    assert.deepEqual(deleted, ["tone-1"]);
  });
});

describe("Apply now", () => {
  it("puts a library sound on the doorbell, as the 04:00 roll does", async () => {
    // The button once called apply() without the ring sound cache, so a
    // library sound was skipped without a word: the image changed, the
    // doorbell kept a ringtone that no longer existed.
    store.upsertTheme({
      id: "doubtfire",
      name: "doubtfire",
      image: "hash-xmas",
      priority: 0,
      enabled: true,
      rules: [{}],
      sound: "library:abc",
    });
    const set: string[] = [];
    const local = createApi({
      store,
      source,
      imageDeviceFor: () => new FakeDevice(),
      soundDeviceFor: () => ({ currentRingtone: async () => "gone", setRingtone: async (id: string) => void set.push(id) }),
      ringtones: { ensure: async () => ({ ringtoneId: "tone-up", uploaded: true, evicted: [] }) },
      protect: { displayCapableCameras: async () => [] } as never,
      mediaDir: "media",
      cacheDir: "/tmp/doorman-test-thumbs",
      protectVersion: "7.2.105",
    } as never);

    const { results } = (await local.routes["POST /api/apply"](undefined as never, url("/api/apply?device=front"))) as {
      results: Array<{ sound: string; reason: string }>;
    };
    assert.deepEqual(set, ["tone-up"]);
    assert.equal(results[0]!.sound, "applied");
    assert.match(results[0]!.reason, /ring sound uploaded/);
  });
});
