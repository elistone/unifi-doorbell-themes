#!/usr/bin/env node
/**
 * Print the CHANGELOG section for one version.
 *
 *   node scripts/changelog-for.mjs 0.2.1
 *   node scripts/changelog-for.mjs v0.2.1    (the v is optional)
 *
 * Used by the release workflow so a GitHub release says the same thing the
 * changelog does. Generating release notes from `git log` instead would
 * produce a list of commits, which is a different and much less useful
 * document - the changelog is already written by hand for a reader.
 *
 * Exits non-zero when there is no section, so a tag cut without release
 * notes fails loudly rather than publishing an empty release.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const requested = (process.argv[2] ?? "").replace(/^v/, "");
if (!requested) {
  console.error("usage: changelog-for.mjs <version>");
  process.exit(2);
}

const path = resolve(import.meta.dirname, "..", "CHANGELOG.md");
const lines = (await readFile(path, "utf8")).split("\n");

// Headings look like "## 0.2.1 - 2026-10-04", and "## Unreleased".
const isHeading = (line) => /^##\s+/.test(line);
const versionOf = (line) => line.replace(/^##\s+/, "").split(/\s+[-–]\s+/)[0].trim();

const start = lines.findIndex((line) => isHeading(line) && versionOf(line) === requested);
if (start === -1) {
  console.error(`::error::CHANGELOG.md has no section for ${requested}.`);
  console.error("Write the release notes before tagging - see the Releases section of the README.");
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex(isHeading);
const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

if (!body) {
  console.error(`::error::The ${requested} section of CHANGELOG.md is empty.`);
  process.exit(1);
}

console.log(body);
