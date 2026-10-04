/**
 * Client for Protect's PRIVATE API.
 *
 * Everything the official Integration API cannot do: selecting the doorbell's
 * ring sound, uploading and deleting ringtones, and deleting animations.
 *
 * Kept in a separate file from protect.ts on purpose. That one talks to a
 * documented, versioned, additively-evolving API with a read-scoped key. This
 * one talks to an undocumented surface with an admin login, and it breaks
 * between major Protect releases - 4.0 removed default doorbell messages, 5.0
 * reworked chimes entirely. The split is so that a Protect upgrade can take
 * out the sound half while images carry on working.
 *
 * All endpoints here were verified against Protect 7.2.105 on real hardware.
 */

export interface Ringtone {
  id: string;
  name: string;
  isDefault: boolean;
  size: number;
}

export interface SpeakerSettings {
  isEnabled: boolean;
  areSystemSoundsEnabled: boolean;
  volume: number;
  ringVolume: number;
  ringtoneId: string;
  repeatTimes: number;
  speakerVolume: number;
}

/**
 * The controller refuses uploads past this. Verified in the Protect backend
 * as MAX_CUSTOM_RINGTONE_QUANTITY, and it fails with an empty-bodied 400,
 * which is not a diagnosable error - so count before uploading rather than
 * finding out.
 *
 * Note this is the opposite of animations, which are uncapped. Sounds need an
 * eviction policy; images do not.
 */
export const MAX_RINGTONES = 12;

export class PrivateApi {
  readonly #host: string;
  readonly #username: string;
  readonly #password: string;
  #cookie: string | null = null;
  #csrf: string | null = null;

  constructor(options: { host: string; username: string; password: string }) {
    this.#host = options.host;
    this.#username = options.username;
    this.#password = options.password;
  }

  async #login(): Promise<void> {
    const response = await fetch(`https://${this.#host}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.#username,
        password: this.#password,
        remember: false,
        strict: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Protect login failed with ${response.status}. Check the admin credentials.`);
    }
    // Keep only the TOKEN pair; the attributes confuse the server on replay.
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const token = setCookie.map((c) => c.split(";")[0]).find((c) => c?.startsWith("TOKEN="));
    if (!token) throw new Error("Protect login returned no TOKEN cookie");
    this.#cookie = token;
    this.#csrf =
      response.headers.get("x-updated-csrf-token") ?? response.headers.get("x-csrf-token");
  }

  /**
   * Every private call goes through here, and retries once on 401.
   *
   * Not defensive programming - the CSRF token genuinely rotates on each
   * response, and sessions expire. A session captured minutes earlier
   * returned 401 during development, which is exactly the failure a daemon
   * running for weeks would hit in the middle of the night.
   */
  async #request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.#cookie) await this.#login();

    const response = await fetch(`https://${this.#host}/proxy/protect/api${path}`, {
      ...init,
      headers: {
        cookie: this.#cookie!,
        ...(this.#csrf ? { "x-csrf-token": this.#csrf } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });

    // The token rotates - carry the new one forward or the next call fails.
    const rotated = response.headers.get("x-updated-csrf-token");
    if (rotated) this.#csrf = rotated;

    if (response.status === 401 && retry) {
      this.#cookie = null;
      return this.#request(path, init, false);
    }
    if (!response.ok) {
      throw new Error(
        `${init.method ?? "GET"} ${path} failed with ${response.status}: ` +
          `${(await response.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    return response;
  }

  // -------------------------------------------------------------- ringtones

  async ringtones(): Promise<Ringtone[]> {
    return (await this.#request("/ringtones")).json() as Promise<Ringtone[]>;
  }

  /**
   * Upload a sound. Fails with a bare 400 when the 12-slot limit is reached,
   * so the caller should evict first rather than interpret that.
   */
  async uploadRingtone(bytes: Uint8Array, name: string): Promise<Ringtone> {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/mpeg" }), `${name}.mp3`);
    form.append("name", name);
    return (await this.#request("/ringtones", { method: "POST", body: form })).json() as Promise<Ringtone>;
  }

  async deleteRingtone(id: string): Promise<void> {
    await this.#request(`/ringtones/${id}`, { method: "DELETE" });
  }

  // ------------------------------------------------------- doorbell speaker

  async speakerSettings(cameraId: string): Promise<SpeakerSettings> {
    const camera = (await (await this.#request(`/cameras/${cameraId}`)).json()) as {
      speakerSettings: SpeakerSettings;
    };
    return camera.speakerSettings;
  }

  /**
   * Choose what the person at the door hears.
   *
   * This is the call that made the SSH layer unnecessary. Verified by setting
   * it and pressing the button: the chosen ringtone played at the door.
   *
   * The PATCH merges, so ringVolume and the rest survive - a sound change
   * cannot silently reset a volume someone set by hand.
   */
  async setRingtone(cameraId: string, ringtoneId: string): Promise<void> {
    await this.#request(`/cameras/${cameraId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speakerSettings: { ringtoneId } }),
    });
  }

  // ------------------------------------------------------------- animations

  /**
   * Delete an uploaded welcome image. The official API has no DELETE at all.
   *
   * ignoreFileExtension matters: a GIF upload produces both a `.png` sprite
   * and a `.png.gif` preview, and without the flag only the exact name goes,
   * orphaning the other. Verified - one call took the file count from 16 to
   * 14.
   *
   * Never delete the asset a camera's lcdMessage currently points at. Protect
   * degrades gracefully (it resets the message and falls back to the default)
   * but that reads to a household as the scheduler having broken.
   */
  async deleteAnimation(assetName: string): Promise<void> {
    await this.#request(
      `/files/animations/${encodeURIComponent(assetName)}?ignoreFileExtension=true`,
      { method: "DELETE" },
    );
  }
}
