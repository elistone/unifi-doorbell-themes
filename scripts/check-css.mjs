#!/usr/bin/env node
/**
 * Verify the committed stylesheet is what src/web/tailwind.css builds.
 *
 * public/style.css is generated, but committed, so the server and the
 * Docker image need no install and no build step. The cost is that it can
 * drift: a class used in app.js that was never compiled renders as nothing,
 * silently. This rebuilds into a temporary file and compares.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const committed = join(ROOT, "src/web/public/style.css");
const dir = mkdtempSync(join(tmpdir(), "doorman-css-"));
const built = join(dir, "style.css");

try {
  execFileSync(
    join(ROOT, "node_modules/.bin/tailwindcss"),
    ["-i", join(ROOT, "src/web/tailwind.css"), "-o", built, "--minify"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
  );
  if (readFileSync(built, "utf8") !== readFileSync(committed, "utf8")) {
    console.error("::error::src/web/public/style.css is out of date. Run `npm run css` and commit the result.");
    process.exit(1);
  }
  console.log("style.css matches src/web/tailwind.css.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
