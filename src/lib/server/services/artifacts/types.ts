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
	kind: CreatableArtifactKind;
	title: string;
	body?: string | null;
	metadata?: Record<string, unknown>;
	/** The first version's author. Defaults to "user". */
	author?: ArtifactAuthor;
	/** The first version's summary, e.g. "Alfy wrote the first draft". */
	versionSummary?: string;
}
