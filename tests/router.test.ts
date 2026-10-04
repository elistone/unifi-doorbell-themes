import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createHandler } from "../src/web/router.ts";
import type { AssetSource, ImageDevice } from "../src/apply.ts";
import { Store } from "../src/store/db.ts";
import { clearFailures } from "../src/web/auth.ts";

/**
 * The gate, over real HTTP.
 *
 * Deliberately not against mock request objects: what is being tested is
 * that an unauthenticated caller cannot reach anything, and that depends on
 * cookie round-tripping, header casing and route matching all agreeing. A
 * mock that gets any of those wrong would pass while the real thing was
 * wide open.
 */

class FakeDevice implements ImageDevice {
  async currentImage() {
    return null;
  }
  async showImage() {}
}

class FakeSource implements AssetSource {
  async read() {
    return null;
  }
  async upload() {
    return { name: "a.png", size: 1 };
  }
  async listRemote() {
    return [];
  }
  async localFiles() {
    return new Map<string, string>();
  }
}

let server: Server;
let base: string;
let store: Store;
let mediaDir: string;

// A fresh server per test rather than one shared across the file. The
// shared version captured the store at construction time, so every test ran
// against whichever database happened to exist first - and the failures
// looked like auth bugs rather than a harness bug.
beforeEach(async () => {
  store = new Store(":memory:");
  // A real temp directory, so an upload test cannot write into the actual
  // media library.
  mediaDir = await mkdtemp(join(tmpdir(), "doorman-media-"));

  const handler = createHandler({
    store,
    device: new FakeDevice(),
    source: new FakeSource(),
    cameraId: "cam",
    mediaDir,
    cacheDir: await mkdtemp(join(tmpdir(), "doorman-thumbs-")),
    protectVersion: "7.2.105",
  } as never);

  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // Lockout state is module-level and deliberately survives a new Store, so
  // one test's brute-force attempt would otherwise lock out the next test.
  clearFailures("eli");
  clearFailures("nobody");
});

afterEach(() => server.close());

const json = (path: string, body: unknown, cookie?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** Pull just the name=value part out of a Set-Cookie header. */
const cookieFrom = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

const GOOD = { username: "eli", password: "a long enough password" };

describe("the gate", () => {
  it("refuses every API route without a session", async () => {
    // The list that matters. If any of these answers 200, the UI is open.
    for (const path of [
      "/api/state",
      "/api/themes",
      "/api/media",
      "/api/ringtones",
      "/api/applies",
      "/api/calendar",
      "/api/selection",
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, `${path} must require a session`);
    }
  });

  it("refuses mutating routes without a session", async () => {
    assert.equal((await json("/api/apply", {})).status, 401);
    assert.equal((await json("/api/themes", { id: "x" })).status, 401);
    const del = await fetch(`${base}/api/themes?id=x`, { method: "DELETE" });
    assert.equal(del.status, 401);
  });

  it("refuses the media thumbnails without a session", async () => {
    // These are the library's own images; a logged-out stranger should not
    // be able to enumerate them.
    assert.equal((await fetch(`${base}/media/anything.gif`)).status, 401);
  });

  it("still answers /health, which the readiness probe needs", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });

  it("serves the login page itself, or nobody could ever log in", async () => {
    for (const path of ["/", "/style.css", "/app.js"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 200, path);
    }
  });

  it("reports first-run before any account exists", async () => {
    const body = await (await fetch(`${base}/api/session`)).json();
    assert.equal(body.needsSetup, true);
    assert.equal(body.authenticated, false);
  });
});

describe("setup", () => {
  it("creates the first account and signs it in", async () => {
    const response = await json("/api/setup", GOOD);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);

    // The token must not come back in the body where script could read it.
    const body = await response.json();
    assert.equal(body.session, undefined);

    const state = await fetch(`${base}/api/state`, { headers: { cookie: cookieFrom(response) } });
    assert.equal(state.status, 200);
  });

  it("refuses a second time, so it is not an open admin-maker", async () => {
    await json("/api/setup", GOOD);
    const second = await json("/api/setup", { username: "sneak", password: "another password" });
    assert.equal(second.status, 409);
    assert.equal(store.userCount(), 1);
  });

  it("rejects a weak password before it is ever stored", async () => {
    const response = await json("/api/setup", { username: "eli", password: "short" });
    assert.equal(response.status, 400);
    assert.equal(store.userCount(), 0, "nothing may be created when validation fails");
  });

  it("rejects a username that could be confused for a path", async () => {
    assert.equal((await json("/api/setup", { username: "../x", password: GOOD.password })).status, 400);
  });
});

describe("login", () => {
  beforeEach(async () => {
    await json("/api/setup", GOOD);
  });

  it("accepts the right password and the session then works", async () => {
    const response = await json("/api/login", GOOD);
    assert.equal(response.status, 200);
    const state = await fetch(`${base}/api/state`, { headers: { cookie: cookieFrom(response) } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).username, "eli");
  });

  it("rejects the wrong password", async () => {
    const response = await json("/api/login", { username: "eli", password: "wrong one entirely" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null, "a failed login must not set a cookie");
  });

  it("says the same thing for an unknown user as for a wrong password", async () => {
    // Otherwise the login tells an attacker which usernames are real.
    const missing = await json("/api/login", { username: "nobody", password: "wrong one entirely" });
    const wrong = await json("/api/login", { username: "eli", password: "wrong one entirely" });
    assert.equal(missing.status, wrong.status);
    assert.equal((await missing.json()).error, (await wrong.json()).error);
  });

  it("rejects a forged cookie", async () => {
    const response = await fetch(`${base}/api/state`, {
      headers: { cookie: "doorman_session=" + "f".repeat(64) },
    });
    assert.equal(response.status, 401);
  });

  it("locks out after repeated failures", async () => {
    for (let i = 0; i < 5; i++) {
      await json("/api/login", { username: "eli", password: `guess ${i} wrong` });
    }
    const response = await json("/api/login", { username: "eli", password: "guess again wrong" });
    assert.equal(response.status, 429);

    // And the lockout does not let the real password through either.
    assert.equal((await json("/api/login", GOOD)).status, 429);
  });
});

describe("image upload", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = cookieFrom(await json("/api/setup", GOOD));
  });

  const upload = async (name: string, bytes: Uint8Array) => {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    return fetch(`${base}/api/media`, { method: "POST", headers: { cookie }, body: form });
  };

  it("refuses a file that is named .gif but is not one", async () => {
    // The name is a claim, the header is evidence. Without this, anything
    // at all lands in a directory the rest of the app assumes holds GIFs.
    const response = await upload("evil.gif", new TextEncoder().encode("<html>not a gif"));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not a GIF/);
    assert.deepEqual(await readdir(mediaDir), [], "a rejected upload must write nothing");
  });

  it("refuses a file that is not named .gif at all", async () => {
    assert.equal((await upload("notes.txt", new Uint8Array([1]))).status, 400);
  });

  it("accepts real GIF bytes", async () => {
    // Smallest thing that passes the header check; it never gets decoded.
    const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0]);
    const response = await upload("ok.gif", gif);
    assert.equal(response.status, 200);
    assert.deepEqual(await readdir(mediaDir), ["ok.gif"]);
  });

  it("strips a path from the upload name rather than following it", async () => {
    // The multipart layer applies basename() before anything touches the
    // filesystem, so a path in the part's filename is normalised, not
    // obeyed. What matters is that nothing lands outside mediaDir - a
    // browser sending a path is clumsy, not necessarily an attack.
    const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 0]);
    const response = await upload("../../escaped.gif", gif);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).filename, "escaped.gif");
    assert.deepEqual(await readdir(mediaDir), ["escaped.gif"], "it must land inside, flattened");
  });
});

describe("thumbnails", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = cookieFrom(await json("/api/setup", GOOD));
  });

  it("needs a session like everything else", async () => {
    assert.equal((await fetch(`${base}/thumb/anything.gif`)).status, 401);
  });

  it("404s for a file that is not in the library", async () => {
    const response = await fetch(`${base}/thumb/missing.gif`, { headers: { cookie } });
    assert.equal(response.status, 404);
  });
});

describe("logout and password change", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = cookieFrom(await json("/api/setup", GOOD));
  });

  it("ends the session", async () => {
    const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);

    const after = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(after.status, 401, "the old cookie must stop working server-side, not just locally");
  });

  it("refuses a change without the current password", async () => {
    const response = await json(
      "/api/password",
      { current: "not it at all", next: "a brand new password" },
      cookie,
    );
    assert.equal(response.status, 403);
  });

  it("changes the password and signs other sessions out", async () => {
    const other = cookieFrom(await json("/api/login", GOOD));

    const response = await json(
      "/api/password",
      { current: GOOD.password, next: "a brand new password" },
      cookie,
    );
    assert.equal(response.status, 200);

    // The point of changing a password is to lock someone out.
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { cookie: other } })).status,
      401,
      "the other session must be revoked",
    );
    // The caller keeps working, on a freshly issued session.
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { cookie: cookieFrom(response) } })).status,
      200,
    );
    // And the old password is really gone.
    assert.equal((await json("/api/login", GOOD)).status, 401);
  });
});
