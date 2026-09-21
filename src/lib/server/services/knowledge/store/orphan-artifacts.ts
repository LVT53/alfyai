/**
 * Generated artifacts that nothing can reach any more.
 *
 * `artifacts.conversation_id` is `ON DELETE SET NULL`. Before release
 * f41f7931 a conversation delete therefore cleared the link on every
 * `generated_output` / `work_capsule` it preserved, and from that moment the
 * row was unreachable from every direction: `isArtifactCanonicallyOwned`
 * refuses those two types without a live conversation, so the Library did not
 * list it, GET answered 404, and the bulk "forget all" actions — which filter
 * by canonical ownership — skipped it. The row, its chunks, its stored file
 * and its MinerU parse bundle stayed on disk with nothing able to remove them.
 *
 * The delete path is fixed; what the fix cannot do is reach BACKWARDS, so
 * every box that ran the old code still carries whatever it stranded. This
 * module is the ONE definition of "stranded", shared by the maintenance script
 * (`scripts/sweep-orphan-generated-artifacts.ts`) and by the bulk cleanup
 * action. A sweep and a UI button that disagreed about which rows are
 * unreachable would be worse than either alone.
 *
 * REACHABILITY IS THE CONSERVATIVE SIDE. Every exclusion below asks "can
 * anything still get to this?" and answers yes on any doubt: an unreachable
 * row left behind costs disk, while a reachable row deleted costs a user their
 * work.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { selectInBatches } from "$lib/server/db/id-batches";
import {
	artifactLinks,
	artifacts,
	chatGeneratedFiles,
	conversations,
	messages,
} from "$lib/server/db/schema";
import { parseJsonRecord } from "$lib/server/utils/json";
import { parseWorkingDocumentMetadata } from "./document-metadata";

/** The two types `isArtifactCanonicallyOwned` strands when the link is cleared. */
export const ORPHANABLE_ARTIFACT_TYPES = [
	"generated_output",
	"work_capsule",
] as const;

export type OrphanableArtifactType = (typeof ORPHANABLE_ARTIFACT_TYPES)[number];

export interface OrphanGeneratedArtifact {
	id: string;
	userId: string;
	type: OrphanableArtifactType;
	name: string;
	storagePath: string | null;
	createdAt: Date;
}

type CandidateRow = {
	id: string;
	userId: string;
	type: string;
	name: string;
	storagePath: string | null;
	metadataJson: string | null;
	createdAt: Date;
};

/**
 * Every unreachable generated artifact, for one user or for the whole box.
 *
 * The SQL half is only the cheap, exact part of the question — one of the two
 * types, with `conversation_id IS NULL`. Each reachability exclusion is then a
 * single batched query, so the cost is a fixed number of round trips rather
 * than one per candidate.
 */
export async function listOrphanGeneratedArtifacts(
	options: { userId?: string } = {},
): Promise<OrphanGeneratedArtifact[]> {
	const candidates = (await db
		.select({
			id: artifacts.id,
			userId: artifacts.userId,
			type: artifacts.type,
			name: artifacts.name,
			storagePath: artifacts.storagePath,
			metadataJson: artifacts.metadataJson,
			createdAt: artifacts.createdAt,
		})
		.from(artifacts)
		.where(
			and(
				inArray(artifacts.type, [...ORPHANABLE_ARTIFACT_TYPES]),
				isNull(artifacts.conversationId),
				options.userId ? eq(artifacts.userId, options.userId) : undefined,
			),
		)) as CandidateRow[];
	if (candidates.length === 0) return [];

	const reachable = new Set<string>();
	for (const id of await candidatesWithLiveLink(candidates)) reachable.add(id);
	for (const id of await candidatesWithLiveChatFile(candidates)) {
		reachable.add(id);
	}
	for (const id of await candidatesInLiveDocumentFamily(
		candidates,
		reachable,
	)) {
		reachable.add(id);
	}

	return candidates
		.filter((row) => !reachable.has(row.id))
		.map((row) => ({
			id: row.id,
			userId: row.userId,
			type: row.type as OrphanableArtifactType,
			name: row.name,
			storagePath: row.storagePath,
			createdAt: row.createdAt,
		}));
}

/**
 * Candidates with an `artifact_links` row pointing at a conversation or a
 * message that still EXISTS.
 *
 * The liveness check is the point. `artifact_links.conversation_id` has no
 * cascade from `conversations`, so a link row pointing at a deleted
 * conversation is itself debris; counting it as reachability would make the
 * sweep a no-op on exactly the rows it exists to find.
 */
async function candidatesWithLiveLink(
	candidates: CandidateRow[],
): Promise<Set<string>> {
	const ids = candidates.map((row) => row.id);
	const candidateSet = new Set(ids);
	// Batched: this statement spends TWO bound parameters per candidate, so it
	// hit SQLite's 32766 ceiling at roughly 16k stranded rows — which is well
	// inside what a box that ran the old delete path for a year carries, and is
	// exactly the input this sweep exists for.
	const linkRows = await selectInBatches(ids, (batch) =>
		db
			.select({
				artifactId: artifactLinks.artifactId,
				relatedArtifactId: artifactLinks.relatedArtifactId,
				conversationId: artifactLinks.conversationId,
				messageId: artifactLinks.messageId,
			})
			.from(artifactLinks)
			.where(
				or(
					inArray(artifactLinks.artifactId, batch),
					inArray(artifactLinks.relatedArtifactId, batch),
				),
			),
	);
	if (linkRows.length === 0) return new Set();

	const conversationIds = uniqueStrings(
		linkRows.map((row) => row.conversationId),
	);
	const messageIds = uniqueStrings(linkRows.map((row) => row.messageId));

	const liveConversations = new Set(
		(
			await selectInBatches(conversationIds, (batch) =>
				db
					.select({ id: conversations.id })
					.from(conversations)
					.where(inArray(conversations.id, batch)),
			)
		).map((row) => row.id),
	);
	const liveMessages = new Set(
		(
			await selectInBatches(messageIds, (batch) =>
				db
					.select({ id: messages.id })
					.from(messages)
					.where(inArray(messages.id, batch)),
			)
		).map((row) => row.id),
	);

	const reachable = new Set<string>();
	for (const row of linkRows) {
		const live =
			(row.conversationId && liveConversations.has(row.conversationId)) ||
			(row.messageId && liveMessages.has(row.messageId));
		if (!live) continue;
		if (candidateSet.has(row.artifactId)) reachable.add(row.artifactId);
		if (row.relatedArtifactId && candidateSet.has(row.relatedArtifactId)) {
			reachable.add(row.relatedArtifactId);
		}
	}
	return reachable;
}

/**
 * Candidates whose chat file is still there.
 *
 * The conversation view serves a generated file out of `chat_generated_files`,
 * independently of the artifact row, so a candidate whose file row AND bytes
 * both survive is not stranded — something can still hand it to the user. Both
 * halves are required: a row whose file was already unlinked is as unreachable
 * as no row at all.
 */
async function candidatesWithLiveChatFile(
	candidates: CandidateRow[],
): Promise<Set<string>> {
	const byChatFileId = new Map<string, string[]>();
	for (const row of candidates) {
		const metadata = parseWorkingDocumentMetadata(
			parseJsonRecord(row.metadataJson),
		);
		const chatFileId = metadata.sourceChatFileId;
		if (!chatFileId) continue;
		byChatFileId.set(chatFileId, [
			...(byChatFileId.get(chatFileId) ?? []),
			row.id,
		]);
	}
	if (byChatFileId.size === 0) return new Set();

	const fileRows = await selectInBatches(
		Array.from(byChatFileId.keys()),
		(batch) =>
			db
				.select({
					id: chatGeneratedFiles.id,
					storagePath: chatGeneratedFiles.storagePath,
				})
				.from(chatGeneratedFiles)
				.where(inArray(chatGeneratedFiles.id, batch)),
	);

	const reachable = new Set<string>();
	for (const file of fileRows) {
		if (!existsSync(join(process.cwd(), file.storagePath))) continue;
		for (const artifactId of byChatFileId.get(file.id) ?? []) {
			reachable.add(artifactId);
		}
	}
	return reachable;
}

/**
 * Candidates in a document family that still has a reachable member.
 *
 * A generated document is versioned: v1 supersedes nothing, v2 supersedes v1,
 * and the Library shows the newest while the older versions stay behind it.
 * Deleting an older version out from under a live document would break "show
 * me what this looked like before", which is the whole point of keeping them —
 * so ANY reachable member keeps the whole family, not just a strictly newer
 * one. A family whose every member lost its conversation is genuinely
 * stranded, and those are the ones the sweep takes.
 */
async function candidatesInLiveDocumentFamily(
	candidates: CandidateRow[],
	alreadyReachable: ReadonlySet<string>,
): Promise<Set<string>> {
	const familyByCandidate = new Map<string, string>();
	for (const row of candidates) {
		const metadata = parseWorkingDocumentMetadata(
			parseJsonRecord(row.metadataJson),
		);
		if (metadata.documentFamilyId) {
			familyByCandidate.set(
				row.id,
				`${row.userId}:${metadata.documentFamilyId}`,
			);
		}
	}
	if (familyByCandidate.size === 0) return new Set();

	const owners = uniqueStrings(candidates.map((row) => row.userId));
	const siblings = (await selectInBatches(owners, (batch) =>
		db
			.select({
				id: artifacts.id,
				userId: artifacts.userId,
				conversationId: artifacts.conversationId,
				metadataJson: artifacts.metadataJson,
			})
			.from(artifacts)
			.where(
				and(
					inArray(artifacts.type, [...ORPHANABLE_ARTIFACT_TYPES]),
					inArray(artifacts.userId, batch),
				),
			),
	)) as Array<{
		id: string;
		userId: string;
		conversationId: string | null;
		metadataJson: string | null;
	}>;

	const candidateIds = new Set(candidates.map((row) => row.id));
	const liveFamilies = new Set<string>();
	for (const sibling of siblings) {
		const metadata = parseWorkingDocumentMetadata(
			parseJsonRecord(sibling.metadataJson),
		);
		if (!metadata.documentFamilyId) continue;
		// A sibling is reachable when it still has its conversation, when it was
		// never a candidate at all, or when one of the passes above already
		// judged it reachable.
		const reachable =
			sibling.conversationId !== null ||
			!candidateIds.has(sibling.id) ||
			alreadyReachable.has(sibling.id);
		if (reachable) {
			liveFamilies.add(`${sibling.userId}:${metadata.documentFamilyId}`);
		}
	}

	const keep = new Set<string>();
	for (const [candidateId, familyKey] of familyByCandidate) {
		if (liveFamilies.has(familyKey)) keep.add(candidateId);
	}
	return keep;
}

function uniqueStrings(values: Array<string | null>): string[] {
	return Array.from(new Set(values.filter((v): v is string => Boolean(v))));
}
