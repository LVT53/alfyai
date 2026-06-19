import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getTargetConstructedContext } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	artifacts,
	conversationContextStatus,
	conversationTaskStates,
	taskCheckpoints,
	taskStateEvidenceLinks,
} from "$lib/server/db/schema";
import { RERANK_CONFIDENCE_MIN } from "$lib/server/utils/constants";
import { parseJsonRecord } from "$lib/server/utils/json";
import { dedupeById } from "$lib/server/utils/prompt-context";
import { clipText, normalizeWhitespace } from "$lib/server/utils/text";
import type {
	Artifact,
	ArtifactType,
	ContextDebugState,
	EvidenceSourceType,
	RoutingStage,
	TaskCheckpoint,
	TaskEvidenceLink,
	TaskState,
	TaskSteeringAction,
	VerificationStatus,
} from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { computeCrossConversationDecay } from "../utils/artifact-decay";
import { collapseArtifactsByFamily } from "./evidence-family";
import { parseWorkingDocumentMetadata } from "./knowledge/store";
import { getLatestHonchoMetadata } from "./messages";
import { queueTaskStateSemanticEmbeddingRefresh } from "./semantic-embedding-refresh";
import { shortlistSemanticMatchesBySubject } from "./semantic-ranking";
import { formatTaskStateForPrompt } from "./task-state/artifacts";
import {
	canUseContextSummarizer,
	parseJsonFromModel,
	requestContextSummarizer,
} from "./task-state/control-model";
import { findConflictingDocumentPreferenceArtifactIds } from "./task-state/document-preferences";
import {
	mapTaskCheckpoint,
	mapTaskEvidenceLink,
	mapTaskState,
} from "./task-state/mappers";
import {
	determineTeiWinningMode,
	logTeiRetrievalSummary,
	type SemanticShortlistDiagnostics,
	type TeiRerankDiagnostics,
} from "./tei-observability";
import { canUseTeiReranker, rerankItems } from "./tei-reranker";
import { resolveWorkingDocumentSelection } from "./working-document-selection";
import { scoreMatch } from "./working-set";

// Authority note:
// - task-state owns task/workflow continuity and prompt-time task evidence assembly
// - persona-memory owns persona/temporal/preference clustering
// - document identity/version continuity belongs to artifact metadata plus document-resolution
// - Honcho may enrich context, but it is not the authority for current task/document/temporal truth

export {
	formatTaskStateForPrompt,
	getPromptArtifactSnippets,
	listArtifactChunksForArtifacts,
	summarizeHistoricalContext,
	syncArtifactChunks,
} from "./task-state/artifacts";
export {
	applyProjectContinuitySignalFromMessage,
	attachContinuityToTaskState,
	countFocusContinuityItems,
	countTaskMemoryItems,
	deleteAllProjectMemory,
	detectProjectContinuitySignal,
	findProjectFolderReferenceContextByQuery,
	forgetFocusContinuity,
	forgetProjectMemory,
	forgetTaskMemory,
	getProjectFolderReferenceContext,
	getProjectReferenceContext,
	getTaskContinuitySummary,
	listFocusContinuityItems,
	listProjectMemoryItems,
	listTaskMemoryItems,
	type ProjectFolderReferenceContext,
	type ProjectFolderSiblingPromotionContext,
	type ProjectReferenceContext,
	pruneOrphanProjectMemory,
	resolveProjectContinuityStatus,
	selectProjectFolderSiblingPromotion,
	syncProjectMemoryFromTaskState,
	syncTaskContinuityFromTaskState,
	updateProjectMemoryStatuses,
} from "./task-state/continuity";
export {
	canUseContextSummarizer,
	parseJsonFromModel,
	requestContextSummarizer,
	requestStructuredControlModel,
} from "./task-state/control-model";

const TASK_MATCH_MIN_SCORE = 12;
const MAX_LIST_ITEMS = 6;
const TASK_CONTINUITY_MIN_TASK_MATCH_SCORE = 8;
const CURRENT_TASK_STATUSES: TaskState["status"][] = [
	"active",
	"revived",
	"candidate",
];
// These item limits are performance safeguards. Product inclusion should be
// decided from the available prompt budget and source authority signals.
const TASK_SEMANTIC_SHORTLIST_LIMIT = 32;
const TASK_ROUTER_RERANK_LIMIT = 24;
const MIN_SELECTED_EVIDENCE_ITEMS = 12;
const MAX_SELECTED_EVIDENCE_ITEMS = 64;
const MIN_EVIDENCE_RERANK_CANDIDATES = 24;
const MAX_EVIDENCE_RERANK_CANDIDATES = 64;
const MAX_SELECTED_LINKS = 64;
const SELECTED_EVIDENCE_BUDGET_RATIO = 0.08;
const SELECTED_EVIDENCE_MIN_BUDGET_TOKENS = 3_000;
const SELECTED_EVIDENCE_MAX_ARTIFACT_TEXT_TOKENS = 1_200;
const SELECTED_EVIDENCE_METADATA_TOKENS = 80;
const OUTPUT_CONTROL_RE =
	/\b(?:reply|respond|answer|say|output)\s+(?:with\s+)?(?:only|just|exactly)\b|(?:\bonly\b.*\b(?:codeword|answer|response|text|string|number|word)\b)|(?:\bdo\s+you\s+know\s+what\?)/i;
const LIGHTWEIGHT_MEMORY_RECALL_RE =
	/\b(?:what\s+is|what's|tell\s+me|do\s+you\s+(?:remember|recall|know)|recall|verify|confirm)\b[\s\S]{0,120}\b(?:my\s+)?(?:codeword|memory\s+verification|verification\s+code|memory\s+profile\s+fact|remembered\s+(?:fact|preference|detail)|saved\s+(?:memory|fact))\b|\b(?:memory\s+verification|verify\s+continuity)\b/i;

function isExplicitTaskControlOrRecallTurn(text: string): boolean {
	return (
		OUTPUT_CONTROL_RE.test(text) ||
		LIGHTWEIGHT_MEMORY_RECALL_RE.test(text)
	);
}

function sanitizeTurnTextForTaskState(text: string): string {
	return normalizeWhitespace(text)
		.split(/(?<=[.!?])\s+|\r?\n/)
		.map((segment) => segment.trim())
		.filter((segment) => !isExplicitTaskControlOrRecallTurn(segment))
		.filter(Boolean)
		.join(" ");
}

export function shouldTrackTaskContinuityFromTurn(params: {
	message: string;
	assistantResponse?: string | null;
	taskState?: TaskState | null;
	attachmentIds?: string[];
}): boolean {
	const messageText = normalizeWhitespace(params.message).toLowerCase();
	const assistantText = normalizeWhitespace(
		params.assistantResponse ?? "",
	).toLowerCase();
	const attachments = params.attachmentIds ?? [];
	if (attachments.length > 0) return true;
	if (!messageText && !assistantText) return false;

	if (params.taskState) {
		return (
			scoreMatch(messageText, params.taskState.objective) >=
			TASK_CONTINUITY_MIN_TASK_MATCH_SCORE
		);
	}

	const controlLikeMessage = isExplicitTaskControlOrRecallTurn(messageText);
	const controlLikeResponse = isExplicitTaskControlOrRecallTurn(assistantText);
	if (controlLikeMessage || controlLikeResponse) return false;

	return true;
}

function toEvidenceSourceType(artifactType: ArtifactType): EvidenceSourceType {
	switch (artifactType) {
		case "source_document":
		case "normalized_document":
			return "document";
		default:
			return "tool";
	}
}

function uniqueCompact(
	values: Array<string | null | undefined>,
	limit = MAX_LIST_ITEMS,
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const trimmed = value ? normalizeWhitespace(value) : "";
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
		if (result.length >= limit) break;
	}

	return result;
}

export { estimateTokenCount };

function getTaskSearchBody(task: TaskState): string {
	return [
		task.objective,
		...task.constraints,
		...task.factsToPreserve,
		...task.decisions,
		...task.openQuestions,
		...task.nextSteps,
	].join("\n");
}

function scoreTaskState(
	task: TaskState,
	message: string,
	attachmentIds: string[],
	semanticScore = 0,
	rerankScore = 0,
): number {
	let score = scoreMatch(message, getTaskSearchBody(task)) * 10;
	const attachmentOverlap = attachmentIds.filter((id) =>
		task.activeArtifactIds.includes(id),
	).length;
	score += attachmentOverlap * 18;
	score += Math.min(18, semanticScore * 18);
	score += Math.min(24, rerankScore * 24);

	if (task.status === "active") {
		score += 4;
	}

	const ageMinutes = Math.max(
		0,
		Math.round((Date.now() - task.updatedAt) / 60_000),
	);
	if (ageMinutes <= 30) score += 4;
	else if (ageMinutes <= 180) score += 2;

	return score;
}

async function buildTaskRoutingScoreMaps(params: {
	userId: string;
	message: string;
	states: TaskState[];
}): Promise<{
	semanticScoreByTaskId: Map<string, number>;
	rerankScoreByTaskId: Map<string, number>;
	semanticDiagnostics: SemanticShortlistDiagnostics | null;
	rerankDiagnostics: TeiRerankDiagnostics | null;
}> {
	const trimmedMessage = params.message.trim();
	if (!trimmedMessage || params.states.length === 0) {
		return {
			semanticScoreByTaskId: new Map(),
			rerankScoreByTaskId: new Map(),
			semanticDiagnostics: null,
			rerankDiagnostics: null,
		};
	}

	let semanticDiagnostics: SemanticShortlistDiagnostics | null = null;
	const semanticMatches =
		(await shortlistSemanticMatchesBySubject({
			userId: params.userId,
			subjectType: "task_state",
			query: trimmedMessage,
			items: params.states,
			getSubjectId: (state) => state.taskId,
			limit: TASK_SEMANTIC_SHORTLIST_LIMIT,
			onDiagnostics: (diagnostics) => {
				semanticDiagnostics = diagnostics;
			},
		})) ?? [];
	const semanticScoreByTaskId = new Map(
		semanticMatches.map((match) => [match.subjectId, match.semanticScore]),
	);

	let rerankScoreByTaskId = new Map<string, number>();
	let rerankDiagnostics: TeiRerankDiagnostics | null = null;
	if (canUseTeiReranker() && semanticMatches.length > 1) {
		try {
			const reranked = await rerankItems({
				query: trimmedMessage,
				items: semanticMatches.map((match) => match.item),
				getText: (state) => getTaskSearchBody(state),
				maxTexts: TASK_ROUTER_RERANK_LIMIT,
				onDiagnostics: (diagnostics) => {
					rerankDiagnostics = diagnostics;
				},
			});

			if (reranked && reranked.items.length > 0) {
				rerankScoreByTaskId = new Map(
					reranked.items.map((entry) => [entry.item.taskId, entry.score]),
				);
			}
		} catch (error) {
			console.error("[TASK_STATE] Task semantic reranker failed:", error);
		}
	}

	return {
		semanticScoreByTaskId,
		rerankScoreByTaskId,
		semanticDiagnostics,
		rerankDiagnostics,
	};
}

function extractQuestionCandidate(text: string): string | null {
	if (!text.includes("?")) return null;
	const match = text.replace(/\s+/g, " ").match(/[^.?!]*\?/);
	return match ? clipText(match[0], 180) : clipText(text, 180);
}

function extractListItems(text: string): string[] {
	const lines = sanitizeTurnTextForTaskState(text)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const explicit = lines
		.filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
		.map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));

	if (explicit.length > 0) {
		return explicit.slice(0, MAX_LIST_ITEMS).map((line) => clipText(line, 140));
	}

	return lines.slice(0, 3).map((line) => clipText(line, 140));
}

function extractSentenceCandidates(
	text: string,
	filter?: (sentence: string) => boolean,
): string[] {
	const sentences = text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const selected = filter ? sentences.filter(filter) : sentences;
	return selected.slice(0, 3).map((sentence) => clipText(sentence, 180));
}

function extractDecisionCandidates(text: string): string[] {
	return extractSentenceCandidates(text, (sentence) =>
		/\b(should|recommend|decide|best|need to|will|let's|prefer)\b/i.test(
			sentence,
		),
	);
}

function extractConstraintCandidates(text: string): string[] {
	return extractSentenceCandidates(text, (sentence) =>
		/\b(must|should not|cannot|can't|need to|have to|without|limit|constraint)\b/i.test(
			sentence,
		),
	);
}

function extractFactCandidates(text: string): string[] {
	return extractSentenceCandidates(sanitizeTurnTextForTaskState(text));
}

async function summarizeTaskStateUpdate(params: {
	existing: TaskState | null;
	message: string;
	assistantResponse: string;
	attachmentIds: string[];
	promptArtifactIds: string[];
}): Promise<Partial<TaskState> | null> {
	if (!canUseContextSummarizer()) return null;

	const existingState = params.existing
		? JSON.stringify(
				{
					objective: params.existing.objective,
					constraints: params.existing.constraints,
					factsToPreserve: params.existing.factsToPreserve,
					decisions: params.existing.decisions,
					openQuestions: params.existing.openQuestions,
					activeArtifactIds: params.existing.activeArtifactIds,
					nextSteps: params.existing.nextSteps,
				},
				null,
				2,
			)
		: "null";

	try {
		const content = await requestContextSummarizer({
			system:
				"Update the structured task state for a long-running assistant conversation. Return strict JSON only with keys objective, constraints, factsToPreserve, decisions, openQuestions, nextSteps. Keep each list concise and relevant to the active task.",
			user: [
				`Existing task state: ${existingState}`,
				`User message: ${params.message}`,
				`Assistant response: ${params.assistantResponse}`,
				`Active artifact ids: ${JSON.stringify(uniqueCompact([...params.attachmentIds, ...params.promptArtifactIds], 12))}`,
			].join("\n\n"),
			maxTokens: 500,
			temperature: 0.0,
		});
		if (!content) return null;
		const parsed = parseJsonFromModel(content);
		if (!parsed) return null;
		const parsedFactsToPreserve = Array.isArray(parsed.factsToPreserve)
			? (parsed.factsToPreserve as string[])
			: [];
		const parsedNextSteps = Array.isArray(parsed.nextSteps)
			? (parsed.nextSteps as string[])
			: [];
		return {
			objective:
				typeof parsed.objective === "string" && parsed.objective.trim()
					? clipText(parsed.objective, 220)
					: (params.existing?.objective ?? clipText(params.message, 220)),
			constraints: uniqueCompact(
				Array.isArray(parsed.constraints)
					? (parsed.constraints as string[])
					: [],
			),
			factsToPreserve: uniqueCompact(
				parsedFactsToPreserve.filter(
					(item) => !isExplicitTaskControlOrRecallTurn(item),
				),
			),
			decisions: uniqueCompact(
				Array.isArray(parsed.decisions) ? (parsed.decisions as string[]) : [],
			),
			openQuestions: uniqueCompact(
				Array.isArray(parsed.openQuestions)
					? (parsed.openQuestions as string[])
					: [],
				4,
			),
			nextSteps: uniqueCompact(
				parsedNextSteps.filter(
					(item) => !isExplicitTaskControlOrRecallTurn(item),
				),
				4,
			),
			activeArtifactIds: uniqueCompact(
				[...params.attachmentIds, ...params.promptArtifactIds],
				12,
			),
		};
	} catch (error) {
		// Non-fatal: summarizer unavailable, fall back to deterministic update
		console.warn(
			"[TASK_STATE] Summarizer unavailable, using deterministic update:",
			error,
		);
		return null;
	}
}

function buildDeterministicTaskStateUpdate(params: {
	existing: TaskState | null;
	message: string;
	assistantResponse: string;
	attachmentIds: string[];
	promptArtifactIds: string[];
}): Partial<TaskState> {
	const sanitizedMessage = sanitizeTurnTextForTaskState(params.message);
	const sanitizedAssistantResponse = sanitizeTurnTextForTaskState(
		params.assistantResponse,
	);

	const objective =
		params.existing && scoreMatch(params.message, params.existing.objective) > 0
			? params.existing.objective
			: clipText(sanitizedMessage, 220);

	return {
		objective,
		constraints: uniqueCompact([
			...(params.existing?.constraints ?? []),
			...extractConstraintCandidates(sanitizedMessage),
			...extractConstraintCandidates(sanitizedAssistantResponse),
		]),
		factsToPreserve: uniqueCompact([
			...(params.existing?.factsToPreserve ?? []),
			...extractFactCandidates(sanitizedMessage),
			...params.attachmentIds.map((id) => `Active artifact: ${id}`),
		]),
		decisions: uniqueCompact([
			...(params.existing?.decisions ?? []),
			...extractDecisionCandidates(sanitizedAssistantResponse),
		]),
		openQuestions: uniqueCompact(
			[
				extractQuestionCandidate(sanitizedMessage),
				...(params.existing?.openQuestions ?? []),
			],
			4,
		),
		nextSteps: uniqueCompact(
			[
				...extractListItems(sanitizedAssistantResponse),
				...(params.existing?.nextSteps ?? []),
			],
			4,
		),
		activeArtifactIds: uniqueCompact(
			[
				...(params.existing?.activeArtifactIds ?? []),
				...params.attachmentIds,
				...params.promptArtifactIds,
			],
			12,
		),
	};
}

function getCurrentTaskFromList(states: TaskState[]): TaskState | null {
	return (
		states.find(
			(state) => state.locked && CURRENT_TASK_STATUSES.includes(state.status),
		) ??
		states.find((state) => CURRENT_TASK_STATUSES.includes(state.status)) ??
		null
	);
}

async function setCurrentTask(
	taskId: string,
	userId: string,
	conversationId: string,
	nextStatus: TaskState["status"] = "active",
): Promise<void> {
	await db
		.update(conversationTaskStates)
		.set({
			status: "archived",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.conversationId, conversationId),
				inArray(conversationTaskStates.status, CURRENT_TASK_STATUSES),
			),
		);

	await db
		.update(conversationTaskStates)
		.set({
			status: nextStatus,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.taskId, taskId),
			),
		);
}

export async function listConversationTaskStates(
	userId: string,
	conversationId: string,
): Promise<TaskState[]> {
	const rows = await db
		.select()
		.from(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.conversationId, conversationId),
			),
		)
		.orderBy(desc(conversationTaskStates.updatedAt));

	return rows.map(mapTaskState);
}

export async function getConversationTaskState(
	userId: string,
	conversationId: string,
): Promise<TaskState | null> {
	const states = await listConversationTaskStates(userId, conversationId);
	return getCurrentTaskFromList(states) ?? states[0] ?? null;
}

export async function getTaskStateById(
	userId: string,
	taskId: string,
): Promise<TaskState | null> {
	const [row] = await db
		.select()
		.from(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.taskId, taskId),
			),
		)
		.limit(1);

	return row ? mapTaskState(row) : null;
}

export async function listTaskEvidenceLinks(params: {
	userId: string;
	taskId: string;
	roles?: TaskEvidenceLink["role"][];
}): Promise<TaskEvidenceLink[]> {
	const filters = [
		eq(taskStateEvidenceLinks.userId, params.userId),
		eq(taskStateEvidenceLinks.taskId, params.taskId),
	];
	if (params.roles?.length) {
		filters.push(inArray(taskStateEvidenceLinks.role, params.roles));
	}

	const rows = await db
		.select()
		.from(taskStateEvidenceLinks)
		.where(and(...filters))
		.orderBy(desc(taskStateEvidenceLinks.updatedAt));

	return rows.map(mapTaskEvidenceLink);
}

export async function listTaskCheckpoints(params: {
	userId: string;
	taskId: string;
	checkpointType?: TaskCheckpoint["checkpointType"];
}): Promise<TaskCheckpoint[]> {
	const filters = [
		eq(taskCheckpoints.userId, params.userId),
		eq(taskCheckpoints.taskId, params.taskId),
	];
	if (params.checkpointType) {
		filters.push(eq(taskCheckpoints.checkpointType, params.checkpointType));
	}

	const rows = await db
		.select()
		.from(taskCheckpoints)
		.where(and(...filters))
		.orderBy(desc(taskCheckpoints.updatedAt));

	return rows.map(mapTaskCheckpoint);
}

async function createTaskState(params: {
	userId: string;
	conversationId: string;
	objective: string;
	attachmentIds?: string[];
	status?: TaskState["status"];
	confidence?: number;
	locked?: boolean;
}): Promise<TaskState> {
	const [created] = await db
		.insert(conversationTaskStates)
		.values({
			taskId: randomUUID(),
			userId: params.userId,
			conversationId: params.conversationId,
			status: params.status ?? "candidate",
			objective: clipText(params.objective, 220),
			confidence: Math.round(params.confidence ?? 40),
			locked: params.locked ? 1 : 0,
			openQuestionsJson: JSON.stringify([]),
			activeArtifactIdsJson: JSON.stringify(
				uniqueCompact(params.attachmentIds ?? [], 12),
			),
			lastCheckpointAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();

	const mapped = mapTaskState(created);
	queueTaskStateSemanticEmbeddingRefresh(mapped);
	return mapped;
}

type RoutedTaskState = {
	taskState: TaskState | null;
	routingStage: RoutingStage;
	routingConfidence: number;
};

async function routeTaskStateForTurn(params: {
	userId: string;
	conversationId: string;
	message: string;
	attachmentIds?: string[];
	createIfMissing?: boolean;
}): Promise<RoutedTaskState> {
	const attachmentIds = params.attachmentIds ?? [];
	const states = await listConversationTaskStates(
		params.userId,
		params.conversationId,
	);
	const currentTask = getCurrentTaskFromList(states);

	if (currentTask?.locked) {
		return {
			taskState: currentTask,
			routingStage: "deterministic",
			routingConfidence: 100,
		};
	}

	const {
		semanticScoreByTaskId,
		rerankScoreByTaskId,
		semanticDiagnostics,
		rerankDiagnostics,
	} = await buildTaskRoutingScoreMaps({
		userId: params.userId,
		message: params.message,
		states,
	});

	const ranked = states
		.map((state) => ({
			state,
			score: scoreTaskState(
				state,
				params.message,
				attachmentIds,
				semanticScoreByTaskId.get(state.taskId) ?? 0,
				rerankScoreByTaskId.get(state.taskId) ?? 0,
			),
		}))
		.sort((a, b) => b.score - a.score);

	const best = ranked[0] ?? null;

	logTeiRetrievalSummary({
		scope: "task_routing",
		userId: params.userId,
		conversationId: params.conversationId,
		queryLength: params.message.trim().length,
		candidateCount: states.length,
		semantic: semanticDiagnostics,
		rerank: rerankDiagnostics,
		winningMode: determineTeiWinningMode({
			deterministic: Boolean(currentTask?.locked),
			lexicalScore: best
				? scoreMatch(params.message, getTaskSearchBody(best.state))
				: 0,
			semanticScore: best
				? (semanticScoreByTaskId.get(best.state.taskId) ?? 0)
				: 0,
			rerankScore: best ? (rerankScoreByTaskId.get(best.state.taskId) ?? 0) : 0,
		}),
		winnerId: best?.state.taskId ?? null,
		extra: {
			rankedCount: ranked.length,
			bestScore: best?.score ?? 0,
		},
	});

	const bestSemanticScore = best
		? (semanticScoreByTaskId.get(best.state.taskId) ?? 0)
		: 0;
	const useSemanticStage =
		bestSemanticScore > 0.5 && (best?.score ?? 0) >= TASK_MATCH_MIN_SCORE;

	if (best && best.score >= TASK_MATCH_MIN_SCORE) {
		const stage: RoutingStage = useSemanticStage ? "semantic" : "deterministic";
		if (!currentTask || best.state.taskId !== currentTask.taskId) {
			await setCurrentTask(
				best.state.taskId,
				params.userId,
				params.conversationId,
				best.state.status === "archived" ? "revived" : "active",
			);
			return {
				taskState:
					(await getConversationTaskState(
						params.userId,
						params.conversationId,
					)) ?? best.state,
				routingStage: stage,
				routingConfidence: Math.min(99, Math.max(55, best.score * 4)),
			};
		}

		return {
			taskState: best.state,
			routingStage: stage,
			routingConfidence: Math.min(99, Math.max(55, best.score * 4)),
		};
	}

	if (!params.createIfMissing) {
		return {
			taskState: best?.state ?? currentTask ?? null,
			routingStage: "deterministic" as RoutingStage,
			routingConfidence: Math.min(50, Math.max(0, (best?.score ?? 0) * 4)),
		};
	}

	const created = await createTaskState({
		userId: params.userId,
		conversationId: params.conversationId,
		objective: params.message,
		attachmentIds,
		status: "candidate",
		confidence: 45,
	});
	await setCurrentTask(
		created.taskId,
		params.userId,
		params.conversationId,
		"candidate",
	);
	return {
		taskState:
			(await getConversationTaskState(params.userId, params.conversationId)) ??
			created,
		routingStage: "deterministic" as RoutingStage,
		routingConfidence: 45,
	};
}

export async function selectTaskStateForTurn(params: {
	userId: string;
	conversationId: string;
	message: string;
	attachmentIds?: string[];
	createIfMissing?: boolean;
}): Promise<TaskState | null> {
	const routed = await routeTaskStateForTurn(params);
	return routed.taskState;
}

function getArtifactSearchBody(artifact: Artifact): string {
	return [
		artifact.name,
		artifact.summary ?? "",
		artifact.contentText ?? "",
	].join("\n");
}

type EvidenceSelectionPolicyArtifact = Pick<
	Artifact,
	"name" | "summary" | "contentText"
>;

function estimateSelectedEvidenceItemTokens(
	artifact: EvidenceSelectionPolicyArtifact,
): number {
	const text = [
		artifact.name,
		artifact.summary ?? "",
		clipText(artifact.contentText ?? "", 4_800),
	].join("\n");

	return Math.min(
		SELECTED_EVIDENCE_MAX_ARTIFACT_TEXT_TOKENS,
		Math.max(
			SELECTED_EVIDENCE_METADATA_TOKENS,
			estimateTokenCount(text) + SELECTED_EVIDENCE_METADATA_TOKENS,
		),
	);
}

export function deriveBudgetedSelectedEvidenceLimit(params: {
	candidates: EvidenceSelectionPolicyArtifact[];
	targetConstructedContext?: number | null;
}): number {
	if (params.candidates.length === 0) return 0;

	const targetConstructedContext =
		params.targetConstructedContext ?? getTargetConstructedContext();
	const evidenceBudgetTokens = Math.max(
		SELECTED_EVIDENCE_MIN_BUDGET_TOKENS,
		Math.floor(targetConstructedContext * SELECTED_EVIDENCE_BUDGET_RATIO),
	);
	let usedTokens = 0;
	let budgetedCount = 0;

	for (const candidate of params.candidates) {
		const itemTokens = estimateSelectedEvidenceItemTokens(candidate);
		if (
			budgetedCount >= MIN_SELECTED_EVIDENCE_ITEMS &&
			usedTokens + itemTokens > evidenceBudgetTokens
		) {
			break;
		}

		usedTokens += itemTokens;
		budgetedCount += 1;

		if (budgetedCount >= MAX_SELECTED_EVIDENCE_ITEMS) break;
	}

	return Math.min(
		params.candidates.length,
		Math.max(MIN_SELECTED_EVIDENCE_ITEMS, budgetedCount),
		MAX_SELECTED_EVIDENCE_ITEMS,
	);
}

function deriveEvidenceRerankCandidateLimit(
	selectedEvidenceLimit: number,
): number {
	return Math.max(
		MIN_EVIDENCE_RERANK_CANDIDATES,
		Math.min(MAX_EVIDENCE_RERANK_CANDIDATES, selectedEvidenceLimit * 2),
	);
}

async function replaceSystemSelectedEvidenceLinks(params: {
	userId: string;
	conversationId: string;
	taskId: string;
	selectedArtifacts: Array<{
		artifactId: string;
		confidence: number;
		reason?: string | null;
	}>;
}): Promise<void> {
	await db
		.delete(taskStateEvidenceLinks)
		.where(
			and(
				eq(taskStateEvidenceLinks.userId, params.userId),
				eq(taskStateEvidenceLinks.taskId, params.taskId),
				eq(taskStateEvidenceLinks.role, "selected"),
				eq(taskStateEvidenceLinks.origin, "system"),
			),
		);

	if (params.selectedArtifacts.length === 0) return;

	await db.insert(taskStateEvidenceLinks).values(
		params.selectedArtifacts.slice(0, MAX_SELECTED_LINKS).map((artifact) => ({
			id: randomUUID(),
			taskId: params.taskId,
			userId: params.userId,
			conversationId: params.conversationId,
			artifactId: artifact.artifactId,
			role: "selected",
			origin: "system",
			confidence: Math.round(artifact.confidence),
			reason: artifact.reason ?? null,
			updatedAt: new Date(),
		})),
	);
}

function computeEvidenceScore(params: {
	artifact: Artifact;
	message: string;
	taskState: TaskState | null;
	pinnedIds: Set<string>;
	excludedIds: Set<string>;
	activeDocumentIds: Set<string>;
	correctionTargetIds: Set<string>;
	recentlyRefinedArtifactIds: Set<string>;
	currentAttachmentIds: Set<string>;
	workingSetIds: Set<string>;
	relevantArtifactIds: Set<string>;
	currentGeneratedOutputIds: Set<string>;
	hasCorrectionSignal?: boolean;
}): number {
	if (params.excludedIds.has(params.artifact.id)) return -1000;

	let score =
		scoreMatch(params.message, getArtifactSearchBody(params.artifact)) * 10;
	if (params.taskState) {
		score +=
			scoreMatch(
				params.taskState.objective,
				getArtifactSearchBody(params.artifact),
			) * 6;
		if (params.taskState.activeArtifactIds.includes(params.artifact.id)) {
			score += 16;
		}
	}
	if (params.activeDocumentIds.has(params.artifact.id)) score += 140;
	if (
		params.hasCorrectionSignal &&
		params.correctionTargetIds.has(params.artifact.id)
	) {
		score += 36;
	}
	if (params.recentlyRefinedArtifactIds.has(params.artifact.id)) score += 28;
	if (params.currentAttachmentIds.has(params.artifact.id)) score += 100;
	if (params.workingSetIds.has(params.artifact.id)) score += 10;
	if (params.relevantArtifactIds.has(params.artifact.id)) score += 80;
	if (params.pinnedIds.has(params.artifact.id)) score += 120;
	if (params.artifact.conversationId === params.taskState?.conversationId)
		score += 4;
	if (params.currentGeneratedOutputIds.has(params.artifact.id)) score += 8;

	const isSameConversation =
		!params.artifact.conversationId ||
		params.artifact.conversationId === params.taskState?.conversationId;
	const daysSinceLastAccess = Math.max(
		0,
		(Date.now() - params.artifact.updatedAt) / (1000 * 60 * 60 * 24),
	);
	score = computeCrossConversationDecay({
		baseScore: score,
		daysSinceLastAccess,
		isSameConversation,
	});

	return score;
}

function shouldPersistSystemSelectedEvidenceLink(params: {
	artifact: Artifact;
	conversationId: string;
	taskState: TaskState | null;
	pinnedIds: Set<string>;
	activeDocumentIds: Set<string>;
	correctionTargetIds: Set<string>;
	recentlyRefinedArtifactIds: Set<string>;
	currentGeneratedOutputIds: Set<string>;
	workingSetIds: Set<string>;
	relevantArtifactIds: Set<string>;
}): boolean {
	if (params.pinnedIds.has(params.artifact.id)) return true;
	if (params.activeDocumentIds.has(params.artifact.id)) return true;
	if (params.correctionTargetIds.has(params.artifact.id)) return true;
	if (params.recentlyRefinedArtifactIds.has(params.artifact.id)) return true;
	if (params.currentGeneratedOutputIds.has(params.artifact.id)) return true;
	if (params.workingSetIds.has(params.artifact.id)) return true;
	if (params.taskState?.activeArtifactIds.includes(params.artifact.id)) {
		return true;
	}

	const isCrossConversationRelevantArtifact =
		params.relevantArtifactIds.has(params.artifact.id) &&
		params.artifact.conversationId !== null &&
		params.artifact.conversationId !== params.conversationId;
	if (isCrossConversationRelevantArtifact) return false;

	return true;
}

async function maybeRerankEvidence(params: {
	taskState: TaskState | null;
	message: string;
	candidates: Artifact[];
	pinnedIds: Set<string>;
	excludedIds: Set<string>;
	protectedIds?: Set<string>;
	selectedLimit: number;
	candidateLimit: number;
}): Promise<{
	artifacts: Artifact[];
	usedModel: boolean;
	confidence: number;
}> {
	if (!canUseTeiReranker() || params.candidates.length <= 2) {
		return { artifacts: params.candidates, usedModel: false, confidence: 0 };
	}

	try {
		const reranked = await rerankItems({
			query: [
				params.taskState ? `Current task: ${params.taskState.objective}` : null,
				`User message: ${params.message}`,
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n"),
			items: params.candidates.slice(0, params.candidateLimit),
			getText: (artifact) =>
				[
					artifact.name,
					artifact.type,
					clipText(
						artifact.summary ?? artifact.contentText ?? artifact.name,
						320,
					),
				].join("\n"),
			maxTexts: params.candidateLimit,
		});

		if (reranked && reranked.items.length > 0) {
			const selectedIds = new Set(
				reranked.items
					.slice(0, params.selectedLimit)
					.map(({ item }) => item.id),
			);
			const artifacts = dedupeById([
				...params.candidates.filter(
					(artifact) =>
						params.pinnedIds.has(artifact.id) ||
						(params.protectedIds?.has(artifact.id) ?? false),
				),
				...params.candidates.filter((artifact) => selectedIds.has(artifact.id)),
			]);
			if (artifacts.length > 0) {
				return {
					artifacts,
					usedModel: true,
					confidence: Math.max(RERANK_CONFIDENCE_MIN, reranked.confidence),
				};
			}
		}
	} catch (error) {
		console.error("[TASK_STATE] Evidence reranker failed:", error);
	}

	return { artifacts: params.candidates, usedModel: false, confidence: 0 };
}

export async function prepareTaskContext(params: {
	userId: string;
	conversationId: string;
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	targetConstructedContext?: number | null;
	currentAttachments: Artifact[];
	workingSetArtifacts: Artifact[];
	relevantArtifacts: Artifact[];
}): Promise<{
	taskState: TaskState | null;
	routingStage: RoutingStage;
	routingConfidence: number;
	verificationStatus: VerificationStatus;
	selectedArtifacts: Artifact[];
	pinnedArtifactIds: string[];
	excludedArtifactIds: string[];
}> {
	const attachmentIds = params.attachmentIds ?? [];
	const allowTaskStateCreation = shouldTrackTaskContinuityFromTurn({
		message: params.message,
		attachmentIds,
	});
	const routed = await routeTaskStateForTurn({
		userId: params.userId,
		conversationId: params.conversationId,
		message: params.message,
		attachmentIds,
		createIfMissing: allowTaskStateCreation,
	});
	const taskState = routed.taskState;
	const links = taskState
		? await listTaskEvidenceLinks({
				userId: params.userId,
				taskId: taskState.taskId,
			})
		: [];
	const pinnedIds = new Set(
		links
			.filter((link) => link.role === "pinned")
			.map((link) => link.artifactId),
	);
	const excludedIds = new Set(
		links
			.filter((link) => link.role === "excluded")
			.map((link) => link.artifactId),
	);
	const currentAttachmentIds = new Set(
		params.currentAttachments.map((artifact) => artifact.id),
	);
	const candidateArtifacts = dedupeById([
		...params.currentAttachments,
		...params.workingSetArtifacts,
		...params.relevantArtifacts,
	]).filter(
		(artifact) =>
			!excludedIds.has(artifact.id) || attachmentIds.includes(artifact.id),
	);
	const workingDocumentSelection = resolveWorkingDocumentSelection({
		artifacts: candidateArtifacts,
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		currentConversationId: params.conversationId,
	});
	const activeDocumentIds = new Set(
		workingDocumentSelection.activeFocus.artifactIds,
	);
	const correctionTargetIds = new Set(
		workingDocumentSelection.correction.targetArtifactIds,
	);
	const recentlyRefinedArtifactIds = new Set(
		workingDocumentSelection.recentRefinement.artifactIds,
	);
	const taskEvidenceProtectedIds = new Set(
		workingDocumentSelection.taskEvidence.protectedArtifactIds,
	);
	const workingDocumentProtectedIds = new Set(
		workingDocumentSelection.taskEvidence.workingDocumentProtectedArtifactIds,
	);
	const currentGeneratedOutputIds = new Set(
		candidateArtifacts
			.filter(
				(artifact) =>
					artifact.type === "generated_output" &&
					workingDocumentProtectedIds.has(artifact.id),
			)
			.map((artifact) => artifact.id),
	);
	const collapsedCandidates = await collapseArtifactsByFamily({
		userId: params.userId,
		conversationId: params.conversationId,
		query: params.message,
		artifacts: candidateArtifacts,
		pinnedIds,
		currentAttachmentIds,
		protectedIds: taskEvidenceProtectedIds,
	});

	const workingSetIds = new Set(
		params.workingSetArtifacts.map((artifact) => artifact.id),
	);
	const relevantArtifactIds = new Set(
		params.relevantArtifacts.map((artifact) => artifact.id),
	);
	const hasCorrectionSignal = workingDocumentSelection.correction.hasSignal;
	const rankedCandidates = collapsedCandidates
		.map((artifact) => ({
			artifact,
			score: computeEvidenceScore({
				artifact,
				message: params.message,
				taskState,
				pinnedIds,
				excludedIds,
				activeDocumentIds,
				correctionTargetIds,
				recentlyRefinedArtifactIds,
				currentAttachmentIds,
				workingSetIds,
				relevantArtifactIds,
				currentGeneratedOutputIds,
				hasCorrectionSignal,
			}),
		}))
		.filter((entry) => entry.score > 5)
		.sort((a, b) => b.score - a.score);
	const selectedEvidenceLimit = deriveBudgetedSelectedEvidenceLimit({
		candidates: rankedCandidates.map((entry) => entry.artifact),
		targetConstructedContext: params.targetConstructedContext,
	});
	const rerankCandidateLimit = deriveEvidenceRerankCandidateLimit(
		selectedEvidenceLimit,
	);

	let selectedArtifacts = dedupeById([
		...rankedCandidates
			.filter(
				(entry) =>
					pinnedIds.has(entry.artifact.id) ||
					taskEvidenceProtectedIds.has(entry.artifact.id) ||
					currentAttachmentIds.has(entry.artifact.id),
			)
			.map((entry) => entry.artifact),
		...rankedCandidates
			.slice(0, selectedEvidenceLimit)
			.map((entry) => entry.artifact),
	]);

	let routingStage: RoutingStage = routed.routingStage;
	let routingConfidence = routed.routingConfidence;
	const reranked = await maybeRerankEvidence({
		taskState,
		message: params.message,
		candidates: dedupeById([
			...selectedArtifacts,
			...rankedCandidates
				.slice(0, rerankCandidateLimit)
				.map((entry) => entry.artifact),
		]),
		pinnedIds,
		excludedIds,
		selectedLimit: selectedEvidenceLimit,
		candidateLimit: rerankCandidateLimit,
		protectedIds: new Set([
			...currentAttachmentIds,
			...taskEvidenceProtectedIds,
		]),
	});
	if (reranked.usedModel) {
		selectedArtifacts = dedupeById(reranked.artifacts);
		routingStage = "evidence_rerank";
		routingConfidence = reranked.confidence;
	}

	if (taskState) {
		await replaceSystemSelectedEvidenceLinks({
			userId: params.userId,
			conversationId: params.conversationId,
			taskId: taskState.taskId,
			selectedArtifacts: selectedArtifacts
				.filter((artifact) => !currentAttachmentIds.has(artifact.id))
				.filter((artifact) =>
					shouldPersistSystemSelectedEvidenceLink({
						artifact,
						conversationId: params.conversationId,
						taskState,
						pinnedIds,
						activeDocumentIds,
						correctionTargetIds,
						recentlyRefinedArtifactIds,
						currentGeneratedOutputIds,
						workingSetIds,
						relevantArtifactIds,
					}),
				)
				.map((artifact) => ({
					artifactId: artifact.id,
					confidence: routingConfidence,
					reason:
						routingStage === "evidence_rerank"
							? "control-model selection"
							: "deterministic selection",
				})),
		});
	}

	return {
		taskState,
		routingStage,
		routingConfidence,
		verificationStatus: "skipped" as const,
		selectedArtifacts,
		pinnedArtifactIds: Array.from(pinnedIds),
		excludedArtifactIds: Array.from(excludedIds),
	};
}

export async function getContextDebugState(
	userId: string,
	conversationId: string,
): Promise<ContextDebugState | null> {
	const taskState = await getConversationTaskState(userId, conversationId);
	const [[statusRow], latestHonchoMetadata] = await Promise.all([
		db
			.select()
			.from(conversationContextStatus)
			.where(
				and(
					eq(conversationContextStatus.userId, userId),
					eq(conversationContextStatus.conversationId, conversationId),
				),
			)
			.limit(1),
		getLatestHonchoMetadata(conversationId).catch(() => ({
			honchoContext: null,
			honchoSnapshot: null,
		})),
	]);

	if (!taskState && !statusRow && !latestHonchoMetadata.honchoContext)
		return null;

	const links = taskState
		? await db
				.select({ link: taskStateEvidenceLinks, artifact: artifacts })
				.from(taskStateEvidenceLinks)
				.innerJoin(
					artifacts,
					eq(taskStateEvidenceLinks.artifactId, artifacts.id),
				)
				.where(
					and(
						eq(taskStateEvidenceLinks.userId, userId),
						eq(taskStateEvidenceLinks.taskId, taskState.taskId),
					),
				)
				.orderBy(desc(taskStateEvidenceLinks.updatedAt))
		: [];

	const toDebugItems = (role: TaskEvidenceLink["role"]) =>
		links
			.filter((entry) => entry.link.role === role)
			.map((entry) => ({
				artifactId: entry.artifact.id,
				name: entry.artifact.name,
				artifactType: entry.artifact.type as ArtifactType,
				sourceType: toEvidenceSourceType(entry.artifact.type as ArtifactType),
				role,
				origin: entry.link.origin as TaskEvidenceLink["origin"],
				confidence: entry.link.confidence ?? 0,
				reason: entry.link.reason ?? null,
			}));

	const selectedEvidence = toDebugItems("selected");
	const selectedEvidenceBySource = Array.from(
		selectedEvidence.reduce((acc, item) => {
			acc.set(item.sourceType, (acc.get(item.sourceType) ?? 0) + 1);
			return acc;
		}, new Map<EvidenceSourceType, number>()),
	)
		.map(([sourceType, count]) => ({ sourceType, count }))
		.sort(
			(a, b) => b.count - a.count || a.sourceType.localeCompare(b.sourceType),
		);

	return {
		activeTaskId: taskState?.taskId ?? null,
		activeTaskObjective: taskState?.objective ?? null,
		taskLocked: taskState?.locked ?? false,
		routingStage: (statusRow?.routingStage ?? "deterministic") as RoutingStage,
		routingConfidence: statusRow?.routingConfidence ?? 0,
		verificationStatus: (statusRow?.verificationStatus ??
			"skipped") as VerificationStatus,
		selectedEvidence,
		selectedEvidenceBySource,
		pinnedEvidence: toDebugItems("pinned"),
		excludedEvidence: toDebugItems("excluded"),
		honcho: latestHonchoMetadata.honchoContext,
	};
}

async function upsertEvidenceRole(params: {
	taskId: string;
	userId: string;
	conversationId: string;
	artifactId: string;
	role: "pinned" | "excluded";
	enabled: boolean;
}): Promise<void> {
	const oppositeRole = params.role === "pinned" ? "excluded" : "pinned";
	await db
		.delete(taskStateEvidenceLinks)
		.where(
			and(
				eq(taskStateEvidenceLinks.userId, params.userId),
				eq(taskStateEvidenceLinks.taskId, params.taskId),
				eq(taskStateEvidenceLinks.artifactId, params.artifactId),
				eq(taskStateEvidenceLinks.origin, "user"),
				inArray(taskStateEvidenceLinks.role, [params.role, oppositeRole]),
			),
		);

	if (!params.enabled) return;

	const targetArtifacts = await db
		.select({ artifact: artifacts })
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.id, params.artifactId),
			),
		)
		.limit(1);
	const targetArtifact = targetArtifacts[0]?.artifact ?? null;
	const targetFamilyId = targetArtifact
		? parseWorkingDocumentMetadata(
				parseJsonRecord(targetArtifact.metadataJson ?? null),
			).documentFamilyId
		: null;

	if (targetFamilyId) {
		const existingPreferenceRows = await db
			.select({ link: taskStateEvidenceLinks, artifact: artifacts })
			.from(taskStateEvidenceLinks)
			.innerJoin(artifacts, eq(taskStateEvidenceLinks.artifactId, artifacts.id))
			.where(
				and(
					eq(taskStateEvidenceLinks.userId, params.userId),
					eq(taskStateEvidenceLinks.taskId, params.taskId),
					eq(taskStateEvidenceLinks.origin, "user"),
					inArray(taskStateEvidenceLinks.role, ["pinned", "excluded"]),
				),
			);

		const conflictingArtifactIds = findConflictingDocumentPreferenceArtifactIds(
			{
				entries: existingPreferenceRows.map((row) => ({
					artifactId: row.link.artifactId,
					metadata: parseJsonRecord(row.artifact.metadataJson ?? null),
				})),
				targetArtifactId: params.artifactId,
				targetFamilyId,
			},
		);

		if (conflictingArtifactIds.length > 0) {
			await db
				.delete(taskStateEvidenceLinks)
				.where(
					and(
						eq(taskStateEvidenceLinks.userId, params.userId),
						eq(taskStateEvidenceLinks.taskId, params.taskId),
						eq(taskStateEvidenceLinks.origin, "user"),
						inArray(taskStateEvidenceLinks.role, ["pinned", "excluded"]),
						inArray(
							taskStateEvidenceLinks.artifactId,
							Array.from(new Set(conflictingArtifactIds)),
						),
					),
				);
		}
	}

	await db.insert(taskStateEvidenceLinks).values({
		id: randomUUID(),
		taskId: params.taskId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: params.artifactId,
		role: params.role,
		origin: "user",
		confidence: 100,
		reason: params.role === "pinned" ? "Pinned by user" : "Excluded by user",
		updatedAt: new Date(),
	});
}

export async function applyTaskSteeringAction(params: {
	userId: string;
	conversationId: string;
	action: TaskSteeringAction;
	artifactId?: string | null;
	objective?: string | null;
	preference?: "auto" | "pinned" | "excluded" | null;
}): Promise<{
	taskState: TaskState | null;
	contextDebug: ContextDebugState | null;
}> {
	let taskState = await getConversationTaskState(
		params.userId,
		params.conversationId,
	);

	switch (params.action) {
		case "lock_task":
		case "unlock_task":
			if (taskState) {
				await db
					.update(conversationTaskStates)
					.set({
						locked: params.action === "lock_task" ? 1 : 0,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(conversationTaskStates.userId, params.userId),
							eq(conversationTaskStates.taskId, taskState.taskId),
						),
					);
			}
			break;
		case "start_new_task": {
			const nextObjective = params.objective?.trim()
				? clipText(params.objective.trim(), 220)
				: "New task";
			const created = await createTaskState({
				userId: params.userId,
				conversationId: params.conversationId,
				objective: nextObjective,
				status: "candidate",
				confidence: 100,
				locked: true,
			});
			await setCurrentTask(
				created.taskId,
				params.userId,
				params.conversationId,
				"candidate",
			);
			taskState = created;
			break;
		}
		case "pin_artifact":
		case "exclude_artifact":
		case "unpin_artifact":
		case "include_artifact":
		case "set_artifact_preference":
			if (taskState && params.artifactId) {
				const nextPreference =
					params.action === "set_artifact_preference"
						? (params.preference ?? "auto")
						: params.action === "pin_artifact"
							? "pinned"
							: params.action === "exclude_artifact"
								? "excluded"
								: "auto";
				await upsertEvidenceRole({
					taskId: taskState.taskId,
					userId: params.userId,
					conversationId: params.conversationId,
					artifactId: params.artifactId,
					role: nextPreference === "pinned" ? "pinned" : "excluded",
					enabled: nextPreference !== "auto",
				});
			}
			break;
	}

	taskState = await getConversationTaskState(
		params.userId,
		params.conversationId,
	);
	return {
		taskState,
		contextDebug: await getContextDebugState(
			params.userId,
			params.conversationId,
		),
	};
}

function buildCheckpointContent(taskState: TaskState): string {
	return formatTaskStateForPrompt(taskState);
}

async function upsertTaskCheckpoint(params: {
	taskState: TaskState;
	checkpointType: TaskCheckpoint["checkpointType"];
	content: string;
	sourceEvidenceIds: string[];
	verificationStatus?: VerificationStatus;
	sourceTurnRange?: string | null;
}): Promise<void> {
	const existing = (
		await listTaskCheckpoints({
			userId: params.taskState.userId,
			taskId: params.taskState.taskId,
			checkpointType: params.checkpointType,
		})
	)[0];

	if (existing && existing.content === params.content) {
		await db
			.update(taskCheckpoints)
			.set({
				sourceTurnRange: params.sourceTurnRange ?? existing.sourceTurnRange,
				sourceEvidenceIdsJson: JSON.stringify(params.sourceEvidenceIds),
				verificationStatus:
					params.verificationStatus ?? existing.verificationStatus,
				updatedAt: new Date(),
			})
			.where(eq(taskCheckpoints.id, existing.id));
		return;
	}

	await db.insert(taskCheckpoints).values({
		id: randomUUID(),
		taskId: params.taskState.taskId,
		userId: params.taskState.userId,
		conversationId: params.taskState.conversationId,
		checkpointType: params.checkpointType,
		content: params.content,
		sourceTurnRange: params.sourceTurnRange ?? null,
		sourceEvidenceIdsJson: JSON.stringify(params.sourceEvidenceIds),
		verificationStatus: params.verificationStatus ?? "skipped",
		updatedAt: new Date(),
	});
}

export async function updateTaskStateCheckpoint(params: {
	userId: string;
	conversationId: string;
	message: string;
	assistantResponse: string;
	attachmentIds?: string[];
	promptArtifactIds?: string[];
	userMessageId?: string | null;
	assistantMessageId?: string | null;
}): Promise<TaskState | null> {
	const attachmentIds = params.attachmentIds ?? [];
	const promptArtifactIds = params.promptArtifactIds ?? [];
	const allowTaskStateCreation = shouldTrackTaskContinuityFromTurn({
		message: params.message,
		assistantResponse: params.assistantResponse,
		attachmentIds,
	});
	const routed = await routeTaskStateForTurn({
		userId: params.userId,
		conversationId: params.conversationId,
		message: params.message,
		attachmentIds,
		createIfMissing: allowTaskStateCreation,
	});
	const existing = routed.taskState;
	if (
		!shouldTrackTaskContinuityFromTurn({
			message: params.message,
			assistantResponse: params.assistantResponse,
			taskState: existing,
			attachmentIds,
		})
	) {
		return existing;
	}

	if (!existing) return null;

	const llmUpdate = await summarizeTaskStateUpdate({
		existing,
		message: params.message,
		assistantResponse: params.assistantResponse,
		attachmentIds,
		promptArtifactIds,
	});
	const merged =
		llmUpdate ??
		buildDeterministicTaskStateUpdate({
			existing,
			message: params.message,
			assistantResponse: params.assistantResponse,
			attachmentIds,
			promptArtifactIds,
		});

	const nextConfidence = Math.min(
		100,
		Math.max(
			existing.confidence,
			routed.routingConfidence,
			llmUpdate ? 82 : 72,
		),
	);
	const [updated] = await db
		.update(conversationTaskStates)
		.set({
			status: "active",
			objective: clipText(merged.objective ?? existing.objective, 220),
			confidence: nextConfidence,
			locked: existing.locked ? 1 : 0,
			lastConfirmedTurnMessageId:
				params.assistantMessageId ??
				params.userMessageId ??
				existing.lastConfirmedTurnMessageId,
			constraintsJson: JSON.stringify(
				merged.constraints ?? existing.constraints,
			),
			factsToPreserveJson: JSON.stringify(
				merged.factsToPreserve ?? existing.factsToPreserve,
			),
			decisionsJson: JSON.stringify(merged.decisions ?? existing.decisions),
			openQuestionsJson: JSON.stringify(
				merged.openQuestions ?? existing.openQuestions,
			),
			activeArtifactIdsJson: JSON.stringify(
				merged.activeArtifactIds ?? existing.activeArtifactIds,
			),
			nextStepsJson: JSON.stringify(merged.nextSteps ?? existing.nextSteps),
			lastCheckpointAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(conversationTaskStates.userId, params.userId),
				eq(conversationTaskStates.taskId, existing.taskId),
			),
		)
		.returning();

	await setCurrentTask(
		existing.taskId,
		params.userId,
		params.conversationId,
		"active",
	);
	const current = updated ? mapTaskState(updated) : existing;
	const checkpointContent = buildCheckpointContent(current);
	const sourceEvidenceIds = uniqueCompact(
		[...attachmentIds, ...promptArtifactIds],
		12,
	);
	const sourceTurnRange =
		params.userMessageId || params.assistantMessageId
			? `${params.userMessageId ?? "unknown"}..${params.assistantMessageId ?? "unknown"}`
			: null;

	await upsertTaskCheckpoint({
		taskState: current,
		checkpointType: "micro",
		content: checkpointContent,
		sourceEvidenceIds,
		sourceTurnRange,
		verificationStatus: "skipped",
	});

	if (
		current.decisions.length > 0 ||
		current.factsToPreserve.length > 1 ||
		current.nextSteps.length > 0
	) {
		await upsertTaskCheckpoint({
			taskState: current,
			checkpointType: "stable",
			content: checkpointContent,
			sourceEvidenceIds,
			sourceTurnRange,
			verificationStatus: llmUpdate ? "passed" : "skipped",
		});
	}

	queueTaskStateSemanticEmbeddingRefresh(current);
	return current;
}
