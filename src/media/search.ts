/**
 * Finding GIFs and sounds without leaving the app.
 *
 * Both providers need a key, and both are optional: without one the search
 * box is simply not offered, and pasting a link still works. The keys stay
 * on the server - the browser asks this app, never the provider - so a key
 * is not sitting in page source for anyone with the URL.
 *
 * Tenor would have been the obvious second GIF provider; Google shut its
 * API down in June 2026. Giphy is what is left with a free key.
 */

type Fetch = typeof fetch;

export interface GifResult {
  id: string;
  title: string;
  /** Small and animated, for the results grid. */
  previewUrl: string;
  /** What gets imported. */
  url: string;
  width: number;
  height: number;
  pageUrl: string;
}

export interface SoundResult {
  id: string;
  name: string;
  durationSeconds: number;
  /** A 128k MP3 that needs no OAuth, which is plenty for a doorbell. */
  previewUrl: string;
  licence: string;
  author: string;
  pageUrl: string;
}

export interface Page<T> {
  results: T[];
  /** Pass back to get the next page, or null when there is none. */
  next: number | null;
}

/** Results per page. Enough to fill the grid twice on a laptop. */
const PAGE_SIZE = 24;

/**
 * The person ringing the bell sees this, and so does every neighbour
 * walking past. Giphy's "pg" is the rating that suits a front door.
 */
const GIPHY_RATING = "pg";

/** Giphy originals can be enormous; past this, take its downsized copy. */
const GIPHY_ORIGINAL_LIMIT = 15 * 1024 * 1024;

async function getJson(fetchImpl: Fetch, url: string, provider: string): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider} refused the API key. Check it is copied in full.`);
  }
  if (response.status === 429) {
    throw new Error(`${provider} says too many searches. Free keys are rate limited - wait a few minutes.`);
  }
  if (!response.ok) throw new Error(`${provider} search failed with ${response.status}.`);
  return response.json();
}

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
  size?: string;
}

interface GiphyResponse {
  data?: Array<{
    id: string;
    title?: string;
    url?: string;
    images?: Record<string, GiphyImage | undefined>;
  }>;
  pagination?: { total_count?: number; count?: number; offset?: number };
}

export class GiphySearch {
  readonly #key: string;
  readonly #fetch: Fetch;

  constructor(options: { apiKey: string; fetch?: Fetch }) {
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async search(query: string, offset = 0): Promise<Page<GifResult>> {
    const params = new URLSearchParams({
      api_key: this.#key,
      q: query,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      rating: GIPHY_RATING,
    });
    const body = (await getJson(
      this.#fetch,
      `https://api.giphy.com/v1/gifs/search?${params}`,
      "Giphy",
    )) as GiphyResponse;

    const results: GifResult[] = [];
    for (const item of body.data ?? []) {
      const images = item.images ?? {};
      const original = images.original;
      const preview = images.fixed_width_downsampled ?? images.fixed_width ?? original;
      const full =
        original?.url && Number(original.size ?? 0) <= GIPHY_ORIGINAL_LIMIT
          ? original
          : images.downsized_large ?? original;
      if (!full?.url || !preview?.url) continue;
      results.push({
        id: item.id,
        title: item.title?.trim() || "Untitled",
        previewUrl: preview.url,
        url: full.url,
        width: Number(full.width ?? 0),
        height: Number(full.height ?? 0),
        pageUrl: item.url ?? `https://giphy.com/gifs/${item.id}`,
      });
    }

    const page = body.pagination ?? {};
    const reached = (page.offset ?? offset) + (page.count ?? results.length);
    return { results, next: reached < (page.total_count ?? 0) ? reached : null };
  }
}

interface FreesoundResponse {
  results?: Array<{
    id: number;
    name?: string;
    duration?: number;
    previews?: Record<string, string>;
    license?: string;
    username?: string;
    url?: string;
  }>;
  next?: string | null;
}

/**
 * Freesound's licences arrive as URLs. Shown because a CC BY sound asks for
 * credit, and the person choosing it ought to know before it is on the door.
 */
export function licenceLabel(url: string): string {
  if (url.includes("publicdomain/zero")) return "CC0";
  if (url.includes("/by-nc/")) return "CC BY-NC";
  if (url.includes("/by/")) return "CC BY";
  if (url.includes("sampling+")) return "Sampling+";
  return "see page";
}

/**
 * Longer than a ring is worth searching for. Anything past this is a song
 * or a soundscape, and would only crowd out the short clips that work.
 */
const SOUND_MAX_SECONDS = 30;

export class FreesoundSearch {
  readonly #key: string;
  readonly #fetch: Fetch;

  constructor(options: { apiKey: string; fetch?: Fetch }) {
    this.#key = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async search(query: string, page = 1): Promise<Page<SoundResult>> {
    const params = new URLSearchParams({
      query,
      token: this.#key,
      page: String(page),
      page_size: String(PAGE_SIZE),
      fields: "id,name,duration,previews,license,username,url",
      filter: `duration:[0 TO ${SOUND_MAX_SECONDS}]`,
    });
    const body = (await getJson(
      this.#fetch,
      `https://freesound.org/apiv2/search/text/?${params}`,
      "Freesound",
    )) as FreesoundResponse;

    const results: SoundResult[] = [];
    for (const item of body.results ?? []) {
      const previewUrl = item.previews?.["preview-hq-mp3"] ?? item.previews?.["preview-lq-mp3"];
      if (!previewUrl) continue;
      results.push({
        id: String(item.id),
        name: item.name?.trim() || `Sound ${item.id}`,
        durationSeconds: Number(item.duration ?? 0),
        previewUrl,
        licence: licenceLabel(item.license ?? ""),
        author: item.username ?? "unknown",
        pageUrl: item.url ?? `https://freesound.org/s/${item.id}/`,
      });
    }
    return { results, next: body.next ? page + 1 : null };
  }
}
