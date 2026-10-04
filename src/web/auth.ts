/**
 * Accounts and sessions.
 *
 * scrypt and randomBytes out of node:crypto, so this adds no dependencies -
 * the same constraint as everything else here. scrypt rather than a plain
 * hash because it is deliberately slow and memory-hard, which is the only
 * property that matters when the thing being protected is a password people
 * will reuse somewhere else.
 *
 * This replaced a shared basic-auth credential at the proxy. That worked,
 * but it was one password shared with every other admin surface in the
 * estate, there was no way to change it without an Ansible run, and the
 * browser's own credential dialog cannot be logged out of.
 */
import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** How long a session lasts without being used. 30 days: this is a home tool. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "doorman_session";

/**
 * Format: scrypt$<salt hex>$<hash hex>.
 *
 * The algorithm name is stored alongside so a future change can recognise
 * and re-hash old passwords on next login rather than locking everyone out.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so the guard comes first.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A session token the client keeps, and the digest we store. */
export function newSessionToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString("hex");
  return { token, digest: digestToken(token) };
}

/**
 * Only the digest is stored.
 *
 * A database that leaks then yields no usable sessions, the same reason
 * passwords are not stored either. Plain SHA-256 is right here where it
 * would be wrong for a password: the input is 256 bits of randomness, so
 * there is nothing to brute-force and no need to be slow.
 */
export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    // Strict, not Lax. This is the CSRF defence for the whole API: without
    // it a form on another site could POST multipart to /api/media with the
    // cookie attached. There is nothing a cross-site link needs to reach.
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Slow down password guessing.
 *
 * In memory, so it resets on restart - which is a real weakness and an
 * acceptable one: restarting is not something an attacker can trigger, and
 * the alternative is writing a row to disk on every failed guess, which is
 * its own denial-of-service. The lock is per username, so one account being
 * attacked cannot lock out another.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const attempts = new Map<string, { count: number; until: number }>();

export function lockedOutFor(username: string): number {
  const record = attempts.get(username);
  if (!record || record.until < Date.now()) return 0;
  return record.until - Date.now();
}

export function recordFailure(username: string): void {
  const record = attempts.get(username) ?? { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.until = Date.now() + LOCKOUT_MS;
    record.count = 0;
  }
  attempts.set(username, record);
}

export function clearFailures(username: string): void {
  attempts.delete(username);
}

/** Reject passwords that would make the login pointless. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That is longer than 200 characters.";
  if (/^\s|\s$/.test(password)) return "Leading or trailing spaces are too easy to mistype.";
  return null;
}

export function usernameProblem(username: string): string | null {
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
    return "Letters, digits, dot, dash and underscore; 2 to 64 characters.";
  }
  return null;
}
