import { and, count, eq, inArray } from "drizzle-orm";
import { getTargetConstructedContext } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { listMessageAttachments } from "$lib/server/services/knowledge/store/attachments";
import { getArtifactsForUser } from "$lib/server/services/knowledge/store/core";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import {
	findProjectFolderReferenceContextByQuery,
	getProjectReferenceContext,
	type ProjectReferenceContext,
} from "$lib/server/services/task-state";
import { clipNullableText, normalizeWhitespace } from "$lib/server/utils/text";
import type { ChatAttachment, ToolEvidenceCandidate } from "$lib/types";

const MIN_MAX_SIBLINGS = 5;
const OPERATIONAL_MAX_SIBLINGS = 16;
const SIBLING_CONTEXT_TOKEN_STEP = 32_000;
const MIN_MAX_MESSAGES = 10;
const OPERATIONAL_MAX_MESSAGES = 96;
const MESSAGE_CONTEXT_TOKEN_STEP = 16_000;
const DEFAULT_REPORT_MESSAGES_PER_SIBLING = 6;
const OPERATIONAL_MAX_REPORT_MESSAGES_PER_SIBLING = 12;
const MESSAGE_CONTENT_MAX = 1_200;

export type ProjectContextMode = "summary" | "detail" | "report";

export type ProjectContextSiblingSummary = {
	conversationId: string;
	title: string;
	objective: string | null;
	summary: string | null;
};

export type ProjectContextDetailMessage = {
	role: "user" | "assistant";
	content: string;
	createdAt: number;
	attachments?: Array<{ name: string; content: string }>;
};

export type ProjectContextSelectedSiblingDetail =
	ProjectContextSiblingSummary & {
		messages: ProjectContextDetailMessage[];
		omittedMessageCount: number;
	};

export type ProjectContextResult = {
	success: true;
	mode: ProjectContextMode;
	hasProjectContext: boolean;
	source: ProjectReferenceContext["source"] | "none";
	project: {
		id: string;
		name: string;
		authority: ProjectReferenceContext["source"];
	} | null;
	siblings: ProjectContextSiblingSummary[];
	omittedSiblingCount: number;
	selectedSibling?: ProjectContextSelectedSiblingDetail | null;
	reportSiblings?: ProjectContextSelectedSiblingDetail[];
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		scope: "conversation";
		requestedMaxSiblings: number | null;
		appliedMaxSiblings: number;
		siblingConversationId?: string | null;
		requestedMaxMessages?: number | null;
		appliedMaxMessages?: number;
		reportConversationCount?: number;
		includeEvidenceCandidates: boolean;
		noProjectReason?: "no_memory_context";
	};
};

export type GetProjectContextParams = {
	userId: string;
	conversationId: string;
	mode?: string | null;
	query?: string | null;
	maxSiblings?: number | null;
	siblingConversationId?: string | null;
	maxMessages?: number | null;
	includeEvidenceCandidates?: boolean;
	includeAttachments?: boolean;
};

function deriveMaxSiblingsCap(): number {
	const targetConstructedContext = getTargetConstructedContext();
	if (
		!Number.isFinite(targetConstructedContext) ||
		targetConstructedContext <= 0
	) {
		return MIN_MAX_SIBLINGS;
	}
	return Math.max(
		MIN_MAX_SIBLINGS,
		Math.min(
			OPERATIONAL_MAX_SIBLINGS,
			Math.ceil(targetConstructedContext / SIBLING_CONTEXT_TOKEN_STEP),
		),
	);
}

function normalizeMaxSiblings(value: number | null | undefined): number {
	const cap = deriveMaxSiblingsCap();
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return cap;
	}
	return Math.max(1, Math.min(cap, Math.floor(value)));
}

function normalizeMaxMessages(value: number | null | undefined): number {
	const cap = deriveMaxMessagesCap();
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return cap;
	}
	return Math.max(1, Math.min(cap, Math.floor(value)));
}

function normalizeReportMessagesPerSibling(
	value: number | null | undefined,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_REPORT_MESSAGES_PER_SIBLING;
	}
	return Math.max(
		1,
		Math.min(OPERATIONAL_MAX_REPORT_MESSAGES_PER_SIBLING, Math.floor(value)),
	);
}

function deriveMaxMessagesCap(): number {
	const targetConstructedContext = getTargetConstructedContext();
	if (
		!Number.isFinite(targetConstructedContext) ||
		targetConstructedContext <= 0
	) {
		return MIN_MAX_MESSAGES;
	}
	return Math.max(
		MIN_MAX_MESSAGES,
		Math.min(
			OPERATIONAL_MAX_MESSAGES,
			Math.ceil(targetConstructedContext / MESSAGE_CONTEXT_TOKEN_STEP),
		),
	);
}

function toTimestampMs(value: Date | number | null | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	return 0;
}

function clipMessageContent(value: string): string {
	return (
		clipNullableText(normalizeWhitespace(value), MESSAGE_CONTENT_MAX) ?? ""
	);
}

function buildEvidenceCandidates(
	siblings: ProjectContextSiblingSummary[],
): ToolEvidenceCandidate[] {
	return siblings
		.filter((sibling) => sibling.summary?.trim())
		.map((sibling) => ({
			id: `conversation-summary:${sibling.conversationId}`,
			title: sibling.title,
			snippet: sibling.summary,
			sourceType: "memory" as const,
		}));
}

function buildDetailEvidenceCandidate(
	sibling: ProjectContextSelectedSiblingDetail,
): ToolEvidenceCandidate {
	const snippetParts = [
		sibling.summary,
		...sibling.messages.map((message) => `${message.role}: ${message.content}`),
	].filter((value): value is string => Boolean(value?.trim()));
	return {
		id: `memory-context:project-detail:${sibling.conversationId}`,
		title: sibling.title,
		snippet: clipNullableText(snippetParts.join(" "), 700),
		sourceType: "memory",
	};
}

function buildReportEvidenceCandidates(
	siblings: ProjectContextSelectedSiblingDetail[],
): ToolEvidenceCandidate[] {
	return siblings.map(buildDetailEvidenceCandidate);
}

async function listRecentDialogueMessages(params: {
	conversationId: string;
	maxMessages: number;
	userId?: string;
	includeAttachments?: boolean;
}): Promise<{
	messages: ProjectContextDetailMessage[];
	omittedMessageCount: number;
}> {
	const dialogueWhere = and(
		eq(messages.conversationId, params.conversationId),
		inArray(messages.role, ["user", "assistant"]),
	);
	repairConversationMessageSequences(params.conversationId);

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
		params.includeAttachments && params.userId
			? listMessageAttachments(params.conversationId)
			: Promise.resolve(new Map<string, ChatAttachment[]>()),
	]);
	const messageCount = countRows[0]?.messageCount ?? rows.length;

	const artifactContentMap = new Map<string, string>();
	if (params.includeAttachments && params.userId && attachmentMap.size > 0) {
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

	const selected = rows
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
				content: clipMessageContent(row.content),
				createdAt: toTimestampMs(row.createdAt),
				...(attachments && attachments.length > 0 ? { attachments } : {}),
			};
		})
		.reverse();
	return {
		messages: selected,
		omittedMessageCount: Math.max(0, messageCount - selected.length),
	};
}

async function buildReportResult(params: {
	reference: ProjectReferenceContext;
	userId: string;
	conversationId: string;
	requestedMaxSiblings: number | null;
	appliedMaxSiblings: number;
	requestedMaxMessages: number | null;
	appliedMaxMessages: number;
	includeEvidenceCandidates: boolean;
	includeAttachments?: boolean;
}): Promise<ProjectContextResult> {
	const selectedEntries = params.reference.entries.slice(
		0,
		params.appliedMaxSiblings,
	);
	const messageDetails = await Promise.all(
		selectedEntries.map((entry) =>
			listRecentDialogueMessages({
				conversationId: entry.conversationId,
				maxMessages: params.appliedMaxMessages,
				userId: params.userId,
				includeAttachments: params.includeAttachments,
			}),
		),
	);
	const reportSiblings: ProjectContextSelectedSiblingDetail[] =
		selectedEntries.map((entry, index) => {
			return {
				conversationId: entry.conversationId,
				title: entry.title,
				objective: entry.objective,
				summary: entry.summary,
				messages: messageDetails[index]?.messages ?? [],
				omittedMessageCount: messageDetails[index]?.omittedMessageCount ?? 0,
			};
		});
	const omittedByRequest = Math.max(
		0,
		params.reference.entries.length - reportSiblings.length,
	);
	const omittedSiblingCount =
		params.reference.omittedSiblingCount + omittedByRequest;

	return {
		success: true,
		mode: "report",
		hasProjectContext: true,
		source: params.reference.source,
		project: {
			id: params.reference.projectId,
			name: params.reference.projectName,
			authority: params.reference.source,
		},
		siblings: reportSiblings.map((sibling) => ({
			conversationId: sibling.conversationId,
			title: sibling.title,
			objective: sibling.objective,
			summary: sibling.summary,
		})),
		omittedSiblingCount,
		reportSiblings,
		evidenceCandidates: params.includeEvidenceCandidates
			? buildReportEvidenceCandidates(reportSiblings)
			: [],
		audit: {
			conversationId: params.conversationId,
			scope: "conversation",
			requestedMaxSiblings: params.requestedMaxSiblings,
			appliedMaxSiblings: params.appliedMaxSiblings,
			requestedMaxMessages: params.requestedMaxMessages,
			appliedMaxMessages: params.appliedMaxMessages,
			reportConversationCount: reportSiblings.length,
			includeEvidenceCandidates: params.includeEvidenceCandidates,
		},
	};
}

async function buildDetailResult(params: {
	reference: ProjectReferenceContext;
	userId: string;
	conversationId: string;
	siblingConversationId: string | null | undefined;
	requestedMaxSiblings: number | null;
	appliedMaxSiblings: number;
	requestedMaxMessages: number | null;
	appliedMaxMessages: number;
	includeEvidenceCandidates: boolean;
	includeAttachments?: boolean;
}): Promise<ProjectContextResult> {
	const siblingConversationId = params.siblingConversationId?.trim();
	if (!siblingConversationId) {
		throw new Error("siblingConversationId is required for detail mode");
	}
	if (siblingConversationId === params.conversationId) {
		throw new Error(
			"Current conversation is not a valid memory_context sibling",
		);
	}

	const sibling =
		params.reference.entries.find(
			(entry) => entry.conversationId === siblingConversationId,
		) ?? null;
	if (!sibling) {
		throw new Error("siblingConversationId is outside memory_context scope");
	}

	const detailMessages = await listRecentDialogueMessages({
		conversationId: siblingConversationId,
		userId: params.userId,
		includeAttachments: params.includeAttachments,
		maxMessages: params.appliedMaxMessages,
	});
	const selectedSibling: ProjectContextSelectedSiblingDetail = {
		conversationId: sibling.conversationId,
		title: sibling.title,
		objective: sibling.objective,
		summary: sibling.summary,
		messages: detailMessages.messages,
		omittedMessageCount: detailMessages.omittedMessageCount,
	};

	return {
		success: true,
		mode: "detail",
		hasProjectContext: true,
		source: params.reference.source,
		project: {
			id: params.reference.projectId,
			name: params.reference.projectName,
			authority: params.reference.source,
		},
		siblings: [],
		omittedSiblingCount: params.reference.omittedSiblingCount,
		selectedSibling,
		evidenceCandidates: params.includeEvidenceCandidates
			? [buildDetailEvidenceCandidate(selectedSibling)]
			: [],
		audit: {
			conversationId: params.conversationId,
			scope: "conversation",
			requestedMaxSiblings: params.requestedMaxSiblings,
			appliedMaxSiblings: params.appliedMaxSiblings,
			siblingConversationId,
			requestedMaxMessages: params.requestedMaxMessages,
			appliedMaxMessages: params.appliedMaxMessages,
			includeEvidenceCandidates: params.includeEvidenceCandidates,
		},
	};
}

export async function getProjectContext(
	params: GetProjectContextParams,
): Promise<ProjectContextResult> {
	const mode = params.mode?.trim() || "summary";
	if (mode !== "summary" && mode !== "detail" && mode !== "report") {
		throw new Error("Unsupported memory_context mode");
	}

	const requestedMaxSiblings =
		typeof params.maxSiblings === "number" &&
		Number.isFinite(params.maxSiblings)
			? params.maxSiblings
			: null;
	const maxSiblings = normalizeMaxSiblings(params.maxSiblings);
	const requestedMaxMessages =
		typeof params.maxMessages === "number" &&
		Number.isFinite(params.maxMessages)
			? params.maxMessages
			: null;
	const maxMessages = normalizeMaxMessages(params.maxMessages);
	const reportMessagesPerSibling = normalizeReportMessagesPerSibling(
		params.maxMessages,
	);
	const includeEvidenceCandidates = params.includeEvidenceCandidates !== false;

	const currentReference = await getProjectReferenceContext({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	const reference =
		currentReference ??
		(await findProjectFolderReferenceContextByQuery({
			userId: params.userId,
			conversationId: params.conversationId,
			query: params.query,
		}));
	const effectiveMode =
		mode === "summary" && !currentReference && reference ? "report" : mode;

	if (!reference) {
		return {
			success: true,
			mode: effectiveMode,
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			omittedSiblingCount: 0,
			selectedSibling: effectiveMode === "detail" ? null : undefined,
			reportSiblings: effectiveMode === "report" ? [] : undefined,
			evidenceCandidates: [],
			audit: {
				conversationId: params.conversationId,
				scope: "conversation",
				requestedMaxSiblings,
				appliedMaxSiblings: maxSiblings,
				siblingConversationId:
					effectiveMode === "detail"
						? (params.siblingConversationId?.trim() ?? null)
						: undefined,
				requestedMaxMessages,
				appliedMaxMessages:
					effectiveMode === "report" ? reportMessagesPerSibling : maxMessages,
				reportConversationCount: effectiveMode === "report" ? 0 : undefined,
				includeEvidenceCandidates,
				noProjectReason: "no_memory_context",
			},
		};
	}

	if (effectiveMode === "detail") {
		return buildDetailResult({
			reference,
			userId: params.userId,
			conversationId: params.conversationId,
			siblingConversationId: params.siblingConversationId,
			requestedMaxSiblings,
			appliedMaxSiblings: maxSiblings,
			requestedMaxMessages,
			appliedMaxMessages: maxMessages,
			includeEvidenceCandidates,
			includeAttachments: params.includeAttachments,
		});
	}

	if (effectiveMode === "report") {
		return buildReportResult({
			reference,
			userId: params.userId,
			conversationId: params.conversationId,
			requestedMaxSiblings,
			appliedMaxSiblings: maxSiblings,
			requestedMaxMessages,
			appliedMaxMessages: reportMessagesPerSibling,
			includeEvidenceCandidates,
			includeAttachments: params.includeAttachments,
		});
	}

	const baseSiblings = reference.entries.slice(0, maxSiblings).map((entry) => ({
		conversationId: entry.conversationId,
		title: entry.title,
		objective: entry.objective,
		summary: entry.summary,
	}));
	const siblings = baseSiblings;
	const omittedByRequest = Math.max(
		0,
		reference.entries.length - siblings.length,
	);
	const omittedSiblingCount = reference.omittedSiblingCount + omittedByRequest;

	return {
		success: true,
		mode: "summary",
		hasProjectContext: true,
		source: reference.source,
		project: {
			id: reference.projectId,
			name: reference.projectName,
			authority: reference.source,
		},
		siblings,
		omittedSiblingCount,
		evidenceCandidates: includeEvidenceCandidates
			? buildEvidenceCandidates(siblings)
			: [],
		audit: {
			conversationId: params.conversationId,
			scope: "conversation",
			requestedMaxSiblings,
			appliedMaxSiblings: maxSiblings,
			includeEvidenceCandidates,
		},
	};
}
