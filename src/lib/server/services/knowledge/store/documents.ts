import { and, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactLinks,
	artifacts,
	artifactVersions,
} from "$lib/server/db/schema";
import type {
	Artifact,
	ArtifactSummary,
	ArtifactType,
	KnowledgeDocumentItem,
} from "$lib/server/services/knowledge/types";
import { parseJsonRecord } from "$lib/server/utils/json";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { computeDecayScore } from "../../../utils/artifact-decay";
import { shortlistSemanticMatchesBySubject } from "../../semantic-ranking";
import {
	determineTeiWinningMode,
	logTeiRetrievalSummary,
	type SemanticShortlistDiagnostics,
	type TeiRerankDiagnostics,
} from "../../tei-observability";
import { canUseTeiReranker, rerankItems } from "../../tei-reranker";
import { scoreMatch } from "../../working-set";
import type { ArtifactOwnershipScope } from "./core";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
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

/**
 * The five buckets the Documents tab can filter by (orchestrator amendment to
 * ruling 46, 2026-09-25: six chips total with "All", no "file" chip — a
 * produced file groups under "uploaded" with its own format pill, exactly
 * like an uploaded document). "all" is a client-only concept
 * (`documents-table.ts`'s `DocumentTypeFilter`) — passing it here is a bug,
 * not a no-op.
 */
export type KnowledgeDocumentKindFilter =
	| Exclude<ArtifactKind, "file">
	| "uploaded";

export interface LogicalDocumentPageOptions {
	includeGeneratedOutputs?: boolean;
	query?: string;
	sortKey?: LogicalDocumentSortKey;
	sortDirection?: LogicalDocumentSortDirection;
	offset?: number;
	limit?: number;
	/** Narrow to one kind bucket. Omitted means every kind. */
	kindFilter?: KnowledgeDocumentKindFilter;
}

export interface LogicalDocumentPageResult {
	documents: KnowledgeDocumentItem[];
	totalItems: number;
	/**
	 * Counted after the current `query` is applied (so the numbers move as the
	 * user types) but BEFORE `kindFilter` is applied (so switching chips never
	 * changes the other chips' own numbers).
	 */
	countsByKind: Record<KnowledgeDocumentKindFilter, number>;
}

export type LogicalDocumentArtifactRow = Parameters<
	typeof mapArtifactSummary
>[0] & {
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
	/** `metadata.extractionProducer` — absent on every pre-Phase-4 row. */
	extractionProducer?: string | null;
	/** `metadata.extractionTier` — the real per-file tier of the last parse. */
	extractionTier?: string | null;
}

/** A metadata value that is a usable, short, non-empty string, or undefined. */
function readMetadataLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : undefined;
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
		...(params.displayArtifact.tokenEstimate !== undefined
			? { tokenEstimate: params.displayArtifact.tokenEstimate }
			: {}),
		...(params.displayArtifact.pageCount !== undefined
			? { pageCount: params.displayArtifact.pageCount }
			: {}),
		...(params.displayArtifact.pageCountKind !== undefined
			? { pageCountKind: params.displayArtifact.pageCountKind }
			: {}),
		...(params.displayArtifact.outline !== undefined
			? { outline: params.displayArtifact.outline }
			: {}),
		// Extraction provenance rides on the row so the Library can offer
		// "Re-extract" only where the backend can honour it, and can mark the
		// tier the document is already at. Omitted (never null) when the
		// artifact predates the structured extractor — that absence IS the
		// legacy marker (D12).
		...(params.extractionProducer
			? { extractionProducer: params.extractionProducer }
			: {}),
		...(params.extractionTier ? { extractionTier: params.extractionTier } : {}),
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

// ── The artifact family (Feature 2, ADR-0066): Document/App/Canvas/Slides ──
//
// A `type: "artifact"` row has no source/normalized pairing and no derived-
// link walk — one row in, one row (or null) out. Rather than forcing it
// through the four-type machinery above, it gets its own small read path,
// merged with the legacy set at the `KnowledgeDocumentItem` level. See
// `slice-7.md §Contracts` for the full design.

/**
 * Reads `metadata_json.artifactType` for a `type: "artifact"` row, validated
 * against the four family kinds. Never throws, and deliberately never
 * returns "file": that kind exists only for `generated_output` rows on the
 * pre-existing path above (`getLogicalDocumentKind`) — a `type: "artifact"`
 * row is always one of the four family kinds, or unrecognised.
 *
 * Not imported from `$lib/server/services/artifacts`: that facade's
 * `kindForArtifactRow` exists, but it defaults an unparseable row to `"file"`
 * — the right fallback for its own row-type-agnostic callers, but wrong here,
 * since this function already knows the row is `type: "artifact"` and its
 * caller's fallback (`mapArtifactFamilyRow`'s `?? "document"`) must never be
 * `"file"` (there is no "file" chip for this family — ruling 46, corrected).
 */
function parseArtifactFamilyKind(
	metadataJson: string | null,
): ArtifactKind | null {
	const metadata = parseJsonRecord(metadataJson ?? null);
	const value = metadata?.artifactType;
	return value === "document" ||
		value === "app" ||
		value === "canvas" ||
		value === "slides"
		? value
		: null;
}

/**
 * The artifact-family row → `KnowledgeDocumentItem` mapper. No second DB
 * round trip: every field it needs is already on the row selected via
 * `knowledgeArtifactListSelection` (`core.ts`) — everything but
 * `contentText`, which only the Workspace Search candidate loader needs.
 *
 * Exported for `workspace-search.ts`'s own artifact-family candidate loader
 * (Task 2), which needs the exact same mapping — shared behaviour should
 * exist once, not be copied between the two callers.
 */
export function mapArtifactFamilyRow(
	row: LogicalDocumentArtifactRow,
	versionNumber: number | null,
): KnowledgeDocumentItem {
	// Never throws; "document" is the honest default for a row this slice
	// cannot classify — it still lists and opens, just with a guessed chip
	// (see slice-7.md's failure-mode table).
	const kind = parseArtifactFamilyKind(row.metadataJson ?? null) ?? "document";
	return {
		id: row.id,
		type: "artifact",
		displayArtifactId: row.id,
		// No "What AI sees" duality for this family — see DocumentsList §Contracts.
		promptArtifactId: null,
		// Itself only; no source/normalized pairing.
		familyArtifactIds: [row.id],
		name: row.name,
		mimeType: null,
		// "Size" is not a meaningful concept for a live-edited artifact.
		sizeBytes: null,
		conversationId: row.conversationId,
		summary: null,
		normalizedAvailable: false,
		kind,
		artifactVersionNumber: versionNumber,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * Batches the artifact family's own version counter —
 * `ArtifactCardSummary.versionNumber`'s equivalent, sourced from the newest
 * `artifact_versions` row per artifact id. Not a second reader of the
 * `artifacts/` service's own tables in spirit: this is the one place the
 * Knowledge listing needs a version NUMBER (not a body, not a diff), and it
 * is batched per page the same way `attachExtractionJobs`
 * (`knowledge.ts`) batches the extraction ledger — one query per page, not
 * one per row.
 *
 * Exported for `workspace-search.ts`'s artifact-family candidate loader
 * (Task 2), which batches the same version lookup for its own candidate set.
 */
export async function getArtifactVersionNumbers(
	artifactIds: string[],
): Promise<Map<string, number>> {
	if (artifactIds.length === 0) return new Map();
	const rows = await db
		.select({
			artifactId: artifactVersions.artifactId,
			maxVersion: sql<number>`max(${artifactVersions.versionNumber})`,
		})
		.from(artifactVersions)
		.where(inArray(artifactVersions.artifactId, artifactIds))
		.groupBy(artifactVersions.artifactId);

	return new Map(
		rows
			.filter(
				(row): row is { artifactId: string; maxVersion: number } =>
					typeof row.maxVersion === "number",
			)
			.map((row) => [row.artifactId, row.maxVersion]),
	);
}

/**
 * Which of the six chips (five plus "all", client-side) a row belongs under.
 * Skill Notes fold into "uploaded" here too, and — per the orchestrator
 * amendment correcting ruling 46 — so does every legacy row regardless of
 * `documentOrigin`: a produced file is a file row like an upload, grouped
 * under Uploaded with its own file-format pill, never a separate "file"
 * chip. This is the server-side twin of `documents-table.ts`'s
 * `documentTypeFilterFor` (a browser file, never imported from here).
 */
function resolveDocumentKindFilterBucket(
	item: KnowledgeDocumentItem,
): KnowledgeDocumentKindFilter {
	// `item.kind` is typed as the full `ArtifactKind` (it includes "file" for
	// other callers' sake), but `mapArtifactFamilyRow` never sets it to "file"
	// — this guard keeps the return type honest without a cast.
	return item.kind && item.kind !== "file" ? item.kind : "uploaded";
}

function tallyCountsByKind(
	items: KnowledgeDocumentItem[],
): Record<KnowledgeDocumentKindFilter, number> {
	const counts: Record<KnowledgeDocumentKindFilter, number> = {
		document: 0,
		app: 0,
		canvas: 0,
		slides: 0,
		uploaded: 0,
	};
	for (const item of items) {
		counts[resolveDocumentKindFilterBucket(item)] += 1;
	}
	return counts;
}

/**
 * A new, deliberately shallow scorer for the artifact family: checks `name`
 * only, matching the Documents tab's existing search depth for every other
 * kind (title/label/role/summary, never body content —
 * `scoreLogicalDocumentRecordForSearch` doesn't read `contentText` either).
 * This slice does not deepen the Documents tab's own search, only widens
 * which kinds it covers. Never reads an App's body — Review Focus #3's
 * concern is about `workspace-search.ts`'s content-scoring loop, which this
 * function has no equivalent of.
 */
function scoreArtifactFamilyRowForSearch(
	item: KnowledgeDocumentItem,
	query: string,
): number {
	const normalizedQuery = normalizeLogicalDocumentQuery(query);
	if (!normalizedQuery) return 1;

	const name = normalizeLogicalDocumentQuery(item.name);
	let score = 0;
	if (name.includes(normalizedQuery)) score += 70;
	score += scoreLogicalDocumentTermMatches(
		name,
		tokenizeLogicalDocumentQuery(normalizedQuery),
		18,
	);
	return score;
}

/**
 * The merged-set sibling of `sortLogicalDocumentRecordEntries`'s tie-break
 * discipline (name → newest → id), generalised to read `KnowledgeDocumentItem`
 * fields directly since both the legacy and artifact-family sets are already
 * mapped to that shape before this runs. Not a `documents-table.ts` import —
 * that module is browser-only; this is a small, server-side twin.
 *
 * The "type" sort key preserves the EXACT three-way legacy distinction
 * (generated/skill_note/uploaded) via `getLogicalDocumentKind`, falling back
 * to it only when `item.kind` is unset — mirroring `documents-table.ts`'s own
 * widened `getDocumentKind`. This is deliberately NOT the same grouping as
 * `resolveDocumentKindFilterBucket` (which coarsens every legacy row to
 * "uploaded" for the chip/count concern only) — sorting keeps every existing
 * distinction it already had.
 */
function compareKnowledgeDocumentItems(
	left: KnowledgeDocumentItem,
	right: KnowledgeDocumentItem,
	sortKey: LogicalDocumentSortKey,
	sortDirection: LogicalDocumentSortDirection,
): number {
	const direction = sortDirection === "asc" ? 1 : -1;

	if (sortKey === "name") {
		const byName =
			compareLogicalDocumentText(left.name, right.name) * direction;
		if (byName !== 0) return byName;
	}

	if (sortKey === "size") {
		const bySize = ((left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)) * direction;
		if (bySize !== 0) return bySize;
	}

	if (sortKey === "type") {
		const leftKind = left.kind ?? getLogicalDocumentKind(left);
		const rightKind = right.kind ?? getLogicalDocumentKind(right);
		const byType = compareLogicalDocumentText(leftKind, rightKind) * direction;
		if (byType !== 0) return byType;
	}

	if (sortKey === "date") {
		const byDate = ((left.createdAt ?? 0) - (right.createdAt ?? 0)) * direction;
		if (byDate !== 0) return byDate;
	}

	const byNameTie = compareLogicalDocumentText(left.name, right.name);
	if (byNameTie !== 0) return byNameTie;
	const byDateTie = (right.createdAt ?? 0) - (left.createdAt ?? 0);
	if (byDateTie !== 0) return byDateTie;
	return compareLogicalDocumentText(left.id, right.id);
}

/**
 * Selects the one `type: "artifact"` row for this id, scoped exactly like
 * every other query in this file (`buildArtifactVisibilityCondition` in SQL,
 * `isArtifactCanonicallyOwned` in JS — the same two-step ownership pattern,
 * not a new one). Returns `null` on no match or a failed ownership check.
 */
async function selectSingleArtifactFamilyRow(params: {
	artifactId: string;
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
}): Promise<KnowledgeDocumentItem | null> {
	const { artifactId, ownershipScope, userId } = params;
	const rows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, artifactId),
				eq(artifacts.type, "artifact"),
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
			),
		)
		.limit(1);
	const row = rows[0];
	if (
		!row ||
		!isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row })
	) {
		return null;
	}

	const versionNumbers = await getArtifactVersionNumbers([row.id]);
	return mapArtifactFamilyRow(row, versionNumbers.get(row.id) ?? null);
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
	// The working-document projection above is deliberately narrow, so the raw
	// record is kept beside it for the two extraction-provenance keys.
	const rawMetadataById = new Map(
		rows.map((row) => [row.id, parseJsonRecord(row.metadataJson ?? null)]),
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
		const rawMetadata = rawMetadataById.get(source.id) ?? null;
		records.push({
			extractionProducer: readMetadataLabel(rawMetadata?.extractionProducer),
			extractionTier: readMetadataLabel(rawMetadata?.extractionTier),
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

/**
 * Fetches, scores and maps the legacy four-type candidate set — unchanged
 * query, unchanged scope, unchanged per-record score — but maps each record
 * to a `KnowledgeDocumentItem` immediately rather than after sorting, so a
 * single comparator can order it alongside the artifact-family set below.
 * This retires the old SQL-side LIMIT/OFFSET fast path for the no-query
 * date-sort case (`slice-7.md §Contracts`): once a second source must be
 * merged, a SQL LIMIT/OFFSET on only one of the two sources cannot produce a
 * correct page of the union, so this now always fetches the full
 * ownership-scoped candidate set and sorts/slices in memory — exactly what
 * this function already did for the search-relevance case, just applied
 * unconditionally. AlfyAI is self-hosted, single-account-scale; see the
 * slice's Risks note for the fallback if this is ever measured to matter.
 */
async function loadLegacyDocumentEntries(params: {
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
	includeGeneratedOutputs: boolean;
	query: string;
}): Promise<Array<{ item: KnowledgeDocumentItem; score: number }>> {
	const { includeGeneratedOutputs, ownershipScope, query, userId } = params;
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

	return logicalDocumentRecords
		.filter((record) => record.displayArtifact.type !== "normalized_document")
		.map((record) => ({
			item: mapLogicalDocumentItem(record),
			score: scoreLogicalDocumentRecordForSearch(record, query),
		}));
}

/**
 * Fetches, scores and maps the artifact-family candidate set: no family
 * bundling, no derived-link walk, the same two-step ownership pattern every
 * other query in this file already uses.
 */
async function loadArtifactFamilyDocumentEntries(params: {
	userId: string;
	ownershipScope: ArtifactOwnershipScope;
	query: string;
}): Promise<Array<{ item: KnowledgeDocumentItem; score: number }>> {
	const { ownershipScope, query, userId } = params;
	const rows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				eq(artifacts.type, "artifact"),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const scopedRows = rows.filter((row) =>
		isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row }),
	);
	const versionNumbers = await getArtifactVersionNumbers(
		scopedRows.map((row) => row.id),
	);

	return scopedRows.map((row) => {
		const item = mapArtifactFamilyRow(row, versionNumbers.get(row.id) ?? null);
		return { item, score: scoreArtifactFamilyRowForSearch(item, query) };
	});
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

	const [legacyEntries, familyEntries] = await Promise.all([
		loadLegacyDocumentEntries({
			userId,
			ownershipScope,
			includeGeneratedOutputs,
			query,
		}),
		loadArtifactFamilyDocumentEntries({ userId, ownershipScope, query }),
	]);

	// Drop every zero-score entry from BOTH sets when searching (mirrors the
	// existing `.filter((entry) => !query || entry.score > 0)` rule).
	const queryFilteredLegacy = query
		? legacyEntries.filter((entry) => entry.score > 0)
		: legacyEntries;
	const queryFilteredFamily = query
		? familyEntries.filter((entry) => entry.score > 0)
		: familyEntries;

	// Tallied on the query-filtered, NOT-yet-kindFilter-filtered union — a
	// chip's own count must never move when that same chip is clicked.
	const countsByKind = tallyCountsByKind([
		...queryFilteredLegacy.map((entry) => entry.item),
		...queryFilteredFamily.map((entry) => entry.item),
	]);

	const combined = [...queryFilteredLegacy, ...queryFilteredFamily];
	const kindFiltered = options.kindFilter
		? combined.filter(
				(entry) =>
					resolveDocumentKindFilterBucket(entry.item) === options.kindFilter,
			)
		: combined;

	// Same dual-mode rule the old code used, replicated rather than re-derived:
	// relevance order when searching, plain sortKey/sortDirection order when
	// not — now applied once, over the union of both sources. The retired
	// `sortLogicalDocumentRecordEntries` fell through to the CALLER's own
	// sortKey/sortDirection whenever two scores tied during a search (only an
	// outright score difference short-circuited it); a hardcoded "date"/"desc"
	// tie-break here would silently reorder every row, old and new alike, the
	// moment two results tie on relevance — exactly the behaviour change the
	// Global Constraints promise not to make.
	const sorted = [...kindFiltered].sort((left, right) => {
		if (query && left.score !== right.score) return right.score - left.score;
		return compareKnowledgeDocumentItems(
			left.item,
			right.item,
			sortKey,
			sortDirection,
		);
	});

	return {
		documents: sorted.slice(offset, offset + limit).map((entry) => entry.item),
		totalItems: sorted.length,
		countsByKind,
	};
}

export async function getLogicalDocumentForArtifact(
	userId: string,
	artifactId: string,
): Promise<KnowledgeDocumentItem | null> {
	const trimmedArtifactId = artifactId.trim();
	if (!trimmedArtifactId) return null;

	const ownershipScope = await getArtifactOwnershipScope(userId);

	// The artifact family has no source/normalized pairing and no derived-link
	// walk — one row in, one row (or null) out. Tried BEFORE the legacy
	// four-type lookup so that lookup stays untouched below.
	const familyDocument = await selectSingleArtifactFamilyRow({
		artifactId: trimmedArtifactId,
		userId,
		ownershipScope,
	});
	if (familyDocument) return familyDocument;

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

/**
 * What a project link is worth at retrieval time: a nudge, not a pass.
 *
 * Small on purpose. One unit of `lexicalScore` is worth 10, so this breaks
 * ties in favour of the documents the user's own project holds without ever
 * rescuing one that does not match the query — the relevance gate below is
 * what decides whether a candidate is in the running at all.
 */
const PROJECT_SCOPE_SCORE_BOOST = 5;

async function rankArtifactMatches(params: {
	userId: string;
	query: string;
	candidates: Artifact[];
	limit: number;
	queryEmbedding?: number[];
	/**
	 * Artifacts linked to the current project. Both ids of a document travel
	 * here, because retrieval returns the normalized artifact for an upload.
	 */
	scopeBoostArtifactIds?: string[];
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
			const scopeBoost = params.scopeBoostArtifactIds?.includes(artifact.id)
				? PROJECT_SCOPE_SCORE_BOOST
				: 0;
			const baseScore =
				lexicalScore * 10 +
				semanticScore * 18 +
				rerankScore * 24 +
				artifact.updatedAt / 1_000_000_000_000 +
				scopeBoost;
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
	/**
	 * Artifacts linked to the current project: preferred, never required.
	 *
	 * The list IS the scope. `artifacts` has no project column and a linked
	 * library document has `conversationId = NULL`, so there is no join that
	 * could express this — the link table's ids are what "in the project" means.
	 */
	scopeBoostArtifactIds?: string[];
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
		scopeBoostArtifactIds: params.scopeBoostArtifactIds,
	});
}

export async function findRelevantArtifactsByTypes(params: {
	userId: string;
	query: string;
	types: ArtifactType[];
	limit: number;
	excludeConversationId?: string;
	/** See {@link findRelevantArtifactsByTypesDetailed}. */
	scopeBoostArtifactIds?: string[];
}): Promise<Artifact[]> {
	const matches = await findRelevantArtifactsByTypesDetailed(params);
	return matches.map((entry) => entry.artifact);
}
