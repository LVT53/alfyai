import sharp from "sharp";
import { getEntryByMimeType } from "$lib/shared/file-types";
import { decodeHeifToRgba } from "./heif-decode";
import {
	ImageDecodeTimeoutError,
	ImagePreparationError,
	ImageTooLargeError,
} from "./image-errors";

// Callers have always imported the error from here.
export { ImagePreparationError };

/** Long side of an attachment sent as pixels: about 1,600 tokens. */
export const ATTACHMENT_MAX_LONG_EDGE = 1600;
/** Long side of an Immich thumbnail sent as pixels: about 250 tokens. */
export const THUMBNAIL_MAX_LONG_EDGE = 512;

/** The model server spends one token on each 32 px by 32 px tile of an image. */
const TOKEN_TILE_PX = 32;
const JPEG_QUALITY = 85;
/** Where a transparent picture ends up: the page behind it is white. */
const FLATTEN_BACKGROUND = "#ffffff";
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

/**
 * An uploaded picture as a PNG for the picture server: upright (EXIF
 * orientation applied), first frame only, transparency kept. A HEIC or HEIF is
 * decoded by libheif in a worker thread first (see `prepareImageForModel`) and
 * keeps the alpha channel libheif gives it, which is fully opaque for most
 * photos. Bytes it cannot read throw `ImagePreparationError`; a photo over
 * `HEIF_MAX_PIXELS` throws its subclass `ImageTooLargeError` and a decode that
 * ran out of time `ImageDecodeTimeoutError`, as they are. `maxLongEdge` shrinks
 * it to fit, and never enlarges.
 */
export async function decodeImageToPng(
	input: Uint8Array,
	mimeType: string | null,
	options: { maxLongEdge?: number } = {},
): Promise<{
	png: Buffer;
	width: number;
	height: number;
	hasAlpha: boolean;
}> {
	try {
		const upright = (await openForSharp(input, mimeType)).rotate();
		const fitted = options.maxLongEdge
			? upright.resize({
					width: options.maxLongEdge,
					height: options.maxLongEdge,
					fit: "inside",
					withoutEnlargement: true,
				})
			: upright;
		const { data, info } = await fitted
			.png()
			.toBuffer({ resolveWithObject: true });
		return {
			png: data,
			width: info.width,
			height: info.height,
			hasAlpha: info.channels === 4,
		};
	} catch (error) {
		throw preparationFailure(error);
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
 * What sharp reads the upload from. libvips cannot decode HEVC, so a HEIC or HEIF
 * is decoded to RGBA pixels first, in a worker thread (heif-decode.ts: two at a
 * time for the whole process, a size cap and a timeout), and sharp is handed the
 * pixels. Anything else is handed the bytes themselves.
 */
async function openForSharp(
	input: Uint8Array,
	mimeType: string | null,
): Promise<ReturnType<typeof sharp>> {
	if (!isHeif(input, mimeType)) return sharp(input, { animated: false });
	const { width, height, data } = await decodeHeifToRgba(input);
	return sharp(data, { raw: { width, height, channels: 4 } });
}

/**
 * The error a failed preparation throws. The two a caller tells apart by class,
 * a photo over the pixel limit and a decode that ran out of time, go on as they
 * are. Anything else is wrapped as `image preparation failed: <reason>` with
 * itself as the cause: the image library's errors, and libheif's refusals.
 */
function preparationFailure(error: unknown): ImagePreparationError {
	if (
		error instanceof ImageTooLargeError ||
		error instanceof ImageDecodeTimeoutError
	) {
		return error;
	}
	const reason = error instanceof Error ? error.message : String(error);
	return new ImagePreparationError(`image preparation failed: ${reason}`, {
		cause: error,
	});
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
 * type or by the brand in its first bytes) is decoded by libheif in a worker
 * thread first (`decodeHeifToRgba`), and sharp reads the pixels it gives: the
 * main thread is never held by the decode (it was, for 1.2 to 1.8 s for a 12 MP
 * photo and about 6 s for a 48 MP one, when libheif ran on the calling thread),
 * and no JPEG step stands in between. A photo over `HEIF_MAX_PIXELS` throws
 * `ImageTooLargeError` and a decode that ran out of time
 * `ImageDecodeTimeoutError`, both `ImagePreparationError`s, as they are; a photo
 * libheif refuses is a plain one. A
 * transparent HEIC, like any transparent picture, ends up on white. sharp keeps
 * its strict defaults on purpose, because these bytes are an upload: it fails
 * on a damaged file and on one over 268 megapixels.
 */
export async function prepareImageForModel(
	input: Uint8Array,
	mimeType: string | null,
	options: { maxLongEdge: number },
): Promise<PreparedImage> {
	try {
		const { data, info } = await (await openForSharp(input, mimeType))
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
		throw preparationFailure(error);
	}
}
