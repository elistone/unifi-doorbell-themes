/**
 * Connection check. Run this before anything else: it answers "is this going
 * to work at all" without changing a thing on the doorbell.
 *
 *   PROTECT_HOST=192.168.1.1 PROTECT_API_KEY=... node src/cli/probe.ts
 *
 * Also reports which of the cameras it finds are already configured as
 * doorbells, and - more usefully - which configured doorbells the
 * controller no longer has.
 */
import { existsSync } from "node:fs";
import { Protect } from "../device/protect.ts";
import { Store } from "../store/db.ts";

const host = process.env.PROTECT_HOST;
const apiKey = process.env.PROTECT_API_KEY;

if (!host || !apiKey) {
  console.error("Set PROTECT_HOST and PROTECT_API_KEY. See .env.example.");
  process.exit(1);
}

const protect = new Protect({
  host,
  apiKey,
  insecureTls: process.env.PROTECT_INSECURE_TLS !== "false",
});

const version = await protect.assertSupportedVersion();
console.log(`Protect ${version}`);

const candidates = await protect.displayCapableCameras();
if (candidates.length === 0) {
  console.error("\nNo camera reports an lcdMessage field, so none can show a welcome image.");
  console.error("This needs a doorbell with a screen - the G4 Doorbell Pro is the proven one.");
  process.exit(1);
}

/**
 * Read the configured doorbells, if there is a database to read.
 *
 * Opened read-only in spirit and skipped entirely when the file is not
 * there: probe's whole job is answering "will this work" before anything
 * is set up, so it must not be the thing that creates a database as a side
 * effect of being run.
 */
const dbPath = process.env.DOORMAN_DB ?? "data/doorman.sqlite";
const configured = new Map<string, { name: string; enabled: boolean }>();
if (existsSync(dbPath)) {
  const store = new Store(dbPath);
  for (const device of store.devices()) {
    configured.set(device.id, { name: device.name, enabled: device.enabled });
  }
  store.close();
}

console.log("\nCameras that can display an image:");
for (const camera of candidates) {
  const showing = camera.lcdMessage?.text ?? camera.lcdMessage?.type ?? "nothing";
  const known = configured.get(camera.id);
  const tag = known
    ? `  [configured as "${known.name}"${known.enabled ? "" : ", disabled"}]`
    : "  [not added]";
  console.log(`  ${camera.id}  ${camera.name} (${camera.type})${tag}`);
  console.log(`      state=${camera.state}  showing=${showing}`);
}

// A doorbell in the database that the controller no longer offers is worth
// shouting about: it will fail every roll, and the only symptom otherwise
// is a door that quietly stops changing.
const missing = [...configured].filter(([id]) => !candidates.some((c) => c.id === id));
if (missing.length > 0) {
  console.log("\n⚠️  Configured but NOT on the controller:");
  for (const [id, { name }] of missing) {
    console.log(`  ${id}  "${name}" - every roll for this one will fail`);
  }
}

if (configured.size === 0) {
  console.log(
    `\nNo doorbell is configured yet. Set PROTECT_CAMERA_ID to one of the ids` +
      ` above to adopt it on first run, or add it from Settings in the UI.`,
  );
}

const assets = await protect.animations();
console.log(`\n${assets.length} animation${assets.length === 1 ? "" : "s"} already uploaded.`);
for (const asset of assets.slice(0, 10)) {
  console.log(`  ${asset.name}  <- ${asset.originalName}  ${(asset.size / 1024).toFixed(0)}KB`);
}
