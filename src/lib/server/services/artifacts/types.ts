// The artifact family's shapes (Feature 2, ADR-0066). Slices 1–6 import these
// and extend the service around them; the contract text lives in
// docs/plans/claude-at-home-2/slice-0.md §Contracts.
//
// Both unions live in shared modules so browser components can import them
// without a server path in the client graph; they are re-exported here so
// server callers still have one import site.

import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export type { Anchor } from "$lib/shared/artifacts/anchor";
export type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export type ArtifactAuthor = "user" | "alfy";
export type ArtifactCommentStatus = "open" | "resolved";

/**
 * Which conversations a read may reach an artifact through — the two
 * deliberate ways back into an incognito conversation that
 * `getArtifactOwnershipScope` (knowledge/store/core.ts) already names, passed
 * straight through to it. The default (neither) is the strict scope: no
 * incognito conversation's artifact is reachable.
 */
export interface ArtifactScopeOptions {
	/**
	 * The conversation being served. Its own artifacts stay in scope even when
	 * it is incognito: incognito hides a chat's work from the user's OTHER
	 * chats, never from itself.
	 */
	conversationId?: string | null;
	/** Administration only: archive, erasure, disk sweeps. */
	includeIncognito?: boolean;
}

export interface ArtifactMetadata {
	artifactType: ArtifactKind;
	title: string;
	// No `idIndex`: the parent spec's §3 sketch carried one, nothing here or in
	// any later slice writes it, and dead state does not ride along (ruling
	// 37.2). A type that needs its own index adds a named field of its own.
	[key: string]: unknown;
}

export interface ArtifactRecord {
	id: string;
	userId: string;
	conversationId: string | null;
	kind: ArtifactKind;
	title: string;
	body: string | null;
	bodyHash: string | null;
	metadata: ArtifactMetadata;
	versionNumber: number;
	createdAt: number;
	updatedAt: number;
}

/**
 * One row of "what this chat made": the panel list's and the header count's
 * unit. Named apart from `knowledge/types.ts`'s `ArtifactSummary` (a library
 * document's list row) on purpose — ruling 20: the two are different things
 * and nothing aliases one into the other's place.
 */
/**
 * A Document card's subtitle facts and tickable checklist (spec §2.3, T9
 * steps 4/7) — bounded and NEVER the whole body: `tasks` is at most the
 * first five `taskList` blocks, and `totalTaskCount` is what lets a card
 * with more say "+N more" without shipping the rest. Present only on a
 * `kind: "document"` row; every other kind omits it.
 */
export interface DocumentCardPreview {
	tabCount: number;
	tasks: { blockId: string; text: string; checked: boolean }[];
	totalTaskCount: number;
}

/**
 * `kind: "canvas"` only (Slice 3): what a board's card says about it without
 * shipping the board — how many blocks it holds. Counted by the board's own
 * reader (`normalizeCanvasBody`), so a block of a kind nobody knows is not
 * counted, and the card and the panel agree.
 */
export interface CanvasCardPreview {
	blockCount: number;
}

/**
 * `kind: "app"` only (Wave 2.5 Step 13): the App panel's own status-row
 * verdict, carried along so the in-chat card can show the same fact-check
 * line without a second fetch. Mirrors the shape `AppBody.svelte` already
 * reads off `metadata.verification` client-side — never the full
 * `AppVerification` (findings, repairedHtml, …), which stays panel-only.
 *
 * `verdict` repeats `./app/verify.ts`'s own `AppVerificationVerdict` union as
 * a literal rather than importing it: that module's own import graph
 * (generation/verification/tool-recording) has no reason to run through this
 * shared types file, and a real, small, stable four-value enum is cheaper to
 * repeat here than to risk a new circular dependency over.
 */
export interface AppVerificationSummary {
	checked: boolean;
	verdict: "clean" | "repaired" | "uncertain" | "unavailable";
}

export interface ArtifactCardSummary {
	id: string;
	kind: ArtifactKind;
	title: string;
	conversationId: string | null;
	/** The newest version's number; 0 for a row with no version yet. */
	versionNumber: number;
	commentCount: number;
	updatedAt: number;
	documentPreview?: DocumentCardPreview;
	/** `kind: "app"` only; `null` when the App's facts were never checked. */
	appVerification?: AppVerificationSummary | null;
	/** `kind: "canvas"` only. */
	canvasPreview?: CanvasCardPreview;
	/**
	 * `kind: "document"` only (Wave 2.5 review, F1): the PERSISTED review
	 * state — `document-ops.ts`'s `computePendingReviewBlocks`, through the
	 * artifact's own stored `metadata.review` marker (ruling 61) — never the
	 * ephemeral, session-only `liveDocumentAlfyActivity` signal the chat card,
	 * list row and count-button dot used to read independently (and could
	 * each go stale in a different way). `undefined` for a document that has
	 * never had an Alfy edit land (no marker yet — nothing to review, ever):
	 * distinct from `0`, which means "reviewed" (a marker exists and nothing
	 * is pending right now). Every other kind always omits this field.
	 */
	pendingReviewCount?: number;
	/**
	 * Set (to `true`, never `false`) when the chat can make this item again from
	 * what it kept — a Document or App from the model's own `create_artifact`
	 * arguments, a Document from the message it was opened as, a produced file
	 * from its job's request. It is what lets the delete confirm say "you can
	 * regenerate it from the chat" instead of "this can't be undone". Set by the
	 * conversation detail read model, which has the messages and jobs; absent
	 * means "no source is known", and the confirm keeps the plain warning.
	 */
	regenerable?: true;
}

export interface ArtifactDetail extends ArtifactCardSummary {
	body: string | null;
	bodyHash: string | null;
	metadata: ArtifactMetadata;
}

export interface ArtifactVersionSummary {
	id: string;
	versionNumber: number;
	author: ArtifactAuthor;
	summary: string;
	createdAt: number;
}

export interface ArtifactComment {
	id: string;
	artifactId: string;
	parentId: string | null;
	/** null = the anchor could not be parsed; render as orphaned, never crash. */
	anchor: Anchor | null;
	author: ArtifactAuthor;
	body: string;
	status: ArtifactCommentStatus;
	createdAt: number;
	/** Replies, oldest first. Empty on a reply itself. */
	replies: ArtifactComment[];
}

/**
 * What `runAlfyCommentReply` answers with, whatever kind the artifact is: what
 * became of the request (a change landed, every op was refused, or it was only
 * a question), how many ops did and did not apply, the version the artifact is
 * at afterwards, and Alfy's reply as it now stands in the thread.
 */
export type AlfyCommentOutcome = "applied" | "refused" | "answered";

export interface AlfyCommentReplyResult {
	outcome: AlfyCommentOutcome;
	applied: number;
	refused: number;
	/** The version this reply's own change landed in, or the CURRENT version when nothing changed. */
	version: number;
	reply: ArtifactComment;
}

/**
 * A comment thread as the `@Alfy` hook works on it, whatever the kind: the
 * comment that asked, the thread it is in, the thread's own anchor (a reply has
 * none), and the one way Alfy answers in it. Built once by the comment service
 * so a kind's branch never opens the comment table itself.
 */
export interface AlfyThreadContext {
	/** The comment that asked: a thread's root or one of its replies. */
	target: ArtifactComment;
	rootId: string;
	/** The thread's anchor; null when it could not be read. */
	anchor: Anchor | null;
	/** The root with its replies, oldest first, as the reader sees the thread. */
	thread: ArtifactComment;
	/** Writes Alfy's reply under the root. */
	reply: (body: string) => Promise<ArtifactComment>;
	/** Moves the thread to another anchor: the block it was on was replaced by the change this reply made. */
	reanchor: (anchor: Anchor) => Promise<void>;
}

export interface ArtifactKvRow {
	key: string;
	valueJson: string;
	updatedAt: number;
}

/**
 * The kinds the family creates as its own rows. A File is never created here:
 * it is what `produce_file` already makes, a `generated_output` row read as
 * kind `file` (ruling 18), so creating one would be a second representation
 * of the same thing.
 */
export type CreatableArtifactKind = Exclude<ArtifactKind, "file">;

export interface CreateArtifactInput {
	userId: string;
	conversationId: string | null;
	/**
	 * A trusted server caller's own id for the row — Regenerate makes a deleted
	 * item again under the id its chat cards already carry. Omit for a fresh
	 * one (every other caller). Refused as `id_taken` when a row already has it.
	 */
	id?: string;
	kind: CreatableArtifactKind;
	title: string;
	body?: string | null;
	metadata?: Record<string, unknown>;
	/** The first version's author. Defaults to "user". */
	author?: ArtifactAuthor;
	/** The first version's summary, e.g. "Alfy wrote the first draft". */
	versionSummary?: string;
}
