/**
 * Shrink a GIF until Protect will take it.
 *
 *   node src/cli/fit.ts media/move_it.gif
 *   node src/cli/fit.ts media/move_it.gif --frames 50
 *
 * Writes `<name>.fitted.gif` next to the original and never overwrites it -
 * reducing frames is lossy, and getting your only copy of a GIF back is
 * nobody's idea of a good afternoon.
 */
import { stat } from "node:fs/promises";
import { analyseGif } from "../media/analyse.ts";
import { reduceFrames } from "../media/transform.ts";

const [input] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const framesFlag = process.argv.indexOf("--frames");
const requested = framesFlag === -1 ? null : Number(process.argv[framesFlag + 1]);

if (!input) {
  console.error("Usage: node src/cli/fit.ts <file.gif> [--frames N]");
  process.exit(1);
}
if (requested !== null && (!Number.isInteger(requested) || requested < 2)) {
  console.error("--frames needs a whole number of at least 2");
  process.exit(1);
}

const before = await analyseGif(input, (await stat(input)).size);
console.log(`${input}: ${before.frames} frames, ${before.verdict}`);

if (requested === null && before.verdict === "safe") {
  console.log("Already fits. Pass --frames N to reduce it anyway.");
  process.exit(0);
}

const target = requested ?? before.safeFrameCount;
const output = input.replace(/\.gif$/i, "") + ".fitted.gif";

const result = await reduceFrames(input, output, target);
const after = await analyseGif(output, result.bytesAfter);

const kb = (n: number) => `${Math.round(n / 1024)}KB`;
console.log(
  `  ${result.framesBefore} -> ${result.framesAfter} frames, ` +
    `${kb(result.bytesBefore)} -> ${kb(result.bytesAfter)} source`,
);
console.log(`  ${output}: now ${after.verdict}`);
console.log(`  ${after.advice}`);
console.log("\nThe original is untouched. Check it looks right before swapping it in.");
