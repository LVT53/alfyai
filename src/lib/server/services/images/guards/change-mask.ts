import { downscale, isEmptyImage, type RawImage, workSize } from "./raw-image";
import { GUARD } from "./thresholds";

type Plane = { data: Float32Array; width: number; height: number };

/** Largest channel difference, colour weighted by the less opaque of the two pixels. */
function differencePlane(before: RawImage, after: RawImage): Plane {
	const { width, height } = workSize(before, GUARD.workWidth);
	const a = downscale(before, width, height);
	const b = downscale(after, width, height);
	const data = new Float32Array(width * height);
	for (let i = 0; i < data.length; i++) {
		const o = i * 4;
		const alpha = Math.min(a.data[o + 3], b.data[o + 3]) / 255;
		const colour = Math.max(
			Math.abs(a.data[o] - b.data[o]),
			Math.abs(a.data[o + 1] - b.data[o + 1]),
			Math.abs(a.data[o + 2] - b.data[o + 2]),
		);
		// Edges that alignment exposed are transparent in `after`; that is not an edit.
		const filled = Math.max(0, b.data[o + 3] - a.data[o + 3]);
		data[i] = Math.max(filled, colour * alpha);
	}
	return { data, width, height };
}

/** Separable box filter of the given radius (edges use the pixels that exist). */
function boxBlur(plane: Plane, radius: number): Plane {
	if (radius <= 0) return plane;
	const { width, height } = plane;
	const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
		const out = new Float32Array(src.length);
		const length = horizontal ? width : height;
		const lines = horizontal ? height : width;
		for (let line = 0; line < lines; line++) {
			for (let i = 0; i < length; i++) {
				let sum = 0;
				let n = 0;
				for (
					let k = Math.max(0, i - radius);
					k <= Math.min(length - 1, i + radius);
					k++
				) {
					sum += horizontal ? src[line * width + k] : src[k * width + line];
					n++;
				}
				const value = sum / n;
				if (horizontal) out[line * width + i] = value;
				else out[i * width + line] = value;
			}
		}
		return out;
	};
	return { data: pass(pass(plane.data, true), false), width, height };
}

/** Square max (grow) or min (shrink) filter on a 0/1 plane. */
function morph(plane: Plane, radius: number, grow: boolean): Plane {
	if (radius <= 0) return plane;
	const { width, height } = plane;
	const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
		const out = new Float32Array(src.length);
		const length = horizontal ? width : height;
		const lines = horizontal ? height : width;
		for (let line = 0; line < lines; line++) {
			for (let i = 0; i < length; i++) {
				let value = grow ? 0 : 1;
				for (
					let k = Math.max(0, i - radius);
					k <= Math.min(length - 1, i + radius);
					k++
				) {
					const v = horizontal ? src[line * width + k] : src[k * width + line];
					value = grow ? Math.max(value, v) : Math.min(value, v);
				}
				if (horizontal) out[line * width + i] = value;
				else out[i * width + line] = value;
			}
		}
		return out;
	};
	return { data: pass(pass(plane.data, true), false), width, height };
}

/** Drops 4-connected blobs of 1s smaller than `minSize` pixels. */
function dropSmallBlobs(plane: Plane, minSize: number): Plane {
	const { width, height } = plane;
	const data = new Float32Array(plane.data);
	const seen = new Uint8Array(data.length);
	const stack = new Int32Array(data.length);
	for (let start = 0; start < data.length; start++) {
		if (data[start] === 0 || seen[start]) continue;
		const members: number[] = [];
		let top = 0;
		stack[top++] = start;
		seen[start] = 1;
		while (top > 0) {
			const at = stack[--top];
			members.push(at);
			const x = at % width;
			const y = (at - x) / width;
			const neighbours = [
				x > 0 ? at - 1 : -1,
				x < width - 1 ? at + 1 : -1,
				y > 0 ? at - width : -1,
				y < height - 1 ? at + width : -1,
			];
			for (const next of neighbours) {
				if (next >= 0 && data[next] !== 0 && !seen[next]) {
					seen[next] = 1;
					stack[top++] = next;
				}
			}
		}
		if (members.length < minSize) for (const m of members) data[m] = 0;
	}
	return { data, width, height };
}

/** Bilinear upscale of a plane to full size. */
function upscale(plane: Plane, width: number, height: number): Float32Array {
	const out = new Float32Array(width * height);
	const sx = plane.width / width;
	const sy = plane.height / height;
	for (let y = 0; y < height; y++) {
		const fy = Math.min(plane.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
		const y0 = Math.floor(fy);
		const y1 = Math.min(plane.height - 1, y0 + 1);
		const ty = fy - y0;
		for (let x = 0; x < width; x++) {
			const fx = Math.min(plane.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
			const x0 = Math.floor(fx);
			const x1 = Math.min(plane.width - 1, x0 + 1);
			const tx = fx - x0;
			const top =
				plane.data[y0 * plane.width + x0] * (1 - tx) +
				plane.data[y0 * plane.width + x1] * tx;
			const bottom =
				plane.data[y1 * plane.width + x0] * (1 - tx) +
				plane.data[y1 * plane.width + x1] * tx;
			out[y * width + x] = top * (1 - ty) + bottom * ty;
		}
	}
	return out;
}

/**
 * Where two same-sized pictures differ: a soft 0..1 mask at full size and its mean.
 * Measured at work resolution so a speck of noise never counts.
 */
export function changeMask(
	before: RawImage,
	after: RawImage,
): { mask: Float32Array; changedShare: number } {
	if (before.width !== after.width || before.height !== after.height) {
		throw new Error("changeMask needs two pictures of the same size");
	}
	if (isEmptyImage(before))
		return { mask: new Float32Array(0), changedShare: 0 };

	const diff = boxBlur(differencePlane(before, after), 1);
	const binary: Plane = {
		data: diff.data.map((v) => (v > GUARD.diffThreshold ? 1 : 0)),
		width: diff.width,
		height: diff.height,
	};
	const opened = morph(morph(binary, 1, false), 1, true);
	const kept = dropSmallBlobs(
		opened,
		Math.max(1, Math.ceil(GUARD.minComponentShare * opened.data.length)),
	);
	const short = Math.min(kept.width, kept.height);
	const grown = morph(
		kept,
		Math.max(1, Math.round(GUARD.dilateShare * short)),
		true,
	);
	const soft = boxBlur(
		grown,
		Math.max(1, Math.round(GUARD.featherShare * short)),
	);

	const mask = upscale(soft, before.width, before.height);
	let sum = 0;
	for (let i = 0; i < mask.length; i++) sum += mask[i];
	return { mask, changedShare: sum / mask.length };
}
