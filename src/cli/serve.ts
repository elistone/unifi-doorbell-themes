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
const cameraId = process.env.PROTECT_CAMERA_ID;
if (!host || !apiKey || !cameraId) {
  console.error("Set PROTECT_HOST, PROTECT_API_KEY and PROTECT_CAMERA_ID. See .env.example.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const tickSeconds = Number(process.env.DOORMAN_TICK_SECONDS ?? 300);
/** Local hour to roll at. 4am by default: nobody is at the door. */
const rollHour = Number(process.env.DOORMAN_ROLL_HOUR ?? 4);

const protect = new Protect({ host, apiKey, insecureTls: process.env.PROTECT_INSECURE_TLS !== "false" });
const dbPath = process.env.DOORMAN_DB ?? "data/doorman.sqlite";
const store = new Store(dbPath);
const device = new ProtectImageDevice(protect, cameraId);
const source = new DirectoryAssetSource(process.env.DOORMAN_MEDIA ?? "media", protect);

const adminUser = process.env.PROTECT_ADMIN_USER;
const adminPass = process.env.PROTECT_ADMIN_PASS;
// Held separately from the SoundDevice: the UI needs the raw private API to
// list, upload and delete ringtones, which is more than applying one.
const priv =
  adminUser && adminPass
    ? new PrivateApi({ host, username: adminUser, password: adminPass })
    : undefined;
const sound = priv ? new ProtectSoundDevice(priv, cameraId) : undefined;

const notifier = process.env.NOTIFY_URL
  ? new HttpNotifier({ url: process.env.NOTIFY_URL, method: process.env.NOTIFY_METHOD })
  : undefined;

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

const protectVersion = await protect.assertSupportedVersion();
log(`doorman ${VERSION} - Protect ${protectVersion}, camera ${cameraId}, sound ${sound ? "enabled" : "disabled (no admin credentials)"}`);

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
  if (store.lastRolledDate() !== null && now.getHours() < rollHour) return;

  try {
    const dropped = await reconcile(store, source);
    for (const name of dropped) log(`forgot ${name} - no longer on the NVR`);

    const result = await apply(
      store,
      device,
      source,
      now,
      { defaultSound: process.env.DOORMAN_DEFAULT_RINGTONE },
      notifier,
      sound,
    );
    store.setLastRolledDate(today);
    log(`${result.outcome}: ${result.reason}${result.sound ? ` [ringtone ${result.sound}]` : ""}`);
    if (result.drift) {
      log(`  drift: expected ${result.drift.expected}, device had ${result.drift.found} - left alone`);
    }
  } catch (error) {
    // Do NOT record the date on failure, so the next tick retries rather than
    // waiting until tomorrow.
    const message = error instanceof Error ? error.message : String(error);
    log(`roll failed: ${message}`);
    await notifier?.post("down", `roll failed: ${message}`).catch(() => {});
  }
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
  device,
  source,
  sound,
  priv,
  cameraId,
  mediaDir: process.env.DOORMAN_MEDIA ?? "media",
  // Beside the database rather than in the media library: these are
  // derived files, and the media directory is the one thing here that
  // cannot be regenerated.
  cacheDir: process.env.DOORMAN_CACHE ?? join(dirname(dbPath), "thumbs"),
  protectVersion,
  defaultSound: process.env.DOORMAN_DEFAULT_RINGTONE,
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
