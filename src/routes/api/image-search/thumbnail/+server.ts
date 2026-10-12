import { requireApiUser } from "$lib/server/api/auth";
import { hasSourceThumbnail } from "$lib/server/services/url-provenance";
import { isBraveThumbnailUrl } from "$lib/shared/url-provenance";
import type { RequestHandler } from "./$types";

/**
 * Brave's 500 px thumbnail of an image_search picture, served from this origin
 * (docs/plans/exfil-channels).
 *
 * The chat used to put the picture's own address in an `<img>`, so a page the
 * model had read could make the browser call any host through a link the model
 * wrote. Now the browser asks here, and this route fetches only an address a
 * search returned to THIS user (the source ledger) and only on Brave's image
 * proxy, so a prompt-injected model cannot pick the address, and a forged Brave
 * address (the proxy fetches whatever it wraps) is not one a search returned.
 *
 * What it will not do, each a way a fetched file could turn on the reader:
 * follow a redirect, wait longer than a few seconds, hold more than 2 MB, or
 * pass on anything that is not a raster image (never SVG, which can carry
 * script). What it sends back is inert: typed, not sniffed, sandboxed, and kept
 * only in the asking browser. Anything refused is a bare 404.
 */

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 2 * 1024 * 1024;
const RASTER_TYPES: ReadonlySet<string> = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
]);

function notFound(): Response {
	return new Response(null, {
		status: 404,
		headers: { "cache-control": "no-store" },
	});
}

/** The body whole, or null when it is longer than `MAX_BYTES` (the stream is cut off there). */
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
			if (total > MAX_BYTES) {
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

	// The same address a search returned: the comparison ignores a fragment, and
	// a fragment is never sent, so none goes into the request.
	const target = new URL(requested);
	target.hash = "";
	let upstream: Response;
	try {
		upstream = await fetch(target.href, {
			headers: {
				accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
			},
			// A redirect is an address nobody listed: it fails the fetch.
			redirect: "error",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		// Not the error: it carries the address.
		return notFound();
	}

	const contentType = (upstream.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	const declaredLength = Number(upstream.headers.get("content-length"));
	if (
		!upstream.ok ||
		!upstream.body ||
		!RASTER_TYPES.has(contentType) ||
		(Number.isFinite(declaredLength) && declaredLength > MAX_BYTES)
	) {
		await upstream.body?.cancel().catch(() => {});
		return notFound();
	}

	const bytes = await readCapped(upstream.body);
	if (!bytes || bytes.byteLength === 0) return notFound();

	return new Response(bytes.buffer as ArrayBuffer, {
		status: 200,
		headers: {
			"content-type": contentType,
			"x-content-type-options": "nosniff",
			// Kept long, but only by the browser that asked: which pictures a user
			// may see depends on who they are.
			"cache-control": "private, max-age=86400",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "same-origin",
		},
	});
};
