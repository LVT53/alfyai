import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
	conversationSummaries,
	conversations,
	messages,
} from "$lib/server/db/schema";
import { listMessageAttachments } from "$lib/server/services/knowledge/store/attachments";
import { getArtifactsForUser } from "$lib/server/services/knowledge/store/core";
import {
	messageOrderDesc,
	messageTimestampOrderDesc,
} from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { clipNullableText, normalizeWhitespace } from "$lib/server/utils/text";
import type { ChatAttachment, ToolEvidenceCandidate } from "$lib/types";
import {
	buildHistoryPolicyContent,
	listProjectionPolicyBlockedStatements,
	screenContentAgainstProjectionPolicy,
} from "./policy-screening";
import {
	buildHistoryTermFilter,
	scoreHistoryText,
	tokenizeQuery,
} from "./query";
import { buildMemoryReadSanitizer } from "./sanitize";
import { recordMemoryPromptTelemetry } from "./telemetry";
import type {
	GetMemoryContextParams,
	HistoryMemoryContextConversation,
	HistoryMemoryContextMessage,
	HistoryMemoryContextResult,
	HistoryMemoryContextSelectedConversation,
} from "./types";

const HISTORY_SUMMARY_MATCH_LIMIT = 5_000;
const HISTORY_MESSAGE_MATCH_LIMIT = 10_000;
const DEFAULT_MAX_HISTORY_CONVERSATIONS = 8;
const OPERATIONAL_MAX_HISTORY_CONVERSATIONS = 32;
const HISTORY_MESSAGE_SNIPPETS_PER_CONVERSATION = 3;
const HISTORY_SNIPPET_MAX_CHARS = 700;
const HISTORY_MESSAGE_MAX_CHARS = 1_200;
const MIN_MAX_HISTORY_MESSAGES = 10;
const OPERATIONAL_MAX_HISTORY_MESSAGES = 96;
const HISTORY_EVIDENCE_SNIPPET_MAX_CHARS = 700;

type MemoryReadSanitizer = ReturnType<typeof buildMemoryReadSanitizer>;

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
	historyConversations: HistoryMemoryContextConversation[],
): ToolEvidenceCandidate[] {
	return historyConversations.map((conversation) => ({
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
			HISTORY_EVIDENCE_SNIPPET_MAX_CHARS,
		),
		sourceType: "memory" as const,
	}));
}

function sanitizeHistoryMessage(
	message: HistoryMemoryContextMessage,
	sanitize: MemoryReadSanitizer,
): HistoryMemoryContextMessage {
	return {
		...message,
		content: sanitize(message.content),
		...(message.attachments
			? {
					attachments: message.attachments.map((attachment) => ({
						name: attachment.name,
						content: sanitize(attachment.content),
					})),
				}
			: {}),
	};
}

function sanitizeHistoryConversation(
	conversation: HistoryMemoryContextConversation,
	sanitize: MemoryReadSanitizer,
): HistoryMemoryContextConversation {
	return {
		...conversation,
		title: sanitize(conversation.title),
		summary:
			conversation.summary === null ? null : sanitize(conversation.summary),
		messageSnippets: conversation.messageSnippets.map((message) =>
			sanitizeHistoryMessage(message, sanitize),
		),
	};
}

function sanitizeSelectedConversation(
	selected: HistoryMemoryContextSelectedConversation,
	sanitize: MemoryReadSanitizer,
): HistoryMemoryContextSelectedConversation {
	return {
		...sanitizeHistoryConversation(selected, sanitize),
		messages: selected.messages.map((message) =>
			sanitizeHistoryMessage(message, sanitize),
		),
		omittedMessageCount: selected.omittedMessageCount,
	};
}

export async function getHistoryMemoryContext(
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
	const historyConversations = selectedCandidates.map((candidate) => ({
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
		conversations: historyConversations,
		selectedConversation,
	});
	if (filteredHistory.blockedCount > 0) {
		await recordMemoryPromptTelemetry({
			userId: params.userId,
			eventName: "memory_context_history_projection_policy_filtered",
			reason: "projection_policy_blocked_deleted_or_suppressed",
			status: "filtered",
			count: filteredHistory.blockedCount,
		});
	}

	// Uniform sanitisation: history content reaches the model through this read
	// path, so scrub identity references after policy screening (which runs on
	// the raw text) and before shaping the model-facing result.
	const sanitize = buildMemoryReadSanitizer({
		userId: params.userId,
		userDisplayName: params.userDisplayName,
	});
	const sanitizedConversations = filteredHistory.conversations.map(
		(conversation) => sanitizeHistoryConversation(conversation, sanitize),
	);
	const sanitizedSelected = filteredHistory.selectedConversation
		? sanitizeSelectedConversation(
				filteredHistory.selectedConversation,
				sanitize,
			)
		: null;

	return {
		success: true,
		mode: "history",
		status:
			sanitizedConversations.length > 0 || sanitizedSelected
				? "available"
				: "empty",
		source: "conversation_summaries",
		query,
		conversations: sanitizedConversations,
		omittedConversationCount: Math.max(
			0,
			candidates.length - filteredHistory.conversations.length,
		),
		selectedConversation: sanitizedSelected,
		evidenceCandidates:
			params.includeEvidenceCandidates === false
				? []
				: buildHistoryEvidenceCandidates(sanitizedConversations),
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
