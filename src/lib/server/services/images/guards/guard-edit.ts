import { applyAlignment, estimateAlignment, isNegligible } from "./align";
import { changeMask } from "./change-mask";
import { compositeOnto } from "./composite";
import { isEmptyImage, type RawImage } from "./raw-image";
import { GUARD, MARK_GROW_SHARE } from "./thresholds";

export type MarkBox = { x: number; y: number; w: number; h: number };

export type GuardMeasures = {
	dx: number;
	dy: number;
	scale: number;
	changedShare: number;
	insideMarksShare: number | null;
	global: boolean;
	reanchored: boolean;
	miss: "nothing_changed" | "outside_marks" | null;
};

export type GuardParams = {
	base: RawImage;
	anchor: RawImage | null;
	chainSinceAnchor: number;
	result: RawImage;
	marks: ReadonlyArray<MarkBox> | null;
};

export type GuardOutcome = {
	picture: RawImage;
	measures: GuardMeasures;
	chainSinceAnchor: number;
	anchorIsResult: boolean;
};

function sameSize(a: RawImage, b: RawImage): boolean {
	return a.width === b.width && a.height === b.height;
}

/** Share of the mask's weight that lies inside the marks, each grown by 5% of the short side. */
export function insideMarksShare(
	mask: Float32Array,
	width: number,
	height: number,
	marks: ReadonlyArray<MarkBox>,
): number | null {
	if (marks.length === 0 || mask.length === 0) return null;
	const grow = MARK_GROW_SHARE * Math.min(width, height);
	const inside = new Uint8Array(mask.length);
	for (const mark of marks) {
		const x0 = Math.max(0, Math.floor(mark.x * width - grow));
		const x1 = Math.min(width, Math.ceil((mark.x + mark.w) * width + grow));
		const y0 = Math.max(0, Math.floor(mark.y * height - grow));
		const y1 = Math.min(height, Math.ceil((mark.y + mark.h) * height + grow));
		for (let y = y0; y < y1; y++)
			inside.fill(1, y * width + x0, y * width + x1);
	}
	let total = 0;
	let within = 0;
	for (let i = 0; i < mask.length; i++) {
		total += mask[i];
		if (inside[i]) within += mask[i];
	}
	return total > 0 ? within / total : null;
}

/**
 * Nothing is pasted where the picture underneath is fully transparent, nor
 * where the top is (an edge the alignment exposed); returns the new mean.
 */
function keepTransparent(
	found: { mask: Float32Array; changedShare: number },
	under: RawImage,
	top: RawImage,
): { mask: Float32Array; changedShare: number } {
	const { mask } = found;
	let sum = 0;
	for (let i = 0; i < mask.length; i++) {
		if (under.data[i * 4 + 3] === 0 || top.data[i * 4 + 3] === 0) mask[i] = 0;
		sum += mask[i];
	}
	return { mask, changedShare: mask.length > 0 ? sum / mask.length : 0 };
}

function missOf(
	changedShare: number,
	inside: number | null,
): GuardMeasures["miss"] {
	if (changedShare < GUARD.nothingChangedShare) return "nothing_changed";
	if (inside !== null && inside < GUARD.marksMissShare) return "outside_marks";
	return null;
}

/**
 * Keeps the room in place: aligns the result to the base, then pastes back only
 * what changed. A whole repaint is kept whole. Every `reanchorEvery`th change
 * pastes onto the anchor instead of the base so drift cannot pile up.
 */
export async function guardEdit(params: GuardParams): Promise<GuardOutcome> {
	const { base, anchor, result, marks } = params;
	if (isEmptyImage(base))
		throw new Error("guardEdit needs a base picture with pixels");

	const alignment = await estimateAlignment(result, base);
	const applied = isNegligible(alignment)
		? { dx: 0, dy: 0, scale: 1 }
		: alignment;
	const aligned = await applyAlignment(result, base, applied);

	const against = keepTransparent(changeMask(base, aligned), base, aligned);
	const measures: GuardMeasures = {
		...applied,
		changedShare: against.changedShare,
		insideMarksShare: marks
			? insideMarksShare(against.mask, base.width, base.height, marks)
			: null,
		global: false,
		reanchored: false,
		miss: null,
	};

	if (against.changedShare > GUARD.globalChangeShare) {
		return {
			picture: aligned,
			measures: { ...measures, global: true },
			chainSinceAnchor: 0,
			anchorIsResult: true,
		};
	}
	measures.miss = missOf(against.changedShare, measures.insideMarksShare);

	const reanchor =
		params.chainSinceAnchor + 1 >= GUARD.reanchorEvery &&
		anchor !== null &&
		sameSize(anchor, base);
	if (reanchor) {
		const mask = keepTransparent(
			changeMask(anchor, aligned),
			anchor,
			aligned,
		).mask;
		return {
			picture: compositeOnto(anchor, aligned, mask),
			measures: { ...measures, reanchored: true },
			chainSinceAnchor: 0,
			anchorIsResult: false,
		};
	}
	return {
		picture: compositeOnto(base, aligned, against.mask),
		measures,
		chainSinceAnchor: params.chainSinceAnchor + 1,
		anchorIsResult: false,
	};
}
