import { isBraveThumbnailUrl } from "$lib/shared/url-provenance";
import { getConfig } from "../config-store";

export interface ImageSearchResult {
	url: string;
	title: string;
	source: string;
	thumbnail?: string;
	width?: number;
	height?: number;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function searchImages(
	query: string,
): Promise<ImageSearchResult[]> {
	const config = getConfig();
	const apiKey = config.braveSearchApiKey;

	if (!apiKey) {
		throw new Error("BRAVE_SEARCH_API_KEY is not configured");
	}

	const url = new URL("https://api.search.brave.com/res/v1/images/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", "5");

	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`Brave Search API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
		);
	}

	const data = await response.json();
	const results: ImageSearchResult[] = [];

	if (data.results && Array.isArray(data.results)) {
		for (const item of data.results.slice(0, 5)) {
			results.push({
				url: item.properties?.url || item.url || "",
				title: item.title || "",
				source: item.properties?.host || item.url || "",
				// Brave's resized copy is `thumbnail.src` (the image file itself is
				// `properties.url`, and `url` above is the page). The chat shows this
				// address and no other, through the app's own thumbnail route.
				thumbnail: nonEmptyString(item.thumbnail?.src),
				width: item.properties?.width,
				height: item.properties?.height,
			});
		}
	}

	return results;
}

// ── Brave's thumbnail, for the app's own thumbnail route ─────────────
//
// The chat shows an image_search picture as Brave's 500 px copy, fetched here
// and served from the app's own origin (docs/plans/exfil-channels), so the page
// never calls a host a search result named. The address is one a search returned
// to this user (the route asks the ledger), and it must be on Brave's image
// proxy: a forged address there would make the proxy fetch whatever it wraps.
// What this function will not do is each a way a fetched file could turn on the
// reader: follow a redirect, wait long, hold much, or pass on anything that is
// not a raster image (never SVG, which can carry script).

const THUMBNAIL_FETCH_TIMEOUT_MS = 8_000;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
] as const;

export interface BraveThumbnail {
	bytes: Uint8Array;
	contentType: (typeof THUMBNAIL_TYPES)[number];
}

/** The body whole, or null when it is longer than the cap (the stream is cut off there). */
async function readCapped(
	body: ReadableStream<Uint8Array>,
): Promise<Uint8Array | null> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > THUMBNAIL_MAX_BYTES) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Brave's thumbnail at this address, or null when the address is not on Brave's
 * image proxy, the fetch fails or redirects, takes over 8 s, or the answer is
 * not a raster image of at most 2 MB. Never throws, and says nothing about why:
 * the error carries the address.
 */
export async function fetchBraveThumbnail(
	address: string,
): Promise<BraveThumbnail | null> {
	if (!isBraveThumbnailUrl(address)) return null;
	// A fragment is never sent, and none goes into the request.
	const target = new URL(address);
	target.hash = "";

	let upstream: Response;
	try {
		upstream = await fetch(target.href, {
			headers: {
				accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
			},
			// A redirect is an address nobody listed: it fails the fetch.
			redirect: "error",
			signal: AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS),
		});
	} catch {
		return null;
	}

	const contentType = (upstream.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	const declaredLength = Number(upstream.headers.get("content-length"));
	const type = THUMBNAIL_TYPES.find((allowed) => allowed === contentType);
	if (
		!upstream.ok ||
		!upstream.body ||
		!type ||
		(Number.isFinite(declaredLength) && declaredLength > THUMBNAIL_MAX_BYTES)
	) {
		await upstream.body?.cancel().catch(() => {});
		return null;
	}

	const bytes = await readCapped(upstream.body);
	return bytes && bytes.byteLength > 0 ? { bytes, contentType: type } : null;
}
