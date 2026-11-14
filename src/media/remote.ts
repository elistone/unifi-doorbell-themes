/**
 * Bringing a file in from a link.
 *
 * Search results are links, and so is whatever someone found on their
 * phone, so this is the one path both take. Files are identified by their
 * first bytes rather than by the URL or the Content-Type header, because
 * GIF hosts routinely serve a GIF from a URL ending in `.webp` and a CDN
 * will happily label anything `application/octet-stream`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Staging } from "./staging.ts";

const run = promisify(execFile);
type Fetch = typeof fetch;

/** The same ceiling as an upload. The doorbell takes 10MB. */
export const MAX_REMOTE_BYTES = 20 * 1024 * 1024;

/**
 * yt-dlp is optional and found on PATH, like ffmpeg. Named by environment
 * variable for the same reason FFMPEG_BIN is: a NAS with it somewhere odd.
 */
const YTDLP = process.env.YTDLP_BIN ?? "yt-dlp";

/** Past this, a "clip" is a whole programme and not worth downloading. */
const YTDLP_MAX_SECONDS = 600;

export type Kind = "gif" | "audio";

/**
 * What a file is, from its first bytes. Returns the extension to stage it
 * under, or null for anything that is not a GIF or audio we can handle.
 */
export function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => Buffer.from(bytes.slice(from, to)).toString("latin1");

  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(4, 8) === "ftyp") return "m4a";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  // Frame sync: eleven set bits. ADTS AAC is the variant with layer bits 00.
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return (bytes[1]! & 0x06) === 0 ? "aac" : "mp3";
  }
  return null;
}

/**
 * A Giphy page link, turned into the GIF it shows.
 *
 * Copying the link from the address bar is what people do, and it gets
 * you an HTML page. The id is the last hyphenated segment of the path.
 */
export function directGifUrl(link: URL): URL {
  if (link.hostname === "giphy.com" || link.hostname === "www.giphy.com") {
    const match = link.pathname.match(/^\/(?:gifs|stickers)\/(?:.*-)?([A-Za-z0-9]+)\/?$/);
    if (match) return new URL(`https://media.giphy.com/media/${match[1]}/giphy.gif`);
  }
  return link;
}

export function parseLink(text: string): URL {
  let link: URL;
  try {
    link = new URL(text.trim());
  } catch {
    throw new Error("That is not a link.");
  }
  if (link.protocol !== "https:" && link.protocol !== "http:") {
    throw new Error("Only http and https links can be imported.");
  }
  return link;
}

/** Download, stopping at the size limit rather than after it. */
export async function download(link: URL, fetchImpl: Fetch = fetch): Promise<Uint8Array> {
  const response = await fetchImpl(link, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
    // Some hosts refuse an empty user agent outright.
    headers: { "user-agent": "doorman (+https://github.com/elistone/unifi-doorbell-themes)" },
  });
  if (!response.ok) throw new Error(`${link.hostname} answered ${response.status}.`);

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_REMOTE_BYTES) throw new Error("That file is larger than 20MB.");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > MAX_REMOTE_BYTES) throw new Error("That file is larger than 20MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Whether yt-dlp is installed, checked once and remembered. */
let ytdlpPresent: Promise<boolean> | null = null;
export function hasYtDlp(): Promise<boolean> {
  ytdlpPresent ??= run(YTDLP, ["--version"], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  return ytdlpPresent;
}

/**
 * Pull the audio out of a video page - YouTube and the rest of the sites
 * yt-dlp knows.
 *
 * Takes the best audio-only stream as it comes, with no re-encode: the
 * editor converts to MP3 anyway once the clip is trimmed, and transcoding
 * a three-minute video to keep four seconds of it is waste.
 */
export function ytdlpArgs(link: URL, outputTemplate: string): string[] {
  return [
    "--no-playlist",
    "--no-progress",
    "--quiet",
    "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
    "--max-filesize", String(MAX_REMOTE_BYTES),
    "--match-filter", `duration <= ${YTDLP_MAX_SECONDS}`,
    "-o", outputTemplate,
    "--print", "after_move:filepath",
    // Ends option parsing, so a link can never be read as a flag.
    "--",
    link.href,
  ];
}

async function viaYtDlp(link: URL, staging: Staging): Promise<string> {
  // Reserve a name, then let yt-dlp choose the extension it ends up with.
  const { id } = await staging.reserve("mp3");
  const stem = id.slice(0, id.lastIndexOf("."));
  const { stdout } = await run(YTDLP, ytdlpArgs(link, `${staging.dir}/${stem}.%(ext)s`), {
    timeout: 180_000,
  }).catch((error: { stderr?: string; message?: string }) => {
    const detail = (error.stderr || error.message || "").trim().split("\n").pop();
    throw new Error(`yt-dlp could not get audio from that link: ${detail}`);
  });

  const written = stdout.trim().split("\n").pop() ?? "";
  const name = written.slice(written.lastIndexOf("/") + 1);
  if (!Staging.isId(name)) {
    throw new Error(
      written
        ? `yt-dlp produced a file this cannot use (${name}).`
        : `Nothing downloaded - longer than ${YTDLP_MAX_SECONDS / 60} minutes, or no audio.`,
    );
  }
  return name;
}

/**
 * Fetch a link into staging and return its staged id.
 *
 * For audio, a link that turns out to be a web page rather than a sound is
 * handed to yt-dlp when it is installed, so a YouTube link just works.
 */
export async function importLink(
  text: string,
  kind: Kind,
  staging: Staging,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const link = parseLink(text);
  const target = kind === "gif" ? directGifUrl(link) : link;

  const bytes = await download(target, fetchImpl);
  const extension = sniff(bytes);

  if (kind === "gif") {
    if (extension !== "gif") {
      throw new Error("That link is not a GIF. Open the GIF itself and copy the image address.");
    }
    return staging.put(bytes, extension);
  }

  if (extension && extension !== "gif") return staging.put(bytes, extension);

  if (await hasYtDlp()) return viaYtDlp(link, staging);
  throw new Error(
    "That link is not an audio file. Video links like YouTube need yt-dlp installed on the server.",
  );
}
