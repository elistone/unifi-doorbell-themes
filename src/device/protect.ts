/**
 * Client for UniFi Protect's official Integration API.
 *
 * Written against the published OpenAPI spec and verified against a live
 * controller running Protect 7.2.105. Every endpoint and payload shape here
 * has been exercised on real hardware, not copied from documentation.
 *
 * Deliberately not using a library. The surface needed is five calls, and the
 * things a library buys you - auth refresh, CSRF rotation, schema drift -
 * mostly evaporate when you are using a static API key against a versioned
 * spec. What a library would cost is a dependency on someone else's release
 * cycle for the most fragile part of the project.
 *
 * This only ever touches the OFFICIAL API. The private API at
 * /proxy/protect/api/ breaks at roughly every major Protect release (4.0
 * removed default doorbell messages, 4.0.21 introduced IMAGE and broke every
 * strict client, 5.0 reworked chimes). The official one has been purely
 * additive: v6.1 to v7.2 added 30 paths and removed none.
 */

/** Earliest version where /v1/files/animations and the IMAGE type are known good. */
/**
 * Ordinary requests are metadata reads against a local appliance, so 30s is
 * already generous and a hang is worth surfacing quickly.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Uploads get their own, far longer budget, because this is the one request
 * where the NVR does real work before replying: it tiles every frame into a
 * sprite sheet and quantises the result to a 32-colour palette, on appliance
 * hardware. An 88-frame GIF blew straight through 30s and reported
 * "The operation was aborted due to timeout", which reads exactly like a
 * rejected upload and is not one - the upload was still being processed.
 *
 * Frame count drives the cost, and the frame count that fits is capped near
 * 120, so this is bounded work rather than something that can run away.
 */
const UPLOAD_TIMEOUT_MS = 300_000;

const MINIMUM_PROTECT_VERSION = [6, 1];

export interface ProtectOptions {
  host: string;
  apiKey: string;
  /**
   * Controllers ship a self-signed certificate, so verification has to be
   * relaxed to talk to one by address.
   *
   * This is global to the process, which is tolerable only because this is a
   * single-purpose container whose sole outbound destination is the
   * controller. The better answer is to trust the controller's certificate
   * explicitly via NODE_EXTRA_CA_CERTS; this is the pragmatic default.
   */
  insecureTls?: boolean;
}

export interface LcdMessage {
  type: "IMAGE" | "CUSTOM_MESSAGE" | "DO_NOT_DISTURB" | "LEAVE_PACKAGE_AT_DOOR";
  /** For IMAGE this is the asset `name`, e.g. "ca46fa70-….png". */
  text?: string | null;
  /**
   * UNIX ms. Omitted falls back to the NVR default (60s on a stock install);
   * null means forever, which is what a scheduler wants - the theme should
   * persist until the next roll replaces it, not time out after a minute.
   */
  resetAt?: number | null;
}

export interface Camera {
  id: string;
  name: string;
  type: string;
  state: string;
  lcdMessage?: LcdMessage;
}

export interface AnimationAsset {
  id: string;
  /** The value to put in `lcdMessage.text`. */
  name: string;
  /** Whatever was uploaded. Display only - never used for lookup or dedup. */
  originalName: string;
  path: string;
  size: number;
  createdAt: string;
}

export class ProtectError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ProtectError";
    this.status = status;
    this.body = body;
  }
}

export class Protect {
  readonly #base: string;
  readonly #apiKey: string;

  // Fields written out longhand rather than as constructor parameter
  // properties: Node's strip-only TypeScript mode rejects those, because
  // they are the one piece of TS syntax that has to EMIT code rather than
  // just be erased. Same reason enums and namespaces are out. That is the
  // price of having no build step, and it is a cheap one.
  constructor(options: ProtectOptions) {
    this.#base = `https://${options.host}/proxy/protect/integration/v1`;
    this.#apiKey = options.apiKey;
    if (options.insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const response = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: { "X-API-KEY": this.#apiKey, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new ProtectError(
        `${init.method ?? "GET"} ${path} failed with ${response.status}`,
        response.status,
        await response.text().catch(() => ""),
      );
    }
    return response;
  }

  private async json<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    return (await this.request(path, init, timeoutMs)).json() as Promise<T>;
  }

  /**
   * Fail fast and legibly on an old controller.
   *
   * Without this the first symptom is a 404 from an endpoint that simply does
   * not exist yet - which looks like a bug in this app rather than a version
   * problem, and will be reported as one.
   */
  async assertSupportedVersion(): Promise<string> {
    const { applicationVersion } = await this.json<{ applicationVersion: string }>("/meta/info");
    const parts = applicationVersion.split(".").map(Number);
    const [major = 0, minor = 0] = parts;
    const [needMajor, needMinor] = MINIMUM_PROTECT_VERSION as [number, number];
    if (major < needMajor || (major === needMajor && minor < needMinor)) {
      throw new Error(
        `Protect ${applicationVersion} is too old. This needs ` +
          `${needMajor}.${needMinor} or later, which is when welcome-image ` +
          `uploads became available on the Integration API.`,
      );
    }
    return applicationVersion;
  }

  async cameras(): Promise<Camera[]> {
    return this.json<Camera[]>("/cameras");
  }

  /**
   * Cameras that can display a welcome image.
   *
   * The public API does NOT expose `hasLcdScreen` - `cameraFeatureFlags`
   * carries only snapshot/HDR/mic/speaker flags. But presence of the
   * `lcdMessage` field turns out to discriminate perfectly: on a live
   * controller with twelve cameras, the G4 Doorbell Pro was the only one
   * carrying it.
   *
   * Used to offer a pick-list at setup, not to guess. The camera id stays
   * explicit in configuration, because model-name matching is unreliable -
   * nobody has confirmed whether the original G4 Doorbell accepts IMAGE.
   */
  async displayCapableCameras(): Promise<Camera[]> {
    return (await this.cameras()).filter((c) => c.lcdMessage !== undefined);
  }

  async camera(id: string): Promise<Camera> {
    return this.json<Camera>(`/cameras/${id}`);
  }

  /** What the doorbell is showing right now. Null when nothing is set. */
  async currentMessage(cameraId: string): Promise<LcdMessage | null> {
    return (await this.camera(cameraId)).lcdMessage ?? null;
  }

  async setMessage(cameraId: string, message: LcdMessage): Promise<void> {
    await this.request(`/cameras/${cameraId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lcdMessage: message }),
    });
  }

  /** Display an already-uploaded asset, indefinitely. */
  async showImage(cameraId: string, assetName: string): Promise<void> {
    await this.setMessage(cameraId, { type: "IMAGE", text: assetName, resetAt: null });
  }

  async animations(): Promise<AnimationAsset[]> {
    return this.json<AnimationAsset[]>("/files/animations");
  }

  /**
   * Upload an image and get back the asset to point `lcdMessage` at.
   *
   * Call this once per unique asset, ever. Two verified facts make that the
   * only sensible pattern:
   *
   *   - Overwrite is impossible. Every upload mints a fresh UUIDv1 regardless
   *     of filename; `originalName` is never consulted for lookup.
   *   - There is no DELETE on this API. Removing an asset needs the private
   *     API and an admin login, which is a materially stronger credential.
   *
   * The saving grace is that animations are uncapped - the controller's own
   * quantity limit for them is literally infinity, and the check that enforces
   * limits is never called on this path. So accumulating is wasteful, not
   * dangerous. Rotation should never upload; it should PATCH between names
   * already on the NVR.
   *
   * On size: the route accepts up to 10MB, processes the image server-side
   * into a sprite sheet, and only then enforces under 1MB on the OUTPUT. So do
   * not pre-validate against 1MB - the relationship between what you upload
   * and what gets stored is not something you can predict.
   *
   * But do NOT assume the ceiling is comfortable. Measured against a real
   * library: a synthetic test pattern compressed 243KB -> 83KB, which is
   * reassuring and completely unrepresentative. Actual content from that same
   * NVR sits at 995KB and 932KB - within half a percent of rejection. Real
   * video has far more entropy than a test card.
   *
   * The practical consequence is that upload failures are a normal case, not
   * an edge case, and the error has to be legible: which file, how big it
   * came out, and what to do about it (fewer frames, or a smaller palette).
   * Only the sprite is size-checked - previews can and do exceed 1MB.
   */
  async uploadAnimation(bytes: Uint8Array, filename: string, mimeType: string): Promise<AnimationAsset> {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    return this.json<AnimationAsset>(
      "/files/animations",
      { method: "POST", body: form },
      UPLOAD_TIMEOUT_MS,
    );
  }
}
