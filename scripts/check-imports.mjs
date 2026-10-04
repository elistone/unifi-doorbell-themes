#!/usr/bin/env node
/**
 * Verify every relative import in src/ points at a file that exists.
 *
 * This exists because of a real bug: an unanchored `.gitignore` rule
 * excluded `src/media/` from every commit, so `check.ts` and `fit.ts`
 * shipped without the module they import. Locally everything passed,
 * because locally the files were there, and `git status` stayed clean.
 *
 * Run in CI against a fresh checkout, that class of mistake cannot survive:
 * a file that was never committed is simply not there to resolve to. The
 * test suite does not cover it, because a CLI nobody imports is a CLI whose
 * imports are never resolved.
 *
 * Static on purpose - importing a CLI to see whether it loads would also
 * run it.
 */
import { readdir, readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/** `from "./x.ts"`, `import("./x.ts")`, `export … from "../y.ts"`. */
const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) yield path;
  }
}

const problems = [];
let checked = 0;

for await (const file of walk(SRC)) {
  const source = await readFile(file, "utf8");
  // Deduped: a module imported for both its values and its types appears
  // twice, and reporting it twice just makes the output harder to read.
  const specifiers = new Set([...source.matchAll(IMPORT_PATTERN)].map(([, s]) => s));
  for (const specifier of specifiers) {
    checked++;
    const target = resolve(dirname(file), specifier);
    try {
      await access(target);
    } catch {
      problems.push(`${relative(ROOT, file)} imports ${specifier}, which does not exist`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    // GitHub renders this as an annotation on the run.
    console.error(`::error::${problem}`);
  }
  console.error(`\n${problems.length} unresolved import(s).`);
  process.exit(1);
}

console.log(`${checked} relative imports across src/ all resolve.`);
