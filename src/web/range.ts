/**
 * HTTP byte ranges, for audio the editor seeks around in.
 *
 * Without them Chrome cannot seek an <audio> element at all: setting
 * currentTime on a file served whole snaps back to zero, so "Play
 * selection" and "click to play from here" both started at the very
 * beginning. Only the single-range form is handled - it is the only one a
 * media element sends.
 */
import type { ServerResponse } from "node:http";

/**
 * The bytes a Range header asks for, inclusive at both ends. Null when
 * there is no usable range, which means "send the whole thing"; "invalid"
 * when it asks for bytes the file does not have.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;

  let start: number;
  let end: number;
  if (match[1] === "") {
    // "bytes=-500" is the last 500 bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** Send bytes whole or in part, as the request's Range header asks. */
export function sendBytes(
  res: ServerResponse,
  bytes: Uint8Array,
  headers: Record<string, string>,
  rangeHeader: string | undefined,
): void {
  const size = bytes.byteLength;
  const range = parseRange(rangeHeader, size);
  const common = { ...headers, "Accept-Ranges": "bytes" };

  if (range === "invalid") {
    res.writeHead(416, { ...common, "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  if (range === null) {
    res.writeHead(200, { ...common, "Content-Length": String(size) });
    res.end(bytes);
    return;
  }
  res.writeHead(206, {
    ...common,
    "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    "Content-Length": String(range.end - range.start + 1),
  });
  res.end(bytes.subarray(range.start, range.end + 1));
}
