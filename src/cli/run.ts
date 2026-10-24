/**
 * Evaluate the schedule and apply the result, once.
 *
 *   node src/cli/run.ts                      every enabled doorbell
 *   node src/cli/run.ts --device "Front door"  just that one
 *   node src/cli/run.ts --dry-run              say what would happen
 *
 * The daemon calls the same `apply()` on a timer. Keeping this a thin
 * wrapper is what stops the preview and the real thing drifting apart -
 * which is exactly what happened when this was left single-device after
 * doorbells moved into the database: it passed no device, so `apply()`
 * fell back to the id "default", picked a different theme from the same
 * schedule, and wrote its state and history under a doorbell that does
 * not exist.
 */
import { adopt, apply, reconcile } from "../apply.ts";
import { DirectoryAssetSource, ProtectImageDevice, ProtectSoundDevice } from "../device/adapter.ts";
import { PrivateApi } from "../device/private.ts";
import { Protect } from "../device/protect.ts";
import { Store } from "../store/db.ts";

const dryRun = process.argv.includes("--dry-run");

/**
 * `--at 2026-12-24T18:00` answers "what will this do on Christmas Eve"
 * without waiting for Christmas Eve. Only meaningful alongside --dry-run;
 * applying for a pretend time would set the wrong thing right now.
 */
const atFlag = process.argv.indexOf("--at");
const at = atFlag === -1 ? new Date() : new Date(process.argv[atFlag + 1] ?? "");
if (Number.isNaN(at.getTime())) {
  console.error("--at needs a date, e.g. --at 2026-12-24T18:00");
  process.exit(1);
}
if (atFlag !== -1 && !dryRun) {
  console.error("--at only makes sense with --dry-run - otherwise you would apply a theme for the wrong time.");
  process.exit(1);
}

const deviceFlag = process.argv.indexOf("--device");
const wanted = deviceFlag === -1 ? undefined : process.argv[deviceFlag + 1];

const host = process.env.PROTECT_HOST;
const apiKey = process.env.PROTECT_API_KEY;
const dbPath = process.env.DOORMAN_DB ?? "data/doorman.sqlite";
const mediaDir = process.env.DOORMAN_MEDIA ?? "media";

if (!host || !apiKey) {
  console.error("Set PROTECT_HOST and PROTECT_API_KEY. See .env.example.");
  process.exit(1);
}

const protect = new Protect({
  host,
  apiKey,
  insecureTls: process.env.PROTECT_INSECURE_TLS !== "false",
});
const store = new Store(dbPath);
const source = new DirectoryAssetSource(mediaDir, protect);

// Sound is optional. Without admin credentials the app runs images-only,
// which uses nothing but the documented API - a legitimate way to run this,
// not a degraded mode.
const adminUser = process.env.PROTECT_ADMIN_USER;
const adminPass = process.env.PROTECT_ADMIN_PASS;
const priv =
  adminUser && adminPass
    ? new PrivateApi({ host, username: adminUser, password: adminPass })
    : undefined;

/** The doorbells this invocation covers. */
const targets = (() => {
  const devices = store.devices();
  if (devices.length === 0) {
    console.error("No doorbell is configured. Add one with:");
    console.error("  node src/cli/themes.ts devices add <camera-id> <name>");
    process.exit(1);
  }
  if (!wanted) return devices.filter((d) => d.enabled);

  const found =
    devices.find((d) => d.id === wanted) ??
    devices.find((d) => d.name.toLowerCase() === wanted.toLowerCase());
  if (!found) {
    console.error(`No doorbell called "${wanted}".`);
    console.error(`Known: ${devices.map((d) => d.name).join(", ")}`);
    process.exit(1);
  }
  return [found];
})();

if (targets.length === 0) {
  console.error("Every doorbell is disabled, so there is nothing to apply.");
  process.exit(1);
}

await protect.assertSupportedVersion();

// Someone may have deleted an image through Protect's own UI since last run.
// Finding that out now beats handing the doorbell a name that no longer
// resolves, which Protect answers by silently reverting to its default.
const dropped = await reconcile(store, source);
for (const name of dropped) {
  console.log(`forgot ${name} - no longer on the NVR`);
}

// Claim anything already on the NVR before uploading a second copy of it.
const claimed = await adopt(store, source);
for (const { filename, assetName } of claimed) {
  console.log(`adopted ${filename} -> ${assetName} (already on the NVR)`);
}

// Sequential, matching the daemon: several uploads at once is how you find
// out what the NVR's request limit is.
let failed = false;
const several = targets.length > 1;

for (const target of targets) {
  const result = await apply(
    store,
    new ProtectImageDevice(protect, target.id),
    source,
    at,
    {
      dryRun,
      defaultSound: store.setting("defaultRingtone") ?? process.env.DOORMAN_DEFAULT_RINGTONE,
      deviceId: target.id,
      deviceName: target.name,
    },
    undefined,
    priv ? new ProtectSoundDevice(priv, target.id) : undefined,
  );

  const prefix = several ? `${target.name}: ` : "";
  console.log(`${prefix}${result.outcome}: ${result.reason}`);
  if (result.sound) {
    console.log(`  ringtone: ${result.sound}${result.ringtoneId ? ` (${result.ringtoneId})` : ""}`);
  }
  if (result.sound === "skipped") {
    console.log("  (set PROTECT_ADMIN_USER and PROTECT_ADMIN_PASS to control the ring sound)");
  }
  if (result.drift) {
    console.log(
      `  drift: expected ${result.drift.expected}, found ${result.drift.found} ` +
        `(someone changed it in Protect - leaving their change alone)`,
    );
  }
  if (result.outcome === "failed") failed = true;
}

store.close();
process.exit(failed ? 1 : 0);
