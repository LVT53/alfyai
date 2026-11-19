import {
	assessOutboundUrl,
	createOutboundFetch,
	type OutboundFetch,
} from "$lib/server/outbound";
import { imagePreviewTarget, sourceHostOf } from "$lib/shared/url-provenance";
import { getConfig } from "../config-store";
import { verifyUploadSignature } from "./knowledge/upload-signature";
import { parallelImageSearch } from "./parallel-search/client";

export interface ImageSearchResult {
	provider: "parallel";
	url: string;
	title: string;
	source: string;
	sourcePageUrl: string;
	thumbnail?: string;
	width?: number;
	height?: number;
}

export class ImageSearchNotConfiguredError extends Error {
	constructor() {
		super("PARALLEL_API_KEY is not configured");
		this.name = "ImageSearchNotConfiguredError";
	}
}

// A source page or original may be HTTP (link only). Apply the outbound
// host rules independently of its scheme; a preview verifies DNS at fetch time.
function publicImageResultHost(raw: string): string | null {
	const host = sourceHostOf(raw);
	return host && assessOutboundUrl(`https://${host}`).ok ? host : null;
}

export async function searchImages(
	input: Parameters<typeof parallelImageSearch>[0],
	signal: AbortSignal,
): Promise<ImageSearchResult[]> {
	const { parallelApiKey, parallelBaseUrl } = getConfig();
	if (!parallelApiKey.trim()) throw new ImageSearchNotConfiguredError();
	const items = await parallelImageSearch(input, {
		config: { parallelApiKey, parallelBaseUrl },
		fetch,
		signal,
	});
	const results: ImageSearchResult[] = [];
	for (const item of items) {
		const url = typeof item.image_url === "string" ? item.image_url.trim() : "";
		const sourcePageUrl =
			typeof item.source_page_url === "string"
				? item.source_page_url.trim()
				: "";
		const source = publicImageResultHost(sourcePageUrl);
		if (!source || !publicImageResultHost(url)) continue;
		results.push({
			provider: "parallel",
			url,
			sourcePageUrl,
			source,
			title: typeof item.title === "string" ? item.title : "",
			...(imagePreviewTarget(url) ? { thumbnail: url } : {}),
			...(typeof item.width === "number" && item.width > 0
				? { width: item.width }
				: {}),
			...(typeof item.height === "number" && item.height > 0
				? { height: item.height }
				: {}),
		});
	}
	return results;
}

const THUMBNAIL_FETCH_TIMEOUT_MS = 8_000;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const thumbnailFetch = createOutboundFetch(
	{},
	{ timeoutMs: THUMBNAIL_FETCH_TIMEOUT_MS, maxBytes: THUMBNAIL_MAX_BYTES },
);
const THUMBNAIL_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
] as const;

interface SearchThumbnail {
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

async function fetchThumbnailBytes(
	address: string,
	fetchImpl: OutboundFetch,
	signal?: AbortSignal,
): Promise<SearchThumbnail | null> {
	// A fragment is never sent, and none goes into the request.
	const target = new URL(address);
	target.hash = "";

	const deadline = AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS);
	let upstream: Response;
	try {
		upstream = await fetchImpl(target.href, {
			headers: {
				accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
			},
			// A redirect is an address nobody listed: it is never followed, and its
			// 3xx answer is not `ok`, so it fails below.
			redirect: "manual",
			signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
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

/** Decode untrusted publisher bytes into a small, single-frame raster preview. */
export async function fetchPublisherThumbnail(
	address: string,
	options: { fetch?: OutboundFetch; signal?: AbortSignal } = {},
): Promise<SearchThumbnail | null> {
	const target = imagePreviewTarget(address);
	if (options.signal?.aborted || !target || !assessOutboundUrl(target).ok)
		return null;
	const original = await fetchThumbnailBytes(
		target,
		options.fetch ?? thumbnailFetch,
		options.signal,
	);
	if (!original || options.signal?.aborted) return null;
	const extension = original.contentType.slice("image/".length);
	// Reject mislabeled markup before giving the publisher's bytes to a decoder.
	if (
		!verifyUploadSignature({
			fileName: `image.${extension}`,
			mimeType: original.contentType,
			head: Buffer.from(original.bytes.subarray(0, 16)),
		}).ok
	)
		return null;
	try {
		const { default: sharp } = await import("sharp");
		const input = sharp(original.bytes, {
			animated: false,
			limitInputPixels: 24_000_000,
		});
		const { format } = await input.metadata();
		const declaredFormat =
			original.contentType === "image/avif" ? "heif" : extension;
		if (format !== declaredFormat) return null;
		const bytes = await input
			.autoOrient()
			.resize({
				width: 500,
				height: 500,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp()
			.timeout({ seconds: 3 })
			.toBuffer();
		return options.signal?.aborted
			? null
			: { bytes, contentType: "image/webp" };
	} catch {
		return null;
	}
}
