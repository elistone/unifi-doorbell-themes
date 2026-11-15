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
import { copyFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { apply, hashBytes, reconcile } from "../apply.ts";
import type { AssetSource, ImageDevice, SoundDevice } from "../apply.ts";
import { decide } from "../domain/decide.ts";
import type { Device, Rule, Theme } from "../domain/types.ts";
import { ALWAYS_SAFE_FRAMES, analyseGif } from "../media/analyse.ts";
import type { GifAnalysis } from "../media/analyse.ts";
import { fitToLimit } from "../media/transform.ts";
import { Thumbnailer } from "../media/thumbnail.ts";
import { audioPeaks, centreCrop, probeDuration, renderAudio, renderGif } from "../media/edit.ts";
import type { Crop } from "../media/edit.ts";
import { hasYtDlp, importLink, sniff } from "../media/remote.ts";
import type { FreesoundSearch, GiphySearch } from "../media/search.ts";
import { Staging } from "../media/staging.ts";
import { brokenSounds, isLibraryRef, libraryHash, libraryRef, relinkSounds, soundStatus } from "../sounds.ts";
import type { SoundLibrary } from "../media/soundlib.ts";
import { activityByDay, themeShare, windowStart } from "./stats.ts";
import type { RingtoneCache } from "../ringtones.ts";
import { sendBytes } from "./range.ts";
import { MAX_RINGTONES } from "../device/private.ts";
import type { PrivateApi } from "../device/private.ts";
import type { Protect } from "../device/protect.ts";
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
  source: AssetSource;
  /** Built per request, because doorbells come and go while this runs. */
  imageDeviceFor: (deviceId: string) => ImageDevice;
  soundDeviceFor: (deviceId: string) => SoundDevice | undefined;
  /** For discovering cameras that can show an image. */
  protect: Protect;
  /** Only present when admin credentials were supplied. */
  priv?: PrivateApi;
  /** Who is calling, resolved by the router from the session cookie. */
  callerOf: (req: IncomingMessage) => string | null;
  /** The caller's session digest, so logout can revoke exactly that one. */
  sessionDigestOf: (req: IncomingMessage) => string | null;
  mediaDir: string;
  /** Where poster frames are cached. Regenerable, so losing it costs a decode. */
  cacheDir: string;
  /** Where imports wait while they are cropped or trimmed. Disposable. */
  stagingDir?: string;
  /** Each present only when its API key was configured. */
  gifSearch?: GiphySearch;
  soundSearch?: FreesoundSearch;
  /** Injected so the import routes are testable without the network. */
  fetch?: typeof fetch;
  /** Ring sounds kept on disk. Uploaded to the controller as themes need them. */
  soundLibrary?: SoundLibrary;
  /** The controller's slots as a cache over the library. Needs admin credentials. */
  ringtones?: RingtoneCache;
  protectVersion: string;
  /** Read per call, so a change in Settings applies without a restart. */
  defaultSound?: () => string | undefined;
  /**
   * What the deployment configured, for Settings to show as the fallback
   * behind any stored value.
   */
  env?: { rollHour?: number; defaultRingtone?: string };
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
  const { store, source, priv, mediaDir } = deps;
  const thumbnails = new Thumbnailer(deps.cacheDir);
  const staging = new Staging(deps.stagingDir ?? join(deps.cacheDir, "..", "staging"));

  /** A staged file's path, or a 404 that says the editor sat open too long. */
  function stagedPath(id: unknown): string {
    const path = typeof id === "string" ? staging.path(id) : null;
    if (!path) throw new HttpError(400, "That is not an import id.");
    return path;
  }

  async function assertStaged(path: string): Promise<void> {
    await stat(path).catch(() => {
      throw new HttpError(404, "That import has expired. Find it again.");
    });
  }

  /** Errors from ffmpeg and the network are the user's to read, as a 400. */
  async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Resolve a `?device=` parameter to a configured doorbell.
   *
   * Defaults to the first one, so every single-doorbell call can leave it
   * off entirely and nothing in the UI has to care until there are two.
   */
  function resolveDevice(url: URL): Device {
    const devices = store.devices();
    if (devices.length === 0) {
      throw new HttpError(409, "No doorbell is configured yet. Add one in Settings.");
    }
    const asked = url.searchParams.get("device");
    if (!asked) return devices[0];
    const found = devices.find((d) => d.id === asked);
    if (!found) throw new HttpError(404, `No doorbell with id ${asked}.`);
    return found;
  }

  /**
   * Issue a session and hand the token back for the router to set as a
   * cookie. The route layer never touches Set-Cookie itself.
   */
  async function startSession(username: string): Promise<string> {
    const { token, digest } = newSessionToken();
    store.createSession(digest, username, new Date(Date.now() + SESSION_TTL_MS));
    return token;
  }

  /** The sound library, or nothing when this deployment has none. */
  async function library_() {
    return deps.soundLibrary ? deps.soundLibrary.list() : [];
  }

  function requireLibrary(): SoundLibrary {
    if (!deps.soundLibrary) throw new HttpError(503, "This deployment has no sound library.");
    return deps.soundLibrary;
  }

  /** Hash -> filename, so themes can show what they point at. */
  async function mediaIndex(): Promise<Map<string, string>> {
    return source.localFiles();
  }

  /**
   * Where each value came from, in three states rather than two.
   *
   * "environment" means whoever deployed this chose it and editing here
   * overrides them; "default" means nobody chose anything. Collapsing
   * those two made the UI claim a deployment had configured a value it had
   * never heard of.
   */
  function settingsPayload() {
    const sourceOf = (stored: string | null, fromEnv: unknown) =>
      stored !== null ? "setting" : fromEnv !== undefined && fromEnv !== null ? "environment" : "default";

    const storedHour = store.setting("rollHour");
    const storedRingtone = store.setting("defaultRingtone");
    return {
      selection: store.selection(),
      rollHour: {
        value: Number(storedHour ?? deps.env?.rollHour ?? 4),
        source: sourceOf(storedHour, deps.env?.rollHour),
      },
      defaultRingtone: {
        value: storedRingtone ?? deps.env?.defaultRingtone ?? null,
        source: sourceOf(storedRingtone, deps.env?.defaultRingtone),
      },
    };
  }

  async function themesWithMedia() {
    const files = await mediaIndex();
    const ringtones = await (priv?.ringtones().catch(() => []) ?? Promise.resolve([]));
    const live = new Set(ringtones.map((r) => r.id));
    const library = new Set((await library_()).map((l) => l.hash));

    // A library sound is missing only if its FILE has gone; not being on
    // the controller is normal, and fixed by the next apply.
    const soundMissing = (sound: string | undefined) =>
      !sound ? false : isLibraryRef(sound) ? !library.has(libraryHash(sound)) : Boolean(priv) && !live.has(sound);

    return store.themes().map((theme) => {
      const filename = files.get(theme.image) ?? null;
      return {
        ...theme,
        filename,
        missing: filename === null,
        // Only meaningful when we could actually read the ringtone list;
        // no admin credentials must not look like every sound is broken.
        soundMissing: soundMissing(theme.sound),
      };
    });
  }

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    /** Everything the dashboard needs for its first paint, in one request. */
    /**
     * Everything the dashboard needs for its first paint, in one request -
     * now one entry per doorbell. Device calls run in parallel because
     * they are reads; the writes in a roll are deliberately sequential.
     */
    "GET /api/state": async (req) => {
      const devices = store.devices();
      const files = await mediaIndex();
      const byAsset = new Map(store.assets().map((a) => [a.assetName, a]));
      const ringtones = await (priv?.ringtones().catch(() => []) ?? Promise.resolve([]));
      const now = new Date();

      const doorbells = await Promise.all(
        devices.map(async (d) => {
          const sound = deps.soundDeviceFor(d.id);
          const [showing, currentRingtone] = await Promise.all([
            deps.imageDeviceFor(d.id).currentImage().catch(() => null),
            sound?.currentRingtone().catch(() => null) ?? Promise.resolve(null),
          ]);
          const showingAsset = showing ? byAsset.get(showing) : undefined;

          const decision = decide(
            { themes: store.themesFor(d.id), selection: store.selection() },
            now,
            store.cursor(d.id),
            d.id,
          );

          return {
            id: d.id,
            name: d.name,
            enabled: d.enabled,
            showing: {
              assetName: showing,
              filename: showingAsset ? files.get(showingAsset.hash) ?? null : null,
            },
            ringtone: {
              id: currentRingtone,
              name: ringtones.find((r) => r.id === currentRingtone)?.name ?? null,
              // A ringtoneId pointing at nothing means Protect plays its
              // own fallback, which looks like the app doing nothing.
              dangling: Boolean(currentRingtone) && !ringtones.some((r) => r.id === currentRingtone),
            },
            today: {
              themeId: decision.theme?.id ?? null,
              themeName: decision.theme?.name ?? null,
              reason: decision.reason,
            },
            themeCount: store.themesFor(d.id).length,
            last: store.recentApplies(1, d.id)[0] ?? null,
          };
        }),
      );

      return {
        version: VERSION,
        username: deps.callerOf(req),
        protectVersion: deps.protectVersion,
        soundEnabled: Boolean(priv),
        // What the import dialogs can offer. Pasting a GIF or audio link
        // always works; these are the extras that need a key or a binary.
        importing: {
          gifSearch: Boolean(deps.gifSearch),
          soundSearch: Boolean(deps.soundSearch),
          videoLinks: await hasYtDlp(),
        },
        doorbells,
        counts: {
          devices: devices.length,
          themes: store.themes().length,
          media: files.size,
          ringtones: ringtones.length,
          ringtoneLimit: MAX_RINGTONES,
        },
        last: store.recentApplies(1)[0] ?? null,
      };
    },

    // ------------------------------------------------------------ devices

    "GET /api/devices": async () => store.devices(),

    /**
     * Cameras on the controller that could be added.
     *
     * Filtered to ones that can actually display an image, and to ones not
     * already configured - a list that offers you a doorbell you already
     * have is a list you have to read carefully.
     */
    "GET /api/devices/discover": async () => {
      const known = new Set(store.devices().map((d) => d.id));
      const cameras = await deps.protect.displayCapableCameras();
      return cameras
        .filter((c) => !known.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, type: c.type, state: c.state }));
    },

    "PUT /api/devices": async (req) => {
      const body = await readJson<Partial<Device>>(req);
      if (!body.id) throw new HttpError(400, "A doorbell needs an id.");

      const name = (body.name ?? "").trim();
      if (!name) throw new HttpError(400, "Give the doorbell a name.");
      if (name.length > 60) throw new HttpError(400, "That name is longer than 60 characters.");

      const existing = store.device(body.id);
      // Adding, rather than renaming: check the controller actually has it,
      // so a typo becomes an error now instead of a doorbell that silently
      // never updates.
      if (!existing) {
        const cameras = await deps.protect.displayCapableCameras().catch(() => []);
        if (cameras.length > 0 && !cameras.some((c) => c.id === body.id)) {
          throw new HttpError(
            400,
            `Protect has no image-capable camera with id ${body.id}.`,
          );
        }
      }

      const device: Device = {
        id: body.id,
        name,
        enabled: body.enabled !== false,
        position: Number(body.position ?? existing?.position ?? store.devices().length),
      };
      store.upsertDevice(device);
      return device;
    },

    "DELETE /api/devices": async (_req, url) => {
      const id = url.searchParams.get("id");
      if (!id) throw new HttpError(400, "Which doorbell?");
      if (!store.device(id)) throw new HttpError(404, `No doorbell with id ${id}.`);

      // Themes scoped only to this one are disabled rather than silently
      // promoted to every other doorbell - see Store.deleteDevice.
      const orphaned = store.themes().filter(
        (t) => t.devices.length === 1 && t.devices[0] === id,
      ).length;
      store.deleteDevice(id);
      return { removed: id, themesDisabled: orphaned };
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

      // Unknown ids are dropped rather than rejected: a theme referring to
      // a doorbell that has since been removed should be fixable by saving
      // it, not blocked by the thing you are trying to fix.
      const known = new Set(store.devices().map((d) => d.id));
      const devices = Array.isArray(body.devices)
        ? [...new Set(body.devices.filter((id) => known.has(id)))]
        : (store.themes().find((t) => t.id === body.id)?.devices ?? []);

      // Remember the ringtone's NAME as well as its id. Ids are per-console,
      // so the name is the only thing that survives a Protect migration and
      // lets the sound be re-attached afterwards.
      let soundName: string | undefined;
      if (isLibraryRef(body.sound)) {
        const hash = libraryHash(body.sound);
        soundName = (await library_()).find((l) => l.hash === hash)?.name;
        if (!soundName) throw new HttpError(400, "That sound is not in the library.");
      } else if (body.sound && priv) {
        soundName = (await priv.ringtones().catch(() => []))
          .find((r) => r.id === body.sound)?.name;
      }

      const theme: Theme = {
        id: safeName(body.id),
        name: body.name?.trim() || body.id,
        image,
        sound: body.sound || undefined,
        // Keep the previous name if the lookup failed, rather than erasing
        // the one piece of evidence that makes re-linking possible.
        soundName:
          soundName ?? store.themes().find((t) => t.id === body.id)?.soundName,
        priority: Number(body.priority ?? 0),
        enabled: body.enabled !== false,
        rules: Array.isArray(body.rules) && body.rules.length > 0 ? (body.rules as Rule[]) : [{}],
        devices,
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
          // A stat, not a read: the size is all that is wanted here.
          const bytes = (await stat(path)).size;
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

    // ------------------------------------------------------------ importing

    "GET /api/search/gifs": async (_req, url) => {
      if (!deps.gifSearch) throw new HttpError(503, "GIF search needs GIPHY_API_KEY.");
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) throw new HttpError(400, "Search for something.");
      const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
      return asBadRequest(() => deps.gifSearch!.search(query, offset));
    },

    "GET /api/search/sounds": async (_req, url) => {
      if (!deps.soundSearch) throw new HttpError(503, "Sound search needs FREESOUND_API_KEY.");
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) throw new HttpError(400, "Search for something.");
      const page = Number(url.searchParams.get("page") ?? 1) || 1;
      return asBadRequest(() => deps.soundSearch!.search(query, page));
    },

    /**
     * Bring something into staging so it can be cropped or trimmed: a link
     * (a search result is one), or a GIF already in the library, which is
     * how an old wide GIF gets squared up after the fact.
     *
     * Answers with what the editor needs to draw itself - dimensions and
     * length - so it never has to guess at the source.
     */
    "POST /api/staging": async (req) => {
      const body = await readJson<{ link?: string; filename?: string; kind?: string }>(req);
      const kind = body.kind === "audio" ? "audio" : "gif";

      let id: string;
      if (body.filename) {
        if (kind !== "gif") throw new HttpError(400, "Only library GIFs can be edited.");
        const name = safeName(body.filename);
        const bytes = await readFile(join(mediaDir, name)).catch(() => {
          throw new HttpError(404, `${name} is not in the media library.`);
        });
        id = await staging.put(bytes, "gif");
      } else if (body.link) {
        id = await asBadRequest(() => importLink(body.link!, kind, staging, deps.fetch));
      } else {
        throw new HttpError(400, "Import what? Send a link or a filename.");
      }

      const path = staging.path(id)!;
      if (kind === "audio") {
        return { id, kind, durationSeconds: await asBadRequest(() => probeDuration(path)) };
      }
      const analysis = await asBadRequest(async () => analyseGif(path, (await stat(path)).size));
      return {
        id,
        kind,
        width: analysis.width,
        height: analysis.height,
        frames: analysis.frames,
        durationSeconds: analysis.durationSeconds,
        crop: centreCrop(analysis.width, analysis.height),
        // For the editor's "this will become N frames" line as the trim moves.
        safeFrames: ALWAYS_SAFE_FRAMES,
      };
    },

    /**
     * A file from this computer, into staging, for the same editors.
     *
     * Ring sounds go through here rather than straight to the controller,
     * so an uploaded sound is trimmed, converted to a real MP3, and kept in
     * the library like any other.
     */
    "POST /api/staging/upload": async (req, url) => {
      const kind = url.searchParams.get("kind") === "audio" ? "audio" : "gif";
      const { name, bytes } = await readUpload(req);
      const extension = sniff(bytes);
      if (kind === "gif" ? extension !== "gif" : !extension || extension === "gif") {
        throw new HttpError(400, `${name} is not ${kind === "gif" ? "a GIF" : "an audio file this can read"}.`);
      }
      const id = await staging.put(bytes, extension!);
      const path = staging.path(id)!;
      if (kind === "audio") {
        return { id, kind, durationSeconds: await asBadRequest(() => probeDuration(path)) };
      }
      const analysis = await asBadRequest(async () => analyseGif(path, (await stat(path)).size));
      return {
        id,
        kind,
        width: analysis.width,
        height: analysis.height,
        frames: analysis.frames,
        durationSeconds: analysis.durationSeconds,
        crop: centreCrop(analysis.width, analysis.height),
        safeFrames: ALWAYS_SAFE_FRAMES,
      };
    },

    /**
     * Crop and trim a staged GIF into a new staged GIF, for preview.
     *
     * The result is square, 240px, and never more frames than always fit -
     * so an imported GIF does not need the Shrink button afterwards.
     */
    "POST /api/media/render": async (req) => {
      const body = await readJson<{ id?: string; crop?: Crop; start?: number; end?: number }>(req);
      const input = stagedPath(body.id);
      await assertStaged(input);
      const { id, path } = await staging.reserve("gif");
      const analysis = await asBadRequest(() =>
        renderGif(input, path, {
          crop: body.crop,
          start: body.start === undefined ? undefined : Number(body.start),
          end: body.end === undefined ? undefined : Number(body.end),
        }),
      );
      return {
        id,
        frames: analysis.frames,
        bytes: analysis.sourceBytes,
        verdict: analysis.verdict,
        advice: analysis.advice,
      };
    },

    /**
     * Put a rendered GIF into the library under a name.
     *
     * Refuses to overwrite, unlike an upload: the editor suggests a name,
     * and silently replacing a GIF a theme points at because two imports
     * were both called "hello.gif" is a bad way to find out.
     */
    "POST /api/media/keep": async (req) => {
      const body = await readJson<{ id?: string; filename?: string }>(req);
      const input = stagedPath(body.id);
      await assertStaged(input);

      let filename = safeName((body.filename ?? "").trim());
      if (!GIF_EXTENSIONS.has(extname(filename).toLowerCase())) filename += ".gif";

      const bytes = await readFile(input);
      const hash = hashBytes(bytes);
      const files = await mediaIndex();
      const existing = files.get(hash);
      if (existing) return { filename: existing, hash, duplicateOf: existing };
      if ([...files.values()].includes(filename)) {
        throw new HttpError(409, `${filename} is already in the library. Choose another name.`);
      }
      await copyFile(input, join(mediaDir, filename));
      return { filename, hash, bytes: bytes.byteLength };
    },

    /** What the sound editor draws: a staged sound's waveform. */
    "GET /api/staging/peaks": async (_req, url) => {
      const path = stagedPath(url.searchParams.get("id"));
      await assertStaged(path);
      const buckets = Math.min(Math.max(Number(url.searchParams.get("buckets")) || 800, 50), 4000);
      // A window, when the editor is zoomed in: decoded on its own so the
      // detail is real rather than the overview stretched.
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      const window =
        url.searchParams.has("start") && Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0
          ? { start, end }
          : undefined;
      return asBadRequest(() => audioPeaks(path, buckets, window));
    },

    /** Trim and normalise a staged sound into a staged MP3, for preview. */
    "POST /api/ringtones/render": async (req) => {
      const body = await readJson<{
        id?: string; start?: number; end?: number; normalise?: boolean; fadeIn?: number; fadeOut?: number;
      }>(req);
      const input = stagedPath(body.id);
      await assertStaged(input);
      const { id, path } = await staging.reserve("mp3");
      const result = await asBadRequest(() =>
        renderAudio(input, path, {
          start: body.start === undefined ? undefined : Number(body.start),
          end: body.end === undefined ? undefined : Number(body.end),
          normalise: body.normalise !== false,
          fadeIn: Number(body.fadeIn) || 0,
          fadeOut: Number(body.fadeOut) || 0,
        }),
      );
      return { id, ...result };
    },

    /**
     * Keep a rendered sound in the library.
     *
     * Never fails because the controller is full - that is the point of the
     * library. With `upload`, it is also put on the controller now, making
     * room if it has to, for someone who wants to press the bell and hear it.
     */
    "POST /api/sounds/library": async (req) => {
      const library = requireLibrary();
      const body = await readJson<{ id?: string; name?: string; upload?: boolean; replaces?: string }>(req);
      const input = stagedPath(body.id);
      await assertStaged(input);

      const bytes = new Uint8Array(await readFile(input));
      const { sound, duplicate } = await asBadRequest(() => library.add(bytes, body.name ?? ""));

      // Found again to replace a sound only on the controller: move what used
      // it across and retire the old copy. Otherwise, the same name as a sound
      // added through Protect means it IS that sound - link the two, so the
      // slot it holds becomes one Doorman can manage.
      let adopted: string[] = [];
      let replaced: "removed" | "linked" | null = null;
      if (body.replaces) {
        if (!deps.ringtones) throw new HttpError(503, "Ring sounds need admin credentials.");
        replaced = await asBadRequest(() => deps.ringtones!.replace(body.replaces!, sound.hash));
      } else if (deps.ringtones && priv) {
        adopted = await deps.ringtones.adopt(await priv.ringtones()).catch(() => []);
      }

      let onDoorbell: { ringtoneId: string; evicted: string[] } | null = null;
      if (body.upload) {
        if (!deps.ringtones) throw new HttpError(503, "Ring sounds need admin credentials.");
        onDoorbell = await asBadRequest(() => deps.ringtones!.ensure(sound.hash));
      }
      return { ...sound, ref: libraryRef(sound.hash), duplicate, adopted, replaced, onDoorbell };
    },

    /**
     * Rename a library sound. Themes point at its content, so nothing breaks;
     * the name they display is updated to match. A copy already on the
     * controller keeps its old name there until it is next uploaded - Protect
     * has no rename, and a name is not worth a delete and re-upload.
     */
    "PUT /api/sounds/library": async (req) => {
      const library = requireLibrary();
      const body = await readJson<{ hash?: string; name?: string }>(req);
      const renamed = await asBadRequest(() => library.rename(body.hash ?? "", body.name ?? ""));
      const ref = libraryRef(renamed.hash);
      for (const theme of store.themes()) {
        if (theme.sound === ref) store.upsertTheme({ ...theme, soundName: renamed.name });
      }
      return { ...renamed, ref };
    },

    /** Put a library sound on the controller now, making room if it must. */
    "POST /api/sounds/library/upload": async (_req, url) => {
      if (!deps.ringtones) throw new HttpError(503, "Ring sounds need admin credentials.");
      const hash = url.searchParams.get("hash") ?? "";
      if (!(await library_()).some((l) => l.hash === hash)) {
        throw new HttpError(404, "That sound is not in the library.");
      }
      return asBadRequest(() => deps.ringtones!.ensure(hash));
    },

    /**
     * Delete a library sound, and its copy on the controller where that is
     * safe. Refused while a theme or the default names it, the same as a
     * GIF a theme uses.
     */
    "DELETE /api/sounds/library": async (_req, url) => {
      const library = requireLibrary();
      const hash = url.searchParams.get("hash") ?? "";
      const ref = libraryRef(hash);
      const using = store.themes().filter((t) => t.sound === ref);
      if (using.length > 0) {
        throw new HttpError(409, `Still used by ${using.map((t) => t.name).join(", ")}.`);
      }
      if (deps.defaultSound?.() === ref) {
        throw new HttpError(409, "It is the default ring sound. Choose another default first.");
      }
      // Off the controller first: if that fails the file is still here, and
      // a sound on the controller with no file behind it could never be
      // removed again by Doorman.
      const released = (await deps.ringtones?.release(hash)) ?? "absent";
      const removed = await library.remove(hash);
      if (!removed) throw new HttpError(404, "That sound is not in the library.");
      return { removed: removed.name, fromDoorbell: released };
    },

    /**
     * Which theme sounds no longer resolve, and whether anything on the
     * console could be re-attached to them.
     */
    "GET /api/sounds/broken": async () => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const ringtones = await priv.ringtones();
      return brokenSounds(soundStatus(store.themes(), ringtones)).map((s) => ({
        themeId: s.theme.id,
        themeName: s.theme.name,
        wants: s.theme.soundName ?? null,
        missingId: s.theme.sound,
        // Non-null once the audio has been uploaded again under that name.
        canRelinkTo: s.candidate ? { id: s.candidate.id, name: s.candidate.name } : null,
      }));
    },

    /** Re-attach every broken sound that now has a same-named ringtone. */
    "POST /api/sounds/relink": async () => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const relinked = relinkSounds(store, store.themes(), await priv.ringtones());
      return { relinked };
    },

    /**
     * Everything the Sounds tab and the sound pickers need: what is on the
     * controller, and what is in the library.
     *
     * "In use" means a theme or the default names it. For a library sound
     * that is by reference; for a ringtone it is by id, or by being the
     * controller's copy of a library sound that is in use.
     */
    "GET /api/ringtones": async () => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const tones = await priv.ringtones();
      deps.ringtones?.reconcile(tones);
      // A sound added through Protect becomes manageable the moment its
      // original is in the library; noticing it here means the Sounds tab
      // is right as soon as it is opened.
      await deps.ringtones?.adopt(tones);
      await deps.ringtones?.relinkBroken(tones);

      const refs = new Set(store.themes().map((t) => t.sound).filter(Boolean));
      const fallback = deps.defaultSound?.();
      if (fallback) refs.add(fallback);

      const manifest = new Map(store.ringtoneRecords().map((r) => [r.ringtoneId, r.hash]));
      const library = await library_();

      return {
        limit: MAX_RINGTONES,
        ringtones: tones.map((t) => {
          const hash = manifest.get(t.id);
          return {
            ...t,
            // Doorman uploaded it and has the file, so it may remove it to
            // make room and put it back later.
            managed: hash !== undefined,
            // Only on the controller, and Protect cannot hand it back - so
            // Doorman will never remove it, and it holds a slot for good.
            noCopy: !t.isDefault && hash === undefined,
            inUse: refs.has(t.id) || (hash !== undefined && refs.has(libraryRef(hash))),
          };
        }),
        library: library.map((l) => ({
          ref: libraryRef(l.hash),
          hash: l.hash,
          name: l.name,
          bytes: l.bytes,
          onDoorbell: store.ringtoneFor(l.hash) !== null,
          inUse: refs.has(libraryRef(l.hash)),
        })),
      };
    },

    "DELETE /api/ringtones": async (_req, url) => {
      if (!priv) throw new HttpError(503, "Ring sounds need admin credentials.");
      const id = url.searchParams.get("id");
      if (!id) throw new HttpError(400, "Which ring sound?");
      const using = store.themes().filter((t) => t.sound === id);
      if (using.length > 0) {
        throw new HttpError(409, `Still used by ${using.map((t) => t.name).join(", ")}.`);
      }

      // What a doorbell is playing right now. Deleting it does not stop the
      // doorbell pointing at it: Protect quietly swaps in a hidden sound of
      // its own, and the dashboard can only say "points at a ring sound
      // that no longer exists". If a doorbell cannot be read, refuse rather
      // than guess.
      for (const device of store.devices()) {
        const playing = await deps.soundDeviceFor(device.id)?.currentRingtone().catch(() => {
          throw new HttpError(503, `Could not check what ${device.name} is playing, so nothing was deleted.`);
        });
        if (playing === id) {
          throw new HttpError(409, `${device.name} is playing it right now. Apply a different theme first.`);
        }
      }

      const record = store.ringtoneRecords().find((r) => r.ringtoneId === id);
      const fallback = deps.defaultSound?.();
      if (fallback === id || (record && fallback === libraryRef(record.hash))) {
        throw new HttpError(409, "It is the default ring sound. Choose another default first.");
      }

      await priv.deleteRingtone(id);
      if (record) store.forgetRingtone(record.hash);
      console.log(`[${new Date().toISOString()}] removed ring sound ${id} - deleted on the Sounds tab`);
      // A library sound's copy comes back when a theme needs it; anything
      // else is gone for good, and the caller deserves to know which.
      return { removed: id, inLibrary: Boolean(record) };
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

    "GET /api/applies": async (_req, url) => {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const asked = url.searchParams.get("device");
      const names = new Map(store.devices().map((d) => [d.id, d.name]));
      return store
        .recentApplies(limit, asked ?? undefined)
        .map((row) => ({ ...row, deviceName: row.deviceId ? names.get(row.deviceId) ?? null : null }));
    },

    /**
     * The dashboard: what the scheduler did each day over the last N, and
     * which themes were on the doorbells. Across every doorbell, or one.
     */
    "GET /api/stats": async (_req, url) => {
      const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 366);
      const asked = url.searchParams.get("device");
      const now = new Date();
      const rows = store
        .appliesSince(windowStart(days, now).toISOString())
        .filter((row) => !asked || row.deviceId === asked);
      const names = new Map(store.themes().map((t) => [t.id, t.name]));
      return {
        days: activityByDay(rows, days, now),
        themes: themeShare(rows).map((t) => ({ ...t, name: names.get(t.themeId) ?? t.themeId })),
      };
    },

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
      const target = resolveDevice(url);
      const config = { themes: store.themesFor(target.id), selection: store.selection() };
      const files = await mediaIndex();

      let cursor = store.cursor(target.id);
      const out = [];
      for (let i = 0; i < days; i++) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, 12);
        const decision = decide(config, day, cursor, target.id);
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
      return { device: { id: target.id, name: target.name }, days: out };
    },

    /** Run the real thing, now. Same call the scheduler makes. */
    /**
     * Run the real thing now - the same call the scheduler makes.
     *
     * With no `device` parameter this covers every enabled doorbell, which
     * is what the button on the dashboard means. Sequential for the same
     * reason the scheduler is: several uploads at once is how you find the
     * NVR's request limit.
     */
    "POST /api/apply": async (_req, url) => {
      const dryRun = url.searchParams.get("dryRun") === "true";
      const now = new Date();

      const asked = url.searchParams.get("device");
      const targets = asked
        ? [resolveDevice(url)]
        : store.devices().filter((d) => d.enabled);
      if (targets.length === 0) {
        throw new HttpError(409, "No doorbell is enabled. Add or enable one in Settings.");
      }

      if (!dryRun) {
        const dropped = await reconcile(store, source);
        if (dropped.length > 0) console.log(`forgot ${dropped.join(", ")} - no longer on the NVR`);
      }

      const results = [];
      for (const target of targets) {
        results.push(
          await apply(
            store,
            deps.imageDeviceFor(target.id),
            source,
            now,
            {
              dryRun,
              defaultSound: deps.defaultSound?.(),
              ringtones: deps.ringtones,
              deviceId: target.id,
              deviceName: target.name,
            },
            undefined,
            deps.soundDeviceFor(target.id),
          ),
        );
      }

      // Today counts as rolled only when nothing failed, matching the
      // scheduler - a partial failure must stay retryable.
      if (!dryRun && results.every((r) => r.outcome !== "failed")) {
        deps.onApplied?.(todayLocal(now));
      }
      return { results };
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

    // ----------------------------------------------------------- settings

    /**
     * Preferences, with the environment as the fallback.
     *
     * `source` tells the UI whether a value is the deployment's default or
     * something somebody set here, which is the difference between "change
     * this" and "this is pinned by whoever deployed it".
     */
    "GET /api/settings": async () => settingsPayload(),

    "PUT /api/settings": async (req) => {
      const body = await readJson<Record<string, unknown>>(req);

      if (body.selection !== undefined) {
        if (body.selection !== "random" && body.selection !== "sequential") {
          throw new HttpError(400, "Selection is 'random' or 'sequential'.");
        }
        store.setSelection(body.selection);
      }

      if (body.rollHour !== undefined) {
        const hour = Number(body.rollHour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          throw new HttpError(400, "The roll hour is a whole number from 0 to 23.");
        }
        store.setSetting("rollHour", String(hour));
      }

      if (body.defaultRingtone !== undefined) {
        // Empty string means "go back to the deployment's default", which
        // is a different thing from "no sound at all".
        if (body.defaultRingtone === "" || body.defaultRingtone === null) {
          store.clearSetting("defaultRingtone");
        } else {
          store.setSetting("defaultRingtone", String(body.defaultRingtone));
        }
      }

      return settingsPayload();
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

  /** A staged import, for the editor to show or play. */
  async function serveStaged(id: string, res: ServerResponse, range?: string): Promise<void> {
    const path = staging.path(id);
    if (!path) throw new HttpError(404, "No such import.");
    const bytes = await readFile(path).catch(() => {
      throw new HttpError(404, "That import has expired.");
    });
    // In ranges, so the editor can seek - see range.ts.
    sendBytes(
      res,
      bytes,
      {
        "Content-Type": staging.typeOf(id),
        // The id is random and the file never changes under it.
        "Cache-Control": "private, max-age=86400, immutable",
        // Fetched from anywhere on the web, so doubly do not sniff it.
        "X-Content-Type-Options": "nosniff",
      },
      range,
    );
  }

  /** A library sound, for listening to on the Sounds tab. */
  async function serveLibrarySound(hash: string, res: ServerResponse, range?: string): Promise<void> {
    const found = deps.soundLibrary ? await deps.soundLibrary.read(hash) : null;
    if (!found) throw new HttpError(404, "That sound is not in the library.");
    sendBytes(
      res,
      found.bytes,
      {
        "Content-Type": "audio/mpeg",
        // Addressed by content hash, so these bytes never change under it.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
      range,
    );
  }

  return { routes, serveMedia, serveThumbnail, serveStaged, serveLibrarySound };
}
