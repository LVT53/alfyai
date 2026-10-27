import type { MarkBox } from "./guard-edit";
import { GUARD, MARK_CLAMP_GROW_SHARE } from "./thresholds";

/**
 * Where a marked edit may change the picture: the union of the mark boxes,
 * each grown by MARK_CLAMP_GROW_SHARE of the short side, with a soft edge that
 * ramps inwards over GUARD.featherShare of the short side. Pixels beyond the
 * grown boxes are exactly 0, so nothing outside them changes; pixels deeper
 * than the feather are exactly 1.
 */
export function marksClamp(
	width: number,
	height: number,
	marks: ReadonlyArray<MarkBox>,
): Float32Array {
	const clamp = new Float32Array(width * height);
	const short = Math.min(width, height);
	const grow = MARK_CLAMP_GROW_SHARE * short;
	const feather = Math.max(1, GUARD.featherShare * short);
	for (const mark of marks) {
		const x0 = mark.x * width - grow;
		const x1 = (mark.x + mark.w) * width + grow;
		const y0 = mark.y * height - grow;
		const y1 = (mark.y + mark.h) * height + grow;
		const fromX = Math.max(0, Math.floor(x0));
		const toX = Math.min(width, Math.ceil(x1));
		const fromY = Math.max(0, Math.floor(y0));
		const toY = Math.min(height, Math.ceil(y1));
		for (let y = fromY; y < toY; y++) {
			const vertical = Math.min(y + 0.5 - y0, y1 - (y + 0.5));
			for (let x = fromX; x < toX; x++) {
				const inward = Math.min(vertical, x + 0.5 - x0, x1 - (x + 0.5));
				const weight = Math.min(1, Math.max(0, inward / feather));
				const at = y * width + x;
				if (weight > clamp[at]) clamp[at] = weight;
			}
		}
	}
	return clamp;
}
