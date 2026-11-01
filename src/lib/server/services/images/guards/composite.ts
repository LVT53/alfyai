import type { RawImage } from "./raw-image";

/** Top over base by the mask: 0 keeps the base's bytes, 1 takes the top's, between blends. */
export function compositeOnto(
	base: RawImage,
	top: RawImage,
	mask: Float32Array,
): RawImage {
	if (base.width !== top.width || base.height !== top.height) {
		throw new Error("compositeOnto needs two pictures of the same size");
	}
	const pixels = base.width * base.height;
	if (mask.length !== pixels)
		throw new Error("compositeOnto: mask does not fit the picture");
	const out = new Uint8Array(base.data);
	for (let i = 0; i < pixels; i++) {
		const m = mask[i];
		if (m <= 0) continue;
		const o = i * 4;
		const keepAlpha = base.data[o + 3] === 255;
		if (m >= 1) {
			for (let c = 0; c < 4; c++) out[o + c] = top.data[o + c];
		} else {
			for (let c = 0; c < 4; c++) {
				out[o + c] = Math.round(
					base.data[o + c] * (1 - m) + top.data[o + c] * m,
				);
			}
		}
		// An opaque base stays opaque: a pasted pixel never makes a hole.
		if (keepAlpha) out[o + 3] = 255;
	}
	return { data: out, width: base.width, height: base.height };
}

/**
 * The top laid over the base ("over"): where the top is see-through the base
 * shows through, so an edge that alignment exposed (alpha 0) takes the base's
 * own pixels, which are the right content there. Where the base is see-through
 * too, so is the result: transparency the base really has is never filled.
 */
export function overBase(base: RawImage, top: RawImage): RawImage {
	if (base.width !== top.width || base.height !== top.height) {
		throw new Error("overBase needs two pictures of the same size");
	}
	const out = new Uint8Array(top.data);
	for (let o = 0; o < out.length; o += 4) {
		const topAlpha = top.data[o + 3];
		const baseAlpha = base.data[o + 3];
		if (topAlpha === 255 || baseAlpha === 0) continue;
		const t = topAlpha / 255;
		const b = (baseAlpha / 255) * (1 - t);
		const alpha = t + b;
		for (let c = 0; c < 3; c++) {
			out[o + c] = Math.round(
				(top.data[o + c] * t + base.data[o + c] * b) / alpha,
			);
		}
		out[o + 3] = Math.round(alpha * 255);
	}
	return { data: out, width: top.width, height: top.height };
}
