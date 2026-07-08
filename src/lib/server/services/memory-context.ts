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
import { listMessageAttachments } from "$lib/server/services/knowledge/store/attachments";
import { getArtifactsForUser } from "$lib/server/services/knowledge/store/core";
import { getPersonaSummary } from "$lib/server/services/memory-consolidation/summary";
import {
	getProjectContext,
	type ProjectContextResult,
} from "$lib/server/services/memory-context/project";
import {
	type ActiveMemoryProfileContext,
	formatActiveMemoryProfileContextForPrompt,
	getActiveMemoryProfileContext,
	listProjectionPolicyBlockedStatements,
	type MemoryProfileScope,
} from "$lib/server/services/memory-profile/active-context";
import { recordMemoryReworkTelemetry } from "$lib/server/services/memory-profile/telemetry";
import {
	messageOrderDesc,
	messageTimestampOrderDesc,
} from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { getConversationProjectId } from "$lib/server/services/projects";
import { shortlistSemanticMatchesBySubject } from "$lib/server/services/semantic-ranking";
import {
	clipNullableText,
	clipText,
	normalizeWhitespace,
} from "$lib/server/utils/text";
import type { ChatAttachment, ToolEvidenceCandidate } from "$lib/types";

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
	includeAttachments?: boolean;
};

export type ProjectMemoryContextResult = Omit<ProjectContextResult, "mode"> & {
	mode: "project";
	projectMode: ProjectContextResult["mode"];
};

export type PersonaMemoryContextResult = {
	success: true;
	mode: "persona";
	status: "available" | "empty" | "error";
	source: "active_memory_profile";
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
	attachments?: Array<{ name: string; content: string }>;
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
const PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET = 8_000;
const HISTORY_SUMMARY_MATCH_LIMIT = 5_000;
const HISTORY_MESSAGE_MATCH_LIMIT = 10_000;
const DEFAULT_MAX_HISTORY_CONVERSATIONS = 8;
const OPERATIONAL_MAX_HISTORY_CONVERSATIONS = 32;
const HISTORY_MESSAGE_SNIPPETS_PER_CONVERSATION = 3;
const HISTORY_SNIPPET_MAX_CHARS = 700;
const HISTORY_MESSAGE_MAX_CHARS = 1_200;
const MIN_MAX_HISTORY_MESSAGES = 10;
const OPERATIONAL_MAX_HISTORY_MESSAGES = 96;
const PROJECT_REPORT_QUERY_RE =
	/\b(report|pdf|docx?|document|export|download|file|summari[sz]e|write[- ]?up)\b|(?:jelentés|jelentes|riport|dokumentum|fájl|fajl|letöltés|letoltes|összefoglal(?:ó|o)?|foglalj\s+össze|foglalj\s+ossze|írd\s+meg|ird\s+meg|készíts|keszits)/iu;
const PROJECT_FOLDER_QUERY_RE =
	/\b(project folder|folder|project|workspace|content from|content of|memory)\b|(?:projektmappa|projekt[\p{L}]*|mappa|munkaterület|munkaterulet|memória|memoria|korábbi\s+beszélgetések|korabbi\s+beszelgetesek|kapcsolódó\s+beszélgetések|kapcsolodo\s+beszelgetesek)/iu;
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
	"az",
	"egy",
	"és",
	"vagy",
	"hogy",
	"de",
	"ha",
	"akkor",
	"mert",
	"nem",
	"van",
	"volt",
	"lesz",
	"ezt",
	"azt",
	"itt",
	"ott",
	"nekem",
	"neki",
	"róla",
	"rola",
	"erről",
	"errol",
	"arról",
	"arrol",
	"kérlek",
	"kerlek",
	"tudsz",
	"tudnál",
	"tudnal",
	"mondd",
	"mondj",
	"mi",
	"mit",
	"milyen",
	"hogyan",
	"hol",
	"mikor",
	"melyik",
	"keress",
	"keres",
	"rá",
	"ra",
]);

type ProjectionPolicyBlockedStatement = Awaited<
	ReturnType<typeof listProjectionPolicyBlockedStatements>
>[number];

function summarizeActiveMemoryProfileTelemetry(
	context: ActiveMemoryProfileContext,
): {
	categoryCounts: Record<string, number>;
	scopeCounts: Record<string, number>;
} {
	const categoryCounts: Record<string, number> = {};
	const scopeCounts: Record<string, number> = {};
	for (const item of context.items) {
		categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
		scopeCounts[item.scope.type] = (scopeCounts[item.scope.type] ?? 0) + 1;
	}
	return { categoryCounts, scopeCounts };
}

async function recordMemoryContextPromptTelemetry(params: {
	userId: string;
	eventName: string;
	reason: string;
	status: string;
	count: number;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "prompt_use",
			eventName: params.eventName,
			reason: params.reason,
			status: params.status,
			count: params.count,
			metadata: params.metadata,
		});
	} catch {
		// Tool responses should not fail because telemetry is unavailable.
	}
}

function normalizeMemoryPolicyText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function screenContentAgainstProjectionPolicy(params: {
	blockedStatements: ProjectionPolicyBlockedStatement[];
	content: string | null;
}): {
	blocked: boolean;
	blockedCount: number;
	unresolvedStatuses: string[];
} {
	const normalizedContent = normalizeMemoryPolicyText(params.content ?? "");
	if (!normalizedContent) {
		return { blocked: false, blockedCount: 0, unresolvedStatuses: [] };
	}

	let blockedCount = 0;
	const unresolvedStatuses = new Set<string>();
	for (const statement of params.blockedStatements) {
		const normalizedStatement = normalizeMemoryPolicyText(statement.statement);
		if (
			normalizedStatement.length >= 12 &&
			normalizedContent.includes(normalizedStatement)
		) {
			if (statement.status === "deleted" || statement.status === "suppressed") {
				blockedCount += 1;
			} else {
				unresolvedStatuses.add(statement.status);
			}
		}
	}
	return {
		blocked: blockedCount > 0,
		blockedCount,
		unresolvedStatuses: Array.from(unresolvedStatuses).sort(),
	};
}

export function resolveProjectMemoryContextMode(params: {
	query?: string | null;
	siblingConversationId?: string | null;
}): ProjectContextResult["mode"] {
	const query = params.query?.trim() ?? "";
	if (params.siblingConversationId?.trim()) return "detail";
	return PROJECT_REPORT_QUERY_RE.test(query) &&
		PROJECT_FOLDER_QUERY_RE.test(query)
		? "report"
		: "summary";
}

async function getProjectMemoryContext(
	params: GetMemoryContextParams,
): Promise<ProjectMemoryContextResult> {
	const projectMode = resolveProjectMemoryContextMode({
		query: params.query,
		siblingConversationId: params.siblingConversationId,
	});
	const result = await getProjectContext({
		userId: params.userId,
		conversationId: params.conversationId,
		mode: projectMode,
		query: params.query ?? null,
		maxSiblings: params.maxSiblings,
		siblingConversationId: params.siblingConversationId?.trim() || null,
		maxMessages: params.maxMessages,
		includeEvidenceCandidates: params.includeEvidenceCandidates,
		includeAttachments: params.includeAttachments,
	});

	return {
		...result,
		mode: "project",
		projectMode: result.mode,
	};
}

const PERSONA_FACT_TITLE_MAX_CHARS = 120;
const PERSONA_SEMANTIC_SHORTLIST_THRESHOLD = 12;
const PERSONA_SEMANTIC_SHORTLIST_LIMIT = 12;
const PERSONA_FACTS_MIN_TOKEN_BUDGET = 1_000;

type ActiveMemoryProfileItem = ActiveMemoryProfileContext["items"][number];

function buildPersonaFactEvidenceCandidates(params: {
	includedItemIds: string[];
	itemsById: Map<string, ActiveMemoryProfileItem>;
}): ToolEvidenceCandidate[] {
	const candidates: ToolEvidenceCandidate[] = [];
	for (const itemId of params.includedItemIds) {
		const item = params.itemsById.get(itemId);
		if (!item) continue;
		const title = clipText(
			normalizeWhitespace(item.statement),
			PERSONA_FACT_TITLE_MAX_CHARS,
		);
		candidates.push({
			id: `memory-fact:${itemId}`,
			title,
			sourceType: "memory",
			metadata: { memoryItemId: itemId },
		});
	}
	return candidates;
}

async function getPersonaMemoryContext(
	params: GetMemoryContextParams,
): Promise<PersonaMemoryContextResult> {
	const query = params.query?.trim() || DEFAULT_PERSONA_RECALL_QUERY;
	const trimmedQuery = params.query?.trim() ?? "";

	let summary: Awaited<ReturnType<typeof getPersonaSummary>>;
	let activeProfile: ActiveMemoryProfileContext;
	try {
		const projectId = await getConversationProjectId(
			params.userId,
			params.conversationId,
		).catch(() => null);
		const applicableScopes: MemoryProfileScope[] = [];
		if (projectId) {
			applicableScopes.push({ type: "project", id: projectId });
		}
		applicableScopes.push({
			type: "conversation",
			id: params.conversationId,
		});
		[summary, activeProfile] = await Promise.all([
			getPersonaSummary({ userId: params.userId }),
			getActiveMemoryProfileContext({
				userId: params.userId,
				applicableScopes,
			}),
		]);
	} catch (error) {
		await recordMemoryContextPromptTelemetry({
			userId: params.userId,
			eventName: "memory_context_persona_active_profile_blocked",
			reason: "active_profile_context_error",
			status: "error",
			count: 0,
		});

		return {
			success: true,
			mode: "persona",
			status: "error",
			source: "active_memory_profile",
			content: null,
			error:
				error instanceof Error ? error.message : "Memory profile unavailable",
			evidenceCandidates: [],
			audit: {
				conversationId: params.conversationId,
				query,
			},
		};
	}

	// Top-K: only when a query is present and the active fact set is large, rank
	// facts semantically and keep the best matches. A null shortlist (no TEI
	// configured) leaves the full fact set untouched.
	let factItems = activeProfile.items;
	if (trimmedQuery && factItems.length > PERSONA_SEMANTIC_SHORTLIST_THRESHOLD) {
		const shortlist = await shortlistSemanticMatchesBySubject({
			userId: params.userId,
			subjectType: "memory_profile_item",
			query: trimmedQuery,
			items: factItems,
			getSubjectId: (item) => item.id,
			limit: PERSONA_SEMANTIC_SHORTLIST_LIMIT,
		}).catch(() => null);
		if (shortlist) {
			factItems = shortlist.map((match) => match.item);
		}
	}

	const summaryTokens = summary ? Math.ceil(summary.text.length / 4) : 0;
	const factsMaxTokens = Math.max(
		PERSONA_FACTS_MIN_TOKEN_BUDGET,
		PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET - summaryTokens,
	);
	const formatted = formatActiveMemoryProfileContextForPrompt(
		{ ...activeProfile, items: factItems },
		{ maxTokens: factsMaxTokens },
	);

	const summarySection = summary
		? `Persona summary (auto-maintained):\n${summary.text}`
		: null;
	const factsSection =
		formatted.includedCount > 0 ? `Facts:\n${formatted.content}` : null;
	const content =
		[summarySection, factsSection].filter(Boolean).join("\n\n") || null;

	if (!content) {
		await recordMemoryContextPromptTelemetry({
			userId: params.userId,
			eventName: "memory_context_persona_active_profile_empty",
			reason: "no_active_projection_items",
			status: "empty",
			count: 0,
			metadata: {
				projectionRevision: activeProfile.projectionRevision,
				resetGeneration: activeProfile.resetGeneration,
				totalItemCount: activeProfile.items.length,
				omittedItemCount: formatted.omittedCount,
				hasSummary: false,
			},
		});

		return {
			success: true,
			mode: "persona",
			status: "empty",
			source: "active_memory_profile",
			content: null,
			evidenceCandidates: [],
			audit: {
				conversationId: params.conversationId,
				query,
			},
		};
	}

	await recordMemoryContextPromptTelemetry({
		userId: params.userId,
		eventName: "memory_context_persona_active_profile_included",
		reason: "active_projection_items",
		status: "included",
		count: formatted.includedCount,
		metadata: {
			projectionRevision: activeProfile.projectionRevision,
			resetGeneration: activeProfile.resetGeneration,
			totalItemCount: activeProfile.items.length,
			shortlistedItemCount: factItems.length,
			omittedItemCount: formatted.omittedCount,
			estimatedTokens: formatted.estimatedTokens,
			hasSummary: Boolean(summary),
			...summarizeActiveMemoryProfileTelemetry(activeProfile),
		},
	});

	let evidenceCandidates: ToolEvidenceCandidate[] = [];
	if (params.includeEvidenceCandidates !== false) {
		const itemsById = new Map(factItems.map((item) => [item.id, item]));
		evidenceCandidates = buildPersonaFactEvidenceCandidates({
			includedItemIds: formatted.includedItemIds,
			itemsById,
		});
		if (summary) {
			evidenceCandidates.push({
				id: `memory-context:summary:${params.userId}`,
				title: "Persona summary",
				sourceType: "memory",
			});
		}
	}

	return {
		success: true,
		mode: "persona",
		status: "available",
		source: "active_memory_profile",
		content,
		evidenceCandidates,
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

export function tokenizeQuery(query: string): string[] {
	return Array.from(
		new Set(
			(query.toLowerCase().match(/[\p{L}\p{N}%_\\]+/giu) ?? []).filter(
				(term) =>
					/[\p{L}\p{N}]/iu.test(term) &&
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

function buildHistoryPolicyContent(
	conversation: Pick<
		HistoryMemoryContextConversation,
		"title" | "summary" | "messageSnippets"
	> & {
		messages?: HistoryMemoryContextMessage[];
	},
): string {
	return [
		conversation.title,
		conversation.summary,
		...conversation.messageSnippets.map((message) => message.content),
		...(conversation.messages ?? []).map((message) =>
			[
				message.content,
				...(message.attachments ?? []).map((attachment) => attachment.content),
			]
				.filter(Boolean)
				.join(" "),
		),
	]
		.filter(Boolean)
		.join(" ");
}

async function filterHistoryByProjectionPolicy(params: {
	userId: string;
	conversations: HistoryMemoryContextConversation[];
	selectedConversation: HistoryMemoryContextSelectedConversation | null;
}): Promise<{
	conversations: HistoryMemoryContextConversation[];
	selectedConversation: HistoryMemoryContextSelectedConversation | null;
	blockedCount: number;
}> {
	if (params.conversations.length === 0 && !params.selectedConversation) {
		return {
			conversations: params.conversations,
			selectedConversation: null,
			blockedCount: 0,
		};
	}
	const blockedStatements = await listProjectionPolicyBlockedStatements({
		userId: params.userId,
	});
	if (blockedStatements.length === 0) {
		return {
			conversations: params.conversations,
			selectedConversation: params.selectedConversation,
			blockedCount: 0,
		};
	}

	let blockedCount = 0;
	const filteredConversations = params.conversations.filter((conversation) => {
		const screen = screenContentAgainstProjectionPolicy({
			blockedStatements,
			content: buildHistoryPolicyContent(conversation),
		});
		if (!screen.blocked) return true;
		blockedCount += 1;
		return false;
	});
	let selectedConversation = params.selectedConversation;
	if (
		selectedConversation &&
		screenContentAgainstProjectionPolicy({
			blockedStatements,
			content: buildHistoryPolicyContent(selectedConversation),
		}).blocked
	) {
		selectedConversation = null;
	}
	if (params.selectedConversation && !selectedConversation) {
		blockedCount += 1;
	}

	return {
		conversations: filteredConversations,
		selectedConversation,
		blockedCount,
	};
}

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
		.orderBy(...messageTimestampOrderDesc())
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
	includeAttachments?: boolean;
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
	repairConversationMessageSequences(params.historyConversationId);
	const [countRows, rows, attachmentMap] = await Promise.all([
		db.select({ messageCount: count() }).from(messages).where(dialogueWhere),
		db
			.select({
				id: messages.id,
				role: messages.role,
				content: messages.content,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(dialogueWhere)
			.orderBy(...messageOrderDesc())
			.limit(params.maxMessages),
		params.includeAttachments
			? listMessageAttachments(params.historyConversationId)
			: Promise.resolve(new Map<string, ChatAttachment[]>()),
	]);

	const artifactContentMap = new Map<string, string>();
	if (params.includeAttachments && attachmentMap.size > 0) {
		const artifactIds = Array.from(
			new Set(
				Array.from(attachmentMap.values()).flatMap((attachments) =>
					attachments.map((a) => a.artifactId),
				),
			),
		);
		const artifacts = await getArtifactsForUser(params.userId, artifactIds);
		for (const artifact of artifacts) {
			if (artifact.contentText) {
				artifactContentMap.set(artifact.id, artifact.contentText);
			}
		}
	}

	const selectedMessages = rows
		.map((row) => {
			const messageAttachments = attachmentMap.get(row.id);
			const attachments =
				messageAttachments && messageAttachments.length > 0
					? messageAttachments
							.map((attachment) => ({
								name: attachment.name,
								content: artifactContentMap.get(attachment.artifactId) ?? "",
							}))
							.filter((a) => a.content.length > 0)
					: undefined;
			return {
				role: row.role as "user" | "assistant",
				content: clipHistoryMessage(row.content),
				createdAt: toTimestampMs(row.createdAt),
				...(attachments && attachments.length > 0 ? { attachments } : {}),
			};
		})
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
				includeAttachments: params.includeAttachments,
			})
		: null;
	const filteredHistory = await filterHistoryByProjectionPolicy({
		userId: params.userId,
		conversations,
		selectedConversation,
	});
	if (filteredHistory.blockedCount > 0) {
		await recordMemoryContextPromptTelemetry({
			userId: params.userId,
			eventName: "memory_context_history_projection_policy_filtered",
			reason: "projection_policy_blocked_deleted_or_suppressed",
			status: "filtered",
			count: filteredHistory.blockedCount,
		});
	}

	return {
		success: true,
		mode: "history",
		status:
			filteredHistory.conversations.length > 0 ||
			filteredHistory.selectedConversation
				? "available"
				: "empty",
		source: "conversation_summaries",
		query,
		conversations: filteredHistory.conversations,
		omittedConversationCount: Math.max(
			0,
			candidates.length - filteredHistory.conversations.length,
		),
		selectedConversation: filteredHistory.selectedConversation,
		evidenceCandidates:
			params.includeEvidenceCandidates === false
				? []
				: buildHistoryEvidenceCandidates(filteredHistory.conversations),
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
