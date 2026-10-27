import type { RawImage } from "./raw-image";

export const SCENE_W = 1248;
export const SCENE_H = 832;

export type Box = { x: number; y: number; w: number; h: number };

/** Pixel boxes of the five rectangles in the test scene. */
export const RECTS: Array<{ box: Box; rgb: [number, number, number] }> = [
	{ box: { x: 120, y: 100, w: 220, h: 180 }, rgb: [200, 40, 40] },
	{ box: { x: 520, y: 80, w: 260, h: 160 }, rgb: [40, 160, 60] },
	{ box: { x: 900, y: 140, w: 220, h: 220 }, rgb: [50, 70, 210] },
	{ box: { x: 200, y: 500, w: 300, h: 200 }, rgb: [230, 200, 40] },
	{ box: { x: 760, y: 520, w: 280, h: 180 }, rgb: [150, 60, 180] },
];

export function fillBox(
	image: RawImage,
	box: Box,
	rgb: [number, number, number],
): void {
	for (let y = box.y; y < box.y + box.h; y++) {
		for (let x = box.x; x < box.x + box.w; x++) {
			const o = (y * image.width + x) * 4;
			image.data[o] = rgb[0];
			image.data[o + 1] = rgb[1];
			image.data[o + 2] = rgb[2];
			image.data[o + 3] = 255;
		}
	}
}

/** A smooth gradient with five coloured rectangles; all opaque. */
export function makeScene(): RawImage {
	const data = new Uint8Array(SCENE_W * SCENE_H * 4);
	const image = { data, width: SCENE_W, height: SCENE_H };
	for (let y = 0; y < SCENE_H; y++) {
		for (let x = 0; x < SCENE_W; x++) {
			const o = (y * SCENE_W + x) * 4;
			data[o] = 20 + Math.round((x / SCENE_W) * 180);
			data[o + 1] = 20 + Math.round((y / SCENE_H) * 180);
			data[o + 2] = 120;
			data[o + 3] = 255;
		}
	}
	for (const rect of RECTS) fillBox(image, rect.box, rect.rgb);
	return image;
}

export function copyOf(image: RawImage): RawImage {
	return { ...image, data: new Uint8Array(image.data) };
}

/** result(p) = base(c + (p - c - d) / s): the content scaled about the centre, then moved. */
export function warp(
	base: RawImage,
	scale: number,
	dx: number,
	dy: number,
): RawImage {
	const out = new Uint8Array(base.data.length);
	const cx = base.width / 2;
	const cy = base.height / 2;
	for (let y = 0; y < base.height; y++) {
		for (let x = 0; x < base.width; x++) {
			const sx = Math.min(
				base.width - 1,
				Math.max(0, Math.round(cx + (x - cx - dx) / scale)),
			);
			const sy = Math.min(
				base.height - 1,
				Math.max(0, Math.round(cy + (y - cy - dy) / scale)),
			);
			const from = (sy * base.width + sx) * 4;
			out.set(base.data.subarray(from, from + 4), (y * base.width + x) * 4);
		}
	}
	return { data: out, width: base.width, height: base.height };
}
