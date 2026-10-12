/**
 * Where the docked panel and the chat share the stage (FB-3, ruling 77: F3, F4).
 *
 * The stage is the row the chat column and the docked panel sit in. The panel
 * asks for a width (its last drag, or the default), and the stage gives it that
 * unless the panel would take more than `DOCK_MAX_PERCENT` of it, or leave the
 * chat column under `CHAT_COLUMN_FLOOR`. The floor is where the composer stops
 * being usable (the friction audit measured a composer of 319 px at 1440 with
 * the sidebar open, 268 at 1280 and 134 at 1100, and ~340 as the one that
 * still is). The panel gives up width before the chat goes under it, and never
 * gets narrower than `DOCK_MIN_WIDTH`.
 *
 * The browser resolves the width itself: `dockedWidthCss` is the arithmetic as
 * a CSS `min()`/`max()`, so the panel's width follows the stage in the very
 * frame the stage changes (the sidebar folding, a window resize) with no script
 * between. `dockedPanelWidth` is the same arithmetic as a number, for the two
 * things that need the number itself: the panel's content, which is laid out at
 * its final width while the column grows (so the editor does not re-wrap through
 * every width on the way), and the sidebar's decision whether the chat has room.
 * `workspace-dock.test.ts` holds the two to each other.
 */

/** The narrowest the chat column may be made by a docked panel. */
export const CHAT_COLUMN_FLOOR = 364;
/** The most of the stage a docked panel may take, in percent. */
const DOCK_MAX_PERCENT = 68;
/** The narrowest a docked panel gets, when the stage is too small for both it and the floor. */
const DOCK_MIN_WIDTH = 440;

/** The width the docked panel has on a stage of `stage` px, asking for `preferred` px. */
export function dockedPanelWidth(preferred: number, stage: number): number {
	const wanted = Math.min(
		preferred,
		(stage * DOCK_MAX_PERCENT) / 100,
		stage - CHAT_COLUMN_FLOOR,
	);
	return Math.max(Math.min(DOCK_MIN_WIDTH, stage), wanted);
}

/** `dockedPanelWidth` as a CSS length, resolved against the stage by the browser. */
export function dockedWidthCss(preferred: number): string {
	return `max(min(${DOCK_MIN_WIDTH}px, 100%), min(${preferred}px, ${DOCK_MAX_PERCENT}%, calc(100% - ${CHAT_COLUMN_FLOOR}px)))`;
}

/**
 * Whether the chat column would be under the floor on a stage of `stage` px if
 * the panel took all it asks for, which is the moment the sidebar folds to its
 * rail to give the stage its room back.
 */
export function chatWouldBeSqueezed(preferred: number, stage: number): boolean {
	const asked = Math.min(preferred, (stage * DOCK_MAX_PERCENT) / 100);
	return stage - asked < CHAT_COLUMN_FLOOR;
}
