import { requireApiUser } from "$lib/server/api/auth";
import { fetchBraveThumbnail } from "$lib/server/services/image-search";
import { hasSourceThumbnail } from "$lib/server/services/url-provenance";
import { isBraveThumbnailUrl } from "$lib/shared/url-provenance";
import type { RequestHandler } from "./$types";

/**
 * Brave's 500 px thumbnail of an image_search picture, served from this origin
 * (docs/plans/exfil-channels).
 *
 * The chat used to put the picture's own address in an `<img>`, so a page the
 * model had read could make the browser call any host through a link the model
 * wrote. Now the browser asks here, and this route serves only an address a
 * search returned to THIS user (the source ledger) and only on Brave's image
 * proxy, so a prompt-injected model cannot pick the address, and a forged Brave
 * address (the proxy fetches whatever it wraps) is not one a search returned.
 * The fetch and its limits (no redirect, 8 s, 2 MB, raster images only, never
 * SVG) are `fetchBraveThumbnail`'s. What this sends back is inert: typed, not
 * sniffed, sandboxed, and kept only in the asking browser. Anything refused is a
 * bare 404.
 */

function notFound(): Response {
	return new Response(null, {
		status: 404,
		headers: { "cache-control": "no-store" },
	});
}

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const requested = event.url.searchParams.get("url");
	if (
		requested === null ||
		!isBraveThumbnailUrl(requested) ||
		!hasSourceThumbnail(user.id, requested)
	) {
		return notFound();
	}

	const thumbnail = await fetchBraveThumbnail(requested);
	if (!thumbnail) return notFound();

	return new Response(thumbnail.bytes.buffer as ArrayBuffer, {
		status: 200,
		headers: {
			"content-type": thumbnail.contentType,
			"x-content-type-options": "nosniff",
			// Kept long, but only by the browser that asked: which pictures a user
			// may see depends on who they are.
			"cache-control": "private, max-age=86400",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "same-origin",
		},
	});
};
