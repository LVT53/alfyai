/**
 * The version summaries the SERVER writes itself, as one vocabulary (Wave 2.5
 * polish G1-B). An Alfy patch's own label ("Moved the museum to Thursday") is
 * free-form content and is shown as stored; these few are fixed English
 * literals the browser recognises and shows in the reader's language (the
 * Versions popover's `summaryLabel`). Browser-safe: no runtime imports, so the
 * routes and services that write them and the component that localises them
 * cannot drift apart on a spelling.
 */
export const VERSION_SUMMARY = {
	/** An ordinary autosave of the user's own typing. */
	edited: "Edited",
	/** The user undid Alfy's change (spec §4.2 item 6). */
	undidAlfyChange: "Undid Alfy's change",
	/**
	 * How restores were written BEFORE they named their version: they wrapped the
	 * summary of the version they brought back, `restored <that summary>`. Rows
	 * like that still exist, so the browser still reads them; a new restore
	 * writes `restoredSummary(n)` instead.
	 */
	restoredPrefix: "restored ",
	/** `create_artifact`'s first version. */
	alfyFirstDraft: "Alfy wrote the first draft",
	/** "Save as a new document" after the open one was deleted. */
	savedAsCopy: "Saved as a new document",
} as const;

/** What a restore says about itself: the version it brought back, `Restored v3`. */
export function restoredSummary(versionNumber: number): string {
	return `Restored v${versionNumber}`;
}

const RESTORED_FROM_PATTERN = /^Restored v(\d{1,9})$/;

/** The version number a restore summary names, or `null` for any other summary. */
export function parseRestoredVersion(summary: string): number | null {
	const match = RESTORED_FROM_PATTERN.exec(summary);
	return match ? Number(match[1]) : null;
}

/**
 * What a body save may say about itself beyond "the user typed": the body
 * route accepts one of these names, never text, so the stored summary is
 * always one this vocabulary (and its translations) knows.
 */
const SAVE_SUMMARY_KINDS = {
	undid_alfy_change: VERSION_SUMMARY.undidAlfyChange,
} as const;

export type SaveSummaryKind = keyof typeof SAVE_SUMMARY_KINDS;

export function parseSaveSummaryKind(value: unknown): SaveSummaryKind | null {
	return typeof value === "string" && Object.hasOwn(SAVE_SUMMARY_KINDS, value)
		? (value as SaveSummaryKind)
		: null;
}

/** The summary a body save is stored with: its named kind's, else the ordinary "Edited". */
export function saveSummaryFor(
	kind: SaveSummaryKind | null | undefined,
): string {
	return kind ? SAVE_SUMMARY_KINDS[kind] : VERSION_SUMMARY.edited;
}
