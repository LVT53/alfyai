import convertHeic from "heic-convert";
import sharp from "sharp";
import { getEntryByMimeType } from "$lib/shared/file-types";

/** Long side of an attachment sent as pixels: about 1,600 tokens. */
export const ATTACHMENT_MAX_LONG_EDGE = 1600;
/** Long side of an Immich thumbnail sent as pixels: about 250 tokens. */
export const THUMBNAIL_MAX_LONG_EDGE = 512;

/** The model server spends one token on each 32 px by 32 px tile of an image. */
const TOKEN_TILE_PX = 32;
const JPEG_QUALITY = 85;
/** Where a transparent picture ends up: the page behind it is white. */
const FLATTEN_BACKGROUND = "#ffffff";
/** Only a hop: sharp encodes the result again, after resizing, at JPEG_QUALITY. */
const HEIF_HOP_QUALITY = 0.92;
/** The `ftyp` box starts at byte 4 and its major brand ends at byte 12. */
const HEIF_BRAND_START = 4;
const HEIF_BRAND_END = 12;
const HEIF_BRANDS: ReadonlySet<string> = new Set([
	"ftypheic",
	"ftypheix",
	"ftypmif1",
]);

export type PreparedImage = {
	base64: string;
	mediaType: "image/jpeg";
	width: number;
	height: number;
	estimatedTokens: number;
};

/** The bytes could not be turned into a picture the model can be sent. */
export class ImagePreparationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ImagePreparationError";
	}
}

/**
 * An uploaded picture as a PNG for the picture server: upright (EXIF
 * orientation applied), first frame only, transparency kept. HEIC and HEIF take
 * the same hop through heic-convert as `prepareImageForModel`. Bytes it cannot
 * read throw `ImagePreparationError`.
 */
export async function decodeImageToPng(
	input: Uint8Array,
	mimeType: string | null,
): Promise<{
	png: Buffer;
	width: number;
	height: number;
	hasAlpha: boolean;
}> {
	try {
		const source = isHeif(input, mimeType)
			? await convertHeic({
					buffer: input,
					format: "JPEG",
					quality: HEIF_HOP_QUALITY,
				})
			: input;
		const { data, info } = await sharp(source, { animated: false })
			.rotate()
			.png()
			.toBuffer({ resolveWithObject: true });
		return {
			png: data,
			width: info.width,
			height: info.height,
			hasAlpha: info.channels === 4,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ImagePreparationError(`image preparation failed: ${reason}`, {
			cause: error,
		});
	}
}

/** Tokens the model server charges for an image of this size. */
export function estimateImageTokens(width: number, height: number): number {
	return Math.ceil(width / TOKEN_TILE_PX) * Math.ceil(height / TOKEN_TILE_PX);
}

function isHeif(input: Uint8Array, mimeType: string | null): boolean {
	const declared = getEntryByMimeType(mimeType)?.id;
	if (declared === "heic" || declared === "heif") return true;
	const brand = String.fromCharCode(
		...input.subarray(HEIF_BRAND_START, HEIF_BRAND_END),
	);
	return HEIF_BRANDS.has(brand);
}

/**
 * Turns an uploaded image into one JPEG for a model: upright (EXIF orientation
 * applied), flat (no transparency, only the first frame of an animation) and
 * no longer than `maxLongEdge` on its long side. A small image is not
 * enlarged. Bytes it cannot read throw `ImagePreparationError`, and a caller
 * sends no pixels for that image. A BMP is one of them: sharp's prebuilt
 * libvips has no BMP loader.
 *
 * That libvips cannot decode HEVC either, so a HEIC or HEIF (found by its MIME
 * type or by the brand in its first bytes) takes a hop through heic-convert
 * first. That hop decodes in WebAssembly on the calling thread: about 0.8 s
 * for a 12 MP phone photo on an Apple-silicon Mac, against about 50 ms for
 * sharp. sharp keeps its strict defaults on purpose, because these bytes are an
 * upload: it fails on a damaged file and on one over 268 megapixels.
 */
export async function prepareImageForModel(
	input: Uint8Array,
	mimeType: string | null,
	options: { maxLongEdge: number },
): Promise<PreparedImage> {
	try {
		const source = isHeif(input, mimeType)
			? await convertHeic({
					buffer: input,
					format: "JPEG",
					quality: HEIF_HOP_QUALITY,
				})
			: input;
		const { data, info } = await sharp(source, { animated: false })
			.rotate()
			.flatten({ background: FLATTEN_BACKGROUND })
			.resize({
				width: options.maxLongEdge,
				height: options.maxLongEdge,
				fit: "inside",
				withoutEnlargement: true,
			})
			.jpeg({ quality: JPEG_QUALITY })
			.toBuffer({ resolveWithObject: true });
		return {
			base64: data.toString("base64"),
			mediaType: "image/jpeg",
			width: info.width,
			height: info.height,
			estimatedTokens: estimateImageTokens(info.width, info.height),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ImagePreparationError(`image preparation failed: ${reason}`, {
			cause: error,
		});
	}
}
