import {
	and,
	count,
	desc,
	eq,
	inArray,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	conversationSummaries,
	conversations,
	messages,
} from "$lib/server/db/schema";
import {
	type HonchoPersonaRecallResult,
	recallPersonaMemory,
} from "$lib/server/services/honcho";
import {
	getProjectContext,
	type ProjectContextResult,
} from "$lib/server/services/memory-context/project";
import { clipNullableText, normalizeWhitespace } from "$lib/server/utils/text";
import type { ToolEvidenceCandidate } from "$lib/types";

export type MemoryContextMode = "project" | "persona" | "history";

export type GetMemoryContextParams = {
	userId: string;
	conversationId: string;
	mode?: string | null;
	query?: string | null;
	userDisplayName?: string | null;
	maxSiblings?: number | null;
	siblingConversationId?: string | null;
	maxMessages?: number | null;
	maxHistoryConversations?: number | null;
	historyConversationId?: string | null;
	selectedConversationId?: string | null;
	includeEvidenceCandidates?: boolean;
};

export type ProjectMemoryContextResult = Omit<ProjectContextResult, "mode"> & {
	mode: "project";
	projectMode: ProjectContextResult["mode"];
};

export type PersonaMemoryContextResult = {
	success: true;
	mode: "persona";
	status: "available" | HonchoPersonaRecallResult["status"];
	source: HonchoPersonaRecallResult["source"];
	content: string | null;
	error?: string;
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		query: string;
	};
};

export type HistoryMemoryContextMessage = {
	role: "user" | "assistant";
	content: string;
	createdAt: number;
};

export type HistoryMemoryContextConversation = {
	conversationId: string;
	title: string;
	summary: string | null;
	updatedAt: number;
	messageSnippets: HistoryMemoryContextMessage[];
};

export type HistoryMemoryContextSelectedConversation =
	HistoryMemoryContextConversation & {
		messages: HistoryMemoryContextMessage[];
		omittedMessageCount: number;
	};

export type HistoryMemoryContextResult = {
	success: true;
	mode: "history";
	status: "available" | "empty";
	source: "conversation_summaries";
	query: string;
	conversations: HistoryMemoryContextConversation[];
	omittedConversationCount: number;
	selectedConversation: HistoryMemoryContextSelectedConversation | null;
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		query: string;
		requestedMaxHistoryConversations: number | null;
		appliedMaxHistoryConversations: number;
		historyConversationId: string | null;
		requestedMaxMessages: number | null;
		appliedMaxMessages: number;
	};
};

export type MemoryContextResult =
	| ProjectMemoryContextResult
	| PersonaMemoryContextResult
	| HistoryMemoryContextResult;

const DEFAULT_PERSONA_RECALL_QUERY =
	"What durable user preferences, goals, constraints, and personal context are relevant?";
const HISTORY_SUMMARY_MATCH_LIMIT = 5_000;
const HISTORY_MESSAGE_MATCH_LIMIT = 10_000;
const DEFAULT_MAX_HISTORY_CONVERSATIONS = 8;
const OPERATIONAL_MAX_HISTORY_CONVERSATIONS = 32;
const HISTORY_MESSAGE_SNIPPETS_PER_CONVERSATION = 3;
const HISTORY_SNIPPET_MAX_CHARS = 700;
const HISTORY_MESSAGE_MAX_CHARS = 1_200;
const MIN_MAX_HISTORY_MESSAGES = 10;
const OPERATIONAL_MAX_HISTORY_MESSAGES = 96;
const HISTORY_QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"all",
	"am",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"but",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"know",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"please",
	"remember",
	"tell",
	"that",
	"the",
	"their",
	"them",
	"there",
	"this",
	"to",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"with",
	"would",
	"you",
	"your",
]);

function buildPersonaEvidenceCandidate(params: {
	userId: string;
	content: string | null;
}): ToolEvidenceCandidate[] {
	const snippet = clipNullableText(
		normalizeWhitespace(params.content ?? ""),
		700,
	);
	if (!snippet) return [];
	return [
		{
			id: `memory-context:persona:${params.userId}`,
			title: "Honcho persona recall",
			snippet,
			sourceType: "memory",
		},
	];
}

async function getProjectMemoryContext(
	params: GetMemoryContextParams,
): Promise<ProjectMemoryContextResult> {
	const projectMode = params.siblingConversationId ? "detail" : "summary";
	const result = await getProjectContext({
		userId: params.userId,
		conversationId: params.conversationId,
		mode: projectMode,
		query: params.query ?? null,
		maxSiblings: params.maxSiblings,
		siblingConversationId: params.siblingConversationId?.trim() || null,
		maxMessages: params.maxMessages,
		includeEvidenceCandidates: params.includeEvidenceCandidates,
	});

	return {
		...result,
		mode: "project",
		projectMode: result.mode,
	};
}

async function getPersonaMemoryContext(
	params: GetMemoryContextParams,
): Promise<PersonaMemoryContextResult> {
	const query = params.query?.trim() || DEFAULT_PERSONA_RECALL_QUERY;
	const recall = await recallPersonaMemory({
		userId: params.userId,
		userDisplayName: params.userDisplayName,
		query,
	});
	const status = recall.status === "ok" ? "available" : recall.status;

	return {
		success: true,
		mode: "persona",
		status,
		source: recall.source,
		content: recall.content,
		...(recall.error ? { error: recall.error } : {}),
		evidenceCandidates:
			params.includeEvidenceCandidates === false
				? []
				: buildPersonaEvidenceCandidate({
						userId: params.userId,
						content: recall.content,
					}),
		audit: {
			conversationId: params.conversationId,
			query,
		},
	};
}

function toTimestampMs(value: Date | number | null | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	return 0;
}

function normalizePositiveLimit(
	value: number | null | undefined,
	fallback: number,
	maximum: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function requestedLimit(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenizeQuery(query: string): string[] {
	return Array.from(
		new Set(
			(query.toLowerCase().match(/[a-z0-9%_\\]+/gi) ?? []).filter(
				(term) =>
					/[a-z0-9]/i.test(term) &&
					term.length >= 2 &&
					!HISTORY_QUERY_STOPWORDS.has(term),
			),
		),
	);
}

function escapeHistoryLikeTerm(term: string): string {
	return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function scoreHistoryText(terms: string[], text: string): number {
	if (terms.length === 0) return 1;
	const normalized = text.toLowerCase();
	return terms.reduce(
		(score, term) => score + (normalized.includes(term) ? 1 : 0),
		0,
	);
}

function buildHistoryTermFilter(
	terms: string[],
	columns: SQL[],
): SQL | undefined {
	if (terms.length === 0) return undefined;
	const filters = terms.flatMap((term) => {
		const pattern = `%${escapeHistoryLikeTerm(term)}%`;
		return columns.map(
			(column) => sql`lower(${column}) like ${pattern} escape '\\'`,
		);
	});
	return or(...filters);
}

function clipHistoryMessage(content: string): string {
	return (
		clipNullableText(normalizeWhitespace(content), HISTORY_MESSAGE_MAX_CHARS) ??
		""
	);
}

async function getDb() {
	const module = await import("$lib/server/db");
	return module.db;
}

type HistoryCandidate = {
	conversationId: string;
	title: string;
	summary: string | null;
	updatedAt: number;
	score: number;
	messageSnippets: HistoryMemoryContextMessage[];
};

async function listHistoryCandidates(params: {
	userId: string;
	conversationId: string;
	query: string;
}): Promise<HistoryCandidate[]> {
	const db = await getDb();
	const terms = tokenizeQuery(params.query);
	if (terms.length === 0) return [];
	const summaryFilter = buildHistoryTermFilter(terms, [
		sql`${conversations.title}`,
		sql`${conversationSummaries.summary}`,
	]);
	const messageFilter = buildHistoryTermFilter(terms, [
		sql`${messages.content}`,
	]);
	const summaryRows = await db
		.select({
			conversationId: conversationSummaries.conversationId,
			title: conversations.title,
			summary: conversationSummaries.summary,
			updatedAt: conversationSummaries.updatedAt,
		})
		.from(conversationSummaries)
		.innerJoin(
			conversations,
			eq(conversationSummaries.conversationId, conversations.id),
		)
		.where(
			and(
				eq(conversationSummaries.userId, params.userId),
				eq(conversations.userId, params.userId),
				isNull(conversations.projectId),
				ne(conversations.id, params.conversationId),
				summaryFilter,
			),
		)
		.orderBy(desc(conversationSummaries.updatedAt))
		.limit(HISTORY_SUMMARY_MATCH_LIMIT);
	const messageRows = await db
		.select({
			conversationId: messages.conversationId,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
			role: messages.role,
			content: messages.content,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.innerJoin(conversations, eq(messages.conversationId, conversations.id))
		.where(
			and(
				eq(conversations.userId, params.userId),
				isNull(conversations.projectId),
				ne(conversations.id, params.conversationId),
				inArray(messages.role, ["user", "assistant"]),
				messageFilter,
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(HISTORY_MESSAGE_MATCH_LIMIT);

	const candidates = new Map<string, HistoryCandidate>();
	for (const row of summaryRows) {
		const score = scoreHistoryText(terms, `${row.title}\n${row.summary ?? ""}`);
		if (score <= 0) continue;
		candidates.set(row.conversationId, {
			conversationId: row.conversationId,
			title: row.title,
			summary: row.summary,
			updatedAt: toTimestampMs(row.updatedAt),
			score,
			messageSnippets: [],
		});
	}

	for (const row of messageRows) {
		const score = scoreHistoryText(terms, row.content);
		if (score <= 0) continue;
		const current =
			candidates.get(row.conversationId) ??
			({
				conversationId: row.conversationId,
				title: row.title,
				summary: null,
				updatedAt: toTimestampMs(row.updatedAt),
				score: 0,
				messageSnippets: [],
			} satisfies HistoryCandidate);
		current.score += score;
		if (
			current.messageSnippets.length < HISTORY_MESSAGE_SNIPPETS_PER_CONVERSATION
		) {
			current.messageSnippets.push({
				role: row.role as "user" | "assistant",
				content:
					clipNullableText(
						normalizeWhitespace(row.content),
						HISTORY_SNIPPET_MAX_CHARS,
					) ?? "",
				createdAt: toTimestampMs(row.createdAt),
			});
		}
		candidates.set(row.conversationId, current);
	}

	return Array.from(candidates.values()).sort((left, right) => {
		if (right.score !== left.score) return right.score - left.score;
		return right.updatedAt - left.updatedAt;
	});
}

async function loadHistoryConversationDetail(params: {
	userId: string;
	currentConversationId: string;
	historyConversationId: string;
	maxMessages: number;
	candidate?: HistoryCandidate | null;
}): Promise<HistoryMemoryContextSelectedConversation> {
	const db = await getDb();
	const [conversation] = await db
		.select({
			conversationId: conversations.id,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.id, params.historyConversationId),
				eq(conversations.userId, params.userId),
				isNull(conversations.projectId),
				ne(conversations.id, params.currentConversationId),
			),
		)
		.limit(1);
	if (!conversation) {
		throw new Error(
			"historyConversationId is outside memory_context history scope",
		);
	}
	const [summary] = await db
		.select({
			summary: conversationSummaries.summary,
			updatedAt: conversationSummaries.updatedAt,
		})
		.from(conversationSummaries)
		.where(
			and(
				eq(conversationSummaries.userId, params.userId),
				eq(conversationSummaries.conversationId, params.historyConversationId),
			),
		)
		.limit(1);
	const dialogueWhere = and(
		eq(messages.conversationId, params.historyConversationId),
		inArray(messages.role, ["user", "assistant"]),
	);
	const [countRows, rows] = await Promise.all([
		db.select({ messageCount: count() }).from(messages).where(dialogueWhere),
		db
			.select({
				role: messages.role,
				content: messages.content,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(dialogueWhere)
			.orderBy(desc(messages.createdAt))
			.limit(params.maxMessages),
	]);
	const selectedMessages = rows
		.map((row) => ({
			role: row.role as "user" | "assistant",
			content: clipHistoryMessage(row.content),
			createdAt: toTimestampMs(row.createdAt),
		}))
		.reverse();
	const messageCount = countRows[0]?.messageCount ?? selectedMessages.length;
	const base = params.candidate;
	return {
		conversationId: conversation.conversationId,
		title: conversation.title,
		summary: summary?.summary ?? base?.summary ?? null,
		updatedAt: toTimestampMs(summary?.updatedAt ?? conversation.updatedAt),
		messageSnippets: base?.messageSnippets ?? [],
		messages: selectedMessages,
		omittedMessageCount: Math.max(0, messageCount - selectedMessages.length),
	};
}

function buildHistoryEvidenceCandidates(
	conversations: HistoryMemoryContextConversation[],
): ToolEvidenceCandidate[] {
	return conversations.map((conversation) => ({
		id: `memory-context:history:${conversation.conversationId}`,
		title: conversation.title,
		snippet: clipNullableText(
			[
				conversation.summary,
				...conversation.messageSnippets.map(
					(message) => `${message.role}: ${message.content}`,
				),
			]
				.filter(Boolean)
				.join(" "),
			700,
		),
		sourceType: "memory" as const,
	}));
}

async function getHistoryMemoryContext(
	params: GetMemoryContextParams,
): Promise<HistoryMemoryContextResult> {
	const query = params.query?.trim() ?? "";
	const maxHistoryConversations = normalizePositiveLimit(
		params.maxHistoryConversations,
		DEFAULT_MAX_HISTORY_CONVERSATIONS,
		OPERATIONAL_MAX_HISTORY_CONVERSATIONS,
	);
	const maxMessages = normalizePositiveLimit(
		params.maxMessages,
		MIN_MAX_HISTORY_MESSAGES,
		OPERATIONAL_MAX_HISTORY_MESSAGES,
	);
	const historyConversationId =
		params.historyConversationId?.trim() ||
		params.selectedConversationId?.trim() ||
		null;
	const candidates = await listHistoryCandidates({
		userId: params.userId,
		conversationId: params.conversationId,
		query,
	});
	const selectedCandidates = candidates.slice(0, maxHistoryConversations);
	const conversations = selectedCandidates.map((candidate) => ({
		conversationId: candidate.conversationId,
		title: candidate.title,
		summary: candidate.summary,
		updatedAt: candidate.updatedAt,
		messageSnippets: candidate.messageSnippets,
	}));
	const selectedHistoryCandidate = historyConversationId
		? selectedCandidates.find(
				(candidate) => candidate.conversationId === historyConversationId,
			)
		: null;
	if (historyConversationId && !selectedHistoryCandidate) {
		throw new Error(
			"historyConversationId is outside memory_context history scope",
		);
	}
	const selectedConversation = historyConversationId
		? await loadHistoryConversationDetail({
				userId: params.userId,
				currentConversationId: params.conversationId,
				historyConversationId,
				maxMessages,
				candidate: selectedHistoryCandidate,
			})
		: null;

	return {
		success: true,
		mode: "history",
		status:
			conversations.length > 0 || selectedConversation ? "available" : "empty",
		source: "conversation_summaries",
		query,
		conversations,
		omittedConversationCount: Math.max(
			0,
			candidates.length - conversations.length,
		),
		selectedConversation,
		evidenceCandidates:
			params.includeEvidenceCandidates === false
				? []
				: buildHistoryEvidenceCandidates(conversations),
		audit: {
			conversationId: params.conversationId,
			query,
			requestedMaxHistoryConversations: requestedLimit(
				params.maxHistoryConversations,
			),
			appliedMaxHistoryConversations: maxHistoryConversations,
			historyConversationId,
			requestedMaxMessages: requestedLimit(params.maxMessages),
			appliedMaxMessages: maxMessages,
		},
	};
}

export async function getMemoryContext(
	params: GetMemoryContextParams,
): Promise<MemoryContextResult> {
	const mode = params.mode?.trim() || "persona";
	if (mode === "project") {
		return getProjectMemoryContext(params);
	}
	if (mode === "persona") {
		return getPersonaMemoryContext(params);
	}
	if (mode === "history") {
		return getHistoryMemoryContext(params);
	}
	throw new Error(`Unsupported memory_context mode: ${mode}`);
}
