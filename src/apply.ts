import { createHash } from "node:crypto";
import { decide } from "./domain/decide.ts";
import type { Config } from "./domain/types.ts";
import type { Outcome, Store } from "./store/db.ts";

/**
 * The one callable operation.
 *
 * The daemon calls this on a timer, the UI calls it for a manual override, and
 * a dry run calls it with `dryRun: true`. That is deliberate: a single entry
 * point means the preview and the real thing cannot drift apart, and it gives
 * a test seam without any extra machinery.
 *
 * The ports below are narrow on purpose. Everything genuinely hard to test -
 * the network, the NVR, the clock - enters through them, so the orchestration
 * can be exercised against fakes while the real adapter is tested by pressing
 * a doorbell.
 */

/** What the doorbell can be asked to do. */
export interface ImageDevice {
  /** The asset name currently displayed, or null. */
  currentImage(): Promise<string | null>;
  showImage(assetName: string): Promise<void>;
}

/**
 * Choosing what the visitor hears.
 *
 * Separate from ImageDevice because the two halves live on different APIs
 * with different credentials: images on the documented Integration API with
 * a read-scoped key, sound on the private API with an admin login. Keeping
 * them apart means a Protect upgrade that breaks the private API leaves the
 * image half working, and an images-only install needs no admin credentials
 * at all.
 */
export interface SoundDevice {
  currentRingtone(): Promise<string | null>;
  setRingtone(ringtoneId: string): Promise<void>;
}

/** Where media comes from, and how it reaches the NVR. */
export interface AssetSource {
  /** Raw bytes for a content hash, or null if the file has gone missing. */
  read(hash: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string } | null>;
  upload(
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
  ): Promise<{ name: string; size: number }>;
  /** What the NVR currently holds, for reconciling and adopting. */
  listRemote(): Promise<Array<{ name: string; originalName: string }>>;
  /** Local media, as content hash -> filename. */
  localFiles(): Promise<Map<string, string>>;
}

export interface Notifier {
  send(event: ApplyResult): Promise<void>;
}

export interface ApplyResult {
  outcome: Outcome;
  /** Human-readable, and the thing worth logging. Never just the outcome. */
  reason: string;
  themeId: string | null;
  themeName: string | null;
  assetName: string | null;
  /** The ringtone that was set, when the theme names one. */
  ringtoneId?: string | null;
  /** Whether the sound half actually changed, was already right, or was skipped. */
  sound?: "applied" | "unchanged" | "skipped" | "failed";
  /**
   * Set when the device was showing something other than what we last set -
   * someone changed it through Protect, or a reboot reset it.
   *
   * Reported, never fought. Polling and correcting would stamp on a person
   * who set "Back in 5 minutes" by hand, and would mean constant writes to
   * consumer hardware for no benefit.
   */
  drift?: { expected: string | null; found: string | null };
  error?: string;
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** Skip the write when the device already shows the right thing. Default true. */
  skipUnchanged?: boolean;
}

export async function apply(
  store: Store,
  device: ImageDevice,
  source: AssetSource,
  now: Date,
  options: ApplyOptions = {},
  notifier?: Notifier,
  sound?: SoundDevice,
): Promise<ApplyResult> {
  const { dryRun = false, skipUnchanged = true } = options;
  const at = now.toISOString();

  const finish = async (result: ApplyResult): Promise<ApplyResult> => {
    if (!dryRun) {
      store.recordApply({
        at,
        themeId: result.themeId,
        assetName: result.assetName,
        reason: result.reason,
        outcome: result.outcome,
      });
    }
    await notifier?.send(result).catch(() => {
      // A notification failing must never fail the apply. The doorbell being
      // right matters more than someone hearing about it.
    });
    return result;
  };

  const config: Config = { themes: store.themes(), selection: store.selection() };
  const decision = decide(config, now, store.cursor());

  if (!decision.theme) {
    return finish({
      outcome: "no-theme",
      reason: decision.reason,
      themeId: null,
      themeName: null,
      assetName: null,
    });
  }

  const theme = decision.theme;

  try {
    // Resolve the asset WITHOUT uploading when this is a dry run.
    //
    // ensureUploaded is not a read: on a cache miss it POSTs, and a Protect
    // upload is permanent and undeletable without admin credentials. A dry
    // run that quietly leaves an asset behind is worse than no dry run - it
    // is the one operation a person reaches for precisely because they expect
    // it to change nothing.
    const known = store.asset(theme.image);
    if (dryRun && !known) {
      return finish({
        outcome: "dry-run",
        reason:
          `${decision.reason}; would upload ${theme.image.slice(0, 12)} first, ` +
          `then set the asset it returns`,
        themeId: theme.id,
        themeName: theme.name,
        assetName: null,
      });
    }

    const assetName = known
      ? known.assetName
      : await ensureUploaded(store, source, theme.image);

    // Read the device before writing. This is what turns "the UI disagrees
    // with the doorbell" from a mystery into a fact, and it is cheap.
    const showing = await device.currentImage();
    const expected = store.lastAppliedAsset();
    const drift =
      expected !== null && showing !== expected
        ? { expected, found: showing }
        : undefined;

    if (skipUnchanged && showing === assetName) {
      if (!dryRun) store.setCursor(decision.cursor);
      return finish({
        outcome: "unchanged",
        reason: `${decision.reason}; already showing it`,
        themeId: theme.id,
        themeName: theme.name,
        assetName,
        drift,
      });
    }

    if (dryRun) {
      return finish({
        outcome: "dry-run",
        reason: `${decision.reason}; would set ${assetName}`,
        themeId: theme.id,
        themeName: theme.name,
        assetName,
        drift,
      });
    }

    await device.showImage(assetName);
    store.setLastAppliedAsset(assetName);
    store.setCursor(decision.cursor);

    // Sound is best-effort and deliberately cannot fail the apply.
    //
    // It lives on the private API, which breaks between major Protect
    // releases - so when it goes, the image half must carry on rather than
    // the whole scheduler stopping. A doorbell showing the right picture with
    // the wrong chime is a far better failure than one stuck on December's
    // GIF in March.
    let soundOutcome: ApplyResult["sound"] = theme.sound ? "skipped" : undefined;
    if (theme.sound && sound) {
      try {
        const current = await sound.currentRingtone();
        if (current === theme.sound) {
          soundOutcome = "unchanged";
        } else {
          await sound.setRingtone(theme.sound);
          soundOutcome = "applied";
        }
      } catch {
        soundOutcome = "failed";
      }
    }

    return finish({
      outcome: "applied",
      reason:
        soundOutcome === "failed"
          ? `${decision.reason}; image set, ringtone failed`
          : decision.reason,
      themeId: theme.id,
      themeName: theme.name,
      assetName,
      ringtoneId: theme.sound ?? null,
      sound: soundOutcome,
      drift,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({
      outcome: "failed",
      reason: `${decision.reason}; ${message}`,
      themeId: theme.id,
      themeName: theme.name,
      assetName: null,
      error: message,
    });
  }
}

/**
 * Resolve a content hash to an asset name on the NVR, uploading only if this
 * is the first time we have seen those exact bytes.
 *
 * Upload-once is not an optimisation here, it is the only correct behaviour.
 * Protect mints a fresh UUID on every upload, offers no overwrite, and has no
 * DELETE on the public API - so uploading per rotation would leak a permanent
 * asset every single day.
 */
export async function ensureUploaded(
  store: Store,
  source: AssetSource,
  hash: string,
): Promise<string> {
  const known = store.asset(hash);
  if (known) return known.assetName;

  const file = await source.read(hash);
  if (!file) {
    throw new Error(`media ${hash.slice(0, 12)} is missing from the library`);
  }

  const uploaded = await source.upload(file.bytes, file.filename, file.mimeType);
  store.recordAsset({
    hash,
    assetName: uploaded.name,
    originalName: file.filename,
    size: uploaded.size,
    uploadedAt: new Date().toISOString(),
  });
  return uploaded.name;
}

/** Content hash of some bytes. The identity of a piece of media. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Drop manifest entries for assets that are no longer on the NVR.
 *
 * Run at startup. Someone deleting an image through Protect's own UI would
 * otherwise leave us handing out a name that no longer resolves - and Protect
 * responds to that by quietly reverting to the default image, which looks like
 * the scheduler not working rather than a missing file.
 */
export async function reconcile(store: Store, source: AssetSource): Promise<string[]> {
  return store.reconcileAssets(new Set((await source.listRemote()).map((a) => a.name)));
}

/**
 * Claim assets the NVR already has, instead of uploading them again.
 *
 * Anyone installing this already has images on their doorbell - they put
 * them there through Protect, which is why they want something better. On
 * first run the manifest is empty, so every one of those gets uploaded a
 * second time. That was not theoretical: the first live run duplicated a
 * 395KB dancing-bones that was already sitting there.
 *
 * Matching is by `originalName`, since Protect keeps the filename you
 * uploaded (as "<name>.png"). That is a HEURISTIC, not identity - an asset
 * called dancing-bones.gif.png on the NVR might be a different cut of the
 * same GIF. The cost of being wrong is showing a slightly different
 * animation than expected; the cost of not doing it is duplicating someone's
 * entire library. Returns what it adopted so the caller can say so out loud.
 */
export async function adopt(store: Store, source: AssetSource): Promise<Array<{ filename: string; assetName: string }>> {
  const remote = await source.listRemote();
  const local = await source.localFiles();
  const adopted: Array<{ filename: string; assetName: string }> = [];

  for (const [hash, filename] of local) {
    if (store.asset(hash)) continue;
    // Protect stores a GIF as "<original>.png" and its preview as
    // "<original>.png.gif"; only the sprite is a candidate.
    const match = remote.find(
      (a) => a.originalName === `${filename}.png` && !a.name.endsWith(".gif"),
    );
    if (!match) continue;
    store.recordAsset({
      hash,
      assetName: match.name,
      originalName: match.originalName,
      size: null,
      uploadedAt: new Date().toISOString(),
    });
    adopted.push({ filename, assetName: match.name });
  }
  return adopted;
}
