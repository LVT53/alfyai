import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversationSummaries,
	conversations,
	conversationTaskStates,
	memoryEvents,
	messages,
	projects,
	taskCheckpoints,
} from "$lib/server/db/schema";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { clipNullableText, normalizeWhitespace } from "$lib/server/utils/text";
import type { TaskCheckpoint, TaskMemoryItem, TaskState } from "$lib/types";
import { mapTaskCheckpoint, mapTaskState } from "./mappers";

const PROJECT_FOLDER_AWARENESS_LIMIT = 5;
const PROJECT_FOLDER_AWARENESS_TITLE_MAX = 120;
const PROJECT_FOLDER_AWARENESS_OBJECTIVE_MAX = 240;
const PROJECT_FOLDER_AWARENESS_SUMMARY_MAX = 360;
const PROJECT_FOLDER_SIBLING_CANDIDATE_LIMIT = 24;
const PROJECT_FOLDER_SIBLING_MESSAGE_LIMIT = 6;
const PROJECT_FOLDER_SIBLING_MIN_SCORE = 8;
const PROJECT_FOLDER_SIBLING_MIN_MATCHED_TERMS = 2;
const PROJECT_FOLDER_LOOKUP_LIMIT = 64;
const PROJECT_FOLDER_LOOKUP_CONVERSATION_LIMIT = 64;
const PROJECT_FOLDER_SIBLING_TITLE_MAX = 160;
const PROJECT_FOLDER_SIBLING_OBJECTIVE_MAX = 360;
const PROJECT_FOLDER_SIBLING_SUMMARY_MAX = 600;
const PROJECT_FOLDER_SIBLING_MESSAGE_MAX = 900;
const PROJECT_FOLDER_SIBLING_STOP_TERMS = new Set([
	"a",
	"about",
	"again",
	"all",
	"an",
	"and",
	"any",
	"are",
	"did",
	"discuss",
	"discussed",
	"do",
	"for",
	"from",
	"have",
	"in",
	"it",
	"of",
	"on",
	"our",
	"project",
	"that",
	"the",
	"this",
	"to",
	"was",
	"we",
	"what",
	"which",
	"with",
]);

export type ProjectFolderReferenceEntry = {
	conversationId: string;
	title: string;
	objective: string | null;
	summary: string | null;
};

export type ProjectFolderReferenceContext = {
	projectId: string;
	projectName: string;
	entries: ProjectFolderReferenceEntry[];
	omittedSiblingCount: number;
};

// Folder-anchored continuity is the single continuity authority (ADR-0051).
// A project reference is always a Project Folder; the previously inferred
// project-memory bucket variant has been retired.
export type ProjectReferenceContext = ProjectFolderReferenceContext & {
	source: "project_folder";
};

export type ProjectFolderSiblingPromotionContext = {
	projectId: string;
	projectName: string;
	conversationId: string;
	title: string;
	objective: string | null;
	summary: string | null;
	score: number;
	matchedTerms: string[];
	messages: Array<{
		role: "user" | "assistant";
		content: string;
		createdAt: number;
	}>;
	omittedMessageCount: number;
};

function clipNullable(
	value: string | null | undefined,
	maxLength: number,
): string | null {
	return clipNullableText(value, maxLength);
}

function clipRequired(text: string, maxLength: number): string {
	return clipNullable(text, maxLength) ?? text.slice(0, maxLength);
}

function isPlaceholderObjective(objective: string): boolean {
	const normalized = normalizeWhitespace(objective).toLowerCase();
	return !normalized || normalized === "new task";
}

function overlapScore(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) return 0;
	const rightSet = new Set(right);
	let overlap = 0;
	for (const value of left) {
		if (rightSet.has(value)) overlap += 1;
	}
	return overlap;
}

function tokenizeSiblingPromotionText(
	value: string | null | undefined,
): string[] {
	const normalized = normalizeWhitespace(value ?? "")
		.toLowerCase()
		.replace(/['’]s\b/g, "");
	const tokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [];
	return Array.from(
		new Set(
			tokens.filter((token) => !PROJECT_FOLDER_SIBLING_STOP_TERMS.has(token)),
		),
	);
}

function normalizeProjectFolderLookupText(
	value: string | null | undefined,
): string {
	return normalizeWhitespace(value ?? "")
		.toLowerCase()
		.replace(/['’]s\b/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function scoreProjectFolderNameMatch(params: {
	query: string;
	folderName: string;
}): number {
	const query = normalizeProjectFolderLookupText(params.query);
	const folderName = normalizeProjectFolderLookupText(params.folderName);
	if (!query || !folderName) return 0;
	if (query === folderName) return 1_000;
	if (query.includes(folderName)) return 900;
	if (folderName.includes(query)) return 800;

	const queryTerms = tokenizeSiblingPromotionText(query);
	const folderTerms = tokenizeSiblingPromotionText(folderName);
	const overlap = overlapScore(folderTerms, queryTerms);
	if (overlap === 0) return 0;
	const requiredOverlap = Math.min(2, folderTerms.length);
	if (overlap < requiredOverlap) return 0;
	return overlap * 40;
}

function scoreSiblingPromotionCandidate(params: {
	queryTerms: string[];
	title: string;
	objective: string | null;
	summary: string | null;
}): { score: number; matchedTerms: string[] } {
	if (params.queryTerms.length === 0) {
		return { score: 0, matchedTerms: [] };
	}

	const titleTerms = new Set(tokenizeSiblingPromotionText(params.title));
	const objectiveTerms = new Set(
		tokenizeSiblingPromotionText(params.objective),
	);
	const summaryTerms = new Set(tokenizeSiblingPromotionText(params.summary));
	const matchedTerms: string[] = [];
	let score = 0;

	for (const term of params.queryTerms) {
		let termScore = 0;
		if (titleTerms.has(term)) termScore += 5;
		if (objectiveTerms.has(term)) termScore += 4;
		if (summaryTerms.has(term)) termScore += 3;
		if (termScore > 0) {
			matchedTerms.push(term);
			score += termScore;
		}
	}

	return { score, matchedTerms };
}

async function getConversationSummaryMap(params: {
	userId: string;
	conversationIds: string[];
}): Promise<Map<string, string>> {
	if (params.conversationIds.length === 0) return new Map();
	const rows = await db
		.select({
			conversationId: conversationSummaries.conversationId,
			summary: conversationSummaries.summary,
		})
		.from(conversationSummaries)
		.where(
			and(
				eq(conversationSummaries.userId, params.userId),
				inArray(conversationSummaries.conversationId, params.conversationIds),
			),
		);

	return new Map(
		rows
			.map((row) => [row.conversationId, row.summary] as const)
			.filter(([, summary]) => normalizeWhitespace(summary).length > 0),
	);
}

export async function getProjectFolderReferenceContext(params: {
	userId: string;
	conversationId: string;
}): Promise<ProjectFolderReferenceContext | null> {
	const [conversationRow] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, params.userId),
				eq(conversations.id, params.conversationId),
			),
		)
		.limit(1);

	if (!conversationRow?.projectId) return null;

	const [projectRow] = await db
		.select({ name: projects.name })
		.from(projects)
		.where(
			and(
				eq(projects.userId, params.userId),
				eq(projects.id, conversationRow.projectId),
			),
		)
		.limit(1);

	const siblingWhere = and(
		eq(conversations.userId, params.userId),
		eq(conversations.projectId, conversationRow.projectId),
		ne(conversations.id, params.conversationId),
	);
	const [siblingCountRows, siblingRows] = await Promise.all([
		db
			.select({ siblingCount: count() })
			.from(conversations)
			.where(siblingWhere),
		db
			.select({
				conversationId: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(siblingWhere)
			.orderBy(desc(conversations.updatedAt), asc(conversations.id))
			.limit(PROJECT_FOLDER_AWARENESS_LIMIT),
	]);

	if (siblingRows.length === 0) return null;
	const siblingCount = siblingCountRows[0]?.siblingCount ?? siblingRows.length;

	const siblingConversationIds = siblingRows.map((row) => row.conversationId);
	const taskRows = await db
		.select({
			taskId: conversationTaskStates.taskId,
			conversationId: conversationTaskStates.conversationId,
			objective: conversationTaskStates.objective,
			updatedAt: conversationTaskStates.updatedAt,
		})
		.from(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, params.userId),
				inArray(conversationTaskStates.conversationId, siblingConversationIds),
			),
		)
		.orderBy(
			desc(conversationTaskStates.updatedAt),
			asc(conversationTaskStates.taskId),
		);

	const taskByConversation = new Map<
		string,
		{ taskId: string; objective: string }
	>();
	for (const row of taskRows) {
		if (taskByConversation.has(row.conversationId)) continue;
		if (isPlaceholderObjective(row.objective)) continue;
		taskByConversation.set(row.conversationId, {
			taskId: row.taskId,
			objective: clipRequired(
				row.objective,
				PROJECT_FOLDER_AWARENESS_OBJECTIVE_MAX,
			),
		});
	}

	const selectedTaskIds = Array.from(
		new Set(Array.from(taskByConversation.values()).map((task) => task.taskId)),
	);
	const checkpointRows =
		selectedTaskIds.length > 0
			? await db
					.select({
						taskId: taskCheckpoints.taskId,
						content: taskCheckpoints.content,
						checkpointType: taskCheckpoints.checkpointType,
						updatedAt: taskCheckpoints.updatedAt,
					})
					.from(taskCheckpoints)
					.where(
						and(
							eq(taskCheckpoints.userId, params.userId),
							inArray(taskCheckpoints.taskId, selectedTaskIds),
						),
					)
					.orderBy(desc(taskCheckpoints.updatedAt))
			: [];
	const latestCheckpointByTask = new Map<string, string>();
	const latestStableCheckpointByTask = new Map<string, string>();
	for (const row of checkpointRows) {
		if (!latestCheckpointByTask.has(row.taskId)) {
			latestCheckpointByTask.set(row.taskId, row.content);
		}
		if (
			row.checkpointType === "stable" &&
			!latestStableCheckpointByTask.has(row.taskId)
		) {
			latestStableCheckpointByTask.set(row.taskId, row.content);
		}
	}
	const summaryByConversation = await getConversationSummaryMap({
		userId: params.userId,
		conversationIds: siblingConversationIds,
	});

	return {
		projectId: conversationRow.projectId,
		projectName: projectRow?.name ?? "Project folder",
		entries: siblingRows.map((row) => {
			const task = taskByConversation.get(row.conversationId) ?? null;
			const summary =
				summaryByConversation.get(row.conversationId) ??
				(task
					? (latestStableCheckpointByTask.get(task.taskId) ??
						latestCheckpointByTask.get(task.taskId) ??
						task.objective)
					: null);
			return {
				conversationId: row.conversationId,
				title: clipRequired(row.title, PROJECT_FOLDER_AWARENESS_TITLE_MAX),
				objective: task?.objective ?? null,
				summary: clipNullable(summary, PROJECT_FOLDER_AWARENESS_SUMMARY_MAX),
			};
		}),
		omittedSiblingCount: Math.max(0, siblingCount - siblingRows.length),
	};
}

export async function findProjectFolderReferenceContextByQuery(params: {
	userId: string;
	conversationId: string;
	query: string | null | undefined;
}): Promise<ProjectReferenceContext | null> {
	const query = normalizeWhitespace(params.query ?? "");
	if (!query) return null;

	const folders = await db
		.select({
			projectId: projects.id,
			projectName: projects.name,
			updatedAt: projects.updatedAt,
		})
		.from(projects)
		.where(eq(projects.userId, params.userId))
		.orderBy(desc(projects.updatedAt), asc(projects.id))
		.limit(PROJECT_FOLDER_LOOKUP_LIMIT);

	const ranked = folders
		.map((folder) => ({
			...folder,
			score: scoreProjectFolderNameMatch({
				query,
				folderName: folder.projectName,
			}),
		}))
		.filter((folder) => folder.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			const leftUpdatedAt =
				left.updatedAt instanceof Date
					? left.updatedAt.getTime()
					: Number(left.updatedAt ?? 0);
			const rightUpdatedAt =
				right.updatedAt instanceof Date
					? right.updatedAt.getTime()
					: Number(right.updatedAt ?? 0);
			return rightUpdatedAt - leftUpdatedAt;
		});
	const selected = ranked[0];
	if (!selected) return null;

	const folderWhere = and(
		eq(conversations.userId, params.userId),
		eq(conversations.projectId, selected.projectId),
	);
	const [conversationCountRows, conversationRows] = await Promise.all([
		db.select({ siblingCount: count() }).from(conversations).where(folderWhere),
		db
			.select({
				conversationId: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(folderWhere)
			.orderBy(desc(conversations.updatedAt), asc(conversations.id))
			.limit(PROJECT_FOLDER_LOOKUP_CONVERSATION_LIMIT),
	]);
	const summaryByConversation = await getConversationSummaryMap({
		userId: params.userId,
		conversationIds: conversationRows.map((row) => row.conversationId),
	});

	return {
		source: "project_folder",
		projectId: selected.projectId,
		projectName: selected.projectName,
		entries: conversationRows.map((row) => ({
			conversationId: row.conversationId,
			title: clipRequired(row.title, PROJECT_FOLDER_AWARENESS_TITLE_MAX),
			objective: null,
			summary: clipNullable(
				summaryByConversation.get(row.conversationId),
				PROJECT_FOLDER_AWARENESS_SUMMARY_MAX,
			),
		})),
		omittedSiblingCount: Math.max(
			0,
			(conversationCountRows[0]?.siblingCount ?? conversationRows.length) -
				conversationRows.length,
		),
	};
}

// Folder-anchored continuity only: a folder conversation resolves to its
// Project Folder siblings; a non-folder conversation has no passive reference
// context. On-demand recall over unorganized conversations is served by the
// `memory_context` tool's history search, not by a stored reference.
export async function getProjectReferenceContext(params: {
	userId: string;
	conversationId: string;
}): Promise<ProjectReferenceContext | null> {
	const [conversationRow] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, params.userId),
				eq(conversations.id, params.conversationId),
			),
		)
		.limit(1);

	if (!conversationRow?.projectId) return null;

	const folderContext = await getProjectFolderReferenceContext(params);
	return folderContext ? { ...folderContext, source: "project_folder" } : null;
}

export async function selectProjectFolderSiblingPromotion(params: {
	userId: string;
	conversationId: string;
	query: string;
	candidateLimit?: number;
	messageLimit?: number;
}): Promise<ProjectFolderSiblingPromotionContext | null> {
	const queryTerms = tokenizeSiblingPromotionText(params.query);
	if (queryTerms.length === 0) return null;

	const candidateLimit = Math.max(
		1,
		params.candidateLimit ?? PROJECT_FOLDER_SIBLING_CANDIDATE_LIMIT,
	);
	const messageLimit = Math.max(
		1,
		params.messageLimit ?? PROJECT_FOLDER_SIBLING_MESSAGE_LIMIT,
	);

	const [conversationRow] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, params.userId),
				eq(conversations.id, params.conversationId),
			),
		)
		.limit(1);

	if (!conversationRow?.projectId) return null;

	const [projectRow, siblingRows] = await Promise.all([
		db
			.select({ name: projects.name })
			.from(projects)
			.where(
				and(
					eq(projects.userId, params.userId),
					eq(projects.id, conversationRow.projectId),
				),
			)
			.limit(1),
		db
			.select({
				conversationId: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, params.userId),
					eq(conversations.projectId, conversationRow.projectId),
					ne(conversations.id, params.conversationId),
				),
			)
			.orderBy(desc(conversations.updatedAt), asc(conversations.id))
			.limit(candidateLimit),
	]);

	if (siblingRows.length === 0) return null;

	const siblingConversationIds = siblingRows.map((row) => row.conversationId);
	const taskRows = await db
		.select({
			taskId: conversationTaskStates.taskId,
			conversationId: conversationTaskStates.conversationId,
			objective: conversationTaskStates.objective,
			updatedAt: conversationTaskStates.updatedAt,
		})
		.from(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, params.userId),
				inArray(conversationTaskStates.conversationId, siblingConversationIds),
			),
		)
		.orderBy(
			desc(conversationTaskStates.updatedAt),
			asc(conversationTaskStates.taskId),
		);

	const taskByConversation = new Map<
		string,
		{ taskId: string; objective: string }
	>();
	for (const row of taskRows) {
		if (taskByConversation.has(row.conversationId)) continue;
		if (isPlaceholderObjective(row.objective)) continue;
		taskByConversation.set(row.conversationId, {
			taskId: row.taskId,
			objective: row.objective,
		});
	}

	const selectedTaskIds = Array.from(
		new Set(Array.from(taskByConversation.values()).map((task) => task.taskId)),
	);
	const checkpointRows =
		selectedTaskIds.length > 0
			? await db
					.select({
						taskId: taskCheckpoints.taskId,
						content: taskCheckpoints.content,
						checkpointType: taskCheckpoints.checkpointType,
						updatedAt: taskCheckpoints.updatedAt,
					})
					.from(taskCheckpoints)
					.where(
						and(
							eq(taskCheckpoints.userId, params.userId),
							inArray(taskCheckpoints.taskId, selectedTaskIds),
						),
					)
					.orderBy(desc(taskCheckpoints.updatedAt))
			: [];

	const latestCheckpointByTask = new Map<string, string>();
	const latestStableCheckpointByTask = new Map<string, string>();
	for (const row of checkpointRows) {
		if (!latestCheckpointByTask.has(row.taskId)) {
			latestCheckpointByTask.set(row.taskId, row.content);
		}
		if (
			row.checkpointType === "stable" &&
			!latestStableCheckpointByTask.has(row.taskId)
		) {
			latestStableCheckpointByTask.set(row.taskId, row.content);
		}
	}

	const ranked = siblingRows
		.map((row) => {
			const task = taskByConversation.get(row.conversationId) ?? null;
			const summary = task
				? (latestStableCheckpointByTask.get(task.taskId) ??
					latestCheckpointByTask.get(task.taskId) ??
					task.objective)
				: null;
			const scored = scoreSiblingPromotionCandidate({
				queryTerms,
				title: row.title,
				objective: task?.objective ?? null,
				summary,
			});
			return {
				conversationId: row.conversationId,
				title: row.title,
				updatedAt:
					row.updatedAt instanceof Date
						? row.updatedAt.getTime()
						: Number(row.updatedAt ?? 0),
				objective: task?.objective ?? null,
				summary,
				score: scored.score,
				matchedTerms: scored.matchedTerms,
			};
		})
		.filter(
			(candidate) =>
				candidate.score >= PROJECT_FOLDER_SIBLING_MIN_SCORE &&
				candidate.matchedTerms.length >=
					PROJECT_FOLDER_SIBLING_MIN_MATCHED_TERMS,
		)
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.updatedAt - left.updatedAt ||
				left.conversationId.localeCompare(right.conversationId),
		);

	const winner = ranked[0];
	if (!winner) return null;

	repairConversationMessageSequences(winner.conversationId);

	const [messageCountRows, messageRows] = await Promise.all([
		db
			.select({ messageCount: count() })
			.from(messages)
			.where(eq(messages.conversationId, winner.conversationId)),
		db
			.select({
				role: messages.role,
				content: messages.content,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(eq(messages.conversationId, winner.conversationId))
			.orderBy(...messageOrderDesc())
			.limit(messageLimit),
	]);

	const selectedMessages = messageRows
		.filter((row) => row.role === "user" || row.role === "assistant")
		.map((row) => ({
			role: row.role as "user" | "assistant",
			content: clipRequired(row.content, PROJECT_FOLDER_SIBLING_MESSAGE_MAX),
			createdAt:
				row.createdAt instanceof Date
					? row.createdAt.getTime()
					: Number(row.createdAt ?? 0),
		}))
		.sort((left, right) => left.createdAt - right.createdAt);

	const messageCount =
		messageCountRows[0]?.messageCount ?? selectedMessages.length;

	return {
		projectId: conversationRow.projectId,
		projectName: projectRow[0]?.name ?? "Project folder",
		conversationId: winner.conversationId,
		title: clipRequired(winner.title, PROJECT_FOLDER_SIBLING_TITLE_MAX),
		objective: clipNullable(
			winner.objective,
			PROJECT_FOLDER_SIBLING_OBJECTIVE_MAX,
		),
		summary: clipNullable(winner.summary, PROJECT_FOLDER_SIBLING_SUMMARY_MAX),
		score: winner.score,
		matchedTerms: winner.matchedTerms,
		messages: selectedMessages,
		omittedMessageCount: Math.max(0, messageCount - selectedMessages.length),
	};
}

export async function listTaskMemoryItems(
	userId: string,
): Promise<TaskMemoryItem[]> {
	const rows = await db
		.select({
			task: conversationTaskStates,
			conversationTitle: conversations.title,
		})
		.from(conversationTaskStates)
		.leftJoin(
			conversations,
			eq(conversationTaskStates.conversationId, conversations.id),
		)
		.where(eq(conversationTaskStates.userId, userId))
		.orderBy(desc(conversationTaskStates.updatedAt));

	if (rows.length === 0) {
		return [];
	}

	const taskIds = rows.map((row) => row.task.taskId);
	const checkpointRows = await db
		.select()
		.from(taskCheckpoints)
		.where(
			and(
				eq(taskCheckpoints.userId, userId),
				inArray(taskCheckpoints.taskId, taskIds),
			),
		)
		.orderBy(desc(taskCheckpoints.updatedAt));

	const latestCheckpointByTask = new Map<string, TaskCheckpoint>();
	const latestStableCheckpointByTask = new Map<string, TaskCheckpoint>();

	for (const row of checkpointRows) {
		const checkpoint = mapTaskCheckpoint(row);
		if (!latestCheckpointByTask.has(checkpoint.taskId)) {
			latestCheckpointByTask.set(checkpoint.taskId, checkpoint);
		}
		if (
			checkpoint.checkpointType === "stable" &&
			!latestStableCheckpointByTask.has(checkpoint.taskId)
		) {
			latestStableCheckpointByTask.set(checkpoint.taskId, checkpoint);
		}
	}

	return rows.map((row) => {
		const task = mapTaskState(row.task);
		const checkpoint =
			latestStableCheckpointByTask.get(task.taskId) ??
			latestCheckpointByTask.get(task.taskId) ??
			null;

		return {
			taskId: task.taskId,
			conversationId: task.conversationId,
			conversationTitle: row.conversationTitle ?? null,
			objective: task.objective,
			status: task.status,
			locked: task.locked,
			updatedAt: task.updatedAt,
			lastCheckpointAt: task.lastCheckpointAt,
			checkpointSummary: checkpoint
				? clipRequired(checkpoint.content, 240)
				: null,
		};
	});
}

export async function countTaskMemoryItems(userId: string): Promise<number> {
	const [row] = await db
		.select({ itemCount: count() })
		.from(conversationTaskStates)
		.where(eq(conversationTaskStates.userId, userId));

	return row?.itemCount ?? 0;
}

export async function forgetTaskMemory(
	userId: string,
	taskId: string,
): Promise<boolean> {
	const [existing] = await db
		.select({ taskId: conversationTaskStates.taskId })
		.from(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.taskId, taskId),
			),
		)
		.limit(1);
	if (!existing) return false;

	await db
		.delete(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.taskId, taskId),
			),
		);

	await db
		.delete(memoryEvents)
		.where(
			and(
				eq(memoryEvents.userId, userId),
				eq(memoryEvents.domain, "task"),
				eq(memoryEvents.relatedId, taskId),
			),
		);

	return true;
}

// Folder-anchored continuity retired the inferred continuity summary, so there
// is no longer anything to attach — this remains a stable passthrough seam so
// callers keep a single, uniform post-routing hook.
export async function attachContinuityToTaskState<T extends TaskState | null>(
	_userId: string,
	taskState: T,
): Promise<T> {
	return taskState;
}
