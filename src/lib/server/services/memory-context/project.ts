import {
	getProjectReferenceContext,
	type ProjectReferenceContext,
} from "$lib/server/services/task-state";
import { db } from "$lib/server/db";
import { artifacts, deepResearchJobs, messages } from "$lib/server/db/schema";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { clipNullableText, normalizeWhitespace } from "$lib/server/utils/text";
import type { ToolEvidenceCandidate } from "$lib/types";
import { getTargetConstructedContext } from "$lib/server/config-store";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";

const MIN_MAX_SIBLINGS = 5;
const OPERATIONAL_MAX_SIBLINGS = 64;
const SIBLING_CONTEXT_TOKEN_STEP = 32_000;
const MIN_MAX_MESSAGES = 10;
const OPERATIONAL_MAX_MESSAGES = 96;
const MESSAGE_CONTEXT_TOKEN_STEP = 16_000;
const MESSAGE_CONTENT_MAX = 1_200;
const DEEP_RESEARCH_RESULTS_PER_CONVERSATION = 3;
const DEEP_RESEARCH_SUMMARY_MAX = 900;
const DEEP_RESEARCH_CONTENT_MAX = 2_400;

export type ProjectContextMode = "summary" | "detail";

export type ProjectContextSiblingSummary = {
	conversationId: string;
	title: string;
	objective: string | null;
	summary: string | null;
	deepResearchResults?: ProjectContextDeepResearchResult[];
	omittedDeepResearchResultCount?: number;
};

export type ProjectContextDetailMessage = {
	role: "user" | "assistant";
	content: string;
	createdAt: number;
};

export type ProjectContextSelectedSiblingDetail = ProjectContextSiblingSummary & {
	messages: ProjectContextDetailMessage[];
	omittedMessageCount: number;
};

export type ProjectContextDeepResearchResult = {
	jobId: string;
	title: string;
	userRequest: string;
	depth: string;
	completedAt: number;
	reportArtifact: {
		id: string;
		title: string;
		summary: string | null;
		content?: string | null;
	};
};

type DeepResearchResultRow = {
	conversationId: string;
	jobId: string;
	title: string;
	userRequest: string;
	depth: string;
	completedAt: Date | number | null;
	reportArtifactId: string;
	reportTitle: string;
	reportSummary: string | null;
	reportContent: string | null;
};

type DeepResearchResultsByConversation = Map<
	string,
	{
		results: ProjectContextDeepResearchResult[];
		omittedCount: number;
	}
>;

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
	evidenceCandidates: ToolEvidenceCandidate[];
	audit: {
		conversationId: string;
		scope: "conversation";
		requestedMaxSiblings: number | null;
		appliedMaxSiblings: number;
		siblingConversationId?: string | null;
		requestedMaxMessages?: number | null;
		appliedMaxMessages?: number;
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
};

function deriveMaxSiblingsCap(): number {
	const targetConstructedContext = getTargetConstructedContext();
	if (!Number.isFinite(targetConstructedContext) || targetConstructedContext <= 0) {
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

function deriveMaxMessagesCap(): number {
	const targetConstructedContext = getTargetConstructedContext();
	if (!Number.isFinite(targetConstructedContext) || targetConstructedContext <= 0) {
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
	return clipNullableText(normalizeWhitespace(value), MESSAGE_CONTENT_MAX) ?? "";
}

function clipDeepResearchText(
	value: string | null | undefined,
	maxLength: number,
): string | null {
	return clipNullableText(normalizeWhitespace(value ?? ""), maxLength);
}

function attachDeepResearchResults(
	sibling: ProjectContextSiblingSummary,
	deepResearchResults: DeepResearchResultsByConversation,
): ProjectContextSiblingSummary {
	const result = deepResearchResults.get(sibling.conversationId);
	if (!result || result.results.length === 0) return sibling;
	return {
		...sibling,
		deepResearchResults: result.results,
		omittedDeepResearchResultCount: result.omittedCount,
	};
}

function mapDeepResearchResultRow(
	row: DeepResearchResultRow,
	includeContent: boolean,
): ProjectContextDeepResearchResult {
	return {
		jobId: row.jobId,
		title: row.title,
		userRequest: clipDeepResearchText(row.userRequest, DEEP_RESEARCH_SUMMARY_MAX) ?? "",
		depth: row.depth,
		completedAt: toTimestampMs(row.completedAt),
		reportArtifact: {
			id: row.reportArtifactId,
			title: row.reportTitle,
			summary: clipDeepResearchText(row.reportSummary, DEEP_RESEARCH_SUMMARY_MAX),
			...(includeContent
				? {
						content: clipDeepResearchText(
							row.reportContent,
							DEEP_RESEARCH_CONTENT_MAX,
						),
					}
				: {}),
		},
	};
}

async function listDeepResearchResults(params: {
	userId: string;
	conversationIds: string[];
	includeContent: boolean;
}): Promise<DeepResearchResultsByConversation> {
	const conversationIds = Array.from(new Set(params.conversationIds)).filter(
		Boolean,
	);
	if (conversationIds.length === 0) return new Map();

	const rows = (await db
		.select({
			conversationId: deepResearchJobs.conversationId,
			jobId: deepResearchJobs.id,
			title: deepResearchJobs.title,
			userRequest: deepResearchJobs.userRequest,
			depth: deepResearchJobs.depth,
			completedAt: deepResearchJobs.completedAt,
			reportArtifactId: artifacts.id,
			reportTitle: artifacts.name,
			reportSummary: artifacts.summary,
			reportContent: artifacts.contentText,
		})
		.from(deepResearchJobs)
		.innerJoin(artifacts, eq(deepResearchJobs.reportArtifactId, artifacts.id))
		.where(
			and(
				eq(deepResearchJobs.userId, params.userId),
				eq(deepResearchJobs.status, "completed"),
				inArray(deepResearchJobs.conversationId, conversationIds),
				eq(artifacts.userId, params.userId),
			),
		)
		.orderBy(
			desc(deepResearchJobs.completedAt),
			desc(deepResearchJobs.updatedAt),
			desc(deepResearchJobs.createdAt),
		)) as DeepResearchResultRow[];

	const grouped: DeepResearchResultsByConversation = new Map();
	for (const row of rows) {
		const current = grouped.get(row.conversationId) ?? {
			results: [],
			omittedCount: 0,
		};
		if (current.results.length < DEEP_RESEARCH_RESULTS_PER_CONVERSATION) {
			current.results.push(
				mapDeepResearchResultRow(row, params.includeContent),
			);
		} else {
			current.omittedCount += 1;
		}
		grouped.set(row.conversationId, current);
	}
	return grouped;
}

function buildEvidenceCandidates(
	siblings: ProjectContextSiblingSummary[],
): ToolEvidenceCandidate[] {
	const summaryCandidates = siblings
		.filter((sibling) => sibling.summary?.trim())
		.map((sibling) => ({
			id: `conversation-summary:${sibling.conversationId}`,
			title: sibling.title,
			snippet: sibling.summary,
			sourceType: "memory",
		}));
	const deepResearchCandidates = siblings.flatMap((sibling) =>
		buildDeepResearchEvidenceCandidates(sibling.deepResearchResults ?? []),
	);
	return [...summaryCandidates, ...deepResearchCandidates];
}

function buildDeepResearchEvidenceCandidates(
	results: ProjectContextDeepResearchResult[],
): ToolEvidenceCandidate[] {
	return results.map((result) => ({
		id: `deep-research-report:${result.reportArtifact.id}`,
		title: result.reportArtifact.title,
		snippet: clipNullableText(
			[`Question: ${result.userRequest}`, result.reportArtifact.summary]
				.filter(Boolean)
				.join(" "),
			700,
		),
		sourceType: "document" as const,
	}));
}

function buildDetailEvidenceCandidate(
	sibling: ProjectContextSelectedSiblingDetail,
): ToolEvidenceCandidate {
	const snippetParts = [
		sibling.summary,
		...sibling.messages.map((message) => `${message.role}: ${message.content}`),
		...(sibling.deepResearchResults ?? []).map(
			(result) =>
				`deep research question: ${result.userRequest} report: ${
					result.reportArtifact.content ??
					result.reportArtifact.summary ??
					result.reportArtifact.title
				}`,
		),
	].filter((value): value is string => Boolean(value?.trim()));
	return {
		id: `memory-context:project-detail:${sibling.conversationId}`,
		title: sibling.title,
		snippet: clipNullableText(snippetParts.join(" "), 700),
		sourceType: "memory",
	};
}

async function listRecentDialogueMessages(params: {
	conversationId: string;
	maxMessages: number;
}): Promise<{
	messages: ProjectContextDetailMessage[];
	omittedMessageCount: number;
}> {
	const dialogueWhere = and(
		eq(messages.conversationId, params.conversationId),
		inArray(messages.role, ["user", "assistant"]),
	);
	repairConversationMessageSequences(params.conversationId);

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
			.orderBy(...messageOrderDesc())
			.limit(params.maxMessages),
	]);
	const messageCount = countRows[0]?.messageCount ?? rows.length;
	const selected = rows
		.map((row) => ({
			role: row.role as "user" | "assistant",
			content: clipMessageContent(row.content),
			createdAt: toTimestampMs(row.createdAt),
		}))
		.reverse();
	return {
		messages: selected,
		omittedMessageCount: Math.max(0, messageCount - selected.length),
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
}): Promise<ProjectContextResult> {
	const siblingConversationId = params.siblingConversationId?.trim();
	if (!siblingConversationId) {
		throw new Error("siblingConversationId is required for detail mode");
	}
	if (siblingConversationId === params.conversationId) {
		throw new Error("Current conversation is not a valid memory_context sibling");
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
		maxMessages: params.appliedMaxMessages,
	});
	const deepResearchResults = await listDeepResearchResults({
		userId: params.userId,
		conversationIds: [siblingConversationId],
		includeContent: true,
	});
	const selectedSiblingBase: ProjectContextSiblingSummary = {
		conversationId: sibling.conversationId,
		title: sibling.title,
		objective: sibling.objective,
		summary: sibling.summary,
	};
	const selectedSibling: ProjectContextSelectedSiblingDetail = {
		...attachDeepResearchResults(selectedSiblingBase, deepResearchResults),
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
			? [
					buildDetailEvidenceCandidate(selectedSibling),
					...buildDeepResearchEvidenceCandidates(
						selectedSibling.deepResearchResults ?? [],
					),
				]
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
	if (mode !== "summary" && mode !== "detail") {
		throw new Error("Unsupported memory_context mode");
	}

	const requestedMaxSiblings =
		typeof params.maxSiblings === "number" && Number.isFinite(params.maxSiblings)
			? params.maxSiblings
			: null;
	const maxSiblings = normalizeMaxSiblings(params.maxSiblings);
	const requestedMaxMessages =
		typeof params.maxMessages === "number" && Number.isFinite(params.maxMessages)
			? params.maxMessages
			: null;
	const maxMessages = normalizeMaxMessages(params.maxMessages);
	const includeEvidenceCandidates =
		params.includeEvidenceCandidates !== false;

	const reference = await getProjectReferenceContext({
		userId: params.userId,
		conversationId: params.conversationId,
	});

	if (!reference) {
		return {
			success: true,
			mode,
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			omittedSiblingCount: 0,
			selectedSibling: mode === "detail" ? null : undefined,
			evidenceCandidates: [],
			audit: {
				conversationId: params.conversationId,
				scope: "conversation",
				requestedMaxSiblings,
				appliedMaxSiblings: maxSiblings,
				siblingConversationId:
					mode === "detail" ? (params.siblingConversationId?.trim() ?? null) : undefined,
				requestedMaxMessages,
				appliedMaxMessages: maxMessages,
				includeEvidenceCandidates,
				noProjectReason: "no_memory_context",
			},
		};
	}

	if (mode === "detail") {
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
		});
	}

	const baseSiblings = reference.entries.slice(0, maxSiblings).map((entry) => ({
		conversationId: entry.conversationId,
		title: entry.title,
		objective: entry.objective,
		summary: entry.summary,
	}));
	const deepResearchResults = await listDeepResearchResults({
		userId: params.userId,
		conversationIds: baseSiblings.map((sibling) => sibling.conversationId),
		includeContent: false,
	});
	const siblings = baseSiblings.map((sibling) =>
		attachDeepResearchResults(sibling, deepResearchResults),
	);
	const omittedByRequest = Math.max(0, reference.entries.length - siblings.length);
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
