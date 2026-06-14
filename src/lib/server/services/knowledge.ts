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

function tokenizeLibraryQuery(query: string): string[] {
	return Array.from(
		new Set(
			normalizeLibraryQuery(query)
				.split(/\s+/)
				.filter((term) => term.length > 1),
		),
	);
}

function scoreLibraryTermMatches(
	target: string,
	terms: string[],
	weight: number,
): number {
	if (!target || terms.length === 0) return 0;
	let score = 0;
	for (const term of terms) {
		if (target.includes(term)) {
			score += weight;
		}
	}
	return score;
}

function getLibraryDocumentKind(
	document: KnowledgeDocumentItem,
): "generated" | "skill_note" | "uploaded" {
	if (
		document.documentOrigin === "skill_note" ||
		document.type === "skill_note"
	) {
		return "skill_note";
	}
	return document.documentOrigin === "generated" ||
		document.type === "generated_output"
		? "generated"
		: "uploaded";
}

function scoreLibraryDocumentForSearch(
	document: KnowledgeDocumentItem,
	query: string,
): number {
	const normalizedQuery = normalizeLibraryQuery(query);
	if (!normalizedQuery) return 1;

	const terms = tokenizeLibraryQuery(normalizedQuery);
	const name = normalizeLibraryQuery(document.name);
	const label = normalizeLibraryQuery(document.documentLabel ?? null);
	const role = normalizeLibraryQuery(document.documentRole ?? null);
	const summary = normalizeLibraryQuery(document.summary ?? null);
	const kind = getLibraryDocumentKind(document);

	let score = 0;

	if (name.includes(normalizedQuery)) score += 70;
	if (label.includes(normalizedQuery)) score += 60;
	if (summary.includes(normalizedQuery)) score += 28;
	if (role.includes(normalizedQuery)) score += 18;
	if (kind.includes(normalizedQuery)) score += 12;

	score += scoreLibraryTermMatches(name, terms, 18);
	score += scoreLibraryTermMatches(label, terms, 15);
	score += scoreLibraryTermMatches(summary, terms, 6);
	score += scoreLibraryTermMatches(role, terms, 5);

	return score;
}

function compareLibraryText(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		sensitivity: "base",
		numeric: true,
	});
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

function sortLibraryDocuments(
	entries: Array<{ document: KnowledgeDocumentItem; score: number }>,
	options: {
		query: string;
		sortKey: KnowledgeLibrarySortKey;
		sortDirection: KnowledgeLibrarySortDirection;
	},
): KnowledgeDocumentItem[] {
	const direction = options.sortDirection === "asc" ? 1 : -1;
	const sorted = [...entries];

	sorted.sort((leftEntry, rightEntry) => {
		const left = leftEntry.document;
		const right = rightEntry.document;

		if (options.query && leftEntry.score !== rightEntry.score) {
			return rightEntry.score - leftEntry.score;
		}

		if (options.sortKey === "name") {
			const byName = compareLibraryText(left.name, right.name) * direction;
			if (byName !== 0) return byName;
		}

		if (options.sortKey === "size") {
			const bySize =
				((left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)) * direction;
			if (bySize !== 0) return bySize;
		}

		if (options.sortKey === "type") {
			const byType =
				compareLibraryText(
					getLibraryDocumentKind(left),
					getLibraryDocumentKind(right),
				) * direction;
			if (byType !== 0) return byType;
		}

		if (options.sortKey === "date") {
			const byDate =
				((left.createdAt ?? 0) - (right.createdAt ?? 0)) * direction;
			if (byDate !== 0) return byDate;
		}

		const byNameTie = compareLibraryText(left.name, right.name);
		if (byNameTie !== 0) return byNameTie;
		const byDateTie = (right.createdAt ?? 0) - (left.createdAt ?? 0);
		if (byDateTie !== 0) return byDateTie;
		return compareLibraryText(left.id, right.id);
	});

	return sorted.map((entry) => entry.document);
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

	const logicalDocuments = await listLogicalDocuments(userId, {
		includeGeneratedOutputs: true,
	});
	const searchedDocuments = logicalDocuments
		.filter((document) => document.type !== "normalized_document")
		.map((document) => ({
			document,
			score: scoreLibraryDocumentForSearch(document, query),
		}))
		.filter((entry) => !query || entry.score > 0);
	const sortedDocuments = sortLibraryDocuments(searchedDocuments, {
		query,
		sortKey,
		sortDirection,
	});

	const totalItems = sortedDocuments.length;
	const totalPages = Math.ceil(totalItems / pageSize);
	const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
	const start = (page - 1) * pageSize;

	return {
		documents: sortedDocuments.slice(start, start + pageSize),
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
