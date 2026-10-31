import { readFile } from "node:fs/promises";

/** Long enough to mark on (a box is a fraction of the picture); a phone's 12 MP photo as a PNG is not. */
const PREVIEW_MAX_LONG_EDGE = 2048;

type Convert = (
	filePath: string,
	mimeType: string | null,
) => Promise<Buffer | null>;

/**
 * Conversions run one at a time, since a HEIC decode holds the calling thread,
 * and a request for a photo already on its way shares that answer: one photo is
 * asked for by its tile, its marks chip and the marking screen at once.
 */
export function createHeifPreviewQueue(convert: Convert): Convert {
	const running = new Map<string, Promise<Buffer | null>>();
	let tail: Promise<unknown> = Promise.resolve();
	return (filePath, mimeType) => {
		const known = running.get(filePath);
		if (known) return known;
		const answer = tail
			.then(() => convert(filePath, mimeType))
			.finally(() => running.delete(filePath));
		running.set(filePath, answer);
		tail = answer.catch(() => undefined);
		return answer;
	};
}

/**
 * The PNG a preview hands over for a HEIC or HEIF photo, or null for a file that
 * cannot be converted. The converter loads only when such a photo is asked for.
 */
async function convertToPreviewPng(
	filePath: string,
	mimeType: string | null,
): Promise<Buffer | null> {
	try {
		const { decodeImageToPng } = await import(
			"$lib/server/services/vision/prepare-image"
		);
		const bytes = await readFile(filePath);
		const { png } = await decodeImageToPng(bytes, mimeType, {
			maxLongEdge: PREVIEW_MAX_LONG_EDGE,
		});
		return png;
	} catch (error) {
		console.warn("[PREVIEW] A HEIC photo could not be converted", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export const heifPreviewPng = createHeifPreviewQueue(convertToPreviewPng);
