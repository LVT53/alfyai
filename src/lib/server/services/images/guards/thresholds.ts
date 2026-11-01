/**
 * Pixel-guard numbers, tuned in plan 2c Task 5 on real Qwen renders of generated
 * rooms (see Tuning in docs/plans/image-generation/results-part-2-server.md;
 * scripts/images/drift.ts re-measures). Keep every one of them here.
 */
export const GUARD = {
	/** Width the alignment and the change mask are measured at. */
	workWidth: 256,
	/** Largest per-channel difference (0-255) that counts as changed. */
	diffThreshold: 24,
	/** Smallest changed blob kept, as a share of the work frame. */
	minComponentShare: 0.001,
	/** Growth of the changed area, as a share of the short side. */
	dilateShare: 0.02,
	/** Soft edge of the mask, as a share of the short side. */
	featherShare: 0.015,
	/** Above this share of changed pixels the result is a whole repaint. */
	globalChangeShare: 0.6,
	/** Below this share nothing counts as changed. */
	nothingChangedShare: 0.002,
	/**
	 * Share of a marked box that must differ, at work resolution, for the box to
	 * count as changed. Not at full size: on real 1248 px renders asked to change
	 * nothing, the model's noise moved over 2% of the pixels of most boxes. At work
	 * resolution that noise was 3% of a box at the 90th percentile in the worst
	 * render, and two removed small objects were 29% of theirs (2026-10-31).
	 */
	markedBoxChangedShare: 0.05,
	/**
	 * Smallest blob kept on the second look at an unmarked edit that seemed to
	 * change nothing, so a small removal is not pasted away as noise.
	 */
	fineComponentShare: 0.00015,
	/** Every this-many changes the paste goes back onto the anchor. */
	reanchorEvery: 4,
	/** Over an opaque base, a top pixel less opaque than this (0-255) is never pasted; the model's own alpha is 252 or more. */
	pasteMinAlpha: 240,
	/** Largest shift searched, as a share of the width. */
	maxShiftShare: 0.06,
	scaleMin: 0.94,
	scaleMax: 1.06,
	scaleStep: 0.01,
} as const;

/** The marks are grown by this share of the short side before counting. */
export const MARK_GROW_SHARE = 0.05;

/**
 * A marked edit may change the picture only inside the marks grown by this share
 * of the short side, at most: a small box grows by half its own short side, or
 * the model's habit of overreaching (a whole plant pot for its cactus) pastes in
 * half an object.
 */
export const MARK_CLAMP_GROW_SHARE = 0.1;
/** The least a mark grows, as a share of the short side: room for a soft edge. */
export const MARK_CLAMP_MIN_GROW_SHARE = 0.02;
