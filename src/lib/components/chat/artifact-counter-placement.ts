// Where the phone's floating artifact counter sits. Pure, so the rule is one
// function with a test rather than a few lines in the chat page.
//
// On a phone the counter leaves the header and becomes a pill in the corner the
// Chat Scroller's jump-to-latest controls use: the round button, or the
// "11 / 30" capsule, whose CSS bottom is `max(8rem, composer + --space-sm)` and
// whose height is 40 px (`ConversationJumpRail.svelte`, `MessageArea.svelte`).
// The pill sits one gap above that whole reserve, so it is in the same corner
// without ever covering the jump control, whether or not the control is drawn
// (the capsule appears only once the reader has left the bottom). Above the
// composer always, since the jump controls are above it.
//
// The page does the browser-only parts: it measures the composer, puts the
// number from here on the pill's `bottom`, and lets the viewport clamp it.

/** The jump controls' own floor above the composer (their CSS `8rem`). */
export const JUMP_CONTROL_MIN_BOTTOM_PX = 128;
/** `--space-sm`: the gap both the jump controls and the pill use. */
export const JUMP_CONTROL_GAP_PX = 8;
/** The round jump button's and the capsule's height (`ConversationJumpRail.svelte`). */
export const JUMP_CONTROL_SIZE_PX = 40;
/** The clear space the pill keeps above the jump controls. */
export const ARTIFACT_COUNTER_GAP_PX = 8;

/**
 * The pill's `bottom` inside the chat column, in px: one gap above the jump
 * controls' reserve.
 *
 * `composerHeight` is `ChatComposerPanel`'s measured layer (it includes the
 * composer's own safe-area padding), so the pill rides above the composer and
 * its safe area with it. A composer not measured yet (0) leaves the floor.
 */
export function artifactCounterPillBottom(input: {
	composerHeight: number;
}): number {
	const composerHeight = Math.max(0, input.composerHeight);
	const jumpBottom = Math.max(
		JUMP_CONTROL_MIN_BOTTOM_PX,
		composerHeight + JUMP_CONTROL_GAP_PX,
	);
	return jumpBottom + JUMP_CONTROL_SIZE_PX + ARTIFACT_COUNTER_GAP_PX;
}
