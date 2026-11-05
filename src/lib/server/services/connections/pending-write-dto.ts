// Issue 7.5 — inline write-confirm card DTO. Mirrors the shape returned by
// GET /api/conversations/[id]/pending-writes (see write-guard.ts's own
// `WritePreview` for the server-side build-time source of truth this is
// kept in sync with, and pending-writes.ts's own `PendingWriteStatus` for
// the storage-row lifecycle this projects) and by
// $lib/client/api/connection-writes.ts's confirm/cancel calls. Named
// distinctly from those two modules' local types to avoid colliding with
// them — this is the client-facing read/confirm view, not the storage row
// or the build-time preview. Relocated out of the former
// src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home.

export type PendingWriteStatus =
	| "pending"
	| "executing"
	| "executed"
	| "cancelled"
	// Terminal: the proposal outlived its 30-minute TTL and can no longer be
	// confirmed. The endpoint projects it onto a row that is still physically
	// "pending" but past `expiresAt` (nothing sweeps the table), so the card
	// reaches this state on a plain reload and not only after a refused
	// confirm — see isPendingWriteExpired in pending-writes.ts.
	| "expired"
	| "failed";

export interface WritePreview {
	title: string;
	detail: string;
	reversible: boolean;
	destructive: boolean;
	withinAllowlist: boolean | null;
	warnings: string[];
}

/** What the permission card asks. Finer than the operation: replacing a file and saving a new one are the same `files.put`. */
export type WriteCardKind =
	| "email.send"
	| "email.trash"
	| "email.mark_read"
	| "email.mark_unread"
	| "email.flag"
	| "email.unflag"
	| "calendar.create_event"
	| "calendar.update_event"
	| "calendar.delete_event"
	| "files.save"
	| "files.replace"
	| "files.move"
	| "files.rename"
	| "files.delete"
	| "files.create_folder"
	| "files.share_link"
	| "photos.add_to_album";

export type WriteCardFactKey =
	| "to"
	| "cc"
	| "from"
	| "sent"
	| "when"
	| "where"
	| "folder"
	| "new_name"
	| "new_when"
	| "new_where"
	| "new_notes"
	| "photos";

/** A small line under the name. A `when`, `new_when` or `sent` holds machine dates, for the reader's own language and clock to format. */
export interface WriteCardFact {
	key: WriteCardFactKey;
	value: string;
	end?: string;
}

/** A consequence worth a sentence on the card, named by code so the sentence is in the reader's language. */
export type WriteCardRisk =
	| "replaces_file_for_good"
	| "replaces_file_unchecked"
	| "deletes_whole_series"
	| "changes_whole_series"
	| "cannot_undo"
	| "public_link"
	| "outside_allowed_folders";

export interface WriteCard {
	kind: WriteCardKind;
	/** The name of the thing this is about, which the card draws large. Empty when it has none: a flag change stored before it named its email knows only the email's number. */
	subject: string;
	facts: WriteCardFact[];
	/** The text of an email: it leaves the account, so it is what the person is agreeing to. */
	message: string | null;
	risks: WriteCardRisk[];
	/** The reader loses something: the red confirm button. */
	danger: boolean;
	/** The photos a write adds, as the app's own thumbnail addresses: a count does not say which. */
	thumbnails?: string[];
}

export interface PendingWrite {
	id: string;
	conversationId: string | null;
	assistantMessageId: string | null;
	status: PendingWriteStatus;
	preview: WritePreview;
	/** Absent or null for a write this version cannot read: the card then shows `preview`. */
	card?: WriteCard | null;
	/** The account this lands in, when its connection still exists. */
	account?: string | null;
	provider: string;
	createdAt: number;
	etag?: string | null;
}
