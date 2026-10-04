/**
 * Serve the UI's own files.
 *
 * Three files, read from disk on each request. No bundler, no cache layer
 * and no templating: the whole point of the no-build-step rule is that what
 * is in the repo is what runs, and that property is worth more here than the
 * microseconds a memory cache would save on a single-user admin page.
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  // normalize collapses `..` before the prefix check, so a path that climbs
  // out of the directory fails the check rather than resolving past it.
  const target = normalize(join(PUBLIC_DIR, relative));
  if (!target.startsWith(PUBLIC_DIR)) return false;

  try {
    const bytes = await readFile(target);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": bytes.byteLength,
      // No caching on the UI itself: an admin page serving a stale app.js
      // after an upgrade is a support question nobody can diagnose.
      "Cache-Control": "no-cache",
    });
    res.end(bytes);
    return true;
  } catch {
    return false;
  }
}
