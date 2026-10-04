/**
 * Evaluate the schedule and apply the result, once.
 *
 *   node src/cli/run.ts            apply for real
 *   node src/cli/run.ts --dry-run  say what would happen, change nothing
 *
 * The daemon will call the same `apply()` on a timer. Keeping this a thin
 * wrapper is what stops the preview and the real thing drifting apart.
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

const host = process.env.PROTECT_HOST;
const apiKey = process.env.PROTECT_API_KEY;
const cameraId = process.env.PROTECT_CAMERA_ID;
const dbPath = process.env.DOORMAN_DB ?? "data/doorman.sqlite";
const mediaDir = process.env.DOORMAN_MEDIA ?? "media";

if (!host || !apiKey || !cameraId) {
  console.error("Set PROTECT_HOST, PROTECT_API_KEY and PROTECT_CAMERA_ID. See .env.example.");
  process.exit(1);
}

const protect = new Protect({
  host,
  apiKey,
  insecureTls: process.env.PROTECT_INSECURE_TLS !== "false",
});
const store = new Store(dbPath);
const device = new ProtectImageDevice(protect, cameraId);
const source = new DirectoryAssetSource(mediaDir, protect);

// Sound is optional. Without admin credentials the app runs images-only,
// which uses nothing but the documented API - a legitimate way to run this,
// not a degraded mode.
const adminUser = process.env.PROTECT_ADMIN_USER;
const adminPass = process.env.PROTECT_ADMIN_PASS;
const sound =
  adminUser && adminPass
    ? new ProtectSoundDevice(new PrivateApi({ host, username: adminUser, password: adminPass }), cameraId)
    : undefined;

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

const result = await apply(store, device, source, at, { dryRun }, undefined, sound);

console.log(`${result.outcome}: ${result.reason}`);
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

store.close();
process.exit(result.outcome === "failed" ? 1 : 0);
