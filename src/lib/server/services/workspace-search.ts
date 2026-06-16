import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	conversations,
	messages,
	projects,
} from "$lib/server/db/schema";
import {
	listLogicalDocuments,
	listLogicalDocumentsPage,
} from "$lib/server/services/knowledge/store";
import { resolveWorkingDocumentIdentity } from "$lib/services/working-document-identity";
import type {
	KnowledgeDocumentItem,
	WorkspaceSearchConversationResult,
	WorkspaceSearchDocumentMatchType,
	WorkspaceSearchDocumentResult,
	WorkspaceSearchResponse,
} from "$lib/types";

const DEFAULT_LIMIT = 3;
const QUERY_LIMIT = 6;
const CONVERSATION_SCAN_LIMIT = 200;
const MESSAGE_SCAN_LIMIT = 500;
const SNIPPET_RADIUS = 64;

type ConversationRow = {
	id: string;
	title: string;
	projectId: string | null;
	projectName: string | null;
	status: string;
	sealedAt: Date | null;
	updatedAt: Date;
};

type MessageMatchRow = ConversationRow & {
	messageId: string;
	messageRole: string;
	messageContent: string;
	messageCreatedAt: Date;
};

type ArtifactTextRow = {
	id: string;
	contentText: string | null;
	summary: string | null;
};

type ConversationCandidate = {
	row: ConversationRow;
	score: number;
	match: WorkspaceSearchConversationResult["match"];
};

function normalizeQuery(value: string | null | undefined): string {
	return (value ?? "").trim();
}

function isQueryMode(query: string): boolean {
	return query.replace(/\s+/g, "").length >= 2;
}

function normalizeSearchText(value: string | null | undefined): string {
	return (value ?? "").toLowerCase();
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toUnixSeconds(value: Date | null | undefined): number | null {
	return value instanceof Date ? value.getTime() / 1000 : null;
}

function buildChatHref(
	conversationId: string,
	messageId?: string | null,
): string {
	const url = new URL(`/chat/${conversationId}`, "http://localhost");
	if (messageId) {
		url.searchParams.set("focus_message", messageId);
	}
	return `${url.pathname}${url.search}`;
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

function mapConversationResult(
	row: ConversationRow,
	match: WorkspaceSearchConversationResult["match"],
): WorkspaceSearchConversationResult {
	return {
		id: row.id,
		title: row.title,
		projectId: row.projectId ?? null,
		projectName: row.projectName ?? null,
		status: row.status === "sealed" ? "sealed" : "open",
		sealedAt: toUnixSeconds(row.sealedAt),
		updatedAt: toUnixSeconds(row.updatedAt) ?? 0,
		href: buildChatHref(row.id, match.messageId),
		match,
	};
}

async function loadVisibleConversationRows(
	userId: string,
	limit: number,
): Promise<ConversationRow[]> {
	return db
		.select({
			id: conversations.id,
			title: conversations.title,
			projectId: conversations.projectId,
			projectName: projects.name,
			status: conversations.status,
			sealedAt: conversations.sealedAt,
			updatedAt: conversations.updatedAt,
		})
		.from(conversations)
		.leftJoin(projects, eq(projects.id, conversations.projectId))
		.where(
			and(
				eq(conversations.userId, userId),
				sql`exists (
					select 1 from ${messages}
					where ${messages.conversationId} = ${conversations.id}
					limit 1
				)`,
			),
		)
		.orderBy(desc(conversations.updatedAt), conversations.id)
		.limit(limit);
}

async function loadMatchingMessageRows(
	userId: string,
	query: string,
): Promise<MessageMatchRow[]> {
	const likeQuery = `%${escapeLike(query.toLowerCase())}%`;
	const rows = await db
		.select({
			id: conversations.id,
			title: conversations.title,
			projectId: conversations.projectId,
			projectName: projects.name,
			status: conversations.status,
			sealedAt: conversations.sealedAt,
			updatedAt: conversations.updatedAt,
			messageId: messages.id,
			messageRole: messages.role,
			messageContent: messages.content,
			messageCreatedAt: messages.createdAt,
		})
		.from(messages)
		.leftJoin(conversations, eq(conversations.id, messages.conversationId))
		.leftJoin(projects, eq(projects.id, conversations.projectId))
		.where(
			and(
				eq(conversations.userId, userId),
				sql`lower(${messages.content}) like ${likeQuery} escape '\\'`,
			),
		)
		.orderBy(desc(messages.createdAt), messages.id)
		.limit(MESSAGE_SCAN_LIMIT);

	return rows
		.filter((row): row is MessageMatchRow =>
			Boolean(row.id && row.title && row.status && row.updatedAt),
		)
		.map((row) => ({
			...row,
			projectId: row.projectId ?? null,
			projectName: row.projectName ?? null,
			sealedAt: row.sealedAt ?? null,
		}));
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

function rankConversationRows(
	rows: ConversationRow[],
	messageRows: MessageMatchRow[],
	query: string,
): WorkspaceSearchConversationResult[] {
	const candidates = new Map<string, ConversationCandidate>();

	for (const row of rows) {
		const titleScore = termScore(row.title, query, 30);
		const projectScore = termScore(row.projectName, query, 22);
		const score = Math.max(titleScore, projectScore);
		if (score <= 0) continue;
		candidates.set(row.id, {
			row,
			score,
			match: {
				type: titleScore >= projectScore ? "title" : "project",
				snippet: null,
				messageId: null,
				messageRole: null,
			},
		});
	}

	for (const messageRow of messageRows) {
		const score = termScore(messageRow.messageContent, query, 12);
		if (score <= 0) continue;
		const existing = candidates.get(messageRow.id);
		if (existing && existing.score >= score) continue;
		candidates.set(messageRow.id, {
			row: messageRow,
			score,
			match: {
				type: "body",
				snippet: clipAroundQuery(messageRow.messageContent, query),
				messageId: messageRow.messageId,
				messageRole: messageRow.messageRole,
			},
		});
	}

	return Array.from(candidates.values())
		.map((candidate) => ({
			...mapConversationResult(candidate.row, candidate.match),
			score: candidate.score,
		}))
		.sort(compareByScoreThenRecent)
		.slice(0, QUERY_LIMIT)
		.map(({ score: _score, ...result }) => result);
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
		match,
	};
}

async function searchDocuments(
	userId: string,
	query: string,
): Promise<{ results: WorkspaceSearchDocumentResult[]; overflow: boolean }> {
	const documents = await listLogicalDocuments(userId, {
		includeGeneratedOutputs: true,
	});
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
		overflow: ranked.length > QUERY_LIMIT,
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

export async function searchWorkspace(
	userId: string,
	options: { query?: string | null } = {},
): Promise<WorkspaceSearchResponse> {
	const query = normalizeQuery(options.query);
	const mode = isQueryMode(query) ? "query" : "default";

	if (mode === "default") {
		const [conversationRows, documentResults] = await Promise.all([
			loadVisibleConversationRows(userId, DEFAULT_LIMIT),
			loadDefaultDocuments(userId),
		]);
		return {
			query,
			mode,
			conversations: conversationRows.map((row) =>
				mapConversationResult(row, {
					type: "recent",
					snippet: null,
					messageId: null,
					messageRole: null,
				}),
			),
			documents: documentResults.results,
			documentOverflow: documentResults.overflow,
			knowledgeHref: documentResults.overflow
				? buildKnowledgeHref(query)
				: null,
		};
	}

	const [conversationRows, messageRows, documentResults] = await Promise.all([
		loadVisibleConversationRows(userId, CONVERSATION_SCAN_LIMIT),
		loadMatchingMessageRows(userId, query),
		searchDocuments(userId, query),
	]);
	return {
		query,
		mode,
		conversations: rankConversationRows(conversationRows, messageRows, query),
		documents: documentResults.results,
		documentOverflow: documentResults.overflow,
		knowledgeHref: documentResults.overflow ? buildKnowledgeHref(query) : null,
	};
}
