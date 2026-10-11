/**
 * The version summaries the SERVER writes itself, as one vocabulary (Wave 2.5
 * polish G1-B; every summary since ruling 76, amendment A5). An Alfy patch's
 * own label ("Moved the museum to Thursday") is free-form content and is shown
 * as stored; everything else the server writes is a fixed English literal the
 * browser recognises and shows in the reader's language (History's moment
 * rows). A row keeps the text it was written with, so every older wording is
 * still read here. Browser-safe: only type imports, so the routes and services
 * that write a summary and the code that localises it cannot drift apart on a
 * spelling.
 *
 * An Undo or Redo names the version it acts on (`Undid Alfy's change: v7`), so
 * History can tell which change a reader took back without guessing.
 */
import type { MomentAuthor, MomentKind } from "./history";

export const VERSION_SUMMARY = {
	/** An ordinary autosave of the user's own typing. */
	edited: "Edited",
	/**
	 * The user undid Alfy's change (spec §4.2 item 6). Written plain before an
	 * Undo named its version; rows like that still exist, and a client that does
	 * not name one still writes it.
	 */
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
	/** An Alfy edit that gave no words of its own: the fallback the edit tool writes. */
	alfyEdit: "Alfy's edit",
	/** An Alfy edit that answered a comment (`@Alfy`), a Document's or a board's. */
	alfyCommentReply: "Alfy's comment reply",
	/** "Open as document": the reader kept a chat reply as a Document. */
	keptFromChat: "Kept from a chat reply",
	/** Regenerate made a deleted item again under its old id. */
	alfyRemade: "Alfy made it again",
} as const;

const MADE_APP_PREFIX = "Alfy made the app: ";
const REGENERATED_APP_PREFIX = "Alfy regenerated the app: ";

/** An App's first version: Alfy built it from this brief. */
export function madeAppSummary(brief: string): string {
	return `${MADE_APP_PREFIX}${brief}`;
}

/** The brief an App's first-version summary carries, or `null` for any other summary. */
export function parseMadeApp(summary: string): string | null {
	return summary.startsWith(MADE_APP_PREFIX)
		? summary.slice(MADE_APP_PREFIX.length)
		: null;
}

/** An App rebuilt by Alfy from this prompt ("Change this app…"). */
export function regeneratedAppSummary(prompt: string): string {
	return `${REGENERATED_APP_PREFIX}${prompt}`;
}

/** The prompt an App rebuild's summary carries, or `null` for any other summary. */
export function parseRegeneratedApp(summary: string): string | null {
	return summary.startsWith(REGENERATED_APP_PREFIX)
		? summary.slice(REGENERATED_APP_PREFIX.length)
		: null;
}

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
 * The reader took back Alfy's change in version `alfyVersion`. Without a
 * version it is the plain form older rows (and older clients) carry.
 */
export function undidAlfyChangeSummary(alfyVersion?: number): string {
	return alfyVersion === undefined
		? VERSION_SUMMARY.undidAlfyChange
		: `${VERSION_SUMMARY.undidAlfyChange}: v${alfyVersion}`;
}

const UNDID_ALFY_PATTERN = /^Undid Alfy's change(?:: v(\d{1,9}))?$/;

/**
 * An Undo summary read back: the Alfy version it undid, `null` for the plain
 * older form, or `null` overall for any other summary.
 */
export function parseUndidAlfyChange(
	summary: string,
): { version: number | null } | null {
	const match = UNDID_ALFY_PATTERN.exec(summary);
	if (!match) return null;
	return { version: match[1] === undefined ? null : Number(match[1]) };
}

/** The reader brought back Alfy's change in version `alfyVersion` after undoing it. */
export function redidAlfyChangeSummary(alfyVersion: number): string {
	return `Redid Alfy's change: v${alfyVersion}`;
}

const REDID_ALFY_PATTERN = /^Redid Alfy's change: v(\d{1,9})$/;

/** The Alfy version a Redo summary names, or `null` for any other summary. */
export function parseRedidAlfyChange(summary: string): number | null {
	const match = REDID_ALFY_PATTERN.exec(summary);
	return match ? Number(match[1]) : null;
}

/** The reader undid the restore that made version `restoreVersion`. */
export function undidRestoreSummary(restoreVersion: number): string {
	return `Undid restoring v${restoreVersion}`;
}

const UNDID_RESTORE_PATTERN = /^Undid restoring v(\d{1,9})$/;

/** The restore (by its own version number) an undone-restore summary names, or `null`. */
export function parseUndidRestore(summary: string): number | null {
	const match = UNDID_RESTORE_PATTERN.exec(summary);
	return match ? Number(match[1]) : null;
}

/**
 * What a body save may say about itself beyond "the user typed": the body
 * route accepts one of these names, never text, so the stored summary is
 * always one this vocabulary (and its translations) knows. An Undo or a Redo
 * also names the Alfy version it acts on (`summaryVersion`).
 */
const SAVE_SUMMARY_KINDS = ["undid_alfy_change", "redid_alfy_change"] as const;

export type SaveSummaryKind = (typeof SAVE_SUMMARY_KINDS)[number];

export function parseSaveSummaryKind(value: unknown): SaveSummaryKind | null {
	return SAVE_SUMMARY_KINDS.find((kind) => kind === value) ?? null;
}

/** Version numbers are far below this; the pattern reads nine digits at most. */
const MAX_SUMMARY_VERSION = 999_999_999;

/** A version a save names: a positive integer, else `null`. The route checks it against the artifact's own numbers. */
export function parseSummaryVersion(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= MAX_SUMMARY_VERSION
		? value
		: null;
}

/**
 * The summary a body save is stored with: its named kind's, else the ordinary
 * "Edited". A Redo names the change it brings back or it is only an edit; an
 * Undo that names none (an older client) is the plain older form.
 */
export function saveSummaryFor(
	kind: SaveSummaryKind | null | undefined,
	alfyVersion?: number | null,
): string {
	if (kind === "undid_alfy_change") {
		return alfyVersion
			? undidAlfyChangeSummary(alfyVersion)
			: undidAlfyChangeSummary();
	}
	if (kind === "redid_alfy_change" && alfyVersion) {
		return redidAlfyChangeSummary(alfyVersion);
	}
	return VERSION_SUMMARY.edited;
}

/** What a row's author and summary say it is (versioning.md §3.2). */
export interface ClassifiedSummary {
	/** The kind a single row can have; a tick needs the diff and a turn needs its neighbours. */
	kind: Exclude<MomentKind, "tick" | "alfy_turn">;
	/** Who the headline credits: the reader pressed the button for a kept reply. */
	actor: MomentAuthor;
	/** Alfy's own words, an App's brief or prompt; `null` when the kind has none or the row holds the fallback. */
	text: string | null;
	/**
	 * Undo/redo: the Alfy version it acts on (`null` for the plain older Undo).
	 * Restore: the version brought back (`null` for the older wrapper form).
	 * Undone restore: the restore's own version number.
	 */
	version: number | null;
}

/**
 * Only the author and the version number decide what a row is: a model can
 * write any text as its summary, so Alfy's rows never pass for the reader's
 * (an Alfy edit whose words read "Restored v3" is still an Alfy edit), and a
 * first-version summary on a later version is just an edit.
 */
export function classifyVersionSummary(row: {
	author: MomentAuthor;
	summary: string;
	versionNumber: number;
}): ClassifiedSummary {
	const { summary, versionNumber } = row;
	const first = versionNumber === 1;

	if (row.author === "user") {
		const base = { actor: "user", text: null, version: null } as const;
		if (first && summary === VERSION_SUMMARY.savedAsCopy) {
			return { ...base, kind: "saved_as_copy" };
		}
		const restored = parseRestoredVersion(summary);
		if (restored !== null)
			return { ...base, kind: "restore", version: restored };
		if (summary.startsWith(VERSION_SUMMARY.restoredPrefix)) {
			return { ...base, kind: "restore" };
		}
		const undoneRestore = parseUndidRestore(summary);
		if (undoneRestore !== null) {
			return { ...base, kind: "undo_restore", version: undoneRestore };
		}
		const undid = parseUndidAlfyChange(summary);
		if (undid)
			return { ...base, kind: "undo_alfy_change", version: undid.version };
		const redid = parseRedidAlfyChange(summary);
		if (redid !== null)
			return { ...base, kind: "redo_alfy_change", version: redid };
		return { ...base, kind: "user_edit" };
	}

	if (first) {
		if (summary === VERSION_SUMMARY.keptFromChat) {
			return {
				kind: "kept_from_chat",
				actor: "user",
				text: null,
				version: null,
			};
		}
		if (summary === VERSION_SUMMARY.alfyRemade) {
			return { kind: "made_again", actor: "alfy", text: null, version: null };
		}
		const brief = parseMadeApp(summary);
		if (brief !== null) {
			return {
				kind: "app_made",
				actor: "alfy",
				text: brief.trim() || null,
				version: null,
			};
		}
		// A first version of Alfy's with words this vocabulary does not know is
		// still its first draft; its words are not a change.
		return { kind: "first_draft", actor: "alfy", text: null, version: null };
	}

	const prompt = parseRegeneratedApp(summary);
	if (prompt !== null) {
		return {
			kind: "app_rebuilt",
			actor: "alfy",
			text: prompt.trim() || null,
			version: null,
		};
	}
	if (summary === VERSION_SUMMARY.alfyCommentReply) {
		return {
			kind: "alfy_reply_edit",
			actor: "alfy",
			text: null,
			version: null,
		};
	}
	const words = summary.trim();
	return {
		kind: "alfy_edit",
		actor: "alfy",
		text: words === "" || words === VERSION_SUMMARY.alfyEdit ? null : words,
		version: null,
	};
}
