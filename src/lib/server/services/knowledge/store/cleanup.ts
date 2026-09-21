import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, like, ne, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { batchIds, selectInBatches } from "$lib/server/db/id-batches";
import {
	artifactLinks,
	artifacts,
	conversationWorkingSetItems,
	messages,
	taskStateEvidenceLinks,
} from "$lib/server/db/schema";
import { removeMineruParseBundle } from "$lib/server/services/mineru/bundle";
import { resolveDeletablePath } from "$lib/server/storage-containment";
import { parseJsonRecord } from "$lib/server/utils/json";
import {
	buildArtifactVisibilityCondition,
	getArtifactForUserToDelete,
	getArtifactOwnershipScope,
	isArtifactCanonicallyOwned,
	isArtifactDeletableByUser,
} from "./core";
import { parseWorkingDocumentMetadata } from "./document-metadata";
import { listLogicalDocuments } from "./documents";
import { listOrphanGeneratedArtifacts } from "./orphan-artifacts";

export async function hardDeleteArtifactsForUser(
	userId: string,
	artifactIds: string[],
): Promise<{
	deletedArtifactIds: string[];
	deletedStoragePaths: string[];
	failedStoragePaths: string[];
}> {
	const uniqueIds = Array.from(new Set(artifactIds));
	if (uniqueIds.length === 0) {
		return {
			deletedArtifactIds: [],
			deletedStoragePaths: [],
			failedStoragePaths: [],
		};
	}

	const ownershipScope = await getArtifactOwnershipScope(userId);
	// Batched from here down. A bulk "forget all" for a heavy user, and the
	// orphan sweep for a box that stranded rows for a year, both arrive here
	// with more ids than SQLite will bind into one `IN (...)` — and the
	// `artifact_links` delete below spends two parameters per id.
	const artifactsToDelete = await selectInBatches(uniqueIds, (batch) =>
		db
			.select()
			.from(artifacts)
			.where(
				and(
					inArray(artifacts.id, batch),
					buildArtifactVisibilityCondition({ userId, ownershipScope }),
				),
			),
	);
	// The DELETE authority, not the retrieval one: a row the user owns is theirs
	// to remove even after its conversation link was cleared. See
	// `isArtifactDeletableByUser`.
	const scopedArtifactsToDelete = artifactsToDelete.filter((row) =>
		isArtifactDeletableByUser({
			userId,
			ownershipScope,
			artifact: row,
		}),
	);
	const ids = scopedArtifactsToDelete.map((row) => row.id);

	if (ids.length === 0) {
		return {
			deletedArtifactIds: [],
			deletedStoragePaths: [],
			failedStoragePaths: [],
		};
	}

	// One transaction for the whole batch set, so a crash mid-way leaves either
	// every row or none: a half-applied delete would leave links pointing at
	// artifacts that are gone.
	await db.transaction((tx) => {
		for (const batch of batchIds(ids)) {
			tx.delete(conversationWorkingSetItems)
				.where(inArray(conversationWorkingSetItems.artifactId, batch))
				.run();

			tx.delete(taskStateEvidenceLinks)
				.where(inArray(taskStateEvidenceLinks.artifactId, batch))
				.run();

			tx.delete(artifactLinks)
				.where(
					or(
						inArray(artifactLinks.artifactId, batch),
						inArray(artifactLinks.relatedArtifactId, batch),
					),
				)
				.run();

			tx.delete(artifacts).where(inArray(artifacts.id, batch)).run();
		}
	});

	const deletedStoragePaths: string[] = [];
	const failedStoragePaths: string[] = [];
	for (const row of scopedArtifactsToDelete) {
		// The MinerU parse bundle is keyed on the artifact id, not on the
		// storage path, so it is removed for every row the delete covers —
		// which is what makes this work for both the direct
		// `deleteArtifactForUser` path and the source → normalized expansion.
		//
		// `row.userId`, NOT the acting `userId`. This function deliberately
		// covers rows the actor does not own but is canonically entitled to
		// delete (ownership through a conversation), and the bundle lives under
		// the OWNER's `data/knowledge/<userId>/` — the same directory
		// `row.storagePath` already names on the line below. Deriving it from
		// the deleter's id meant those rows lost their database row and kept
		// their bundle, permanently, in a directory nothing revisits.
		//
		// Best effort by design: `removeMineruParseBundle` warns rather than
		// throwing, because an orphaned bundle is a line in the disk report
		// while a throw here would abandon the remaining unlinks.
		await removeMineruParseBundle(row.userId, row.id).catch(() => undefined);

		if (!row.storagePath) continue;

		// Containment before the unlink. Every `storage_path` this app writes is
		// server-generated and safe, which is an argument about the writers, not
		// about this loop — and this loop is what the orphan sweep drives, box
		// wide, over every user's rows, from a maintenance script. One bad row
		// (a restore from an older schema, a hand-edited database) would
		// otherwise make it `unlink` whatever that row named. A refusal is
		// reported beside the unlinks that failed, so it reaches the disk
		// report instead of stopping a sweep with thousands of good rows left.
		const target = await resolveDeletablePath(row.storagePath);
		if (!target) {
			failedStoragePaths.push(row.storagePath);
			console.warn("[KNOWLEDGE_DELETE] Refused a path outside the data roots", {
				userId,
				artifactId: row.id,
			});
			continue;
		}

		try {
			await unlink(target);
			deletedStoragePaths.push(row.storagePath);
		} catch (error) {
			failedStoragePaths.push(row.storagePath);
			console.warn("[KNOWLEDGE_DELETE] File cleanup failed after DB deletion", {
				userId,
				artifactId: row.id,
				storagePath: row.storagePath,
				error,
			});
		}
	}

	return {
		deletedArtifactIds: ids,
		deletedStoragePaths,
		failedStoragePaths,
	};
}

export async function artifactHasReferencesOutsideConversation(
	userId: string,
	artifactId: string,
	conversationId: string,
): Promise<boolean> {
	const [artifactRow] = await db
		.select({ conversationId: artifacts.conversationId })
		.from(artifacts)
		.where(and(eq(artifacts.userId, userId), eq(artifacts.id, artifactId)))
		.limit(1);

	if (
		artifactRow?.conversationId &&
		artifactRow.conversationId !== conversationId
	) {
		return true;
	}

	const linkRows = await db
		.select({
			conversationId: artifactLinks.conversationId,
			messageConversationId: messages.conversationId,
		})
		.from(artifactLinks)
		.leftJoin(messages, eq(artifactLinks.messageId, messages.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				or(
					eq(artifactLinks.artifactId, artifactId),
					eq(artifactLinks.relatedArtifactId, artifactId),
				),
			),
		);

	if (
		linkRows.some((row) => {
			const linkedConversationId =
				row.conversationId ?? row.messageConversationId ?? null;
			return (
				linkedConversationId === null || linkedConversationId !== conversationId
			);
		})
	) {
		return true;
	}

	const [evidenceReference] = await db
		.select({ id: taskStateEvidenceLinks.id })
		.from(taskStateEvidenceLinks)
		.where(
			and(
				eq(taskStateEvidenceLinks.userId, userId),
				eq(taskStateEvidenceLinks.artifactId, artifactId),
				ne(taskStateEvidenceLinks.conversationId, conversationId),
			),
		)
		.limit(1);

	if (evidenceReference) {
		return true;
	}

	const [workingSetReference] = await db
		.select({ id: conversationWorkingSetItems.id })
		.from(conversationWorkingSetItems)
		.where(
			and(
				eq(conversationWorkingSetItems.userId, userId),
				eq(conversationWorkingSetItems.artifactId, artifactId),
				ne(conversationWorkingSetItems.conversationId, conversationId),
			),
		)
		.limit(1);

	return Boolean(workingSetReference);
}

export async function deleteArtifactForUser(
	userId: string,
	artifactId: string,
): Promise<{
	deletedArtifactIds: string[];
	deletedStoragePaths: string[];
	failedStoragePaths: string[];
} | null> {
	const startedAt = Date.now();
	const artifact = await getArtifactForUserToDelete(userId, artifactId);
	if (!artifact) return null;

	const artifactIdsToDelete = new Set<string>([artifact.id]);
	if (artifact.type === "source_document") {
		const derivedRows = await db
			.select({ artifact: artifacts })
			.from(artifactLinks)
			.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
			.where(
				and(
					eq(artifactLinks.userId, userId),
					eq(artifactLinks.relatedArtifactId, artifact.id),
					eq(artifactLinks.linkType, "derived_from"),
					eq(artifacts.type, "normalized_document"),
				),
			);

		for (const row of derivedRows) {
			artifactIdsToDelete.add(row.artifact.id);
		}
	}

	if (artifact.type === "generated_output") {
		const metadata = parseWorkingDocumentMetadata(artifact.metadata);
		const documentFamilyId = metadata.documentFamilyId;

		if (documentFamilyId) {
			const ownershipScope = await getArtifactOwnershipScope(userId);
			// Use LIKE prefilter to narrow scope before in-memory verification
			const familyRows = await db
				.select()
				.from(artifacts)
				.where(
					and(
						eq(artifacts.userId, userId),
						eq(artifacts.type, "generated_output"),
						like(
							artifacts.metadataJson,
							`%"documentFamilyId":"${documentFamilyId}"%`,
						),
						buildArtifactVisibilityCondition({ userId, ownershipScope }),
					),
				);

			for (const row of familyRows) {
				const rowMetadata = parseWorkingDocumentMetadata(
					parseJsonRecord(row.metadataJson),
				);
				// Double-check the family ID matches (LIKE is approximate)
				if (rowMetadata.documentFamilyId === documentFamilyId) {
					// The delete authority again: a family whose conversation is gone
					// must still come away whole rather than leaving detached versions.
					if (
						isArtifactDeletableByUser({
							userId,
							ownershipScope,
							artifact: row,
						})
					) {
						artifactIdsToDelete.add(row.id);
					}
				}
			}
		}
	}

	const ids = Array.from(artifactIdsToDelete);
	const result = await hardDeleteArtifactsForUser(userId, ids);
	console.info("[KNOWLEDGE_DELETE] Artifact delete completed", {
		userId,
		artifactId: artifact.id,
		artifactType: artifact.type,
		derivedArtifactIds: ids.filter((id) => id !== artifact.id),
		deletedArtifactIds: result.deletedArtifactIds,
		deletedStoragePathCount: result.deletedStoragePaths.length,
		failedStoragePathCount: result.failedStoragePaths.length,
		durationMs: Date.now() - startedAt,
	});
	if (result.failedStoragePaths.length > 0) {
		console.warn(
			"[KNOWLEDGE_DELETE] Artifact delete completed with file cleanup gaps",
			{
				userId,
				artifactId: artifact.id,
				failedStoragePaths: result.failedStoragePaths,
			},
		);
	}
	return result;
}

export type KnowledgeBulkAction =
	| "forget_all_documents"
	| "forget_all_results"
	| "forget_all_workflows";

async function listDocumentRootArtifactIds(userId: string): Promise<string[]> {
	const documents = await listLogicalDocuments(userId);
	return documents.map((document) => document.id);
}

async function listOwnedArtifactIdsByType(
	userId: string,
	artifactType: "generated_output" | "work_capsule",
): Promise<string[]> {
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, userId),
				eq(artifacts.type, artifactType),
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
		.map((row) => row.id);
}

export async function deleteKnowledgeArtifactsByAction(
	userId: string,
	action: KnowledgeBulkAction,
): Promise<{
	deletedArtifactIds: string[];
	deletedStoragePaths: string[];
	failedStoragePaths: string[];
}> {
	// Both working types are stranded the same way and must be swept the same
	// way. A `generated_output` or a `work_capsule` whose conversation was
	// deleted before release f41f7931 has a null `conversation_id`, which
	// `isArtifactCanonicallyOwned` reads as "not this user's" — so the bulk
	// buttons quietly left behind exactly the rows a user most wants gone.
	// `listOrphanGeneratedArtifacts` is the ONE definition of unreachable, the
	// same one the maintenance sweep uses, and `hardDeleteArtifactsForUser`
	// still applies the DELETE authority to every id it returns.
	//
	// `forget_all_results` learned this first and `forget_all_workflows` did
	// not, which left one button fixed and the other still skipping the
	// capsules — one predicate, two answers, which is the failure this module
	// exists to prevent.
	const bulkArtifactType =
		action === "forget_all_results"
			? "generated_output"
			: action === "forget_all_workflows"
				? "work_capsule"
				: null;

	if (bulkArtifactType) {
		const ownedArtifactIds = await listOwnedArtifactIdsByType(
			userId,
			bulkArtifactType,
		);
		const orphans = await listOrphanGeneratedArtifacts({ userId });
		return hardDeleteArtifactsForUser(userId, [
			...ownedArtifactIds,
			...orphans
				.filter((row) => row.type === bulkArtifactType)
				.map((row) => row.id),
		]);
	}

	const rootArtifactIds = await listDocumentRootArtifactIds(userId);

	if (rootArtifactIds.length === 0) {
		return {
			deletedArtifactIds: [],
			deletedStoragePaths: [],
			failedStoragePaths: [],
		};
	}

	const expandedIds = new Set<string>(rootArtifactIds);
	if (action === "forget_all_documents") {
		const derivedRows = await db
			.select({ artifactId: artifactLinks.artifactId })
			.from(artifactLinks)
			.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
			.where(
				and(
					eq(artifactLinks.userId, userId),
					inArray(artifactLinks.relatedArtifactId, rootArtifactIds),
					eq(artifactLinks.linkType, "derived_from"),
					eq(artifacts.type, "normalized_document"),
				),
			);
		for (const row of derivedRows) {
			expandedIds.add(row.artifactId);
		}
	}

	return hardDeleteArtifactsForUser(userId, Array.from(expandedIds));
}
