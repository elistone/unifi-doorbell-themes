/**
 * Check every GIF in the media library before uploading any of them.
 *
 *   node src/cli/check.ts
 *
 * Nothing here touches the network or the doorbell. The point is to find out
 * which files will be rejected without spending an upload to discover it -
 * especially because a rejected upload leaves nothing useful behind, and a
 * successful one is permanent unless you have admin credentials.
 */
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { SPRITE_LIMIT_BYTES, analyseGif } from "../media/analyse.ts";
import type { GifAnalysis } from "../media/analyse.ts";

const mediaDir = process.env.DOORMAN_MEDIA ?? "media";
/**
 * Skip dotfiles.
 *
 * macOS litters shared folders with `._name.gif` AppleDouble forks and
 * `.DS_Store`, and the forks carry a .gif extension while containing no
 * image at all - so an extension check alone lets them through and ffprobe
 * then fails on every one. Anyone copying media from a Mac hits this.
 */
const entries = (await readdir(mediaDir, { withFileTypes: true }))
  .filter(
    (e) =>
      e.isFile() &&
      !e.name.startsWith(".") &&
      [".gif", ".png", ".jpg", ".jpeg"].includes(extname(e.name).toLowerCase()),
  )
  .map((e) => e.name)
  .sort();

if (entries.length === 0) {
  console.error(`No images in ${mediaDir}/`);
  process.exit(1);
}

const results: GifAnalysis[] = [];
for (const name of entries) {
  const path = join(mediaDir, name);
  try {
    results.push(await analyseGif(path, (await stat(path)).size));
  } catch (error) {
    console.error(`  ${name}: could not read - ${error instanceof Error ? error.message : error}`);
  }
}

const kb = (n: number) => `${Math.round(n / 1024)}KB`;
const mark = { safe: "ok  ", borderline: "?   ", "likely-fails": "FAIL" } as const;

console.log(
  `\n${"".padEnd(34)}${"frames".padStart(7)}${"source".padStart(9)}${"est. sprite".padStart(14)}`,
);
for (const r of [...results].sort((a, b) => b.frames - a.frames)) {
  const name = r.path.split("/").pop()!;
  const range =
    r.verdict === "safe"
      ? `< ${kb(r.estimateWorst)}`
      : `${kb(r.estimateBest)}-${kb(r.estimateWorst)}`;
  console.log(
    `${mark[r.verdict]} ${name.padEnd(30)}${String(r.frames).padStart(6)}` +
      `${kb(r.sourceBytes).padStart(9)}${range.padStart(14)}`,
  );
}

const counts = {
  safe: results.filter((r) => r.verdict === "safe").length,
  borderline: results.filter((r) => r.verdict === "borderline").length,
  fails: results.filter((r) => r.verdict === "likely-fails").length,
};

console.log(
  `\n${results.length} files: ${counts.safe} safe, ${counts.borderline} borderline, ` +
    `${counts.fails} likely to be rejected.`,
);
console.log(`The limit is ${kb(SPRITE_LIMIT_BYTES)} on the sprite Protect builds, not on the source.`);

const needWork = results.filter((r) => r.verdict !== "safe").sort((a, b) => b.frames - a.frames);
if (needWork.length > 0) {
  console.log("\nWhat to do:");
  for (const r of needWork) {
    console.log(`  ${r.path.split("/").pop()}`);
    console.log(`    ${r.advice}`);
  }
  console.log(
    `\n  node src/cli/fit.ts <file>   writes a reduced copy alongside the original`,
  );
}
