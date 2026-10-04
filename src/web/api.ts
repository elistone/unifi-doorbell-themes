/**
 * The JSON API behind the UI.
 *
 * Kept separate from the daemon so the routes are testable without starting
 * a server, and so `serve.ts` stays what it was: a scheduler that happens to
 * listen on a port.
 *
 * Every mutating route goes through the same functions the CLI uses. The UI
 * is a client of the application, never a second implementation of it - the
 * moment the button and the cron job can disagree about what "apply" means,
 * one of them is wrong and nobody can tell which.
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { apply, hashBytes, reconcile } from "../apply.ts";
import type { AssetSource, ImageDevice, SoundDevice } from "../apply.ts";
import { decide } from "../domain/decide.ts";
import type { Rule, Theme } from "../domain/types.ts";
import { analyseGif } from "../media/analyse.ts";
import type { GifAnalysis } from "../media/analyse.ts";
import { fitToLimit } from "../media/transform.ts";
import { Thumbnailer } from "../media/thumbnail.ts";
import { MAX_RINGTONES } from "../device/private.ts";
import type { PrivateApi } from "../device/private.ts";
import { Store } from "../store/db.ts";
import { VERSION } from "../version.ts";
import {
  SESSION_TTL_MS,
  clearFailures,
  hashPassword,
  lockedOutFor,
  newSessionToken,
  passwordProblem,
  recordFailure,
  usernameProblem,
  verifyPassword,
} from "./auth.ts";

export interface ApiDeps {
  store: Store;
  device: ImageDevice;
  source: AssetSource;
  sound?: SoundDevice;
  /** Only present when admin credentials were supplied. */
  priv?: PrivateApi;
  /** Who is calling, resolved by the router from the session cookie. */
  callerOf: (req: IncomingMessage) => string | null;
  /** The caller's session digest, so logout can revoke exactly that one. */
  sessionDigestOf: (req: IncomingMessage) => string | null;
  cameraId: string;
  mediaDir: string;
  /** Where poster frames are cached. Regenerable, so losing it costs a decode. */
  cacheDir: string;
  protectVersion: string;
  defaultSound?: string;
  /** Injected so the daemon's own roll bookkeeping stays in one place. */
  onApplied?: (date: string) => void;
}

/** Set by the router before a route runs, for routes that need the caller. */
export interface Caller {
  username: string | null;
}

/** 20MB. The device accepts 10MB; the slack is for the error to be ours. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * A real hash of a value nobody knows, to compare against when the username
 * does not exist. Without it, a missing account returns noticeably faster
 * than a wrong password and the login enumerates usernames.
 */
const DUMMY_HASH =
  "scrypt$00000000000000000000000000000000$" + "0".repeat(128);

const GIF_EXTENSIONS = new Set([".gif"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Analysis is cached by path+size+mtime-free content hash of the file size.
 *
 * ffprobe has to decode every frame to count them, which takes a second or
 * more per file. Doing that for 31 files on every page load made the media
 * tab feel broken. The cache key includes the byte length, so replacing a
 * file under the same name re-analyses it.
 */
const analysisCache = new Map<string, GifAnalysis>();

async function analyseCached(path: string, bytes: number): Promise<GifAnalysis> {
  const key = `${path}:${bytes}`;
  const hit = analysisCache.get(key);
  if (hit) return hit;
  const result = await analyseGif(path, bytes);
  analysisCache.set(key, result);
  return result;
}

function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Parse YYYY-MM-DD as LOCAL noon, so a timezone shift cannot move the day. */
function parseLocalDate(text: string): Date {
  const [y, m, d] = text.split("-").map(Number);
  if (!y || !m || !d) throw new HttpError(400, `${text} is not a YYYY-MM-DD date`);
  return new Date(y, m - 1, d, 12, 0, 0);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, "Upload is larger than 20MB.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

/**
 * Pull one file out of a multipart body using the platform's own parser.
 *
 * `Response.formData()` is undici's multipart implementation, already in
 * Node. Writing a boundary parser by hand would be the single largest piece
 * of security-sensitive code in the project, in a repo whose whole premise is
 * that it has no dependencies to audit.
 */
async function readUpload(req: IncomingMessage, field = "file"): Promise<{ name: string; bytes: Uint8Array }> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new HttpError(400, "Expected a multipart/form-data upload.");
  }
  const body = await readBody(req);
  const form = await new Response(body, { headers: { "content-type": contentType } })
    .formData()
    .catch(() => {
      throw new HttpError(400, "Could not parse the upload.");
    });
  const file = form.get(field);
  if (!(file instanceof File)) throw new HttpError(400, `No "${field}" in the upload.`);
  return { name: basename(file.name), bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * Reject anything that is not a plain filename.
 *
 * The media directory is addressed by name in several routes, and a name is
 * the one piece of user input that reaches the filesystem. `..` and absolute
 * paths are the obvious cases; a leading dot also matters, because the
 * scanners skip dotfiles and a file the UI could create but never list would
 * be invisible rather than absent.
 */
function safeName(name: string): string {
  const clean = basename(name);
  if (!clean || clean !== name || clean.startsWith(".") || clean.includes("/") || clean.includes("\\")) {
    throw new HttpError(400, `"${name}" is not a valid filename.`);
  }
  return clean;
}

export function createApi(deps: ApiDeps) {
  const { store, device, source, sound, priv, cameraId, mediaDir } = deps;
  const thumbnails = new Thumbnailer(deps.cacheDir);

  /**
   * Issue a session and hand the token back for the router to set as a
   * cookie. The route layer never touches Set-Cookie itself.
   */
  async function startSession(username: string): Promise<string> {
    const { token, digest } = newSessionToken();
    store.createSession(digest, username, new Date(Date.now() + SESSION_TTL_MS));
    return token;
  }

  /** Hash -> filename, so themes can show what they point at. */
  async function mediaIndex(): Promise<Map<string, string>> {
    return source.localFiles();
  }

  async function themesWithMedia(): Promise<Array<Theme & { filename: string | null; missing: boolean }>> {
    const files = await mediaIndex();
    return store.themes().map((theme) => {
      const filename = files.get(theme.image) ?? null;
      return { ...theme, filename, missing: filename === null };
    });
  }

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    /** Everything the dashboard needs for its first paint, in one request. */
    "GET /api/state": async (req) => {
      const [showing, currentRingtone, ringtones] = await Promise.all([
        device.currentImage().catch(() => null),
        sound?.currentRingtone().catch(() => null) ?? Promise.resolve(null),
        priv?.ringtones().catch(() => []) ?? Promise.resolve([]),
      ]);
      const files = await mediaIndex();
      const byAsset = new Map(store.assets().map((a) => [a.assetName, a]));
      const showingAsset = showing ? byAsset.get(showing) : undefined;
      const showingFile = showingAsset ? files.get(showingAsset.hash) ?? null : null;

      const now = new Date();
      const decision = decide(
        { themes: store.themes(), selection: store.selection() },
        now,
        store.cursor(),
      );

      return {
        version: VERSION,
        username: deps.callerOf(req),
        protectVersion: deps.protectVersion,
        cameraId,
        soundEnabled: Boolean(sound),
        showing: { assetName: showing, filename: showingFile },
        ringtone: {
          id: currentRingtone,
          name: ringtones.find((r) => r.id === currentRingtone)?.name ?? null,
          /** A ringtoneId pointing at nothing means Protect plays its fallback. */
          dangling: Boolean(currentRingtone) && !ringtones.some((r) => r.id === currentRingtone),
        },
        today: {
          themeId: decision.theme?.id ?? null,
          themeName: decision.theme?.name ?? null,
          reason: decision.reason,
        },
        counts: {
          themes: store.themes().length,
          media: files.size,
          ringtones: ringtones.length,
          ringtoneLimit: MAX_RINGTONES,
        },
        last: store.recentApplies(1)[0] ?? null,
      };
    },

    "GET /api/themes": async () => themesWithMedia(),

    "PUT /api/themes": async (req) => {
      const body = await readJson<Partial<Theme> & { filename?: string }>(req);
      if (!body.id) throw new HttpError(400, "A theme needs an id.");

      // Themes are stored against a content hash, but the UI talks in
      // filenames - renaming a GIF must not orphan its theme.
      let image = body.image;
      if (body.filename) {
        const name = safeName(body.filename);
        const files = await mediaIndex();
        const found = [...files.entries()].find(([, f]) => f === name);
        if (!found) throw new HttpError(400, `${name} is not in the media library.`);
        image = found[0];
      }
      if (!image) throw new HttpError(400, "A theme needs an image.");

      const theme: Theme = {
        id: safeName(body.id),
        name: body.name?.trim() || body.id,
        image,
        sound: body.sound || undefined,
        priority: Number(body.priority ?? 0),
        enabled: body.enabled !== false,
        rules: Array.isArray(body.rules) && body.rules.length > 0 ? (body.rules as Rule[]) : [{}],
      };
      store.upsertTheme(theme);
      return theme;
    },

    "DELETE /api/themes": async (_req, url) => {
      const id = url.searchParams.get("id");
      if (!id) throw new HttpError(400, "Which theme?");
      store.deleteTheme(id);
      return { removed: id };
    },

    "GET /api/media": async () => {
      const files = await mediaIndex();
      const used = new Set(store.themes().map((t) => t.image));
      const entries = await Promise.all(
        [...files.entries()].map(async ([hash, filename]) => {
          const path = join(mediaDir, filename);
          const bytes = (await readFile(path)).byteLength;
          let analysis: GifAnalysis | null = null;
          let analysisError: string | null = null;
          try {
            analysis = await analyseCached(path, bytes);
          } catch (error) {
            // A GIF ffprobe cannot read still belongs in the list, flagged.
            analysisError = error instanceof Error ? error.message : String(error);
          }
          return {
            hash,
            filename,
            bytes,
            inUse: used.has(hash),
            uploaded: store.asset(hash)?.assetName ?? null,
            frames: analysis?.frames ?? null,
            verdict: analysis?.verdict ?? null,
            advice: analysis?.advice ?? analysisError,
            estimateWorst: analysis?.estimateWorst ?? null,
            safeFrameCount: analysis?.safeFrameCount ?? null,
          };
        }),
      );
      return entries.sort((a, b) => a.filename.localeCompare(b.filename));
    },

    "POST /api/media": async (req) => {
      const { name, bytes } = await readUpload(req);
      const filename = safeName(name);
      if (!GIF_EXTENSIONS.has(extname(filename).toLowerCase())) {
        throw new HttpError(400, "Welcome images must be GIFs.");
      }
      // The name is a claim; the header is evidence. Checking it keeps a
      // mislabelled file out of a directory everything else assumes is GIFs.
      const magic = Buffer.from(bytes.slice(0, 6)).toString("latin1");
      if (magic !== "GIF87a" && magic !== "GIF89a") {
        throw new HttpError(400, `${filename} is named .gif but is not a GIF.`);
      }
      const files = await mediaIndex();
      const hash = hashBytes(bytes);
      const existing = files.get(hash);
      if (existing) {
        // Same bytes already here under some name. Uploading again would make
        // a second file that can never be told apart from the first.
        return { filename: existing, hash, duplicateOf: existing };
      }
      await writeFile(join(mediaDir, filename), bytes);
      return { filename, hash, bytes: bytes.byteLength };
    },

    "DELETE /api/media": async (_req, url) => {
      const filename = safeName(url.searchParams.get("filename") ?? "");
      const files = await mediaIndex();
      const hash = [...files.entries()].find(([, f]) => f === filename)?.[0];
      if (!hash) throw new HttpError(404, `${filename} is not in the media library.`);
      if (store.themes().some((t) => t.image === hash)) {
        throw new HttpError(409, `${filename} is still used by a theme. Remove the theme first.`);
      }
      await unlink(join(mediaDir, filename));
      return { removed: filename };
    },

    /**
     * Shrink a GIF until it should fit, in place of the `fit` CLI.
     *
     * Writes a new file rather than overwriting: the original is the
     * irreplaceable artifact and a transform that silently destroys it is
     * not a tool, it is a trap.
     */
    "POST /api/media/fit": async (_req, url) => {
      const filename = safeName(url.searchParams.get("filename") ?? "");
      const input = join(mediaDir, filename);
      const output = join(mediaDir, `${basename(filename, extname(filename))}-fitted.gif`);
      const result = await fitToLimit(input, output);
      return { from: filename, to: basename(output), ...result };
    },

    "GET /api/ringtones": async () => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const tones = await priv.ringtones();
      const used = new Set(store.themes().map((t) => t.sound).filter(Boolean));
      return {
        limit: MAX_RINGTONES,
        ringtones: tones.map((t) => ({ ...t, inUse: used.has(t.id) })),
      };
    },

    "POST /api/ringtones": async (req) => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const existing = await priv.ringtones();
      // Unlike animations, ringtones are capped - and the cap is the reason
      // themes reference them by id rather than by content hash.
      if (existing.length >= MAX_RINGTONES) {
        throw new HttpError(
          409,
          `The doorbell holds ${MAX_RINGTONES} ring sounds and has ${existing.length}. Delete one first.`,
        );
      }
      const { name, bytes } = await readUpload(req);
      if (!AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) {
        throw new HttpError(400, "Ring sounds must be an audio file.");
      }
      return priv.uploadRingtone(bytes, basename(name, extname(name)));
    },

    "DELETE /api/ringtones": async (_req, url) => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const id = url.searchParams.get("id");
      if (!id) throw new HttpError(400, "Which ring sound?");
      const using = store.themes().filter((t) => t.sound === id);
      if (using.length > 0) {
        throw new HttpError(409, `Still used by ${using.map((t) => t.name).join(", ")}.`);
      }
      await priv.deleteRingtone(id);
      return { removed: id };
    },

    /**
     * Readiness, and the one route that must answer before anyone has ever
     * logged in - Ansible waits on it during install and Uptime Kuma polls
     * it. Its STATUS CODE is the signal, not its body.
     */
    "GET /health": async () => {
      const last = store.recentApplies(1)[0];
      const healthy = !last || (Date.now() - new Date(last.at).getTime()) / 3_600_000 <= 25;
      // Thrown rather than returned, because the status code is the point
      // and every other route here answers 200.
      if (!healthy) {
        throw new HttpError(503, `stalled: nothing applied since ${last.at}`);
      }
      return { status: "ok", version: VERSION, last: last ?? null };
    },

    "GET /api/applies": async (_req, url) => store.recentApplies(Number(url.searchParams.get("limit") ?? 50)),

    /**
     * What would show on each of the next N days.
     *
     * Pure `decide()`, no device calls, so it is cheap enough to recompute on
     * every render. This is the answer to "will Christmas actually win?",
     * which is otherwise only discoverable by waiting until December.
     */
    "GET /api/calendar": async (_req, url) => {
      const days = Math.min(Number(url.searchParams.get("days") ?? 60), 400);
      const start = url.searchParams.get("from") ?? todayLocal();
      const from = parseLocalDate(start);
      const config = { themes: store.themes(), selection: store.selection() };
      const files = await mediaIndex();

      let cursor = store.cursor();
      const out = [];
      for (let i = 0; i < days; i++) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, 12);
        const decision = decide(config, day, cursor);
        // Carry the cursor forward so sequential selection previews the real
        // sequence rather than the same entry every day.
        cursor = decision.cursor;
        out.push({
          date: todayLocal(day),
          themeId: decision.theme?.id ?? null,
          themeName: decision.theme?.name ?? null,
          filename: decision.theme ? files.get(decision.theme.image) ?? null : null,
          priority: decision.theme?.priority ?? null,
        });
      }
      return out;
    },

    /** Run the real thing, now. Same call the scheduler makes. */
    "POST /api/apply": async (_req, url) => {
      const dryRun = url.searchParams.get("dryRun") === "true";
      const now = new Date();
      if (!dryRun) {
        const dropped = await reconcile(store, source);
        if (dropped.length > 0) console.log(`forgot ${dropped.join(", ")} - no longer on the NVR`);
      }
      const result = await apply(
        store,
        device,
        source,
        now,
        { dryRun, defaultSound: deps.defaultSound },
        undefined,
        sound,
      );
      // Record the roll so the daemon does not immediately roll again, and so
      // a manual apply counts as today's.
      if (!dryRun && result.outcome !== "failed") deps.onApplied?.(todayLocal(now));
      return result;
    },

    // ------------------------------------------------------------- accounts

    /**
     * The gate the UI asks about before rendering anything.
     *
     * Unauthenticated by design - it has to be answerable by someone who is
     * not logged in, and it reveals only whether an account exists.
     */
    "GET /api/session": async (req) => {
      const username = deps.callerOf(req);
      return {
        needsSetup: store.userCount() === 0,
        authenticated: username !== null,
        username,
        version: VERSION,
      };
    },

    /**
     * Create the first account. Refuses once one exists, which is what stops
     * this being an open "make yourself an admin" endpoint.
     */
    "POST /api/setup": async (req) => {
      if (store.userCount() > 0) {
        throw new HttpError(409, "Setup has already been completed. Sign in instead.");
      }
      const { username, password } = await readJson<{ username: string; password: string }>(req);
      const nameProblem = usernameProblem(username ?? "");
      if (nameProblem) throw new HttpError(400, nameProblem);
      const pwProblem = passwordProblem(password ?? "");
      if (pwProblem) throw new HttpError(400, pwProblem);

      store.createUser(username, await hashPassword(password));
      return { username, session: await startSession(username) };
    },

    "POST /api/login": async (req) => {
      const { username, password } = await readJson<{ username: string; password: string }>(req);
      if (!username || !password) throw new HttpError(400, "Username and password are required.");

      const waitMs = lockedOutFor(username);
      if (waitMs > 0) {
        throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`);
      }

      // Always run one scrypt, even for a username that does not exist, so a
      // missing account and a wrong password take the same time to answer.
      // Otherwise the login enumerates usernames by how fast it says no.
      const user = store.user(username);
      const matched = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      const ok = user !== null && matched;

      if (!ok) {
        recordFailure(username);
        // One message for both cases: which half was wrong is not the
        // caller's business.
        throw new HttpError(401, "Wrong username or password.");
      }

      clearFailures(username);
      return { username, session: await startSession(username) };
    },

    "POST /api/logout": async (req) => {
      const digest = deps.sessionDigestOf(req);
      if (digest) store.deleteSession(digest);
      return { ended: true };
    },

    "POST /api/password": async (req) => {
      const username = deps.callerOf(req);
      if (!username) throw new HttpError(401, "Sign in first.");
      const { current, next } = await readJson<{ current: string; next: string }>(req);

      const user = store.user(username);
      if (!user || !(await verifyPassword(current ?? "", user.passwordHash))) {
        throw new HttpError(403, "That is not your current password.");
      }
      const problem = passwordProblem(next ?? "");
      if (problem) throw new HttpError(400, problem);

      store.setPassword(username, await hashPassword(next));
      // Every other session is now someone who knows the old password.
      store.deleteSessionsFor(username);
      return { changed: true, session: await startSession(username) };
    },

    "GET /api/selection": async () => ({ selection: store.selection() }),

    "PUT /api/selection": async (req) => {
      const { selection } = await readJson<{ selection: string }>(req);
      if (selection !== "random" && selection !== "sequential") {
        throw new HttpError(400, "Selection is 'random' or 'sequential'.");
      }
      store.setSelection(selection);
      return { selection };
    },
  };

  /**
   * Serve a GIF out of the media directory for the thumbnails.
   *
   * Separate from the JSON routes because it streams bytes, and separate from
   * the static UI assets because the media directory is a mounted volume the
   * user writes to, not shipped content.
   */
  async function serveMedia(filename: string, res: ServerResponse): Promise<void> {
    const bytes = await readFile(join(mediaDir, safeName(filename)));
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": bytes.byteLength,
      // Content-addressed in practice: a changed GIF gets a changed name or
      // the user re-uploads. An hour is enough to make scrolling smooth.
      "Cache-Control": "private, max-age=3600",
      // The bytes are user-uploaded, so do not let a browser decide for
      // itself that they are something more interesting than an image.
      "X-Content-Type-Options": "nosniff",
    });
    res.end(bytes);
  }

  /**
   * One still frame, for the grids.
   *
   * Falls back to the GIF itself when ffmpeg is missing or the file will
   * not decode: a library that renders heavily beats a library of broken
   * image icons, and the checker already reports unreadable files properly.
   */
  async function serveThumbnail(filename: string, res: ServerResponse): Promise<void> {
    const name = safeName(filename);
    const files = await source.localFiles();
    const hash = [...files.entries()].find(([, f]) => f === name)?.[0];
    if (!hash) throw new HttpError(404, `${name} is not in the media library.`);

    let bytes: Buffer;
    let type = "image/jpeg";
    try {
      bytes = await readFile(await thumbnails.ensure(hash, join(mediaDir, name)));
    } catch {
      bytes = await readFile(join(mediaDir, name));
      type = "image/gif";
    }

    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": bytes.byteLength,
      // A year: the URL carries the content hash, so these bytes can never
      // stand for anything else.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(bytes);
  }

  return { routes, serveMedia, serveThumbnail };
}
