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
	/** Less than this share of the change inside the marks is a miss. */
	marksMissShare: 0.5,
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
