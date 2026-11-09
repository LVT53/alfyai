import type { GuideSectionId } from "../guide-content";

/**
 * The parts of each section's drawing a row can light: the ids an entry's
 * `drawingSpot` (`guide-content.ts`) may name. A drawing marks every one of
 * these, and no other, with `data-drawing-spot`; `drawings.test.ts` holds both
 * ways, and that every entry names a spot its section has.
 *
 * A change to a section's drawing that adds or removes a spot changes this list
 * in the same change.
 */
export const SECTION_DRAWING_SPOTS: Readonly<
	Record<GuideSectionId, readonly string[]>
> = {
	ask: ["thinking", "sources", "attach", "atlas", "replyActions"],
	make: ["document", "picture", "download", "history"],
	knowsYou: ["memory", "instructions", "style", "skills"],
	yourThings: ["library", "fromLibrary", "connections", "okCard"],
	organized: ["search", "projects", "sidebarList", "incognito", "home"],
	account: ["language", "twoStep", "data", "activity"],
};
