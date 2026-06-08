import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import type {
	Artifact,
	ArtifactSummary,
	KnowledgeDocumentItem,
	WorkCapsule,
} from "$lib/types";
import { mapWorkCapsuleFromArtifactRow } from "./knowledge/capsules";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	guessSummary,
	isArtifactCanonicallyOwned,
	knowledgeArtifactListSelection,
	listLogicalDocuments,
	mapArtifact,
	mapArtifactSummary,
} from "./knowledge/store";
import { queueArtifactSemanticEmbeddingRefresh } from "./semantic-embedding-refresh";
import { syncArtifactChunks } from "./task-state/chunk-sync";

export {
	createGeneratedOutputArtifact,
	upsertWorkCapsule,
} from "./knowledge/capsules";
export {
	findRelevantKnowledgeArtifacts,
	getConversationContextStatus,
	getConversationWorkingSet,
	refreshConversationWorkingSet,
	selectWorkingSetArtifactsForPrompt,
	updateConversationContextStatus,
} from "./knowledge/context";
export type { KnowledgeBulkAction } from "./knowledge/store";
export {
	AttachmentReadinessError,
	artifactHasReferencesOutsideConversation,
	assertPromptReadyAttachments,
	attachArtifactsToMessage,
	buildArtifactVisibilityCondition,
	createArtifactLink,
	createNormalizedArtifact,
	deleteArtifactForUser,
	deleteKnowledgeArtifactsByAction,
	getArtifactForUser,
	getArtifactOwnershipScope,
	getArtifactsForUser,
	getCompactionUiThreshold,
	getMaxModelContext,
	getSourceArtifactIdForNormalizedArtifact,
	getTargetConstructedContext,
	hardDeleteArtifactsForUser,
	isAttachmentReadinessError,
	listArtifactLinksForUser,
	listConversationArtifacts,
	listConversationOwnedArtifacts,
	listConversationSourceArtifactIds,
	listConversationSourceArtifactNames,
	listMessageAttachments,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifact,
	saveUploadedArtifactFromStoredFile,
	WORKING_SET_DOCUMENT_TOKEN_BUDGET,
	WORKING_SET_OUTPUT_TOKEN_BUDGET,
	WORKING_SET_PROMPT_TOKEN_BUDGET,
} from "./knowledge/store";

export async function listKnowledgeArtifacts(userId: string): Promise<{
	documents: KnowledgeDocumentItem[];
	results: ArtifactSummary[];
	workflows: WorkCapsule[];
}> {
	void import("./memory-maintenance")
		.then(({ runUserMemoryMaintenance }) =>
			runUserMemoryMaintenance(userId, "knowledge_read"),
		)
		.catch((error) => {
			console.error("[KNOWLEDGE] Deferred maintenance failed", {
				userId,
				error,
			});
		});

	const ownershipScope = await getArtifactOwnershipScope(userId);

	const rows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(buildArtifactVisibilityCondition({ userId, ownershipScope }))
		.orderBy(desc(artifacts.updatedAt));
	const scopedRows = rows.filter((row) =>
		isArtifactCanonicallyOwned({
			userId,
			ownershipScope,
			artifact: row,
		}),
	);

	const documents = await listLogicalDocuments(userId, {
		includeGeneratedOutputs: true,
	});

	const latestGeneratedByConversation = new Map<
		string,
		(typeof rows)[number]
	>();
	for (const row of scopedRows) {
		if (row.type !== "generated_output") continue;
		const key = row.conversationId ?? row.id;
		if (!latestGeneratedByConversation.has(key)) {
			latestGeneratedByConversation.set(key, row);
		}
	}

	return {
		documents,
		results: Array.from(latestGeneratedByConversation.values()).map(
			mapArtifactSummary,
		),
		workflows: scopedRows
			.filter((row) => row.type === "work_capsule")
			.map((row) => mapWorkCapsuleFromArtifactRow(row)),
	};
}

type SkillNoteArtifactMutationDb = Pick<typeof db, "insert" | "update">;

export function buildSkillNoteArtifactSummary(
	body: string,
	title: string,
): string {
	return guessSummary(body, title);
}

export async function getMutableSkillNoteArtifact(params: {
	userId: string;
	conversationId: string;
	artifactId: string;
}): Promise<Artifact | null> {
	const row = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, params.artifactId),
				eq(artifacts.userId, params.userId),
				eq(artifacts.conversationId, params.conversationId),
			),
		)
		.get();

	if (!row || row.type !== "skill_note") return null;
	return mapArtifact(row);
}

export function insertSkillNoteArtifactRecord(
	tx: SkillNoteArtifactMutationDb,
	params: {
		artifactId: string;
		userId: string;
		conversationId: string;
		title: string;
		body: string;
		metadata: Record<string, unknown>;
		now: Date;
	},
): void {
	tx.insert(artifacts)
		.values({
			id: params.artifactId,
			userId: params.userId,
			conversationId: params.conversationId,
			type: "skill_note",
			retrievalClass: "durable",
			name: params.title,
			mimeType: "text/markdown",
			extension: "md",
			sizeBytes: Buffer.byteLength(params.body, "utf8"),
			contentText: params.body,
			summary: buildSkillNoteArtifactSummary(params.body, params.title),
			metadataJson: JSON.stringify(params.metadata),
			updatedAt: params.now,
		})
		.run();
}

export function updateSkillNoteArtifactRecord(
	tx: SkillNoteArtifactMutationDb,
	params: {
		artifactId: string;
		name: string;
		body: string;
		metadata: Record<string, unknown>;
		now: Date;
	},
): void {
	tx.update(artifacts)
		.set({
			contentText: params.body,
			sizeBytes: Buffer.byteLength(params.body, "utf8"),
			summary: buildSkillNoteArtifactSummary(params.body, params.name),
			metadataJson: JSON.stringify(params.metadata),
			updatedAt: params.now,
		})
		.where(eq(artifacts.id, params.artifactId))
		.run();
}

export async function refreshSkillNoteArtifact(
	artifactId: string,
): Promise<void> {
	const row = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.get();
	if (!row || row.type !== "skill_note") return;
	const artifact = mapArtifact(row);
	await syncArtifactChunks({
		artifactId: artifact.id,
		userId: artifact.userId,
		conversationId: artifact.conversationId,
		contentText: artifact.contentText,
	});
	queueArtifactSemanticEmbeddingRefresh(artifact);
}
