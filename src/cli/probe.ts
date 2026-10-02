/**
 * Connection check. Run this before anything else: it answers "is this going
 * to work at all" without changing a thing on the doorbell.
 *
 *   PROTECT_HOST=192.168.1.1 PROTECT_API_KEY=... node src/cli/probe.ts
 */
import { Protect } from "../device/protect.ts";

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

console.log("\nCameras that can display an image:");
for (const camera of candidates) {
  const showing = camera.lcdMessage?.text ?? camera.lcdMessage?.type ?? "nothing";
  console.log(`  ${camera.id}  ${camera.name} (${camera.type})`);
  console.log(`      state=${camera.state}  showing=${showing}`);
}

const assets = await protect.animations();
console.log(`\n${assets.length} animation${assets.length === 1 ? "" : "s"} already uploaded.`);
for (const asset of assets.slice(0, 10)) {
  console.log(`  ${asset.name}  <- ${asset.originalName}  ${(asset.size / 1024).toFixed(0)}KB`);
}
