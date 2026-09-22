import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "$lib/server/db";
import { artifactLinks, artifacts, conversations } from "$lib/server/db/schema";
import type {
	Artifact,
	ArtifactLink,
	ArtifactSummary,
	ArtifactType,
} from "$lib/server/services/knowledge/types";
import type { ChunkPlanEntry } from "$lib/server/services/mineru/result";
import { parseJsonRecord } from "$lib/server/utils/json";
import { fileExtension as registryFileExtension } from "$lib/shared/file-types";
import {
	getDocumentTokenBudget,
	getCompactionUiThreshold as getPerModelCompactionThreshold,
	getMaxModelContext as getPerModelMaxContext,
	getTargetConstructedContext as getPerModelTargetContext,
	getSmallFileThreshold,
	getWorkingSetPromptTokenBudget,
} from "../../../config-store";
import { queueArtifactSemanticEmbeddingRefresh } from "../../semantic-embedding-refresh";
import { syncArtifactChunks } from "../../task-state/chunk-sync";
import {
	readStoredOutline,
	readStoredPageCount,
	readStoredPageCountKind,
	readStoredTokenEstimate,
} from "../outline";

export function getMaxModelContext(modelId?: string): number {
	return getPerModelMaxContext(modelId);
}

export function getCompactionUiThreshold(modelId?: string): number {
	return getPerModelCompactionThreshold(modelId);
}

export function getTargetConstructedContext(modelId?: string): number {
	return getPerModelTargetContext(modelId);
}

export const WORKING_SET_PROMPT_TOKEN_BUDGET = 3_000;
export const WORKING_SET_DOCUMENT_TOKEN_BUDGET = 1_200;
export const WORKING_SET_OUTPUT_TOKEN_BUDGET = 1_000;

export {
	getDocumentTokenBudget,
	getSmallFileThreshold,
	getWorkingSetPromptTokenBudget,
};

type ArtifactSummaryRow = Pick<
	typeof artifacts.$inferSelect,
	| "id"
	| "type"
	| "retrievalClass"
	| "name"
	| "mimeType"
	| "sizeBytes"
	| "conversationId"
	| "summary"
	| "createdAt"
	| "updatedAt"
> & {
	// Present whenever the row came from a full `artifacts` select or from
	// `knowledgeArtifactListSelection` (both include it); absent for the
	// handful of narrower ad-hoc selections. Long-document comfort fields
	// are simply omitted from the mapped summary when it's missing.
	metadataJson?: string | null;
};

export type ArtifactOwnershipScope = {
	conversationIds: Set<string>;
};

type ArtifactOwnershipCandidate = Pick<
	typeof artifacts.$inferSelect,
	"userId" | "type" | "conversationId"
>;

export const knowledgeArtifactListSelection = {
	id: artifacts.id,
	userId: artifacts.userId,
	type: artifacts.type,
	retrievalClass: artifacts.retrievalClass,
	name: artifacts.name,
	mimeType: artifacts.mimeType,
	sizeBytes: artifacts.sizeBytes,
	conversationId: artifacts.conversationId,
	summary: artifacts.summary,
	metadataJson: artifacts.metadataJson,
	createdAt: artifacts.createdAt,
	updatedAt: artifacts.updatedAt,
} as const;

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

	// A row WITHOUT one falls back to the user stamp, except for the two
	// working types, which require a live conversation link and so are never
	// owned once it is gone.
	const throughUserStamp = and(
		isNull(artifacts.conversationId),
		eq(artifacts.userId, params.userId),
		notInArray(artifacts.type, ["generated_output", "work_capsule"]),
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
		artifact.type === "work_capsule"
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

/**
 * Whether this user may DELETE this row — a different question from whether the
 * artifact may be RETRIEVED, which `isArtifactCanonicallyOwned` answers.
 *
 * The two were the same function once, and that is how a `generated_output`
 * became undeletable. Retrieval deliberately requires a LIVE conversation link
 * for `generated_output` / `work_capsule`: a working artifact whose
 * conversation is gone must never come back as context. But `conversation_id`
 * is `ON DELETE SET NULL`, so deleting a conversation cleared the link on every
 * artifact the cleanup pass chose to preserve — and from that moment the row
 * was invisible in the library, 404 on GET, and answered "already removed" on
 * DELETE while it, its chunks, its stored file and its MinerU parse bundle sat
 * on disk with no way for anyone to ever remove them.
 *
 * Deletion asks something simpler and stricter than retrieval: is this the
 * user's OWN row, or one they hold through a live conversation of theirs? A row
 * stamped with the user's id is theirs to delete whatever its `conversation_id`
 * says — it is the same row the account data archive ships to them and the same
 * row an account erasure removes. The conversation branch is kept because
 * `hardDeleteArtifactsForUser` deliberately covers rows the actor does not own
 * but is entitled to delete through a conversation.
 */
export function isArtifactDeletableByUser(params: {
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
	artifact: ArtifactOwnershipCandidate;
}): boolean {
	const { artifact, ownershipScope, userId } = params;

	if (artifact.userId === userId) return true;

	return Boolean(
		artifact.conversationId &&
			ownershipScope.conversationIds.has(artifact.conversationId),
	);
}

export function mapArtifactSummary(row: ArtifactSummaryRow): ArtifactSummary {
	const metadata = parseJsonRecord(row.metadataJson ?? null);
	const tokenEstimate = readStoredTokenEstimate(metadata?.tokenEstimate);
	const pageCount = readStoredPageCount(metadata?.pageCount);
	const pageCountKind = readStoredPageCountKind(metadata?.pageCountKind);
	const outline = readStoredOutline(metadata?.outline);

	return {
		id: row.id,
		type: row.type as ArtifactType,
		retrievalClass: (row.retrievalClass ??
			"durable") as ArtifactSummary["retrievalClass"],
		name: row.name,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes ?? null,
		conversationId: row.conversationId ?? null,
		summary: row.summary ?? null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
		...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
		...(pageCount !== undefined ? { pageCount } : {}),
		...(pageCountKind !== undefined ? { pageCountKind } : {}),
		...(outline.length > 0 ? { outline } : {}),
	};
}

export function mapArtifact(row: typeof artifacts.$inferSelect): Artifact {
	return {
		...mapArtifactSummary(row),
		userId: row.userId,
		extension: row.extension ?? null,
		storagePath: row.storagePath ?? null,
		contentText: row.contentText ?? null,
		metadata: parseJsonRecord(row.metadataJson ?? null),
	};
}

function mapArtifactLink(row: typeof artifactLinks.$inferSelect): ArtifactLink {
	return {
		id: row.id,
		userId: row.userId,
		artifactId: row.artifactId,
		relatedArtifactId: row.relatedArtifactId ?? null,
		conversationId: row.conversationId ?? null,
		messageId: row.messageId ?? null,
		linkType: row.linkType as ArtifactLink["linkType"],
		createdAt: row.createdAt.getTime(),
	};
}

/**
 * The registry parser, wrapped to keep this module's `string | null` contract
 * (callers at `attachments.ts:402,479,583` test for null). Note it is no
 * longer `extname`-based: a dotfile like `.env` now answers "env" rather than
 * null, which is the behaviour `attachment-file-type.ts` always had and the
 * one the registry standardises on (spec open question 13).
 */
export function fileExtension(name: string): string | null {
	return registryFileExtension(name) || null;
}

export function knowledgeUserDir(userId: string): string {
	return join(process.cwd(), "data", "knowledge", userId);
}

export function guessSummary(text: string | null, fallback: string): string {
	const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
	return trimmed ? trimmed.slice(0, 240) : fallback.slice(0, 240);
}

export function safeStem(name: string): string {
	const stem = basename(name, extname(name)).trim();
	return stem.length > 0 ? stem : "artifact";
}

export function hashBinaryBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

export async function findExistingArtifactByBinaryHash(params: {
	userId: string;
	binaryHash: string;
}): Promise<Artifact | null> {
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.binaryHash, params.binaryHash),
				eq(artifacts.type, "source_document"),
			),
		)
		.limit(1);

	const existing = rows[0];
	if (!existing || existing.binaryHash !== params.binaryHash) {
		return null;
	}

	return mapArtifact(existing);
}

export async function createArtifact(params: {
	id?: string;
	userId: string;
	conversationId?: string | null;
	type: ArtifactType;
	retrievalClass?: Artifact["retrievalClass"];
	name: string;
	mimeType?: string | null;
	extension?: string | null;
	sizeBytes?: number | null;
	binaryHash?: string | null;
	storagePath?: string | null;
	contentText?: string | null;
	summary?: string | null;
	metadata?: Record<string, unknown> | null;
	/**
	 * A structure-aware chunk plan for this artifact's text, from
	 * `planStructuredChunks`. Forwarded verbatim to `syncArtifactChunks`,
	 * which decides whether to use it (the small-file bypass and the
	 * `MINERU_STRUCTURE_CHUNKING_ENABLED` flag both outrank it). Omitted by
	 * every caller that has no parsed blocks, which is all of them but the
	 * extraction persist path.
	 */
	chunkPlan?: readonly ChunkPlanEntry[] | null;
	/**
	 * `chunkPlanSourceDigest()` of the text the plan was derived from.
	 * Forwarded verbatim; a plan whose digest does not match `contentText` is
	 * ignored by the sync in favour of the character chunker.
	 */
	chunkPlanSourceDigest?: string | null;
}): Promise<Artifact> {
	const id = params.id ?? randomUUID();
	const [artifact] = await db
		.insert(artifacts)
		.values({
			id,
			userId: params.userId,
			conversationId: params.conversationId ?? null,
			type: params.type,
			retrievalClass: params.retrievalClass ?? "durable",
			name: params.name,
			mimeType: params.mimeType ?? null,
			extension: params.extension ?? null,
			sizeBytes: params.sizeBytes ?? null,
			binaryHash: params.binaryHash ?? null,
			storagePath: params.storagePath ?? null,
			contentText: params.contentText ?? null,
			summary: params.summary ?? null,
			metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
			updatedAt: new Date(),
		})
		.returning();

	let mapped = mapArtifact(artifact);
	try {
		const sync = await syncArtifactChunks({
			artifactId: mapped.id,
			userId: mapped.userId,
			conversationId: mapped.conversationId,
			contentText: mapped.contentText,
			chunkPlan: params.chunkPlan ?? null,
			chunkPlanSourceDigest: params.chunkPlanSourceDigest ?? null,
		});
		if (sync.truncated) {
			// Retrieval now sees only the first `MAX_ARTIFACT_CHUNKS` of this
			// document. Recording it on the artifact is what keeps that from being
			// a silent fact: anything that reads the artifact — the extraction
			// ledger's diagnostics, a future prompt assembler, an operator looking
			// at why a search misses the end of a file — can see it.
			const patch = {
				chunksTruncated: true,
				chunkCount: sync.chunkCount,
				chunkCountBeforeTruncation: sync.totalChunks,
			};
			await updateArtifactMetadata({
				artifactId: mapped.id,
				userId: mapped.userId,
				patch,
			});
			mapped = { ...mapped, metadata: { ...mapped.metadata, ...patch } };
		}
	} catch (error) {
		// The artifact row is already committed at this point. Leaving it would
		// mean an artifact with zero chunks whose full `contentText` still
		// reaches the prompt pipeline and which retrieval can never search —
		// worse than no artifact at all, and invisible. Drop it and let the
		// caller see the failure. The delete is best-effort: if it also fails,
		// the original error is still what the caller needs.
		await db
			.delete(artifacts)
			.where(eq(artifacts.id, mapped.id))
			.catch(() => undefined);
		throw error;
	}
	queueArtifactSemanticEmbeddingRefresh(mapped);

	return mapped;
}

export async function updateArtifactBinaryHash(
	artifactId: string,
	binaryHash: string,
): Promise<void> {
	await db
		.update(artifacts)
		.set({
			binaryHash,
			updatedAt: new Date(),
		})
		.where(eq(artifacts.id, artifactId));
}

/** Merges `patch` into an artifact's existing metadata JSON (last-write-wins
 * per key). Used at ingestion to attach long-document comfort fields
 * (tokenEstimate/pageCount/outline) onto the source artifact after
 * extraction completes, without disturbing the rest of its metadata
 * (uploadSource, renamed, etc).
 *
 * `userId` is required and scopes both the read and the write: an artifact id
 * alone is guessable/enumerable, so an id-only UPDATE would let one user's
 * ingestion patch metadata onto another user's artifact. Callers must pass the
 * server-derived owner id, never one taken from a request body. A mismatch is
 * a silent no-op (the same shape a missing artifact already had). */
export async function updateArtifactMetadata(params: {
	artifactId: string;
	userId: string;
	patch: Record<string, unknown>;
}): Promise<void> {
	const scope = and(
		eq(artifacts.id, params.artifactId),
		eq(artifacts.userId, params.userId),
	);

	const rows = await db
		.select({ metadataJson: artifacts.metadataJson })
		.from(artifacts)
		.where(scope)
		.limit(1);

	// No row for this (id, owner) pair — nothing this user may patch.
	if (rows.length === 0) return;

	const existing = parseJsonRecord(rows[0]?.metadataJson ?? null) ?? {};
	const merged = { ...existing, ...params.patch };

	await db
		.update(artifacts)
		.set({
			metadataJson: JSON.stringify(merged),
			updatedAt: new Date(),
		})
		.where(scope);
}

export async function getNormalizedArtifactForSource(
	userId: string,
	sourceArtifactId: string,
): Promise<Artifact | null> {
	const rows = await db
		.select({ artifact: artifacts })
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				eq(artifactLinks.relatedArtifactId, sourceArtifactId),
				eq(artifactLinks.linkType, "derived_from"),
				eq(artifacts.type, "normalized_document"),
			),
		)
		.orderBy(asc(artifactLinks.createdAt))
		.limit(1);

	return rows[0] ? mapArtifact(rows[0].artifact) : null;
}

export function withAttachmentDisplayName(
	promptArtifact: Artifact,
	displayArtifact: Artifact,
): Artifact {
	return {
		...promptArtifact,
		name: displayArtifact.name,
		mimeType: displayArtifact.mimeType ?? promptArtifact.mimeType,
		sizeBytes: displayArtifact.sizeBytes ?? promptArtifact.sizeBytes,
	};
}

export async function createArtifactLink(params: {
	userId: string;
	artifactId: string;
	linkType: ArtifactLink["linkType"];
	relatedArtifactId?: string | null;
	conversationId?: string | null;
	messageId?: string | null;
}): Promise<ArtifactLink> {
	const [row] = await db
		.insert(artifactLinks)
		.values({
			id: randomUUID(),
			userId: params.userId,
			artifactId: params.artifactId,
			linkType: params.linkType,
			relatedArtifactId: params.relatedArtifactId ?? null,
			conversationId: params.conversationId ?? null,
			messageId: params.messageId ?? null,
		})
		.returning();
	return mapArtifactLink(row);
}

/**
 * One artifact the user holds, BY ID.
 *
 * `includeIncognito` because this is authorization, not discovery: the id
 * comes from a caller that already has it — a file card in the chat that made
 * it, a preview or figure URL, a working-set row — and an incognito
 * conversation has to keep working from the inside. Nothing here can be
 * enumerated: the queries that hand out ids (the library listing, search, the
 * semantic candidate pool) all take the strict scope, so an incognito
 * artifact's id never leaves the conversation that produced it.
 */
export async function getArtifactForUser(
	userId: string,
	artifactId: string,
): Promise<Artifact | null> {
	const ownershipScope = await getArtifactOwnershipScope(userId, {
		includeIncognito: true,
	});
	const [row] = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, artifactId),
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
			),
		);
	if (
		!row ||
		!isArtifactCanonicallyOwned({
			userId,
			ownershipScope,
			artifact: row,
		})
	) {
		return null;
	}
	return mapArtifact(row);
}

/**
 * The same lookup, under the DELETE authority instead of the retrieval one.
 *
 * `getArtifactForUser` above is the right gate for reading an artifact and the
 * wrong one for removing it: it hides a `generated_output` whose conversation
 * link has been cleared, which is precisely the row a user most needs to be
 * able to delete. See `isArtifactDeletableByUser`.
 */
export async function getArtifactForUserToDelete(
	userId: string,
	artifactId: string,
): Promise<Artifact | null> {
	const ownershipScope = await getArtifactOwnershipScope(userId, {
		includeIncognito: true,
	});
	const [row] = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, artifactId),
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
			),
		);
	if (
		!row ||
		!isArtifactDeletableByUser({
			userId,
			ownershipScope,
			artifact: row,
		})
	) {
		return null;
	}
	return mapArtifact(row);
}

export async function listArtifactLinksForUser(
	userId: string,
	artifactId: string,
): Promise<ArtifactLink[]> {
	const rows = await db
		.select()
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, userId),
				eq(artifactLinks.artifactId, artifactId),
			),
		)
		.orderBy(desc(artifactLinks.createdAt));
	return rows.map(mapArtifactLink);
}

/** The batched twin of {@link getArtifactForUser}, and scoped like it. */
export async function getArtifactsForUser(
	userId: string,
	artifactIds: string[],
): Promise<Artifact[]> {
	if (artifactIds.length === 0) return [];
	const ownershipScope = await getArtifactOwnershipScope(userId, {
		includeIncognito: true,
	});
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				inArray(artifacts.id, artifactIds),
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
			),
		);
	return rows
		.filter((row) =>
			isArtifactCanonicallyOwned({
				userId,
				ownershipScope,
				artifact: row,
			}),
		)
		.map(mapArtifact);
}

export async function listConversationOwnedArtifacts(
	userId: string,
	conversationId: string,
): Promise<Artifact[]> {
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, userId),
				eq(artifacts.conversationId, conversationId),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	return rows.map(mapArtifact);
}

export async function getSourceArtifactIdForNormalizedArtifact(
	userId: string,
	normalizedArtifactId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ sourceArtifactId: artifactLinks.relatedArtifactId })
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				eq(artifactLinks.artifactId, normalizedArtifactId),
				eq(artifactLinks.linkType, "derived_from"),
				eq(artifacts.type, "normalized_document"),
			),
		)
		.limit(1);

	return row?.sourceArtifactId ?? null;
}

export async function listConversationArtifacts(
	userId: string,
	conversationId: string,
): Promise<ArtifactSummary[]> {
	// Return artifacts with a pending (messageId IS NULL) conversation link,
	// but exclude any that have already been consumed by a message.  A LEFT
	// JOIN against message-level links filters them out while preserving the
	// original pending links that workspace and document systems rely on.
	const messageLinks = alias(artifactLinks, "message_links");

	const rows = await db
		.select({ artifact: artifacts })
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.leftJoin(
			messageLinks,
			and(
				eq(messageLinks.artifactId, artifactLinks.artifactId),
				eq(messageLinks.conversationId, conversationId),
				eq(messageLinks.linkType, "attached_to_conversation"),
				isNotNull(messageLinks.messageId),
			),
		)
		.where(
			and(
				eq(artifactLinks.userId, userId),
				eq(artifactLinks.conversationId, conversationId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				isNull(artifactLinks.messageId),
				isNull(messageLinks.id),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const unique = new Map<string, ArtifactSummary>();
	for (const row of rows) {
		unique.set(row.artifact.id, mapArtifactSummary(row.artifact));
	}
	return Array.from(unique.values());
}
