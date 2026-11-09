import { applyAlignment, estimateAlignment, isNegligible } from "./align";
import { boxChangedShare, changeMask } from "./change-mask";
import { compositeOnto, overBase } from "./composite";
import { marksClamp } from "./marks-clamp";
import { isEmptyImage, type RawImage, resizeRaw } from "./raw-image";
import { GUARD, MARK_GROW_SHARE } from "./thresholds";

export type MarkBox = { x: number; y: number; w: number; h: number };

export type GuardMeasures = {
	/**
	 * Where the result sat against the base: its content is the base scaled by
	 * `scale` about the centre, then moved by (dx, dy) base pixels. A pasted
	 * result has this undone; a whole repaint is only measured and kept as drawn.
	 */
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
	/** The paste mask used (0..1, picture size); all 1 for a whole repaint. */
	mask: Float32Array;
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
 * where the top is (an edge the alignment exposed), nor where the top is
 * clearly translucent over an opaque base (a fractional-shift rim); returns the new mean.
 */
function keepTransparent(
	found: { mask: Float32Array; changedShare: number },
	under: RawImage,
	top: RawImage,
): { mask: Float32Array; changedShare: number } {
	const { mask } = found;
	let sum = 0;
	for (let i = 0; i < mask.length; i++) {
		const underAlpha = under.data[i * 4 + 3];
		const topAlpha = top.data[i * 4 + 3];
		if (
			underAlpha === 0 ||
			topAlpha === 0 ||
			(underAlpha === 255 && topAlpha < GUARD.pasteMinAlpha)
		)
			mask[i] = 0;
		sum += mask[i];
	}
	return { mask, changedShare: mask.length > 0 ? sum / mask.length : 0 };
}

function missOf(
	changedShare: number,
	inside: number | null,
	allMarksChanged: boolean,
): GuardMeasures["miss"] {
	if (allMarksChanged) return null;
	if (changedShare < GUARD.nothingChangedShare) return "nothing_changed";
	if (inside !== null) return "outside_marks";
	return null;
}

/**
 * Keeps the room in place: aligns the result to the base, then pastes back only
 * what changed. An unmarked whole repaint is kept whole, as the model drew it:
 * it is measured aligned but not stored aligned, because nothing is pasted and
 * undoing its reframe leaves a strip of the base along an edge. A marked one is
 * not kept whole (it is measured and pasted back inside the marks, `global`
 * reported). Every `reanchorEvery`th change pastes onto the anchor instead of
 * the base so drift cannot pile up.
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
	// What is measured is `aligned`, exposed edges and all (they are not edits);
	// what is pasted is `painted`, the same result with the base showing wherever
	// it is see-through, so an exposed strip takes the base's own pixels. (A whole
	// repaint is not pasted: it is kept as drawn, below.)
	const painted = overBase(base, aligned);

	let against = keepTransparent(changeMask(base, aligned), base, aligned);
	let componentShare: number = GUARD.minComponentShare;
	if (against.changedShare < GUARD.nothingChangedShare) {
		// Nothing big changed: look again for something small before calling the
		// edit a miss, or a small removal is pasted away as noise.
		const fine = keepTransparent(
			changeMask(base, aligned, GUARD.fineComponentShare),
			base,
			aligned,
		);
		if (fine.changedShare > 0) {
			against = fine;
			componentShare = GUARD.fineComponentShare;
		}
	}
	const marked = Boolean(marks && marks.length > 0);
	const boxesChanged = (marks ?? []).map(
		(mark) =>
			boxChangedShare(base, painted, mark) >= GUARD.markedBoxChangedShare,
	);
	// A marked edit changes the picture only where the person marked (grown a
	// little, feathered): the measures below see the model's whole change, but
	// only the boxes decide a miss, and nothing beyond them is pasted.
	const clamp =
		marks && marks.length > 0
			? marksClamp(base.width, base.height, marks)
			: null;
	// The person chose this area: what the model made in it is kept whole, not
	// only the blobs big enough to survive the change mask. Transparency still
	// holds: a filled-in background is not what a box asked for.
	const limit = (mask: Float32Array, under: RawImage): Float32Array => {
		if (!clamp) return mask;
		if (boxesChanged.includes(true)) {
			return keepTransparent(
				{ mask: clamp.slice(), changedShare: 0 },
				under,
				aligned,
			).mask;
		}
		const limited = new Float32Array(mask.length);
		for (let i = 0; i < mask.length; i++) limited[i] = mask[i] * clamp[i];
		return limited;
	};
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
		if (!clamp) {
			// The model's own picture, at the base's size, over the base only where it
			// is itself see-through (an opaque base stays opaque). Not aligned: it is
			// not pasted onto the base, and undoing a reframe of up to 6% (what
			// production stored) filled an edge strip with the base's pixels.
			const drawn = overBase(
				base,
				await resizeRaw(result, base.width, base.height),
			);
			return {
				picture: drawn,
				mask: new Float32Array(aligned.width * aligned.height).fill(1),
				measures: { ...measures, global: true },
				chainSinceAnchor: 0,
				anchorIsResult: true,
			};
		}
		// A marked repaint is not kept whole: it goes the normal marked way below
		// (miss measured, paste limited to the marks, transparency kept), with
		// `global` still reported.
		measures.global = true;
	}
	measures.miss = marked
		? missOf(
				against.changedShare,
				measures.insideMarksShare,
				!boxesChanged.includes(false),
			)
		: componentShare < GUARD.minComponentShare
			? null
			: missOf(against.changedShare, null, false);

	const reanchor =
		params.chainSinceAnchor + 1 >= GUARD.reanchorEvery &&
		anchor !== null &&
		sameSize(anchor, base);
	if (reanchor) {
		const mask = limit(
			keepTransparent(
				changeMask(anchor, aligned, componentShare),
				anchor,
				aligned,
			).mask,
			anchor,
		);
		// With marks, what earlier changes made outside them must survive the
		// reset: the anchor shows only where the base never left it.
		const under = clamp
			? compositeOnto(
					anchor,
					base,
					keepTransparent(changeMask(anchor, base), anchor, base).mask,
				)
			: anchor;
		return {
			picture: compositeOnto(under, painted, mask),
			mask,
			measures: { ...measures, reanchored: true },
			chainSinceAnchor: 0,
			anchorIsResult: false,
		};
	}
	const mask = limit(against.mask, base);
	return {
		picture: compositeOnto(base, painted, mask),
		mask,
		measures,
		chainSinceAnchor: params.chainSinceAnchor + 1,
		anchorIsResult: false,
	};
}
