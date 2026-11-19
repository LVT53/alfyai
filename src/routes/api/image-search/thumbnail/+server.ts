import { requireApiUser } from "$lib/server/api/auth";
import {
	fetchBraveThumbnail,
	fetchPublisherThumbnail,
} from "$lib/server/services/image-search";
import { hasSourceThumbnail } from "$lib/server/services/url-provenance";
import { isBraveThumbnailUrl } from "$lib/shared/url-provenance";
import type { RequestHandler } from "./$types";

/**
 * Serve only exact image-search previews recorded for the signed-in user.
 * Publisher originals are fetched through the public-address guard and resized
 * to inert raster thumbnails. Old Brave results retain their hosted preview.
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
	if (requested === null || !hasSourceThumbnail(user.id, requested)) {
		return notFound();
	}

	let thumbnail: Awaited<ReturnType<typeof fetchBraveThumbnail>>;
	try {
		thumbnail = isBraveThumbnailUrl(requested)
			? await fetchBraveThumbnail(requested)
			: await fetchPublisherThumbnail(requested);
	} catch {
		// It does not throw; if it ever does, not the error: it carries the address.
		return notFound();
	}
	if (!thumbnail) return notFound();

	return new Response(new Uint8Array(thumbnail.bytes), {
		status: 200,
		headers: {
			"content-type": thumbnail.contentType,
			"x-content-type-options": "nosniff",
			// Kept long, but only by the browser that asked: which pictures a user
			// may see depends on who they are.
			"cache-control": "private, max-age=86400",
			vary: "Cookie",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "same-origin",
		},
	});
};
