// The artifact-retrieval ownership boundary, on its own.
//
// This is where incognito is enforced for everything that reads `artifacts`.
// It lives in a lightweight module because a DB-only reader on a hot request
// path needs the scope without the rest of the knowledge store: importing
// `store/core.ts` reaches the parse bundle, and `knowledge/readiness.ts` sits on
// the extraction poll route. `store/core.ts` imports these helpers and
// re-exports them, so every existing caller keeps its import.
//
// Nothing here may reach an extractor, `node:fs`, or `store/`.

import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts, conversations } from "$lib/server/db/schema";

export type ArtifactOwnershipScope = {
	conversationIds: Set<string>;
};

export type ArtifactOwnershipCandidate = Pick<
	typeof artifacts.$inferSelect,
	"userId" | "type" | "conversationId"
>;

/**
 * Options for {@link getArtifactOwnershipScope}, which is where incognito is
 * enforced for everything that reads `artifacts`.
 *
 * The scope is the set of conversations an artifact may be held through, and
 * every user-scoped artifact query in the app derives its answer from it —
 * through `buildArtifactCanonicalOwnershipCondition` in SQL or
 * `isArtifactCanonicallyOwned` in JS. Dropping a conversation from the set
 * therefore removes its artifacts from the Knowledge library, from workspace
 * search, from the semantic candidate pool every evidence selection draws on,
 * and from the working set — in one place, rather than in each of them.
 *
 * The default is the strict one: no incognito conversation is in scope. The
 * two ways back in are both deliberate and both named at the call site.
 */
export type ArtifactOwnershipScopeOptions = {
	/**
	 * The conversation being served. Its own artifacts stay in scope even when
	 * it is incognito: incognito hides a chat's work from the user's OTHER
	 * chats, never from itself, and inside it everything keeps working.
	 */
	conversationId?: string | null;
	/**
	 * Administration — deletion, account export, erasure, disk sweeps. These
	 * have to see every row the user owns: a scope that hid an incognito
	 * conversation's artifacts from the delete path would leave them on disk
	 * for ever, which is the opposite of what incognito promises.
	 */
	includeIncognito?: boolean;
};

export async function getArtifactOwnershipScope(
	userId: string,
	options: ArtifactOwnershipScopeOptions = {},
): Promise<ArtifactOwnershipScope> {
	const conversationRows = await db
		.select({
			id: conversations.id,
			memoryIncognito: conversations.memoryIncognito,
		})
		.from(conversations)
		.where(eq(conversations.userId, userId));

	// The CURRENT setting governs, as it does everywhere else incognito is
	// read (`memory-controls.ts`, `listUserChatFilesElsewhere`): the flag lives
	// on the chat, not on the file, and the user can move it either way.
	const reachable = conversationRows.filter(
		(row) =>
			options.includeIncognito === true ||
			!row.memoryIncognito ||
			row.id === options.conversationId,
	);

	return {
		conversationIds: new Set(reachable.map((row) => row.id)),
	};
}

export function buildArtifactVisibilityCondition(params: {
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
}) {
	const conditions = [eq(artifacts.userId, params.userId)];
	const conversationIds = Array.from(params.ownershipScope.conversationIds);

	if (conversationIds.length > 0) {
		conditions.push(inArray(artifacts.conversationId, conversationIds));
	}

	return or(...conditions);
}

/**
 * `isArtifactCanonicallyOwned` as a WHERE clause, for a query that cannot pair
 * its rows with the JS predicate — a `count(*)`.
 *
 * It exists because the Knowledge library's pagination had the two halves
 * disagreeing: the ROWS were filtered by `isArtifactCanonicallyOwned` after
 * they came back, and the `totalItems` beside them counted with only
 * `buildArtifactVisibilityCondition`, which is strictly wider. A linked or
 * non-owned artifact was therefore counted and not shown, and the library
 * advertised more documents than it could ever page through.
 *
 * Kept adjacent to the JS predicate on purpose, and `core.test.ts` drives the
 * same fixtures through both. Two spellings of one rule is exactly the pair
 * that drifted.
 */
export function buildArtifactCanonicalOwnershipCondition(params: {
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
}) {
	const conversationIds = Array.from(params.ownershipScope.conversationIds);
	// A row WITH a conversation is owned iff that conversation is the user's —
	// which, with no conversations at all, is never.
	const throughConversation =
		conversationIds.length > 0
			? and(
					isNotNull(artifacts.conversationId),
					inArray(artifacts.conversationId, conversationIds),
				)
			: sql`0 = 1`;

	// A row WITHOUT one falls back to the user stamp, except for the three
	// conversation-scoped working types, which require a live conversation
	// link and so are never owned once it is gone. The artifact family
	// (Feature 2's Document/App/Canvas/Slides rows, `type: "artifact"`) lives
	// beside one conversation the same way a `generated_output` row does — see
	// `isArtifactCanonicallyOwned` below — so it belongs in this exclusion
	// too, not just the two original working types.
	const throughUserStamp = and(
		isNull(artifacts.conversationId),
		eq(artifacts.userId, params.userId),
		notInArray(artifacts.type, [
			"generated_output",
			"work_capsule",
			"artifact",
		]),
	);

	return or(throughConversation, throughUserStamp);
}

export function isArtifactCanonicallyOwned(params: {
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
	artifact: ArtifactOwnershipCandidate;
}): boolean {
	const { artifact, ownershipScope, userId } = params;

	if (
		artifact.type === "generated_output" ||
		artifact.type === "work_capsule" ||
		// Feature 2's artifact family (Document/App/Canvas/Slides): it is
		// created inside, and belongs beside, exactly one conversation — the
		// mockup's own "what this chat made" framing, echoed throughout
		// AGENTS.md's Artifacts section. Falling through to the generic
		// `artifact.userId === userId` stamp below would let a row cleanup
		// preserved (kept because of an outside reference, e.g. a fork's
		// copied link) resurface for its owner the instant its own
		// conversation is deleted and `conversation_id` is cleared by the
		// `ON DELETE SET NULL` FK — including one made inside an incognito
		// conversation. Retrieval must stay closed even though the row itself
		// may still exist; see `isArtifactDeletableByUser` for why that is
		// still safe to delete.
		artifact.type === "artifact"
	) {
		return Boolean(
			artifact.conversationId &&
				ownershipScope.conversationIds.has(artifact.conversationId),
		);
	}

	if (artifact.conversationId) {
		return ownershipScope.conversationIds.has(artifact.conversationId);
	}

	return artifact.userId === userId;
}
