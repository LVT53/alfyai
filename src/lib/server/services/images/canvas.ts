export type CanvasSize = { width: number; height: number };
export type PictureSize = "landscape" | "portrait" | "square" | "wide" | "tall";

const STEP = 32;
const MIN_SIDE = 256;
const MAX_SIDE = 2752;
const AREA = 1_048_576;
const PRINT_AREA = 4_194_304;

export const NEW_PICTURE_CANVAS: Record<PictureSize, CanvasSize> = {
	landscape: { width: 1248, height: 832 },
	portrait: { width: 832, height: 1248 },
	square: { width: 1056, height: 1056 },
	wide: { width: 1376, height: 768 },
	tall: { width: 768, height: 1376 },
};

export function canvasForNewPicture(
	size: PictureSize | undefined,
	print: boolean,
): CanvasSize {
	const base = NEW_PICTURE_CANVAS[size ?? "landscape"];
	return print
		? { width: base.width * 2, height: base.height * 2 }
		: { ...base };
}

function side(value: number): number {
	const snapped = Math.round(value / STEP) * STEP;
	return Math.min(MAX_SIDE, Math.max(MIN_SIDE, snapped));
}

/** Keeps the photo's shape at about 1 MP (about 4 MP for print), in multiples of 32. */
export function canvasForEdit(base: CanvasSize, print: boolean): CanvasSize {
	const area = print ? PRINT_AREA : AREA;
	const width = side(Math.sqrt((area * base.width) / base.height));
	const height = side(Math.sqrt((area * base.height) / base.width));
	// 1024x1024 is the size Qwen-Image-Edit treats as its own; stay off it.
	if (width === 1024 && height === 1024) return { width: 1056, height: 1056 };
	return { width, height };
}
