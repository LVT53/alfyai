import { join } from "node:path";
import { and, asc, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactLinks, artifacts } from "$lib/server/db/schema";
import { parseJsonRecord } from "$lib/server/utils/json";
import type {
	Artifact,
	ArtifactSummary,
	ArtifactType,
	KnowledgeDocumentItem,
} from "$lib/types";
import { computeDecayScore } from "../../../utils/artifact-decay";
import { extractDocumentText } from "../../document-extraction";
import { shortlistSemanticMatchesBySubject } from "../../semantic-ranking";
import {
	determineTeiWinningMode,
	logTeiRetrievalSummary,
	type SemanticShortlistDiagnostics,
	type TeiRerankDiagnostics,
} from "../../tei-observability";
import { canUseTeiReranker, rerankItems } from "../../tei-reranker";
import { scoreMatch } from "../../working-set";
import {
	buildArtifactVisibilityCondition,
	createArtifact,
	createArtifactLink,
	getArtifactOwnershipScope,
	guessSummary,
	isArtifactCanonicallyOwned,
	knowledgeArtifactListSelection,
	mapArtifact,
	mapArtifactSummary,
} from "./core";
import {
	getArtifactDocumentOrigin,
	parseWorkingDocumentMetadata,
} from "./document-metadata";
import { resolveWorkingDocumentIdentity } from "./working-document-identity";

const SEMANTIC_ARTIFACT_CANDIDATE_LIMIT = 120;
const SEMANTIC_ARTIFACT_SHORTLIST_LIMIT = 24;

export interface RankedArtifactMatch {
	artifact: Artifact;
	lexicalScore: number;
	semanticScore: number;
	rerankScore: number;
	finalScore: number;
}

export type LogicalDocumentSortKey = "name" | "size" | "type" | "date";
export type LogicalDocumentSortDirection = "asc" | "desc";

export interface LogicalDocumentPageOptions {
	includeGeneratedOutputs?: boolean;
	query?: string;
	sortKey?: LogicalDocumentSortKey;
	sortDirection?: LogicalDocumentSortDirection;
	offset?: number;
	limit?: number;
}

export interface LogicalDocumentPageResult {
	documents: KnowledgeDocumentItem[];
	totalItems: number;
}

type LogicalDocumentArtifactRow = Parameters<typeof mapArtifactSummary>[0] & {
	id: string;
	userId: string;
	metadataJson?: string | null;
};

interface LogicalDocumentRecord {
	displayArtifact: ArtifactSummary;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	normalizedAvailable: boolean;
	summary: string | null;
	updatedAt: number;
	documentOrigin?: KnowledgeDocumentItem["documentOrigin"];
	documentFamilyId?: string | null;
	documentFamilyStatus?: KnowledgeDocumentItem["documentFamilyStatus"];
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
}

function mapLogicalDocumentItem(
	params: LogicalDocumentRecord,
): KnowledgeDocumentItem {
	const document: KnowledgeDocumentItem = {
		id: params.displayArtifact.id,
		type: params.displayArtifact.type,
		displayArtifactId: params.displayArtifact.id,
		promptArtifactId: params.promptArtifactId,
		familyArtifactIds: params.familyArtifactIds,
		name: params.displayArtifact.name,
		mimeType: params.displayArtifact.mimeType,
		sizeBytes: params.displayArtifact.sizeBytes,
		conversationId: params.displayArtifact.conversationId,
		summary: params.summary,
		normalizedAvailable: params.normalizedAvailable,
		documentOrigin: params.documentOrigin,
		documentFamilyId: params.documentFamilyId ?? null,
		documentFamilyStatus: params.documentFamilyStatus ?? null,
		documentLabel: params.documentLabel ?? null,
		documentRole: params.documentRole ?? null,
		versionNumber: params.versionNumber ?? null,
		originConversationId: params.originConversationId ?? null,
		originAssistantMessageId: params.originAssistantMessageId ?? null,
		sourceChatFileId: params.sourceChatFileId ?? null,
		createdAt: params.displayArtifact.createdAt,
		updatedAt: params.updatedAt,
	};
	const identity = resolveWorkingDocumentIdentity(document);

	return {
		...document,
		displayArtifactId: identity.display.artifactId,
		promptArtifactId: identity.prompt?.artifactId ?? null,
		familyArtifactIds: identity.family.artifactIds,
		sourceChatFileId: identity.preview.sourceChatFileId,
	};
}

function normalizeLogicalDocumentQuery(
	value: string | null | undefined,
): string {
	return (value ?? "").toLowerCase().trim();
}

function tokenizeLogicalDocumentQuery(query: string): string[] {
	return Array.from(
		new Set(
			normalizeLogicalDocumentQuery(query)
				.split(/\s+/)
				.filter((term) => term.length > 1),
		),
	);
}

function scoreLogicalDocumentTermMatches(
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

function getLogicalDocumentKind(
	document: Pick<KnowledgeDocumentItem, "documentOrigin" | "type">,
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

function getLogicalDocumentRecordKind(
	record: LogicalDocumentRecord,
): "generated" | "skill_note" | "uploaded" {
	return getLogicalDocumentKind({
		documentOrigin: record.documentOrigin,
		type: record.displayArtifact.type,
	});
}

function scoreLogicalDocumentRecordForSearch(
	record: LogicalDocumentRecord,
	query: string,
): number {
	const normalizedQuery = normalizeLogicalDocumentQuery(query);
	if (!normalizedQuery) return 1;

	const terms = tokenizeLogicalDocumentQuery(normalizedQuery);
	const name = normalizeLogicalDocumentQuery(record.displayArtifact.name);
	const label = normalizeLogicalDocumentQuery(record.documentLabel ?? null);
	const role = normalizeLogicalDocumentQuery(record.documentRole ?? null);
	const summary = normalizeLogicalDocumentQuery(record.summary ?? null);
	const kind = getLogicalDocumentRecordKind(record);

	let score = 0;

	if (name.includes(normalizedQuery)) score += 70;
	if (label.includes(normalizedQuery)) score += 60;
	if (summary.includes(normalizedQuery)) score += 28;
	if (role.includes(normalizedQuery)) score += 18;
	if (kind.includes(normalizedQuery)) score += 12;

	score += scoreLogicalDocumentTermMatches(name, terms, 18);
	score += scoreLogicalDocumentTermMatches(label, terms, 15);
	score += scoreLogicalDocumentTermMatches(summary, terms, 6);
	score += scoreLogicalDocumentTermMatches(role, terms, 5);

	return score;
}

function compareLogicalDocumentText(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		sensitivity: "base",
		numeric: true,
	});
}

function sortLogicalDocumentRecordEntries(
	entries: Array<{ record: LogicalDocumentRecord; score: number }>,
	options: {
		query: string;
		sortKey: LogicalDocumentSortKey;
		sortDirection: LogicalDocumentSortDirection;
	},
): LogicalDocumentRecord[] {
	const direction = options.sortDirection === "asc" ? 1 : -1;
	const sorted = [...entries];

	sorted.sort((leftEntry, rightEntry) => {
		const left = leftEntry.record;
		const right = rightEntry.record;

		if (options.query && leftEntry.score !== rightEntry.score) {
			return rightEntry.score - leftEntry.score;
		}

		if (options.sortKey === "name") {
			const byName =
				compareLogicalDocumentText(
					left.displayArtifact.name,
					right.displayArtifact.name,
				) * direction;
			if (byName !== 0) return byName;
		}

		if (options.sortKey === "size") {
			const bySize =
				((left.displayArtifact.sizeBytes ?? 0) -
					(right.displayArtifact.sizeBytes ?? 0)) *
				direction;
			if (bySize !== 0) return bySize;
		}

		if (options.sortKey === "type") {
			const byType =
				compareLogicalDocumentText(
					getLogicalDocumentRecordKind(left),
					getLogicalDocumentRecordKind(right),
				) * direction;
			if (byType !== 0) return byType;
		}

		if (options.sortKey === "date") {
			const byDate =
				((left.displayArtifact.createdAt ?? 0) -
					(right.displayArtifact.createdAt ?? 0)) *
				direction;
			if (byDate !== 0) return byDate;
		}

		const byNameTie = compareLogicalDocumentText(
			left.displayArtifact.name,
			right.displayArtifact.name,
		);
		if (byNameTie !== 0) return byNameTie;
		const byDateTie =
			(right.displayArtifact.createdAt ?? 0) -
			(left.displayArtifact.createdAt ?? 0);
		if (byDateTie !== 0) return byDateTie;
		return compareLogicalDocumentText(
			left.displayArtifact.id,
			right.displayArtifact.id,
		);
	});

	return sorted.map((entry) => entry.record);
}

export async function createNormalizedArtifact(params: {
	userId: string;
	conversationId?: string | null;
	sourceArtifactId: string;
	sourceStoragePath: string;
	sourceName: string;
	sourceMimeType: string | null;
}): Promise<Artifact | null> {
	const absoluteSourcePath = join(process.cwd(), params.sourceStoragePath);
	const extraction = await extractDocumentText(
		absoluteSourcePath,
		params.sourceMimeType,
		params.sourceName,
	);

	if (!extraction.text) return null;

	const artifact = await createArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		type: "normalized_document",
		name: extraction.normalizedName,
		mimeType: extraction.mimeType,
		extension: "txt",
		sizeBytes: Buffer.byteLength(extraction.text, "utf8"),
		storagePath: null,
		contentText: extraction.text,
		summary: guessSummary(extraction.text, params.sourceName),
		metadata: {
			sourceArtifactId: params.sourceArtifactId,
			normalizedFrom: params.sourceName,
		},
	});

	await createArtifactLink({
		userId: params.userId,
		artifactId: artifact.id,
		relatedArtifactId: params.sourceArtifactId,
		conversationId: params.conversationId,
		linkType: "derived_from",
	});

	return artifact;
}

async function buildLogicalDocumentRecordsFromRows(params: {
	userId: string;
	rows: LogicalDocumentArtifactRow[];
	includeGeneratedOutputs: boolean;
}): Promise<LogicalDocumentRecord[]> {
	const { includeGeneratedOutputs, rows, userId } = params;
	if (rows.length === 0) return [];

	const summaries = rows.map(mapArtifactSummary);
	const byId = new Map(summaries.map((item) => [item.id, item]));
	const sourceArtifacts = summaries.filter(
		(item) => item.type === "source_document",
	);
	const normalizedArtifacts = summaries.filter(
		(item) => item.type === "normalized_document",
	);
	const generatedOutputArtifacts = summaries.filter(
		(item) => item.type === "generated_output",
	);
	const skillNoteArtifacts = summaries.filter(
		(item) => item.type === "skill_note",
	);
	const metadataById = new Map(
		rows.map((row) => [
			row.id,
			parseWorkingDocumentMetadata(parseJsonRecord(row.metadataJson ?? null)),
		]),
	);

	const derivedRows =
		normalizedArtifacts.length === 0
			? []
			: await db
					.select({
						normalizedArtifactId: artifactLinks.artifactId,
						sourceArtifactId: artifactLinks.relatedArtifactId,
					})
					.from(artifactLinks)
					.where(
						and(
							eq(artifactLinks.userId, userId),
							inArray(
								artifactLinks.artifactId,
								normalizedArtifacts.map((item) => item.id),
							),
							eq(artifactLinks.linkType, "derived_from"),
						),
					);

	const normalizedBySourceId = new Map<string, ArtifactSummary>();
	for (const row of derivedRows) {
		if (!(row.sourceArtifactId && row.normalizedArtifactId)) continue;
		const normalized = byId.get(row.normalizedArtifactId);
		if (!normalized) continue;
		normalizedBySourceId.set(row.sourceArtifactId, normalized);
	}

	const records: LogicalDocumentRecord[] = [];
	for (const source of sourceArtifacts) {
		const normalized = normalizedBySourceId.get(source.id) ?? null;
		records.push({
			displayArtifact: source,
			promptArtifactId: normalized?.id ?? null,
			familyArtifactIds: [source.id, normalized?.id ?? null].filter(
				(value): value is string => Boolean(value),
			),
			normalizedAvailable: Boolean(normalized),
			summary: normalized?.summary ?? source.summary,
			updatedAt: Math.max(
				source.updatedAt,
				normalized?.updatedAt ?? source.updatedAt,
			),
			documentOrigin: getArtifactDocumentOrigin(source.type) ?? undefined,
		});
	}

	if (includeGeneratedOutputs) {
		for (const note of skillNoteArtifacts) {
			records.push({
				displayArtifact: note,
				promptArtifactId: note.id,
				familyArtifactIds: [note.id],
				normalizedAvailable: true,
				summary: note.summary,
				updatedAt: note.updatedAt,
				documentOrigin: "skill_note",
			});
		}

		const generatedByFamily = new Map<
			string,
			{
				artifacts: ArtifactSummary[];
				latest: ArtifactSummary;
				metadata: ReturnType<typeof parseWorkingDocumentMetadata>;
			}
		>();

		for (const artifact of generatedOutputArtifacts) {
			const metadata = metadataById.get(artifact.id) ?? {};
			// Only include generated outputs that represent actual generated files
			// (those with sourceChatFileId in metadata). Exclude non-file AI/process outputs
			// like workflow summaries, result text, and other process artifacts.
			if (!metadata.sourceChatFileId) {
				continue;
			}
			const familyId = metadata.documentFamilyId ?? artifact.id;
			const existing = generatedByFamily.get(familyId);

			if (!existing) {
				generatedByFamily.set(familyId, {
					artifacts: [artifact],
					latest: artifact,
					metadata,
				});
				continue;
			}

			existing.artifacts.push(artifact);
			const latest =
				artifact.updatedAt > existing.latest.updatedAt
					? artifact
					: existing.latest;
			existing.latest = latest;
			if (latest.id === artifact.id) {
				existing.metadata = metadata;
			}
		}

		for (const [familyId, group] of generatedByFamily) {
			const versionCandidates = group.artifacts
				.map((artifact) => metadataById.get(artifact.id)?.versionNumber)
				.filter(
					(value): value is number =>
						typeof value === "number" && Number.isFinite(value),
				);
			const versionNumber =
				versionCandidates.length > 0 ? Math.max(...versionCandidates) : null;

			records.push({
				displayArtifact: group.latest,
				promptArtifactId: group.latest.id,
				familyArtifactIds: group.artifacts.map((artifact) => artifact.id),
				normalizedAvailable: true,
				summary: group.latest.summary,
				updatedAt: group.latest.updatedAt,
				documentOrigin: "generated",
				documentFamilyId: familyId,
				documentFamilyStatus: group.metadata.documentFamilyStatus ?? null,
				documentLabel: group.metadata.documentLabel ?? group.latest.name,
				documentRole: group.metadata.documentRole ?? null,
				versionNumber,
				originConversationId: group.metadata.originConversationId ?? null,
				originAssistantMessageId:
					group.metadata.originAssistantMessageId ?? null,
				sourceChatFileId: group.metadata.sourceChatFileId ?? null,
			});
		}
	}

	return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

function hasGeneratedFileSource(
	metadataJson: string | null | undefined,
): boolean {
	const metadata = parseWorkingDocumentMetadata(
		parseJsonRecord(metadataJson ?? null),
	);
	return Boolean(metadata.sourceChatFileId);
}

function getGeneratedDocumentFamilyId(row: LogicalDocumentArtifactRow): string {
	const metadata = parseWorkingDocumentMetadata(
		parseJsonRecord(row.metadataJson ?? null),
	);
	return metadata.documentFamilyId ?? row.id;
}

function buildGeneratedFileArtifactCondition() {
	return and(
		eq(artifacts.type, "generated_output"),
		eq(artifacts.retrievalClass, "durable"),
		sql`json_extract(${artifacts.metadataJson}, '$.sourceChatFileId') IS NOT NULL`,
	);
}

function buildLatestGeneratedFamilyArtifactCondition() {
	return and(
		buildGeneratedFileArtifactCondition(),
		sql`NOT EXISTS (
			SELECT 1
			FROM artifacts newer
			WHERE newer.type = 'generated_output'
				AND newer.retrieval_class = 'durable'
				AND json_extract(newer.metadata_json, '$.sourceChatFileId') IS NOT NULL
				AND coalesce(json_extract(newer.metadata_json, '$.documentFamilyId'), newer.id) = coalesce(json_extract(${artifacts.metadataJson}, '$.documentFamilyId'), ${artifacts.id})
				AND (
					newer.updated_at > ${artifacts.updatedAt}
					OR (newer.updated_at = ${artifacts.updatedAt} AND newer.id > ${artifacts.id})
				)
		)`,
	);
}

function buildLogicalDocumentDisplayArtifactCondition(
	includeGeneratedOutputs: boolean,
) {
	if (!includeGeneratedOutputs) {
		return eq(artifacts.type, "source_document");
	}

	return or(
		eq(artifacts.type, "source_document"),
		eq(artifacts.type, "skill_note"),
		buildLatestGeneratedFamilyArtifactCondition(),
	);
}

async function selectRowsByArtifactIds(
	ids: string[],
): Promise<LogicalDocumentArtifactRow[]> {
	if (ids.length === 0) return [];
	return db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(inArray(artifacts.id, Array.from(new Set(ids))));
}

function uniqueLogicalDocumentRows(
	rows: LogicalDocumentArtifactRow[],
): LogicalDocumentArtifactRow[] {
	const byId = new Map<string, LogicalDocumentArtifactRow>();
	for (const row of rows) {
		byId.set(row.id, row);
	}
	return Array.from(byId.values());
}

function readCountValue(row: { total?: unknown } | undefined): number {
	const total = row?.total;
	if (typeof total === "number" && Number.isFinite(total)) {
		return total;
	}
	if (typeof total === "string" && total.trim()) {
		const parsed = Number(total);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

async function expandLogicalDocumentCandidateRows(params: {
	userId: string;
	rows: LogicalDocumentArtifactRow[];
	includeGeneratedOutputs: boolean;
	ownershipScope: Awaited<ReturnType<typeof getArtifactOwnershipScope>>;
}): Promise<LogicalDocumentArtifactRow[]> {
	const selectedRows = params.rows.filter((row) =>
		isArtifactCanonicallyOwned({
			userId: params.userId,
			ownershipScope: params.ownershipScope,
			artifact: row,
		}),
	);
	if (selectedRows.length === 0) return [];

	const sourceIds = selectedRows
		.filter((row) => row.type === "source_document")
		.map((row) => row.id);
	const generatedFamilyIds = params.includeGeneratedOutputs
		? Array.from(
				new Set(
					selectedRows
						.filter(
							(row) =>
								row.type === "generated_output" &&
								hasGeneratedFileSource(row.metadataJson),
						)
						.map(getGeneratedDocumentFamilyId),
				),
			)
		: [];

	const [derivedRows, generatedFamilyRows] = await Promise.all([
		sourceIds.length === 0
			? Promise.resolve([])
			: db
					.select({
						normalizedArtifactId: artifactLinks.artifactId,
					})
					.from(artifactLinks)
					.where(
						and(
							eq(artifactLinks.userId, params.userId),
							inArray(artifactLinks.relatedArtifactId, sourceIds),
							eq(artifactLinks.linkType, "derived_from"),
						),
					),
		generatedFamilyIds.length === 0
			? Promise.resolve([])
			: db
					.select(knowledgeArtifactListSelection)
					.from(artifacts)
					.where(
						and(
							buildArtifactVisibilityCondition({
								userId: params.userId,
								ownershipScope: params.ownershipScope,
							}),
							buildGeneratedFileArtifactCondition(),
							or(
								...generatedFamilyIds.map(
									(familyId) =>
										sql`coalesce(json_extract(${artifacts.metadataJson}, '$.documentFamilyId'), ${artifacts.id}) = ${familyId}`,
								),
							),
						),
					),
	]);
	const normalizedRows = await selectRowsByArtifactIds(
		derivedRows
			.map((row) => row.normalizedArtifactId)
			.filter((value): value is string => Boolean(value)),
	);

	return uniqueLogicalDocumentRows([
		...selectedRows,
		...normalizedRows,
		...generatedFamilyRows.filter((row) =>
			isArtifactCanonicallyOwned({
				userId: params.userId,
				ownershipScope: params.ownershipScope,
				artifact: row,
			}),
		),
	]);
}

export async function listLogicalDocuments(
	userId: string,
	options?: {
		includeGeneratedOutputs?: boolean;
	},
): Promise<KnowledgeDocumentItem[]> {
	const includeGeneratedOutputs = options?.includeGeneratedOutputs ?? false;
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const visibilityCondition = buildArtifactVisibilityCondition({
		userId,
		ownershipScope,
	});

	const rows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(
			and(
				visibilityCondition,
				inArray(
					artifacts.type,
					includeGeneratedOutputs
						? [
								"source_document",
								"normalized_document",
								"generated_output",
								"skill_note",
							]
						: ["source_document", "normalized_document"],
				),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const scopedRows = rows.filter((row) =>
		isArtifactCanonicallyOwned({
			userId,
			ownershipScope,
			artifact: row,
		}),
	);

	if (scopedRows.length === 0) return [];

	const records = await buildLogicalDocumentRecordsFromRows({
		userId,
		rows: scopedRows,
		includeGeneratedOutputs,
	});
	return records.map(mapLogicalDocumentItem);
}

export async function listLogicalDocumentsPage(
	userId: string,
	options: LogicalDocumentPageOptions = {},
): Promise<LogicalDocumentPageResult> {
	const includeGeneratedOutputs = options.includeGeneratedOutputs ?? false;
	const query = normalizeLogicalDocumentQuery(options.query);
	const sortKey = options.sortKey ?? "date";
	const sortDirection = options.sortDirection ?? "desc";
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.max(1, Math.floor(options.limit ?? 20));
	const ownershipScope = await getArtifactOwnershipScope(userId);

	if (!query && sortKey === "date") {
		const displayArtifactCondition =
			buildLogicalDocumentDisplayArtifactCondition(includeGeneratedOutputs);
		const whereCondition = and(
			buildArtifactVisibilityCondition({ userId, ownershipScope }),
			displayArtifactCondition,
		);
		const [countRow, rows] = await Promise.all([
			db
				.select({
					total: sql<number>`cast(count(${artifacts.id}) as integer)`,
				})
				.from(artifacts)
				.where(whereCondition)
				.get(),
			db
				.select(knowledgeArtifactListSelection)
				.from(artifacts)
				.where(whereCondition)
				.orderBy(
					sortDirection === "asc"
						? asc(artifacts.createdAt)
						: desc(artifacts.createdAt),
					asc(artifacts.id),
				)
				.limit(limit)
				.offset(offset),
		]);
		const detailRows = await expandLogicalDocumentCandidateRows({
			userId,
			rows,
			includeGeneratedOutputs,
			ownershipScope,
		});
		const records = await buildLogicalDocumentRecordsFromRows({
			userId,
			rows: detailRows,
			includeGeneratedOutputs,
		});
		const sortedRecords = sortLogicalDocumentRecordEntries(
			records.map((record) => ({ record, score: 1 })),
			{ query, sortKey, sortDirection },
		);

		return {
			documents: sortedRecords.map(mapLogicalDocumentItem),
			totalItems: readCountValue(countRow),
		};
	}

	// Search relevance, non-date sort keys, and full generated-family grouping need
	// the complete logical-document set before slicing.
	const rows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				inArray(
					artifacts.type,
					includeGeneratedOutputs
						? [
								"source_document",
								"normalized_document",
								"generated_output",
								"skill_note",
							]
						: ["source_document", "normalized_document"],
				),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const scopedRows = rows.filter((row) =>
		isArtifactCanonicallyOwned({
			userId,
			ownershipScope,
			artifact: row,
		}),
	);

	const logicalDocumentRecords = await buildLogicalDocumentRecordsFromRows({
		userId,
		rows: scopedRows,
		includeGeneratedOutputs,
	});
	const searchedDocuments = logicalDocumentRecords
		.filter((record) => record.displayArtifact.type !== "normalized_document")
		.map((record) => ({
			record,
			score: scoreLogicalDocumentRecordForSearch(record, query),
		}))
		.filter((entry) => !query || entry.score > 0);
	const sortedRecords = sortLogicalDocumentRecordEntries(searchedDocuments, {
		query,
		sortKey,
		sortDirection,
	});

	return {
		documents: sortedRecords
			.slice(offset, offset + limit)
			.map(mapLogicalDocumentItem),
		totalItems: sortedRecords.length,
	};
}

export async function getLogicalDocumentForArtifact(
	userId: string,
	artifactId: string,
): Promise<KnowledgeDocumentItem | null> {
	const trimmedArtifactId = artifactId.trim();
	if (!trimmedArtifactId) return null;

	const ownershipScope = await getArtifactOwnershipScope(userId);
	const targetRows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				eq(artifacts.id, trimmedArtifactId),
				inArray(artifacts.type, [
					"source_document",
					"normalized_document",
					"generated_output",
					"skill_note",
				]),
			),
		)
		.limit(1);
	const targetRow = targetRows[0] ?? null;
	if (
		!targetRow ||
		!isArtifactCanonicallyOwned({
			userId,
			ownershipScope,
			artifact: targetRow,
		})
	) {
		return null;
	}

	let candidateRows: LogicalDocumentArtifactRow[] = [targetRow];
	if (targetRow.type === "normalized_document") {
		const sourceLinks = await db
			.select({
				sourceArtifactId: artifactLinks.relatedArtifactId,
			})
			.from(artifactLinks)
			.where(
				and(
					eq(artifactLinks.userId, userId),
					eq(artifactLinks.artifactId, targetRow.id),
					eq(artifactLinks.linkType, "derived_from"),
				),
			);
		candidateRows = [
			...candidateRows,
			...(await selectRowsByArtifactIds(
				sourceLinks
					.map((row) => row.sourceArtifactId)
					.filter((value): value is string => Boolean(value)),
			)),
		];
	}

	const detailRows = await expandLogicalDocumentCandidateRows({
		userId,
		rows: candidateRows,
		includeGeneratedOutputs: true,
		ownershipScope,
	});
	const records = await buildLogicalDocumentRecordsFromRows({
		userId,
		rows: detailRows,
		includeGeneratedOutputs: true,
	});
	const targetRecord =
		records.find(
			(record) =>
				record.displayArtifact.id === targetRow.id ||
				record.promptArtifactId === targetRow.id ||
				record.familyArtifactIds.includes(targetRow.id),
		) ?? null;

	return targetRecord ? mapLogicalDocumentItem(targetRecord) : null;
}

function buildArtifactSearchBody(artifact: Artifact): string {
	return `${artifact.name}\n${artifact.summary ?? ""}\n${artifact.contentText ?? ""}`;
}

function tokenizeArtifactSearchQuery(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9]+/i)
				.map((token) => token.trim())
				.filter((token) => token.length >= 2)
				.slice(0, 8),
		),
	);
}

async function selectArtifactSearchCandidates(params: {
	userId: string;
	query: string;
	types: ArtifactType[];
	excludeConversationId?: string;
	limit: number;
	preferSemanticBreadth?: boolean;
}): Promise<Artifact[]> {
	const ownershipScope = await getArtifactOwnershipScope(params.userId);
	const tokenFragments = tokenizeArtifactSearchQuery(params.query).map(
		(token) => `%${token}%`,
	);
	const semanticBreadth = params.preferSemanticBreadth ?? false;
	const baseConditions = [
		buildArtifactVisibilityCondition({
			userId: params.userId,
			ownershipScope,
		}),
		inArray(artifacts.type, params.types),
		params.types.includes("generated_output")
			? or(
					ne(artifacts.type, "generated_output"),
					eq(artifacts.retrievalClass, "durable"),
				)
			: undefined,
		params.excludeConversationId
			? sql`${artifacts.conversationId} IS NULL OR ${artifacts.conversationId} <> ${params.excludeConversationId}`
			: undefined,
	];

	if (!semanticBreadth && tokenFragments.length > 0) {
		baseConditions.push(
			or(
				...tokenFragments.flatMap((fragment) => [
					like(artifacts.name, fragment),
					like(artifacts.summary, fragment),
					like(artifacts.contentText, fragment),
				]),
			),
		);
	}

	const rows = await db
		.select()
		.from(artifacts)
		.where(and(...baseConditions))
		.orderBy(desc(artifacts.updatedAt))
		.limit(params.limit);

	return rows
		.filter((row) =>
			isArtifactCanonicallyOwned({
				userId: params.userId,
				ownershipScope,
				artifact: row,
			}),
		)
		.map(mapArtifact);
}

async function rankArtifactMatches(params: {
	userId: string;
	query: string;
	candidates: Artifact[];
	limit: number;
	queryEmbedding?: number[];
}): Promise<RankedArtifactMatch[]> {
	if (params.candidates.length === 0) {
		return [];
	}

	const lexicalMatches = params.candidates.map((artifact) => ({
		artifact,
		lexicalScore: scoreMatch(params.query, buildArtifactSearchBody(artifact)),
	}));
	const lexicalTop = lexicalMatches
		.filter((entry) => entry.lexicalScore > 0)
		.sort((left, right) => {
			if (right.lexicalScore !== left.lexicalScore)
				return right.lexicalScore - left.lexicalScore;
			return right.artifact.updatedAt - left.artifact.updatedAt;
		})
		.slice(0, Math.max(params.limit * 2, 12));

	let semanticDiagnostics: SemanticShortlistDiagnostics | null = null;
	const semanticMatches =
		(await shortlistSemanticMatchesBySubject({
			userId: params.userId,
			subjectType: "artifact",
			query: params.query,
			items: params.candidates,
			getSubjectId: (artifact) => artifact.id,
			limit: SEMANTIC_ARTIFACT_SHORTLIST_LIMIT,
			queryEmbedding: params.queryEmbedding,
			onDiagnostics: (diagnostics) => {
				semanticDiagnostics = diagnostics;
			},
		})) ?? [];
	const semanticScoreById = new Map(
		semanticMatches.map((match) => [match.subjectId, match.semanticScore]),
	);

	const candidateIds = new Set<string>();
	const shortlistedArtifacts: Artifact[] = [];

	for (const entry of lexicalTop) {
		if (candidateIds.has(entry.artifact.id)) continue;
		candidateIds.add(entry.artifact.id);
		shortlistedArtifacts.push(entry.artifact);
	}

	for (const match of semanticMatches) {
		if (candidateIds.has(match.subjectId)) continue;
		candidateIds.add(match.subjectId);
		shortlistedArtifacts.push(match.item);
	}

	if (shortlistedArtifacts.length === 0) {
		shortlistedArtifacts.push(...params.candidates.slice(0, params.limit));
	}

	let rerankScoreById = new Map<string, number>();
	let rerankDiagnostics: TeiRerankDiagnostics | null = null;
	if (canUseTeiReranker() && shortlistedArtifacts.length > 1) {
		try {
			const reranked = await rerankItems({
				query: params.query,
				items: shortlistedArtifacts,
				getText: (artifact) => buildArtifactSearchBody(artifact),
				onDiagnostics: (diagnostics) => {
					rerankDiagnostics = diagnostics;
				},
			});

			if (reranked && reranked.items.length > 0) {
				rerankScoreById = new Map(
					reranked.items.map((entry) => [entry.item.id, entry.score]),
				);
			}
		} catch (error) {
			console.error("[KNOWLEDGE] Artifact semantic reranker failed:", error);
		}
	}

	const rankedMatches = shortlistedArtifacts
		.map((artifact) => {
			const lexicalScore =
				lexicalMatches.find((entry) => entry.artifact.id === artifact.id)
					?.lexicalScore ?? 0;
			const semanticScore = semanticScoreById.get(artifact.id) ?? 0;
			const rerankScore = rerankScoreById.get(artifact.id) ?? 0;
			const baseScore =
				lexicalScore * 10 +
				semanticScore * 18 +
				rerankScore * 24 +
				artifact.updatedAt / 1_000_000_000_000;
			const ageSeconds = Math.max(0, (Date.now() - artifact.updatedAt) / 1000);

			const finalScore = computeDecayScore({
				importance: baseScore,
				ageSeconds,
				staleSeconds: ageSeconds,
				queryOverlap: lexicalScore,
				queryLength: 1,
				decayRate: 0.001,
			});

			return {
				artifact,
				lexicalScore,
				semanticScore,
				rerankScore,
				finalScore,
			};
		})
		.filter(
			(entry) =>
				entry.lexicalScore > 0 ||
				entry.semanticScore > 0 ||
				entry.rerankScore > 0,
		)
		.sort((left, right) => {
			if (right.finalScore !== left.finalScore)
				return right.finalScore - left.finalScore;
			return right.artifact.updatedAt - left.artifact.updatedAt;
		})
		.slice(0, params.limit);

	const winner = rankedMatches[0] ?? null;
	logTeiRetrievalSummary({
		scope: "documents",
		userId: params.userId,
		queryLength: params.query.trim().length,
		candidateCount: params.candidates.length,
		semantic: semanticDiagnostics,
		rerank: rerankDiagnostics,
		winningMode: determineTeiWinningMode({
			lexicalScore: winner?.lexicalScore,
			semanticScore: winner?.semanticScore,
			rerankScore: winner?.rerankScore,
		}),
		winnerId: winner?.artifact.id ?? null,
		extra: {
			winnerType: winner?.artifact.type ?? null,
			shortlistedCount: shortlistedArtifacts.length,
			lexicalTopCount: lexicalTop.length,
			returnedCount: rankedMatches.length,
		},
	});

	return rankedMatches;
}

export async function findRelevantArtifactsByTypesDetailed(params: {
	userId: string;
	query: string;
	types: ArtifactType[];
	limit: number;
	excludeConversationId?: string;
	queryEmbedding?: number[];
}): Promise<RankedArtifactMatch[]> {
	const semanticBreadth = params.query.trim().length > 0;
	const candidates = await selectArtifactSearchCandidates({
		userId: params.userId,
		query: params.query,
		types: params.types,
		excludeConversationId: params.excludeConversationId,
		limit: semanticBreadth
			? SEMANTIC_ARTIFACT_CANDIDATE_LIMIT
			: Math.max(params.limit, 12),
		preferSemanticBreadth: semanticBreadth,
	});

	if (params.query.trim().length === 0) {
		return candidates.slice(0, params.limit).map((artifact) => ({
			artifact,
			lexicalScore: 0,
			semanticScore: 0,
			rerankScore: 0,
			finalScore: artifact.updatedAt,
		}));
	}

	return rankArtifactMatches({
		userId: params.userId,
		query: params.query,
		candidates,
		limit: params.limit,
		queryEmbedding: params.queryEmbedding,
	});
}

export async function findRelevantArtifactsByTypes(params: {
	userId: string;
	query: string;
	types: ArtifactType[];
	limit: number;
	excludeConversationId?: string;
}): Promise<Artifact[]> {
	const matches = await findRelevantArtifactsByTypesDetailed(params);
	return matches.map((entry) => entry.artifact);
}
