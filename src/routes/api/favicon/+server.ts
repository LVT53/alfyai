import { validateFaviconDomain } from "$lib/server/favicon/domain";
import { fetchFavicon } from "$lib/server/favicon/fetch";
import { GLOBE_FALLBACK_SVG_BYTES } from "$lib/server/favicon/globe";
import { FaviconCache } from "$lib/server/favicon/lru";
import type { RequestHandler } from "./$types";

/**
 * Same-origin favicon privacy proxy (ADR 0043, Slice 12).
 *
 * Stops leaking every researched domain to Google's `s2/favicons`. Instead the
 * browser asks US for the icon; we fetch it server-side (source first, then a
 * DuckDuckGo fallback), cache it, and return the bytes. On any failure we
 * return a generic globe SVG so the `<img>` never breaks.
 *
 * No auth gate: a favicon lookup is a public-icon proxy and there is nothing
 * user-specific about the response.
 */

// 7 days. Bound the cache modestly; negative results share it too.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;

// Module-level cache survives across requests on a given server instance.
const cache = new FaviconCache({ maxSize: MAX_ENTRIES, ttlMs: TTL_MS });

// Long-lived caching headers for successful, cacheable responses.
const LONG_CACHE = "public, max-age=604800, immutable";
// Short cache for the globe fallback (the domain might publish an icon later).
const SHORT_CACHE = "public, max-age=300";

export const GET: RequestHandler = ({ url }) => {
	const raw = url.searchParams.get("domain");
	const domain = validateFaviconDomain(raw);
	if (domain === null) {
		return imageResponse(
			GLOBE_FALLBACK_SVG_BYTES,
			"image/svg+xml",
			SHORT_CACHE,
		);
	}

	// `fetchFavicon` is async; return the promise directly (SvelteKit awaits it).
	return fetchFavicon(domain, { cache }).then((result) => {
		if (result.kind === "image") {
			return imageResponse(result.bytes, result.contentType, LONG_CACHE);
		}
		return imageResponse(
			GLOBE_FALLBACK_SVG_BYTES,
			"image/svg+xml",
			SHORT_CACHE,
		);
	});
};

function imageResponse(
	bytes: Uint8Array,
	contentType: string,
	cacheControl: string,
): Response {
	// Copy into a fresh ArrayBuffer so the Response owns stable storage (the
	// cached Uint8Array may be reused across requests).
	const body = new Uint8Array(bytes).buffer;
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": contentType,
			"cache-control": cacheControl,
			// Favicons are fetched cross-origin from our own front-end; the bytes
			// are not credential-bearing, but be explicit.
			"cross-origin-resource-policy": "same-site",
		},
	});
}
