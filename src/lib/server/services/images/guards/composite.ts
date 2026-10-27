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
