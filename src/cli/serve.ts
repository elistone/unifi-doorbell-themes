/**
 * The daemon. Rolls the theme once a day and answers a health check.
 *
 *   node src/cli/serve.ts
 *
 * This is what the container runs. It is a thin wrapper around the same
 * `apply()` the CLI calls, deliberately - the preview, the manual trigger and
 * the scheduled roll must not be able to disagree.
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { adopt, apply, reconcile } from "../apply.ts";
import { DirectoryAssetSource, ProtectImageDevice, ProtectSoundDevice } from "../device/adapter.ts";
import { PrivateApi } from "../device/private.ts";
import { Protect } from "../device/protect.ts";
import { HttpNotifier } from "../notify.ts";
import { Store } from "../store/db.ts";
import { VERSION } from "../version.ts";
import { createHandler } from "../web/router.ts";

const host = process.env.PROTECT_HOST;
const apiKey = process.env.PROTECT_API_KEY;
// Doorbells live in the database now. This is the bootstrap for the first
// one, so a headless install still works without opening the UI - after
// that, doorbells are added and named from Settings.
const bootstrapCameraId = process.env.PROTECT_CAMERA_ID;
if (!host || !apiKey) {
  console.error("Set PROTECT_HOST and PROTECT_API_KEY. See .env.example.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const tickSeconds = Number(process.env.DOORMAN_TICK_SECONDS ?? 300);

/**
 * Settings read fresh each tick rather than captured at boot, so changing
 * one in the UI takes effect without restarting the container. The
 * environment variable stays the default for a headless install.
 */
const rollHour = () => Number(store.setting("rollHour") ?? process.env.DOORMAN_ROLL_HOUR ?? 4);
const defaultRingtone = () =>
  store.setting("defaultRingtone") ?? process.env.DOORMAN_DEFAULT_RINGTONE ?? undefined;

const protect = new Protect({ host, apiKey, insecureTls: process.env.PROTECT_INSECURE_TLS !== "false" });
const dbPath = process.env.DOORMAN_DB ?? "data/doorman.sqlite";
const store = new Store(dbPath);
const source = new DirectoryAssetSource(process.env.DOORMAN_MEDIA ?? "media", protect);

const adminUser = process.env.PROTECT_ADMIN_USER;
const adminPass = process.env.PROTECT_ADMIN_PASS;
// Held separately from the SoundDevice: the UI needs the raw private API to
// list, upload and delete ringtones, which is more than applying one.
const priv =
  adminUser && adminPass
    ? new PrivateApi({ host, username: adminUser, password: adminPass })
    : undefined;


const notifier = process.env.NOTIFY_URL
  ? new HttpNotifier({ url: process.env.NOTIFY_URL, method: process.env.NOTIFY_METHOD })
  : undefined;

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

const protectVersion = await protect.assertSupportedVersion();
log(
  `doorman ${VERSION} - Protect ${protectVersion}, sound ${priv ? "enabled" : "disabled (no admin credentials)"}`,
);

/**
 * Adopt the configured camera as the first doorbell.
 *
 * Only when there are none at all, so this cannot resurrect a doorbell
 * someone deliberately removed, and cannot fight the UI once it is the
 * source of truth. Its name comes from Protect if that call works, because
 * "Front Doorbell" beats a 24-character hex id on first sight.
 */
if (bootstrapCameraId && store.devices().length === 0) {
  let name = "Doorbell";
  try {
    const found = (await protect.cameras()).find((c) => c.id === bootstrapCameraId);
    if (found?.name) name = found.name;
  } catch {
    // Naming is cosmetic; a failure here must not stop the service coming up.
  }
  store.upsertDevice({ id: bootstrapCameraId, name, enabled: true, position: 0 });
  log(`adopted ${name} (${bootstrapCameraId}) from PROTECT_CAMERA_ID`);
}

/** The devices this run should drive, rebuilt each tick so the UI is live. */
function activeDevices() {
  return store.devices().filter((d) => d.enabled);
}

const imageDeviceFor = (id: string) => new ProtectImageDevice(protect, id);
const soundDeviceFor = (id: string) =>
  priv ? new ProtectSoundDevice(priv, id) : undefined;

if (store.userCount() === 0) {
  log("no account yet - open the UI to create one; until then it is unconfigured");
}

const claimed = await adopt(store, source);
for (const { filename, assetName } of claimed) log(`adopted ${filename} -> ${assetName}`);

/**
 * Roll when the local DATE changes, not on a 24-hour timer.
 *
 * A setInterval(24h) daemon restarted at 23:00 every evening would never
 * fire, and one restarted at noon would drift its roll time a little later
 * each day. Comparing against the last rolled date is restart-proof, clock-
 * change-proof, and catches up after downtime instead of silently skipping.
 */
async function tick(): Promise<void> {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  if (store.lastRolledDate() === today) return;
  // Wait for the roll hour, unless we have never rolled (fresh install should
  // put something on the doorbell immediately rather than tomorrow morning).
  if (store.lastRolledDate() !== null && now.getHours() < rollHour()) return;

  const devices = activeDevices();
  if (devices.length === 0) {
    // Not an error, and not worth retrying every tick: there is simply
    // nothing configured to drive yet.
    return;
  }

  try {
    const dropped = await reconcile(store, source);
    for (const name of dropped) log(`forgot ${name} - no longer on the NVR`);
  } catch (error) {
    // Reconciliation is housekeeping. A failure here should not stop the
    // doorbells being updated.
    log(`could not reconcile the manifest: ${error instanceof Error ? error.message : error}`);
  }

  // One doorbell failing must not stop the others. Rolled in sequence
  // rather than in parallel on purpose: these all hit one NVR, and an
  // upload is heavy enough there that doing several at once is how you
  // find out what its request limit is.
  let failures = 0;
  for (const target of devices) {
    try {
      const result = await apply(
        store,
        imageDeviceFor(target.id),
        source,
        now,
        {
          defaultSound: defaultRingtone(),
          deviceId: target.id,
          deviceName: target.name,
        },
        notifier,
        soundDeviceFor(target.id),
      );
      log(
        `${target.name}: ${result.outcome}: ${result.reason}` +
          `${result.sound ? ` [ringtone ${result.sound}]` : ""}`,
      );
      if (result.outcome === "failed") failures++;
      if (result.drift) {
        log(
          `  ${target.name} drift: expected ${result.drift.expected}, device had ${result.drift.found} - left alone`,
        );
      }
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : String(error);
      log(`${target.name}: roll failed: ${message}`);
      await notifier?.post("down", `${target.name}: roll failed: ${message}`).catch(() => {});
    }
  }

  // Only call the day done when every doorbell got its turn. Recording it
  // after a partial failure would leave one door stuck on yesterday until
  // tomorrow, with nothing retrying.
  if (failures === 0) store.setLastRolledDate(today);
}

/**
 * The failure nobody notices: the daemon is up, the doorbell shows something
 * plausible, and nothing has rolled for a week. Worth alarming on separately
 * from errors, because no error occurred.
 */
async function checkForStall(): Promise<void> {
  const last = store.recentApplies(1)[0];
  if (!last) return;
  const hoursSince = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
  if (hoursSince > 25) {
    log(`WARNING: nothing applied for ${Math.floor(hoursSince)} hours`);
    await notifier?.post("down", `no theme applied for ${Math.floor(hoursSince)} hours`).catch(() => {});
  }
}

const handle = createHandler({
  store,
  source,
  priv,
  protect,
  // Built per request from the device the caller names, rather than one
  // pair captured at boot - doorbells can be added and removed while this
  // is running.
  imageDeviceFor,
  soundDeviceFor,
  mediaDir: process.env.DOORMAN_MEDIA ?? "media",
  // Beside the database rather than in the media library: these are
  // derived files, and the media directory is the one thing here that
  // cannot be regenerated.
  cacheDir: process.env.DOORMAN_CACHE ?? join(dirname(dbPath), "thumbs"),
  protectVersion,
  defaultSound: defaultRingtone,
  env: {
    rollHour: process.env.DOORMAN_ROLL_HOUR ? Number(process.env.DOORMAN_ROLL_HOUR) : undefined,
    defaultRingtone: process.env.DOORMAN_DEFAULT_RINGTONE,
  },
  // Set when something terminates TLS in front of this - the app itself
  // always speaks plain HTTP, so it cannot work this out for itself, and
  // guessing wrong either breaks login (Secure over HTTP) or sends the
  // session cookie in the clear.
  secureCookies: process.env.DOORMAN_SECURE_COOKIES === "true",
  // An apply from the UI counts as today's roll, or the scheduler would roll
  // again minutes later and overwrite what the person just chose.
  onApplied: (date) => store.setLastRolledDate(date),
});

createServer((req, res) => void handle(req, res)).listen(port, () =>
  log(`listening on :${port}`),
);

await tick();
setInterval(() => void tick(), tickSeconds * 1000);
setInterval(() => void checkForStall(), 3_600_000);

// Sweep expired sessions hourly. sessionUser() already drops one when it is
// used after expiry, but a session nobody returns to would otherwise sit in
// the table forever.
setInterval(() => {
  const removed = store.deleteExpiredSessions();
  if (removed > 0) log(`cleared ${removed} expired session${removed === 1 ? "" : "s"}`);
}, 3_600_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} - closing`);
    store.close();
    process.exit(0);
  });
}
