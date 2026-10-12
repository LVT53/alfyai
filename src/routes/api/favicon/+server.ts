import { requireApiUser } from "$lib/server/api/auth";
import { validateFaviconDomain } from "$lib/server/favicon/domain";
import { fetchFavicon } from "$lib/server/favicon/fetch";
import { GLOBE_FALLBACK_SVG_BYTES } from "$lib/server/favicon/globe";
import { FaviconCache } from "$lib/server/favicon/lru";
import { hasSourceHost } from "$lib/server/services/url-provenance";
import type { RequestHandler } from "./$types";

/**
 * Same-origin favicon privacy proxy (ADR 0043, Slice 12), held to the source
 * rule of docs/plans/exfil-channels.
 *
 * Stops leaking every researched domain to Google's `s2/favicons`. Instead the
 * browser asks US for the icon; we fetch it server-side (source first, then a
 * DuckDuckGo fallback), cache it, and return the bytes. On any failure we
 * return a generic globe SVG so the `<img>` never breaks.
 *
 * The browser names the host, and the model writes the hosts the browser names
 * (a source chip, a tool row), so asking us is not enough: a prompt-injected
 * model could put private data in a host name and have this server call it. A
 * host is therefore fetched only when a tool returned it to THIS user (the
 * source ledger in `url-provenance`); anything else gets the globe, with no
 * outbound request and nothing remembered about the refusal. What the answer is
 * now depends on who asks, so a served icon is `private`.
 */

// 7 days. Bound the cache modestly; negative results share it too. Only a
// host the ledger vouched for is ever asked of it.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;

// Module-level cache survives across requests on a given server instance.
const cache = new FaviconCache({ maxSize: MAX_ENTRIES, ttlMs: TTL_MS });

// A fetched icon is kept long, but only in the asking browser.
const ICON_CACHE = "private, max-age=604800, immutable";
// The globe for a host whose icon could not be fetched (it might publish one later).
const GLOBE_CACHE = "private, max-age=300";
// The globe for a host that was refused: nothing is kept, so the host is served
// the moment a tool has returned it.
const REFUSED_CACHE = "no-store";

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const domain = validateFaviconDomain(event.url.searchParams.get("domain"));
	if (domain === null || !hasSourceHost(user.id, domain)) {
		return imageResponse(
			GLOBE_FALLBACK_SVG_BYTES,
			"image/svg+xml",
			REFUSED_CACHE,
		);
	}

	const result = await fetchFavicon(domain, { cache });
	if (result.kind === "image") {
		return imageResponse(result.bytes, result.contentType, ICON_CACHE);
	}
	return imageResponse(GLOBE_FALLBACK_SVG_BYTES, "image/svg+xml", GLOBE_CACHE);
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
