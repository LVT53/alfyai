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
	getLogicalDocumentForArtifact,
	guessSummary,
	isArtifactCanonicallyOwned,
	knowledgeArtifactListSelection,
	listLogicalDocuments,
	listLogicalDocumentsPage,
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

export type KnowledgeLibrarySortKey = "name" | "size" | "type" | "date";
export type KnowledgeLibrarySortDirection = "asc" | "desc";

export interface KnowledgeLibraryPageOptions {
	query?: string | null;
	sortKey?: KnowledgeLibrarySortKey | null;
	sortDirection?: KnowledgeLibrarySortDirection | null;
	page?: number | null;
	pageSize?: number | null;
}

export interface KnowledgeLibraryPage {
	documents: KnowledgeDocumentItem[];
	query: string;
	sort: {
		key: KnowledgeLibrarySortKey;
		direction: KnowledgeLibrarySortDirection;
	};
	pagination: {
		page: number;
		pageSize: number;
		totalItems: number;
		totalPages: number;
	};
}

const KNOWLEDGE_LIBRARY_DEFAULT_PAGE_SIZE = 20;
const KNOWLEDGE_LIBRARY_MAX_PAGE_SIZE = 100;

function queueKnowledgeReadMaintenance(userId: string): void {
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
}

function normalizeLibraryQuery(value: string | null | undefined): string {
	return (value ?? "").toLowerCase().trim();
}

function resolveLibrarySortKey(
	value: KnowledgeLibraryPageOptions["sortKey"],
): KnowledgeLibrarySortKey {
	return value === "name" || value === "size" || value === "type"
		? value
		: "date";
}

function resolveLibrarySortDirection(
	value: KnowledgeLibraryPageOptions["sortDirection"],
): KnowledgeLibrarySortDirection {
	return value === "asc" ? "asc" : "desc";
}

function resolveLibraryPageSize(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return KNOWLEDGE_LIBRARY_DEFAULT_PAGE_SIZE;
	}
	const pageSize = Math.floor(value);
	if (pageSize < 1) return KNOWLEDGE_LIBRARY_DEFAULT_PAGE_SIZE;
	return Math.min(pageSize, KNOWLEDGE_LIBRARY_MAX_PAGE_SIZE);
}

function resolveLibraryPage(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 1;
	return Math.max(1, Math.floor(value));
}

export async function getKnowledgeLibraryPage(
	userId: string,
	options: KnowledgeLibraryPageOptions = {},
): Promise<KnowledgeLibraryPage> {
	queueKnowledgeReadMaintenance(userId);

	const query = normalizeLibraryQuery(options.query);
	const sortKey = resolveLibrarySortKey(options.sortKey);
	const sortDirection = resolveLibrarySortDirection(options.sortDirection);
	const pageSize = resolveLibraryPageSize(options.pageSize);
	const requestedPage = resolveLibraryPage(options.page);
	const requestedOffset = (requestedPage - 1) * pageSize;

	let libraryPage = await listLogicalDocumentsPage(userId, {
		includeGeneratedOutputs: true,
		query,
		sortKey,
		sortDirection,
		offset: requestedOffset,
		limit: pageSize,
	});
	const totalItems = libraryPage.totalItems;
	const totalPages = Math.ceil(totalItems / pageSize);
	const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
	const offset = (page - 1) * pageSize;

	if (offset !== requestedOffset) {
		libraryPage = await listLogicalDocumentsPage(userId, {
			includeGeneratedOutputs: true,
			query,
			sortKey,
			sortDirection,
			offset,
			limit: pageSize,
		});
	}

	return {
		documents: libraryPage.documents,
		query,
		sort: {
			key: sortKey,
			direction: sortDirection,
		},
		pagination: {
			page,
			pageSize,
			totalItems,
			totalPages,
		},
	};
}

export async function resolveKnowledgeWorkspaceDocument(
	userId: string,
	artifactId: string,
): Promise<KnowledgeDocumentItem | null> {
	return getLogicalDocumentForArtifact(userId, artifactId);
}

export async function listKnowledgeArtifacts(userId: string): Promise<{
	documents: KnowledgeDocumentItem[];
	results: ArtifactSummary[];
	workflows: WorkCapsule[];
}> {
	queueKnowledgeReadMaintenance(userId);

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

	if (row?.type !== "skill_note") return null;
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
	if (row?.type !== "skill_note") return;
	const artifact = mapArtifact(row);
	await syncArtifactChunks({
		artifactId: artifact.id,
		userId: artifact.userId,
		conversationId: artifact.conversationId,
		contentText: artifact.contentText,
	});
	queueArtifactSemanticEmbeddingRefresh(artifact);
}
