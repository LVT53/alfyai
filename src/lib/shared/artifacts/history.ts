/**
 * An artifact's history as a reader would tell it: moments derived from the
 * `artifact_versions` rows (ruling 76, `docs/design/artifacts-versioning/
 * versioning.md` §3 and §4). Browser-safe: types and a few constants, no
 * runtime imports, so the server that derives a moment (`services/artifacts/
 * history.ts`) and the History panel that draws it cannot drift apart.
 *
 * Everything here is DATA. A moment carries facts (who, what kind, which
 * blocks, how many lines, which version it restores from), never English text:
 * the browser words them in the reader's language (`moment-text.ts`). The one
 * free text in it is Alfy's own summary or an App's brief, as the row stored it.
 *
 * Reading a moment:
 *  - A moment is ONE run of 1..n adjacent version rows. Most are one row. A run
 *    folds when its rows cancel or complete each other (`fold`, versioning.md
 *    §3.3): an Undo onto the change it undid, a Redo after it, a restore and
 *    its undo, one turn of Alfy's several edits. No row is ever hidden: a
 *    folded row is a `steps` entry that stays selectable and previewable.
 *  - `versionId` is the state the moment SHOWS, and `parentVersionId` is what
 *    its changes are measured against ("this version's changes"). For a single
 *    row that is the row and its parent. For `undone`, `redone` and
 *    `restore_undone` it is the FIRST row (Alfy's change, the restore) and its
 *    parent. For `alfy_turn` it is the LAST row (what the turn left) and the
 *    parent of the FIRST row, so the whole turn reads as one change.
 *  - Restore brings back whatever is selected (a moment's `versionId` or a
 *    step's), and is offered only when that version is not the newest and not
 *    `sameAsNow`.
 *  - The version NUMBER orders and guards (`newestVersion` is the
 *    `expectVersion` of a restore made from this page); it is printed only in
 *    History's fine print.
 *
 * Additive changes only after VB-1 landed this file: a new optional field or a
 * new union member the browser must tolerate. Anything else goes through the
 * orchestrator first (VB-2 builds against fixtures of these types).
 */
import type { ArtifactKind } from "./kinds";

/** Who a moment credits: the reader or Alfy. (`kept_from_chat` credits the reader, who pressed the button.) */
export type MomentAuthor = "user" | "alfy";

/**
 * What happened, chosen from the row's author and summary against the fixed
 * vocabulary (`version-summaries.ts`, versioning.md §3.2); any other Alfy
 * summary is an `alfy_edit`, any other reader summary a `user_edit`.
 */
export const MOMENT_KINDS = [
	/** v1 by Alfy ("Alfy wrote the first draft"); a board's first version is this too: the browser says "made the board". */
	"first_draft",
	/** An App's v1 by Alfy; `text` is the brief. */
	"app_made",
	/** The reader kept a chat reply as a Document (v1). */
	"kept_from_chat",
	/** The reader saved it as a new Document after the open one was deleted (v1). */
	"saved_as_copy",
	/** v1 after a delete: Alfy made it again under the same id. */
	"made_again",
	/** The reader's typing, board steps or other saves ("Edited"). */
	"user_edit",
	/** The reader changed only a task's checked state: `tick` says which. */
	"tick",
	/** One Alfy edit; `text` is its own summary, null for the server's fallback. */
	"alfy_edit",
	/** An Alfy edit that answered a comment (`commentId` when a single reply matches). */
	"alfy_reply_edit",
	/** An App rebuilt by Alfy; `text` is the prompt. */
	"app_rebuilt",
	/** The reader undid Alfy's change; `target` names the change when known. */
	"undo_alfy_change",
	/** The reader brought Alfy's undone change back. */
	"redo_alfy_change",
	/** A restore: `restoredFrom` names the version it brought back. */
	"restore",
	/** The reader undid a restore (the restore toast's Undo). */
	"undo_restore",
	/** Several Alfy edits of one turn drawn as one moment (F4); only a moment has it, never a step. */
	"alfy_turn",
] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/** Which fold rule drew a moment from several rows (versioning.md §3.3). */
export type MomentFold =
	/** F1: an Undo that immediately follows the Alfy change it undid. */
	| "undone"
	/** F2: that Undo and the Redo that brought the change back. */
	| "redone"
	/** F3: a restore and the Undo of that restore. */
	| "restore_undone"
	/** F4: consecutive Alfy edits less than two minutes apart. */
	| "alfy_turn";

/**
 * The review status of an Alfy change, from the same marker and computations
 * the review bar uses (rulings 61, 63; amendment A4). History shows it and
 * sends the reader to the review; it never decides.
 */
export const MOMENT_STATUSES = [
	"waiting",
	"kept",
	"undone",
	/** A Document only: some of the blocks were kept, some undone. */
	"partly_kept",
] as const;
export type MomentStatus = (typeof MOMENT_STATUSES)[number];

/** A version named by its id, number and last-save time (ms since the epoch). */
export interface MomentRef {
	versionId: string;
	versionNumber: number;
	at: number;
}

/**
 * Blocks, arrows or lines of one class that a change touched: how many, and
 * the label of the first one (document or board order, at most 60 characters)
 * for "Changed “Saturday” and 2 more". `first` is null when the class is empty
 * or its first member has no words.
 */
export interface MomentDetailBucket {
	count: number;
	first: string | null;
}

/**
 * What changed between a row and its parent, as facts (versioning.md §4.2).
 * Absent classes are `count: 0`. The browser phrases them; the server never
 * does, so one set of strings serves both authors in both languages.
 */
export type MomentDetail =
	/** Nothing to say: a first version, or a save that changed nothing the reader could see. */
	| { type: "none" }
	/** A body over 256 KB: not compared. "Large change". */
	| { type: "large" }
	| {
			type: "document";
			changed: MomentDetailBucket;
			added: MomentDetailBucket;
			removed: MomentDetailBucket;
			/** The tab (its title) of the first changed block, only when it is not the first tab. */
			tab: string | null;
	  }
	| {
			type: "canvas";
			blocksAdded: MomentDetailBucket;
			blocksChanged: MomentDetailBucket;
			blocksRemoved: MomentDetailBucket;
			blocksMoved: number;
			blocksReparented: number;
			arrowsAdded: number;
			arrowsChanged: number;
			arrowsRemoved: number;
	  }
	| {
			type: "app";
			linesAdded: number;
			linesRemoved: number;
	  };

/** A row folded into a moment: a real state, selectable and previewable on its own. */
export interface ArtifactMomentStep {
	versionId: string;
	versionNumber: number;
	/** What this row is: `undo_alfy_change`, `redo_alfy_change`, `undo_restore`, or (in an `alfy_turn`) `alfy_edit` / `alfy_reply_edit`. */
	kind: MomentKind;
	author: MomentAuthor;
	/** Last save, ms since the epoch. */
	at: number;
	/** Alfy's own words for an `alfy_turn` step, as stored; null otherwise or for the fallback. */
	text: string | null;
	/** The reader's name for this version. */
	label: string | null;
	/** This row is the newest version. */
	isNewest: boolean;
	/** Its body equals the newest version's (and it is not the newest itself). */
	sameAsNow: boolean;
	/** The nearest older version in the loaded rows with the same body: an undone restore reads "Same as" the version before it. */
	sameAs: MomentRef | null;
	/** What this row's changes are measured against: the row before it. Null for v1. */
	parentVersionId: string | null;
	parentVersionNumber: number | null;
}

export interface ArtifactMoment {
	/** The state the moment shows (see the file comment). Also the moment's stable key. */
	versionId: string;
	versionNumber: number;
	/** What the moment's changes are measured against; null for a first version. */
	parentVersionId: string | null;
	parentVersionNumber: number | null;

	kind: MomentKind;
	/** Who the headline credits. */
	author: MomentAuthor;
	/** The rule that folded several rows into this moment; null for a single row. */
	fold: MomentFold | null;
	/** F3: a restore that was undone is drawn quiet. */
	quiet: boolean;

	/** The moment's own row's last save, ms since the epoch (a folded moment: its first row's). */
	at: number;
	/** A burst's first save, ms; null when unknown (an older row, or a single save). */
	startedAt: number | null;
	/** The reader's name for the moment's version, or null. */
	label: string | null;

	/**
	 * Alfy's own words (an Alfy edit's summary), an App's brief (`app_made`) or
	 * prompt (`app_rebuilt`), as stored. Null when the kind has none, or when the
	 * row holds the server's fallback ("Alfy's edit": the browser says its own).
	 */
	text: string | null;
	/** `kind: "tick"`: the task item and the state the reader gave it. */
	tick: { text: string; checked: boolean } | null;
	/** An undo or redo: the Alfy change it acts on, when known (named by the new summary, or found by fold or hash for older rows). */
	target: (MomentRef & { text: string | null }) | null;
	/** `kind: "restore"`: the version it brought back; null for an older "restored …" wording that names none. */
	restoredFrom: MomentRef | null;
	/** `kind: "alfy_reply_edit"`: Alfy's reply comment, when exactly one was written with it. */
	commentId: string | null;

	detail: MomentDetail;

	/** Alfy changes only (not a first draft, a made-again or an App); null when the change is not reviewable or was restored over. */
	status: MomentStatus | null;
	/** The Undo that took this change back, folded onto it or later ("Undone later · 10:20"). */
	undoneBy: MomentRef | null;

	/** The moment's own row is the newest version. */
	isNewest: boolean;
	/** The moment's run includes the newest version: the top moment, "Now". */
	containsNewest: boolean;
	/** The moment's own body equals the newest version's (and it is not the newest itself): "Same as now", no Restore. */
	sameAsNow: boolean;
	/** The nearest older version in the loaded rows with the same body: "Same as Mon 10:09". */
	sameAs: MomentRef | null;
	/** Restores that came from this version, newest first, at most 5 ("Restored from here · today 10:20"). */
	restoredHere: MomentRef[];
	/** The body's hash, for a client that compares a version it just saw with the rows. */
	bodyHash: string;

	/** The rows folded into the moment, oldest first; empty for a single row. */
	steps: ArtifactMomentStep[];
}

/** `GET /api/artifacts/[id]/history?before=<versionNumber>&limit=<n>`. */
export interface ArtifactHistoryPage {
	ok: true;
	artifactKind: ArtifactKind;
	/** Newest first. A page never cuts a folded run in two. */
	moments: ArtifactMoment[];
	/** Older versions exist beyond this page. */
	older: boolean;
	/** Pass as `before` to read the next page; null when `older` is false. */
	nextBefore: number | null;
	/** The artifact's newest version number when this was read: the `expectVersion` of a restore made from it. */
	newestVersion: number;
}

export type ArtifactHistoryResponse =
	| ArtifactHistoryPage
	| { ok: false; reason: "not_found" };

/** The longest name a reader may give a version, in characters. */
export const VERSION_LABEL_MAX_CHARS = 60;

/** `PATCH /api/artifacts/[id]/versions/[versionId]`: `label: null` (or blank) removes the name. */
export interface NameVersionRequest {
	label: string | null;
}

export type NameVersionResponse =
	| { ok: true; label: string | null }
	| { ok: false; reason: "not_found" | "invalid_label" };

/**
 * `POST /api/artifacts/[id]/versions/[versionId]/restore`, JSON body optional.
 * `expectVersion` is the History page's `newestVersion`: a restore over a
 * newer version is refused `version_conflict` like a stale save. `undoOf` is
 * the version number of the newest row when the restore reverses it (the
 * restore toast's Undo, an App rebuild's Undo): it must be that row's parent
 * being restored, and it makes the summary name what was undone.
 */
export interface RestoreVersionRequest {
	expectVersion?: number;
	undoOf?: number;
}

export type RestoreVersionResponse =
	| { ok: true; version: number; versionId: string }
	| {
			ok: false;
			reason: "not_found" | "no_body" | "version_conflict" | "invalid_undo";
	  };
