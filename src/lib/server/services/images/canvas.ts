import type { ImageModel } from "$lib/server/config-store";

export type CanvasSize = { width: number; height: number };
export type PictureSize = "landscape" | "portrait" | "square" | "wide" | "tall";

const STEP = 32;
const MIN_SIDE = 256;
const AREA = 1_048_576;
const PRINT_AREA = 4_194_304;

/** Qwen's 1 MP canvases; print doubles each side to about 4 MP. */
export const NEW_PICTURE_CANVAS: Record<PictureSize, CanvasSize> = {
	landscape: { width: 1248, height: 832 },
	portrait: { width: 832, height: 1248 },
	square: { width: 1056, height: 1056 },
	wide: { width: 1376, height: 768 },
	tall: { width: 768, height: 1376 },
};

/**
 * MiniMax-H3-Image's own 4 MP canvases. H3 is 4 MP only: there is no print
 * enlargement and no 8/16 MP tier.
 */
export const H3_NEW_PICTURE_CANVAS: Record<PictureSize, CanvasSize> = {
	landscape: { width: 2496, height: 1664 },
	portrait: { width: 1664, height: 2496 },
	square: { width: 2048, height: 2048 },
	wide: { width: 2720, height: 1536 },
	tall: { width: 1536, height: 2720 },
};

/** The longest side each model's server is allowed to be asked for. */
export const MAX_SIDE_BY_MODEL: Record<ImageModel, number> = {
	qwen: 2752,
	h3: 6272,
};

export function canvasForNewPicture(
	size: PictureSize | undefined,
	print: boolean,
	model: ImageModel,
): CanvasSize {
	if (model === "h3") {
		// H3's request already is 4 MP; `print` has no effect.
		return { ...H3_NEW_PICTURE_CANVAS[size ?? "landscape"] };
	}
	const base = NEW_PICTURE_CANVAS[size ?? "landscape"];
	return print
		? { width: base.width * 2, height: base.height * 2 }
		: { ...base };
}

function side(value: number, maxSide: number): number {
	const snapped = Math.round(value / STEP) * STEP;
	return Math.min(maxSide, Math.max(MIN_SIDE, snapped));
}

/**
 * Keeps the photo's shape in multiples of 32: Qwen at about 1 MP (about 4 MP for
 * print), H3 at 4 MP where print changes nothing.
 */
export function canvasForEdit(
	base: CanvasSize,
	print: boolean,
	model: ImageModel,
): CanvasSize {
	const area = model === "h3" || print ? PRINT_AREA : AREA;
	const maxSide = MAX_SIDE_BY_MODEL[model];
	const width = side(Math.sqrt((area * base.width) / base.height), maxSide);
	const height = side(Math.sqrt((area * base.height) / base.width), maxSide);
	// 1024x1024 is the size Qwen-Image-Edit treats as its own; stay off it. H3 has
	// no such special size.
	if (model === "qwen" && width === 1024 && height === 1024) {
		return { width: 1056, height: 1056 };
	}
	return { width, height };
}
