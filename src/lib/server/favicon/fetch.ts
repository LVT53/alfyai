/**
 * Favicon fetch orchestration (ADR 0043, Slice 12).
 *
 * Pure-ish logic with an injected `fetch`: tries the source site's
 * `/favicon.ico` first, falls back to DuckDuckGo's icon service, and finally
 * returns a generic globe marker. Designed to be the unit-testable seam — the
 * SvelteKit `+server.ts` is a thin adapter around `fetchFavicon`.
 *
 * SSRF hardening lives in `validateFaviconDomain` (the caller must pass an
 * already-validated hostname). Here we additionally:
 *   - force https on every outbound URL,
 *   - pass `redirect: "manual"` so a redirect to an internal address is NOT
 *     silently followed (a 3xx is treated as failure),
 *   - reject non-image content-types and empty bodies.
 */
import { GLOBE_FALLBACK_SVG, GLOBE_FALLBACK_SVG_BYTES } from "./globe";
import type { FaviconCache } from "./lru";

export type FetchFaviconResult =
	| { kind: "image"; bytes: Uint8Array; contentType: string }
	| { kind: "globe" };

export interface FetchFaviconOptions {
	/** Optional shared cache; when omitted no caching is performed. */
	cache?: FaviconCache;
	/** Injectable for testing. Defaults to the global fetch. */
	fetch?: typeof globalThis.fetch;
}

const IMAGE_TYPES = new Set([
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/avif",
	"image/bmp",
]);

/** DuckDuckGo favicon icon service. */
const DUCK_DUCK_GO = (domain: string) =>
	`https://icons.duckduckgo.com/ip3/${domain}.ico` as const;

/** Source-site favicon. */
const SOURCE = (domain: string) => `https://${domain}/favicon.ico` as const;

/**
 * Fetch a favicon for an already-validated `domain`. Returns either the image
 * bytes + content-type, or a `globe` marker on total failure.
 */
export async function fetchFavicon(
	domain: string,
	opts: FetchFaviconOptions = {},
): Promise<FetchFaviconResult> {
	// Cache hit?
	if (opts.cache) {
		const hit = opts.cache.get(domain);
		if (hit !== null) {
			return { kind: "image", bytes: hit.bytes, contentType: hit.contentType };
		}
	}

	const fetchImpl = opts.fetch ?? globalThis.fetch;

	// Try source first, then DuckDuckGo.
	const candidates = [SOURCE(domain), DUCK_DUCK_GO(domain)];
	for (const url of candidates) {
		const fetched = await tryFetchImage(fetchImpl, url);
		if (fetched !== null) {
			if (opts.cache) {
				opts.cache.set(
					domain,
					opts.cache.wrap(fetched.bytes, fetched.contentType),
				);
			}
			return { kind: "image", ...fetched };
		}
	}

	// Negative-cache the globe fallback so a hammering client is cheap.
	if (opts.cache) {
		opts.cache.set(
			domain,
			opts.cache.wrap(GLOBE_FALLBACK_SVG_BYTES, "image/svg+xml"),
		);
	}
	return { kind: "globe" };
}

async function tryFetchImage(
	fetchImpl: typeof globalThis.fetch,
	url: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	try {
		const res = await fetchImpl(url, {
			redirect: "manual",
			headers: { accept: "image/*" },
		});
		// Treat anything outside 2xx as failure (including 3xx redirects, which
		// we did not follow — see header comment on SSRF).
		if (!res.ok) return null;
		const contentType = (res.headers.get("content-type") ?? "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		if (!contentType || !IMAGE_TYPES.has(contentType)) return null;
		const buffer = await res.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		if (bytes.byteLength === 0) return null;
		return { bytes, contentType };
	} catch {
		return null;
	}
}

export { GLOBE_FALLBACK_SVG };
