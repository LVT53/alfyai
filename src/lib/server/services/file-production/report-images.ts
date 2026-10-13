/**
 * The pictures of a rendered HTML report, inlined as self-contained `data:` URIs.
 *
 * A report names its pictures by address (`{ kind: "https", url }`), and the
 * HTML renderer used to write that address straight into an `<img>`. Two
 * things are wrong with that (ADR-0068):
 *
 *   - In the app, the report's preview is the one script-capable page, and its
 *     CSP allowed `img-src https: http:`, so under report-only (the production
 *     default) the renderer's escaping was the only gate on what a report
 *     fetched. Every other preview is held to `img-src data:`.
 *   - A rendered report is a STANDALONE file the reader opens outside the app,
 *     often from disk: a remote `<img>` makes their browser call every host
 *     the report shows a picture from, and tells it which report was read.
 *
 * So, exactly as `report-favicons.ts` does for the cited sites' icons, the
 * pictures are fetched HERE, on the server, and the renderer inlines the bytes:
 * the report keeps its pictures, opening it makes no outbound request, and the
 * preview's policy can be `img-src data:`. The fetch is the one the PDF
 * renderer already makes of the same pictures (`image-loader.ts`: the outbound
 * guard, public addresses only, a byte cap and a timeout), and the addresses
 * are the ones that passed `dropUnsourcedImages` before the request was stored.
 *
 * A picture that cannot be had (refused, unreachable, not a picture, too big)
 * is simply absent from the map, and the renderer draws the same placeholder
 * with the alt text that it draws for a picture it cannot carry. Nothing here
 * throws: a report never fails to render for want of a picture.
 */
import type { OutboundFetch } from "$lib/server/outbound";
import { loadGeneratedDocumentImage } from "./image-loader";
import type { GeneratedDocumentSource } from "./source-schema";

/** Picture address -> self-contained `data:` URI with that picture's bytes. */
export type ReportImages = ReadonlyMap<string, string>;

export const EMPTY_REPORT_IMAGES: ReportImages = new Map<string, string>();

/** A report inlines at most this many distinct pictures; the rest are placeholders. */
export const MAX_REPORT_IMAGES = 12;
/**
 * One picture's share of the file. Base64 inflates it by a third, and the
 * bytes ride in the HTML itself, so a report is not the place for a 25 MB
 * original (a 500 px copy is tens of kilobytes; a lead photo a few megabytes).
 */
export const MAX_REPORT_IMAGE_BYTES = 3 * 1024 * 1024;
/** All the pictures together, before inflation. */
export const MAX_REPORT_IMAGES_TOTAL_BYTES = 12 * 1024 * 1024;
/** In-flight fetches: a 12-picture report must not open 12 sockets at once. */
const CONCURRENCY = 4;

/** The distinct https pictures a report shows, in the order it shows them, up to the limit. */
export function collectReportImageUrls(
	source: GeneratedDocumentSource,
): string[] {
	const urls = new Set<string>();
	for (const block of source.blocks) {
		if (block.type === "image" && block.source.kind === "https") {
			urls.add(block.source.url);
			if (urls.size >= MAX_REPORT_IMAGES) break;
		}
	}
	return [...urls];
}

interface ResolveReportImagesOptions {
	/** A test's fetch. The default is the outbound one (public addresses only). */
	fetchImpl?: OutboundFetch;
}

export async function resolveReportImages(
	source: GeneratedDocumentSource,
	options: ResolveReportImagesOptions = {},
): Promise<ReportImages> {
	const urls = collectReportImageUrls(source);
	if (urls.length === 0) return EMPTY_REPORT_IMAGES;

	const resolved = new Map<string, string>();
	let totalBytes = 0;
	const queue = [...urls];
	const workers = Array.from(
		{ length: Math.min(CONCURRENCY, queue.length) },
		async () => {
			for (;;) {
				const url = queue.shift();
				if (url === undefined) return;
				// Once the report's share is spent, the rest are not asked for.
				if (totalBytes >= MAX_REPORT_IMAGES_TOTAL_BYTES) return;
				try {
					const result = await loadGeneratedDocumentImage(
						{ kind: "https", url },
						{
							maxImageBytes: MAX_REPORT_IMAGE_BYTES,
							fetchImpl: options.fetchImpl,
						},
					);
					if (!result.ok) continue;
					const { bytes, mimeType } = result.image;
					// Several can finish together: the total is judged as each one lands.
					if (totalBytes + bytes.byteLength > MAX_REPORT_IMAGES_TOTAL_BYTES) {
						continue;
					}
					totalBytes += bytes.byteLength;
					resolved.set(
						url,
						`data:${mimeType};base64,${bytes.toString("base64")}`,
					);
				} catch {
					// A picture that cannot be had is a placeholder, never a failed report.
				}
			}
		},
	);
	await Promise.all(workers);
	return resolved;
}
