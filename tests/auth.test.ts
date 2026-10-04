import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
  clearFailures,
  clearedCookie,
  digestToken,
  hashPassword,
  lockedOutFor,
  newSessionToken,
  parseCookies,
  passwordProblem,
  recordFailure,
  sessionCookie,
  usernameProblem,
  verifyPassword,
} from "../src/web/auth.ts";
import { Store } from "../src/store/db.ts";

/**
 * The auth primitives.
 *
 * Worth testing properly rather than by logging in once: these are the only
 * thing between the open internet and a UI that can permanently delete ring
 * sounds, and every failure mode here is silent.
 */

describe("passwords", () => {
  it("verifies the right one and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", hash), true);
    assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
    assert.equal(await verifyPassword("", hash), false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    assert.notEqual(a, b, "two identical passwords must not produce identical hashes");
    assert.equal(await verifyPassword("same password", a), true);
    assert.equal(await verifyPassword("same password", b), true);
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("hunter2hunter2");
    assert.equal(hash.includes("hunter2"), false);
  });

  it("rejects a malformed stored hash rather than throwing", async () => {
    // A truncated or hand-edited row must fail closed, not crash the login.
    for (const broken of ["", "nonsense", "scrypt$", "scrypt$abc", "bcrypt$a$b"]) {
      assert.equal(await verifyPassword("anything", broken), false, broken);
    }
  });

  it("holds the line on length", () => {
    assert.ok(passwordProblem("short"));
    assert.equal(passwordProblem("a reasonable one"), null);
    assert.ok(passwordProblem(" leading space is bad "));
  });

  it("constrains usernames to something that cannot be confused for a path", () => {
    assert.equal(usernameProblem("eli"), null);
    assert.equal(usernameProblem("eli.stone_1-2"), null);
    for (const bad of ["a", "", "../root", "with space", "semi;colon", "x".repeat(65)]) {
      assert.ok(usernameProblem(bad), bad);
    }
  });
});

describe("session tokens", () => {
  it("stores only a digest, so a leaked database yields no sessions", () => {
    const { token, digest } = newSessionToken();
    assert.notEqual(token, digest);
    assert.equal(digestToken(token), digest);
    assert.equal(token.length, 64, "32 bytes of randomness");
  });

  it("issues a different token every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newSessionToken().token));
    assert.equal(seen.size, 50);
  });
});

describe("cookies", () => {
  it("round-trips through a Cookie header", () => {
    const { token } = newSessionToken();
    const header = sessionCookie(token, false);
    const name = header.split("=")[0];
    assert.equal(parseCookies(`${name}=${token}`)[name], token);
  });

  it("is HttpOnly and SameSite=Strict, which is the CSRF defence", () => {
    const header = sessionCookie("abc", false);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
  });

  it("only adds Secure when told to, because the app itself speaks HTTP", () => {
    assert.equal(/Secure/.test(sessionCookie("abc", false)), false);
    assert.match(sessionCookie("abc", true), /Secure/);
  });

  it("expires the cookie when cleared", () => {
    assert.match(clearedCookie(false), /Max-Age=0/);
  });

  it("survives a header with junk in it", () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies("=bad; ; a=1"), { a: "1" });
  });
});

describe("lockout", () => {
  beforeEach(() => clearFailures("victim"));

  it("locks only after repeated failures", () => {
    for (let i = 0; i < 4; i++) recordFailure("victim");
    assert.equal(lockedOutFor("victim"), 0, "four wrong guesses is not yet an attack");
    recordFailure("victim");
    assert.ok(lockedOutFor("victim") > 0, "the fifth locks it");
  });

  it("locks one account without locking another", () => {
    for (let i = 0; i < 5; i++) recordFailure("victim");
    assert.ok(lockedOutFor("victim") > 0);
    assert.equal(lockedOutFor("bystander"), 0, "one account under attack must not lock out another");
  });

  it("forgets failures after a success", () => {
    for (let i = 0; i < 4; i++) recordFailure("victim");
    clearFailures("victim");
    for (let i = 0; i < 4; i++) recordFailure("victim");
    assert.equal(lockedOutFor("victim"), 0);
  });
});

describe("session storage", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("starts with no account, which is the first-run signal", () => {
    assert.equal(store.userCount(), 0);
  });

  it("resolves a live session and refuses an expired one", () => {
    store.createUser("eli", "hash");
    store.createSession("live", "eli", new Date(Date.now() + 60_000));
    store.createSession("dead", "eli", new Date(Date.now() - 1));
    assert.equal(store.sessionUser("live"), "eli");
    assert.equal(store.sessionUser("dead"), null);
  });

  it("deletes an expired session as it rejects it", () => {
    store.createUser("eli", "hash");
    store.createSession("dead", "eli", new Date(Date.now() - 1));
    store.sessionUser("dead");
    assert.equal(store.deleteExpiredSessions(), 0, "already swept on use");
  });

  it("revokes every session for a user, which is what a password change needs", () => {
    store.createUser("eli", "hash");
    store.createSession("a", "eli", new Date(Date.now() + 60_000));
    store.createSession("b", "eli", new Date(Date.now() + 60_000));
    store.createSession("other", "someone-else", new Date(Date.now() + 60_000));

    store.deleteSessionsFor("eli");
    assert.equal(store.sessionUser("a"), null);
    assert.equal(store.sessionUser("b"), null);
    assert.equal(store.sessionUser("other"), "someone-else", "only that user's sessions go");
  });

  it("returns null for a token that was never issued", () => {
    assert.equal(store.sessionUser("made-up"), null);
  });
});
