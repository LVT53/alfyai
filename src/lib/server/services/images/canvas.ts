import type { ImageModel } from "$lib/server/config-store";

export type CanvasSize = { width: number; height: number };
export type PictureSize = "landscape" | "portrait" | "square" | "wide" | "tall";

const STEP = 32;
const MIN_SIDE = 256;
const AREA = 1_048_576;
const PRINT_AREA = 4_194_304;
/**
 * The SHORT edge of the canvas MiniMax-H3-Image changes a picture on. ComfyUI's
 * `MiniMaxH3ImageConditioning` VAE-encodes the picture being edited with its
 * short edge clamped to 1024-2048 px, so a 2048 px canvas matches that reference
 * exactly. Measured on the box on 2026-11-18, sampling a 3:2 edit took 24.0 s at
 * 12 MP and 15.9 s here, and a square one 20.4 s and 10.0 s (34-51% faster); the
 * results are about 4-7.5 MP instead of 12 MP, which the owner accepted for the
 * speed. It is a speed choice, not a repair: 12 MP edits with the fresh seeds
 * the app always draws (`avoidSeeds`) are clean.
 */
const H3_EDIT_SHORT_EDGE = 2048;

/** Qwen's 1 MP canvases; print doubles each side to about 4 MP. */
export const NEW_PICTURE_CANVAS: Record<PictureSize, CanvasSize> = {
	landscape: { width: 1248, height: 832 },
	portrait: { width: 832, height: 1248 },
	square: { width: 1056, height: 1056 },
	wide: { width: 1376, height: 768 },
	tall: { width: 768, height: 1376 },
};

/**
 * MiniMax-H3-Image's own 12 MP canvases for a NEW picture (a change to a picture
 * is not made at 12 MP: see `H3_EDIT_SHORT_EDGE`). The model card puts the
 * effective range at about 4-20 MP with the best results near 16 MP, and 4 MP
 * (the first tier) rendered full-body people as wax: skin and hair only start
 * carrying real detail at this size. H3 has no print enlargement and no 8/16 MP
 * tier: a new picture renders at this size whatever `print` says.
 */
export const H3_NEW_PICTURE_CANVAS: Record<PictureSize, CanvasSize> = {
	landscape: { width: 4224, height: 2816 },
	portrait: { width: 2816, height: 4224 },
	square: { width: 3456, height: 3456 },
	wide: { width: 4608, height: 2592 },
	tall: { width: 2592, height: 4608 },
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
		// H3's request already is its 12 MP working size; `print` has no effect.
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
 * The canvas H3 changes a picture on: the base's shape with its SHORT edge at
 * `H3_EDIT_SHORT_EDGE`, whatever the base's own size (`prepareTakeInputs` scales
 * a smaller base up to it and a larger one down). A long side past the model's
 * limit brings both sides down together, so the shape is kept and the short edge
 * ends under 2048 (a 10:1 panorama lands at 6272x640). Each side is then snapped
 * to a multiple of 32 inside the floor and the limit.
 */
function canvasForH3Edit(base: CanvasSize): CanvasSize {
	const maxSide = MAX_SIDE_BY_MODEL.h3;
	const baseShort = Math.min(base.width, base.height);
	const baseLong = Math.max(base.width, base.height);
	let short = H3_EDIT_SHORT_EDGE;
	let long = (H3_EDIT_SHORT_EDGE * baseLong) / baseShort;
	if (long > maxSide) {
		short = (short * maxSide) / long;
		long = maxSide;
	}
	const snappedShort = side(short, maxSide);
	const snappedLong = side(long, maxSide);
	return base.width < base.height
		? { width: snappedShort, height: snappedLong }
		: { width: snappedLong, height: snappedShort };
}

/**
 * Keeps the photo's shape in multiples of 32: Qwen at about 1 MP (about 4 MP for
 * print), H3 with its short edge at 2048 px (`canvasForH3Edit`), where print
 * changes nothing.
 */
export function canvasForEdit(
	base: CanvasSize,
	print: boolean,
	model: ImageModel,
): CanvasSize {
	if (model === "h3") return canvasForH3Edit(base);
	const area = print ? PRINT_AREA : AREA;
	const maxSide = MAX_SIDE_BY_MODEL[model];
	const width = side(Math.sqrt((area * base.width) / base.height), maxSide);
	const height = side(Math.sqrt((area * base.height) / base.width), maxSide);
	// 1024x1024 is the size Qwen-Image-Edit treats as its own; stay off it.
	if (width === 1024 && height === 1024) {
		return { width: 1056, height: 1056 };
	}
	return { width, height };
}
