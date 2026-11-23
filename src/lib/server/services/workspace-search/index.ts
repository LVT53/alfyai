import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	getArtifactVersionNumbers,
	getLogicalDocumentForArtifact,
	isArtifactCanonicallyOwned,
	knowledgeArtifactListSelection,
	listLogicalDocumentsPage,
	mapArtifactFamilyRow,
} from "$lib/server/services/knowledge/store";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { resolveWorkingDocumentIdentity } from "$lib/services/working-document-identity";
import {
	SEARCH_MIN_QUERY_CHARS,
	searchTerms,
	typedSearchWords,
} from "$lib/shared/workspace-search-text";
import { buildChatHref, recentChats, searchChats } from "./chats";
import {
	SEARCH_ALL_PER_KIND,
	SEARCH_PAGE_SIZE,
	type WorkspaceSearchDocumentMatchType,
	type WorkspaceSearchDocumentResult,
	type WorkspaceSearchKind,
	type WorkspaceSearchResponse,
	type WorkspaceSearchScope,
} from "./types";

export * from "./types";

const DEFAULT_LIMIT = 3;
const QUERY_LIMIT = 6;
const DOCUMENT_METADATA_CANDIDATE_LIMIT = 24;
const DOCUMENT_CONTENT_CANDIDATE_LIMIT = 24;
/** Matches the two existing candidate limits above for symmetry — not a new
 *  policy decision, a consistency one. */
const DOCUMENT_FAMILY_CANDIDATE_LIMIT = 24;
const SNIPPET_RADIUS = 64;

type ArtifactTextRow = {
	id: string;
	contentText: string | null;
	summary: string | null;
};

type ArtifactCandidateRow = {
	id: string;
	userId: string;
	type: string;
	conversationId: string | null;
};

type ArtifactTextCandidateRow = ArtifactTextRow & ArtifactCandidateRow;

type ArtifactOwnershipScope = Awaited<
	ReturnType<typeof getArtifactOwnershipScope>
>;

function normalizeQuery(value: string | null | undefined): string {
	return (value ?? "").trim();
}

function normalizeSearchText(value: string | null | undefined): string {
	return (value ?? "").toLowerCase();
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildKnowledgeHref(query: string): string {
	const url = new URL("/knowledge", "http://localhost");
	url.searchParams.set("query", query);
	return `${url.pathname}${url.search}`;
}

function buildKnowledgeWorkspaceHref(document: KnowledgeDocumentItem): string {
	const identity = resolveWorkingDocumentIdentity(document);
	const url = new URL("/knowledge", "http://localhost");
	url.searchParams.set("open_artifact", identity.preview.artifactId);
	url.searchParams.set("open_filename", document.name);
	if (document.mimeType) {
		url.searchParams.set("open_mime", document.mimeType);
	}
	return `${url.pathname}${url.search}`;
}

function buildDocumentSourceHref(
	document: KnowledgeDocumentItem,
): string | null {
	if (!(document.originConversationId && document.originAssistantMessageId)) {
		return null;
	}
	return buildChatHref(
		document.originConversationId,
		document.originAssistantMessageId,
	);
}

function clipAroundQuery(
	text: string | null | undefined,
	query: string,
): string | null {
	const normalizedText = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalizedText) return null;

	const haystack = normalizeSearchText(normalizedText);
	const needle = normalizeSearchText(query);
	const index = haystack.indexOf(needle);
	if (index < 0) {
		return normalizedText.length > SNIPPET_RADIUS * 2
			? `${normalizedText.slice(0, SNIPPET_RADIUS * 2).trimEnd()}...`
			: normalizedText;
	}

	const start = Math.max(0, index - SNIPPET_RADIUS);
	const end = Math.min(
		normalizedText.length,
		index + query.length + SNIPPET_RADIUS,
	);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < normalizedText.length ? "..." : "";
	return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`;
}

function termScore(
	value: string | null | undefined,
	query: string,
	weight: number,
): number {
	if (!value) return 0;
	const target = normalizeSearchText(value);
	const needle = normalizeSearchText(query);
	if (!needle || !target.includes(needle)) return 0;
	return target === needle ? weight + 4 : weight;
}

function compareByScoreThenRecent<
	T extends { score: number; updatedAt: number; id: string },
>(left: T, right: T): number {
	return (
		right.score - left.score ||
		right.updatedAt - left.updatedAt ||
		left.id.localeCompare(right.id)
	);
}

async function loadArtifactTextRows(
	artifactIds: string[],
): Promise<ArtifactTextRow[]> {
	if (artifactIds.length === 0) return [];
	return db
		.select({
			id: artifacts.id,
			contentText: artifacts.contentText,
			summary: artifacts.summary,
		})
		.from(artifacts)
		.where(inArray(artifacts.id, artifactIds))
		.limit(artifactIds.length);
}

async function loadMatchingArtifactTextCandidateRows(
	userId: string,
	query: string,
	ownershipScope: ArtifactOwnershipScope,
): Promise<ArtifactTextCandidateRow[]> {
	const likeQuery = `%${escapeLike(query.toLowerCase())}%`;
	const rows = await db
		.select({
			id: artifacts.id,
			userId: artifacts.userId,
			type: artifacts.type,
			conversationId: artifacts.conversationId,
			contentText: artifacts.contentText,
			summary: artifacts.summary,
		})
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				inArray(artifacts.type, [
					"source_document",
					"normalized_document",
					"generated_output",
					"skill_note",
				]),
				sql`(
					lower(${artifacts.contentText}) like ${likeQuery} escape '\\'
					or lower(${artifacts.summary}) like ${likeQuery} escape '\\'
				)`,
			),
		)
		.orderBy(desc(artifacts.updatedAt), artifacts.id)
		.limit(DOCUMENT_CONTENT_CANDIDATE_LIMIT);

	return rows.filter((row) =>
		isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row }),
	);
}

async function loadMatchingArtifactMetadataCandidateRows(
	userId: string,
	query: string,
	ownershipScope: ArtifactOwnershipScope,
): Promise<ArtifactCandidateRow[]> {
	const likeQuery = `%${escapeLike(query.toLowerCase())}%`;
	const rows = await db
		.select({
			id: artifacts.id,
			userId: artifacts.userId,
			type: artifacts.type,
			conversationId: artifacts.conversationId,
		})
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				inArray(artifacts.type, [
					"source_document",
					"normalized_document",
					"generated_output",
					"skill_note",
				]),
				sql`(
					${artifacts.type} <> 'generated_output'
					or (
						${artifacts.retrievalClass} = 'durable'
						and json_extract(${artifacts.metadataJson}, '$.sourceChatFileId') is not null
					)
				)`,
				sql`(
					lower(${artifacts.name}) like ${likeQuery} escape '\\'
					or lower(${artifacts.summary}) like ${likeQuery} escape '\\'
					or lower(${artifacts.metadataJson}) like ${likeQuery} escape '\\'
				)`,
			),
		)
		.orderBy(desc(artifacts.updatedAt), artifacts.id)
		.limit(DOCUMENT_METADATA_CANDIDATE_LIMIT);

	return rows.filter((row) =>
		isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row }),
	);
}

/**
 * The artifact family's own candidate loader (Feature 2, ADR-0066): unlike
 * the two loaders above, which return bare id/type candidate rows and need a
 * second `getLogicalDocumentForArtifact` round trip per id to materialise,
 * this one already returns full `KnowledgeDocumentItem`s — there is no
 * family to expand, so that second round trip is not needed here.
 *
 * An App's `content_text` is HTML markup, and an Image's is JSON (file ids,
 * the prompt, marks), not prose: `not in ('app', 'image')` excludes both
 * from the content/summary half of the match so a CSS class name or a tag
 * name can never surface an unrelated app (Review Focus #3). A name match
 * still finds an App by its title, same as every other kind.
 */
async function loadMatchingArtifactFamilyCandidateRows(
	userId: string,
	query: string,
	ownershipScope: ArtifactOwnershipScope,
): Promise<KnowledgeDocumentItem[]> {
	const likeQuery = `%${escapeLike(query.toLowerCase())}%`;
	const rows = await db
		.select(knowledgeArtifactListSelection)
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				eq(artifacts.type, "artifact"),
				sql`(
					lower(${artifacts.name}) like ${likeQuery} escape '\\'
					or (
						json_extract(${artifacts.metadataJson}, '$.artifactType') not in ('app', 'image')
						and (
							lower(${artifacts.contentText}) like ${likeQuery} escape '\\'
							or lower(${artifacts.summary}) like ${likeQuery} escape '\\'
						)
					)
				)`,
			),
		)
		.orderBy(desc(artifacts.updatedAt), artifacts.id)
		.limit(DOCUMENT_FAMILY_CANDIDATE_LIMIT);

	const scopedRows = rows.filter((row) =>
		isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row }),
	);
	const versionNumbers = await getArtifactVersionNumbers(
		scopedRows.map((row) => row.id),
	);
	return scopedRows.map((row) =>
		mapArtifactFamilyRow(row, versionNumbers.get(row.id) ?? null),
	);
}

function getDocumentTextByArtifactId(
	rows: ArtifactTextRow[],
): Map<string, ArtifactTextRow> {
	return new Map(rows.map((row) => [row.id, row]));
}

function scoreDocument(
	document: KnowledgeDocumentItem,
	textRows: Map<string, ArtifactTextRow>,
	query: string,
): {
	score: number;
	type: WorkspaceSearchDocumentMatchType;
	snippet: string | null;
} {
	const fields: Array<{
		type: WorkspaceSearchDocumentMatchType;
		value: string | null | undefined;
		weight: number;
	}> = [
		{ type: "name", value: document.name, weight: 30 },
		{ type: "label", value: document.documentLabel, weight: 26 },
		{ type: "role", value: document.documentRole, weight: 20 },
		{ type: "summary", value: document.summary, weight: 14 },
	];

	let best = {
		score: 0,
		type: "name" as WorkspaceSearchDocumentMatchType,
		snippet: null as string | null,
	};
	for (const field of fields) {
		const score = termScore(field.value, query, field.weight);
		if (score > best.score) {
			best = {
				score,
				type: field.type,
				snippet:
					field.type === "summary" ? clipAroundQuery(field.value, query) : null,
			};
		}
	}

	for (const artifactId of document.familyArtifactIds) {
		// An App's `contentText` is HTML markup, not prose — never a match
		// reason. Necessary IN ADDITION to the candidate loader's own
		// exclusion: a row can become a candidate through its NAME (so it is
		// still a document by this point), and this loop re-scores it against
		// every field independently, so without this guard the raw markup
		// could still win the "best field" comparison (Review Focus #3).
		if (document.kind === "app" || document.kind === "image") continue;
		const textRow = textRows.get(artifactId);
		const contentScore = termScore(textRow?.contentText, query, 10);
		if (contentScore > best.score) {
			best = {
				score: contentScore,
				type: "content",
				snippet: clipAroundQuery(textRow?.contentText, query),
			};
		}
		const summaryScore = termScore(textRow?.summary, query, 14);
		if (summaryScore > best.score) {
			best = {
				score: summaryScore,
				type: "summary",
				snippet: clipAroundQuery(textRow?.summary, query),
			};
		}
	}

	return best;
}

function mapDocumentResult(
	document: KnowledgeDocumentItem,
	match: WorkspaceSearchDocumentResult["match"],
): WorkspaceSearchDocumentResult {
	return {
		id: document.id,
		type: document.type,
		displayArtifactId: document.displayArtifactId,
		promptArtifactId: document.promptArtifactId,
		familyArtifactIds: document.familyArtifactIds,
		name: document.name,
		mimeType: document.mimeType,
		sizeBytes: document.sizeBytes,
		conversationId: document.conversationId,
		summary: document.summary,
		documentOrigin: document.documentOrigin,
		documentFamilyId: document.documentFamilyId,
		documentFamilyStatus: document.documentFamilyStatus,
		documentLabel: document.documentLabel,
		documentRole: document.documentRole,
		versionNumber: document.versionNumber,
		originConversationId: document.originConversationId,
		originAssistantMessageId: document.originAssistantMessageId,
		sourceChatFileId: document.sourceChatFileId,
		updatedAt: document.updatedAt,
		href: buildKnowledgeWorkspaceHref(document),
		sourceHref: buildDocumentSourceHref(document),
		kind: document.kind,
		// Until documents.ts classifies each kind (Task 5), every row is a plain document.
		searchKind: "documents",
		badge: "document",
		originConversationTitle: null,
		preview: null,
		durationMs: null,
		match,
	};
}

async function searchDocuments(
	userId: string,
	query: string,
): Promise<{ results: WorkspaceSearchDocumentResult[]; overflow: boolean }> {
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const [metadataRows, contentRows, familyDocuments] = await Promise.all([
		loadMatchingArtifactMetadataCandidateRows(userId, query, ownershipScope),
		loadMatchingArtifactTextCandidateRows(userId, query, ownershipScope),
		loadMatchingArtifactFamilyCandidateRows(userId, query, ownershipScope),
	]);
	// The legacy family's candidates are bare id/type rows and need a second
	// round trip to materialise into full documents; the artifact family's
	// candidates are already full `KnowledgeDocumentItem`s (no family to
	// expand), so they are used directly instead.
	const legacyDocuments = (
		await Promise.all(
			Array.from(
				new Set([
					...metadataRows.map((row) => row.id),
					...contentRows.map((row) => row.id),
				]),
			).map((artifactId) => getLogicalDocumentForArtifact(userId, artifactId)),
		)
	).filter((document): document is KnowledgeDocumentItem => Boolean(document));
	const documentsByDisplayId = new Map<string, KnowledgeDocumentItem>();
	for (const document of [...legacyDocuments, ...familyDocuments]) {
		documentsByDisplayId.set(document.displayArtifactId, document);
	}
	const documents = Array.from(documentsByDisplayId.values());
	const artifactIds = Array.from(
		new Set(documents.flatMap((document) => document.familyArtifactIds)),
	);
	const textRows = getDocumentTextByArtifactId(
		await loadArtifactTextRows(artifactIds),
	);
	const ranked = documents
		.map((document) => {
			const match = scoreDocument(document, textRows, query);
			return {
				document,
				score: match.score,
				updatedAt: document.updatedAt,
				id: document.displayArtifactId,
				match,
			};
		})
		.filter((entry) => entry.score > 0)
		.sort(compareByScoreThenRecent);

	return {
		results: ranked.slice(0, QUERY_LIMIT).map((entry) =>
			mapDocumentResult(entry.document, {
				type: entry.match.type,
				snippet: entry.match.snippet,
			}),
		),
		overflow:
			ranked.length > QUERY_LIMIT ||
			metadataRows.length >= DOCUMENT_METADATA_CANDIDATE_LIMIT ||
			contentRows.length >= DOCUMENT_CONTENT_CANDIDATE_LIMIT ||
			familyDocuments.length >= DOCUMENT_FAMILY_CANDIDATE_LIMIT,
	};
}

async function loadDefaultDocuments(
	userId: string,
): Promise<{ results: WorkspaceSearchDocumentResult[]; overflow: boolean }> {
	const page = await listLogicalDocumentsPage(userId, {
		includeGeneratedOutputs: true,
		limit: DEFAULT_LIMIT,
		sortDirection: "desc",
		sortKey: "date",
	});
	return {
		results: page.documents.map((document) =>
			mapDocumentResult(document, { type: "recent", snippet: null }),
		),
		overflow: page.totalItems > DEFAULT_LIMIT,
	};
}

const CURSOR_PATTERN = /^o:(\d{1,6})$/;

/** A cursor is "o:<offset>"; one that cannot be read counts as none. */
function readCursorOffset(cursor: string | null | undefined): number {
	const match = CURSOR_PATTERN.exec(cursor ?? "");
	return match ? Number(match[1]) : 0;
}

function emptyTotals(): Record<WorkspaceSearchKind, number> {
	return { chats: 0, memory: 0, documents: 0, media: 0, apps: 0 };
}

export async function searchWorkspace(
	userId: string,
	options: {
		query?: string | null;
		scope?: WorkspaceSearchScope | null;
		cursor?: string | null;
	} = {},
): Promise<WorkspaceSearchResponse> {
	const query = normalizeQuery(options.query);
	const terms = searchTerms(query);
	// A query with no words once cleaned ("!!") shows the empty-query view.
	const mode =
		terms.join("").length >= SEARCH_MIN_QUERY_CHARS ? "query" : "default";

	if (mode === "default") {
		const [conversationResults, documentResults] = await Promise.all([
			recentChats(userId, SEARCH_ALL_PER_KIND),
			loadDefaultDocuments(userId),
		]);
		return {
			query,
			mode,
			scope: "all",
			conversations: conversationResults,
			memories: [],
			documents: documentResults.results,
			totals: {
				...emptyTotals(),
				chats: conversationResults.length,
				documents: documentResults.results.length,
			},
			memorySearchable: false,
			nextCursor: null,
			documentOverflow: documentResults.overflow,
			knowledgeHref: documentResults.overflow
				? buildKnowledgeHref(query)
				: null,
		};
	}

	const scope = options.scope ?? "all";
	const chatWindow =
		scope === "chats"
			? { offset: readCursorOffset(options.cursor), limit: SEARCH_PAGE_SIZE }
			: { offset: 0, limit: SEARCH_ALL_PER_KIND };
	const [chatResults, documentResults] = await Promise.all([
		scope === "all" || scope === "chats"
			? searchChats(
					userId,
					{ terms, words: typedSearchWords(query) },
					chatWindow,
				)
			: null,
		scope === "all" || scope === "documents"
			? searchDocuments(userId, query)
			: null,
	]);
	return {
		query,
		mode,
		scope,
		conversations: chatResults?.results ?? [],
		memories: [],
		documents: documentResults?.results ?? [],
		totals: {
			...emptyTotals(),
			chats: chatResults?.total ?? 0,
			documents: documentResults?.results.length ?? 0,
		},
		memorySearchable: false,
		nextCursor:
			scope === "chats" && chatResults?.hasMore
				? `o:${chatWindow.offset + chatWindow.limit}`
				: null,
		documentOverflow: documentResults?.overflow ?? false,
		knowledgeHref: documentResults?.overflow ? buildKnowledgeHref(query) : null,
	};
}
