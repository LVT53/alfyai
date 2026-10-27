import type { CanvasSize } from "../canvas";
import {
	downscale,
	isEmptyImage,
	type RawImage,
	resizeRaw,
	workSize,
} from "./raw-image";
import { GUARD } from "./thresholds";

/**
 * How the result sits against the base: the result's content is the base scaled
 * by `scale` about the centre, then moved by (dx, dy) base pixels. Applying the
 * alignment undoes that.
 */
export type Alignment = { dx: number; dy: number; scale: number };

const IDENTITY: Alignment = { dx: 0, dy: 0, scale: 1 };

type Gradient = { data: Float32Array; width: number; height: number };

function gradientOf(image: RawImage): Gradient {
	const { width, height } = image;
	const grey = new Float32Array(width * height);
	for (let i = 0; i < grey.length; i++) {
		const o = i * 4;
		const luma =
			0.299 * image.data[o] +
			0.587 * image.data[o + 1] +
			0.114 * image.data[o + 2];
		grey[i] = (luma * image.data[o + 3]) / 255;
	}
	const at = (x: number, y: number) =>
		grey[
			Math.min(height - 1, Math.max(0, y)) * width +
				Math.min(width - 1, Math.max(0, x))
		];
	const data = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const gx =
				at(x + 1, y - 1) +
				2 * at(x + 1, y) +
				at(x + 1, y + 1) -
				at(x - 1, y - 1) -
				2 * at(x - 1, y) -
				at(x - 1, y + 1);
			const gy =
				at(x - 1, y + 1) +
				2 * at(x, y + 1) +
				at(x + 1, y + 1) -
				at(x - 1, y - 1) -
				2 * at(x, y - 1) -
				at(x + 1, y - 1);
			data[y * width + x] = Math.hypot(gx, gy);
		}
	}
	return { data, width, height };
}

function sample(g: Gradient, x: number, y: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const x1 = Math.min(g.width - 1, x0 + 1);
	const y1 = Math.min(g.height - 1, y0 + 1);
	const top =
		g.data[y0 * g.width + x0] * (1 - fx) + g.data[y0 * g.width + x1] * fx;
	const bottom =
		g.data[y1 * g.width + x0] * (1 - fx) + g.data[y1 * g.width + x1] * fx;
	return top * (1 - fy) + bottom * fy;
}

/** Mean absolute gradient difference over the central 80%; Infinity when too little overlaps. */
function score(
	base: Gradient,
	result: Gradient,
	scale: number,
	dx: number,
	dy: number,
	stride: number,
): number {
	const { width, height } = base;
	const cx = width / 2;
	const cy = height / 2;
	const x0 = Math.floor(width * 0.1);
	const x1 = Math.ceil(width * 0.9);
	const y0 = Math.floor(height * 0.1);
	const y1 = Math.ceil(height * 0.9);
	let sum = 0;
	let count = 0;
	let total = 0;
	for (let y = y0; y < y1; y += stride) {
		const py = cy + scale * (y - cy) + dy;
		for (let x = x0; x < x1; x += stride) {
			total++;
			const px = cx + scale * (x - cx) + dx;
			if (px < 0 || py < 0 || px > width - 1 || py > height - 1) continue;
			sum += Math.abs(base.data[y * width + x] - sample(result, px, py));
			count++;
		}
	}
	return count < total / 2 ? Number.POSITIVE_INFINITY : sum / count;
}

type Best = { scale: number; dx: number; dy: number; cost: number };

function search(
	base: Gradient,
	result: Gradient,
	scales: number[],
	shifts: { dx: number[]; dy: number[] },
	stride: number,
): Best {
	let best: Best = { scale: 1, dx: 0, dy: 0, cost: Number.POSITIVE_INFINITY };
	for (const scale of scales) {
		for (const dy of shifts.dy) {
			for (const dx of shifts.dx) {
				const cost = score(base, result, scale, dx, dy, stride);
				if (cost < best.cost) best = { scale, dx, dy, cost };
			}
		}
	}
	return best;
}

function range(from: number, to: number, step: number): number[] {
	const out: number[] = [];
	const n = Math.round((to - from) / step);
	for (let i = 0; i <= n; i++) out.push(from + i * step);
	return out;
}

/** Finds where the result sits against the base. Pure, synchronous; empty input is the identity. */
export function estimateAlignment(result: RawImage, base: RawImage): Alignment {
	if (isEmptyImage(result) || isEmptyImage(base)) return { ...IDENTITY };
	const coarseSize = workSize(base, GUARD.workWidth);
	const fineSize = workSize(base, GUARD.workWidth * 2);
	const g = (image: RawImage, size: { width: number; height: number }) =>
		gradientOf(downscale(image, size.width, size.height));

	const baseCoarse = g(base, coarseSize);
	const resultCoarse = g(result, coarseSize);
	const reach = Math.max(1, Math.round(GUARD.maxShiftShare * coarseSize.width));
	const coarse = search(
		baseCoarse,
		resultCoarse,
		range(GUARD.scaleMin, GUARD.scaleMax, GUARD.scaleStep),
		{ dx: range(-reach, reach, 1), dy: range(-reach, reach, 1) },
		2,
	);
	if (!Number.isFinite(coarse.cost)) return { ...IDENTITY };

	const up = fineSize.width / coarseSize.width;
	const baseFine = g(base, fineSize);
	const resultFine = g(result, fineSize);
	const cx = coarse.dx * up;
	const cy = coarse.dy * (fineSize.height / coarseSize.height);
	const fine = search(
		baseFine,
		resultFine,
		range(coarse.scale - 0.005, coarse.scale + 0.005, 0.0025),
		{ dx: range(cx - 2, cx + 2, 0.25), dy: range(cy - 2, cy + 2, 0.25) },
		2,
	);
	if (!Number.isFinite(fine.cost)) return { ...IDENTITY };
	return {
		dx: (fine.dx * base.width) / fineSize.width,
		dy: (fine.dy * base.height) / fineSize.height,
		scale: fine.scale,
	};
}

/** True when the alignment is too small to be worth resampling the result for. */
export function isNegligible(alignment: Alignment): boolean {
	return (
		Math.abs(alignment.dx) < 0.5 &&
		Math.abs(alignment.dy) < 0.5 &&
		Math.abs(alignment.scale - 1) < 0.002
	);
}

/** Puts the result onto the base's exact size, undoing the alignment; new edges are transparent. */
export async function applyAlignment(
	result: RawImage,
	base: CanvasSize,
	alignment: Alignment,
): Promise<RawImage> {
	const { width, height } = base;
	if (width <= 0 || height <= 0)
		return { data: new Uint8Array(0), width: 0, height: 0 };
	if (isEmptyImage(result)) {
		return { data: new Uint8Array(width * height * 4), width, height };
	}
	if (isNegligible(alignment)) return resizeRaw(result, width, height);

	const { scale } = alignment;
	const stretched = await resizeRaw(
		result,
		Math.max(1, Math.round(width / scale)),
		Math.max(1, Math.round(height / scale)),
	);
	// aligned(q) = stretched(q + o), with o taken in the stretched picture.
	const ox = Math.round((width / 2 + alignment.dx) / scale - width / 2);
	const oy = Math.round((height / 2 + alignment.dy) / scale - height / 2);
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = y + oy;
		if (sy < 0 || sy >= stretched.height) continue;
		for (let x = 0; x < width; x++) {
			const sx = x + ox;
			if (sx < 0 || sx >= stretched.width) continue;
			const from = (sy * stretched.width + sx) * 4;
			out.set(stretched.data.subarray(from, from + 4), (y * width + x) * 4);
		}
	}
	return { data: out, width, height };
}
