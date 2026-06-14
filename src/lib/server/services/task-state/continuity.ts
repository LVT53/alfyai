import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversationSummaries,
	conversations,
	conversationTaskStates,
	memoryEvents,
	memoryProjects,
	memoryProjectTaskLinks,
	messages,
	projects,
	taskCheckpoints,
} from "$lib/server/db/schema";
import {
	listLatestMemoryEventsBySubject,
	listMemoryEvents,
	recordMemoryEvent,
} from "$lib/server/services/memory-events";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { scoreMatch } from "$lib/server/services/working-set";
import { DAY_MS, RERANK_CONFIDENCE_MIN } from "$lib/server/utils/constants";
import { parseJsonStringArray } from "$lib/server/utils/json";
import { clipNullableText, normalizeWhitespace } from "$lib/server/utils/text";
import type {
	FocusContinuityItem,
	FocusContinuityStatus,
	MemoryEventType,
	TaskCheckpoint,
	TaskContinuitySummary,
	TaskMemoryItem,
	TaskState,
} from "$lib/types";
import {
	canUseContextSummarizer,
	requestStructuredControlModel,
} from "./control-model";
import { mapTaskCheckpoint, mapTaskState } from "./mappers";

const PROJECT_MATCH_MIN_SCORE = 16;
const PROJECT_AMBIGUITY_GAP = 6;
const PROJECT_NAME_MAX = 120;
const PROJECT_SUMMARY_MAX = 360;
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
const PROJECT_PAUSE_SIGNAL_PATTERN =
	/\b(pause|put (?:it|this|that)? ?on hold|hold off on|park|set aside|deprioriti[sz]e|stop working on|not working on)\b/i;
const PROJECT_RESUME_SIGNAL_PATTERN =
	/\b(resume|continue|pick (?:it|this|that)? back up|restart|return to|get back to)\b/i;
const PROJECT_STATE_EVENT_TYPES: Array<
	Extract<
		MemoryEventType,
		"project_started" | "project_paused" | "project_resumed"
	>
> = ["project_started", "project_paused", "project_resumed"];

export type ProjectStateEventType = (typeof PROJECT_STATE_EVENT_TYPES)[number];

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

export type ProjectContinuityReferenceContext =
	ProjectFolderReferenceContext & {
		source: "project_continuity";
	};

export type ProjectReferenceContext =
	| (ProjectFolderReferenceContext & { source: "project_folder" })
	| ProjectContinuityReferenceContext;

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

function projectStatusForLastActive(
	lastActiveAt: number | null,
	now = Date.now(),
): FocusContinuityStatus {
	if (!lastActiveAt) return "archived";
	const ageDays = Math.floor((now - lastActiveAt) / DAY_MS);
	if (ageDays >= 45) return "archived";
	if (ageDays >= 14) return "dormant";
	return "active";
}

export function resolveProjectContinuityStatus(params: {
	storedStatus: FocusContinuityStatus;
	lastActiveAt: number | null;
	latestEventType?: ProjectStateEventType | null;
	now?: number;
}): FocusContinuityStatus {
	const ageDerivedStatus = projectStatusForLastActive(
		params.lastActiveAt,
		params.now,
	);
	if (params.latestEventType === "project_paused") {
		return ageDerivedStatus === "archived" ? "archived" : "dormant";
	}
	if (
		params.latestEventType === "project_started" ||
		params.latestEventType === "project_resumed"
	) {
		return ageDerivedStatus;
	}
	if (params.storedStatus === "active" && ageDerivedStatus !== "active") {
		return ageDerivedStatus;
	}
	return params.storedStatus;
}

export function detectProjectContinuitySignal(
	message: string | null | undefined,
): ProjectStateEventType | null {
	const normalized = normalizeWhitespace(message ?? "");
	if (!normalized) return null;
	if (PROJECT_PAUSE_SIGNAL_PATTERN.test(normalized)) return "project_paused";
	if (PROJECT_RESUME_SIGNAL_PATTERN.test(normalized)) return "project_resumed";
	return null;
}

type ProjectCandidate = {
	projectId: string;
	name: string;
	summary: string | null;
	status: FocusContinuityStatus;
	lastActiveAt: number | null;
	artifactIds: string[];
	score: number;
};

async function listProjectCandidates(
	userId: string,
): Promise<ProjectCandidate[]> {
	const rows = await db
		.select({
			project: memoryProjects,
			task: conversationTaskStates,
		})
		.from(memoryProjects)
		.leftJoin(
			memoryProjectTaskLinks,
			eq(memoryProjects.projectId, memoryProjectTaskLinks.projectId),
		)
		.leftJoin(
			conversationTaskStates,
			eq(memoryProjectTaskLinks.taskId, conversationTaskStates.taskId),
		)
		.where(eq(memoryProjects.userId, userId))
		.orderBy(desc(memoryProjects.updatedAt));

	const grouped = new Map<string, ProjectCandidate>();
	for (const row of rows) {
		const projectId = row.project.projectId;
		const existing = grouped.get(projectId) ?? {
			projectId,
			name: row.project.name,
			summary: row.project.summary ?? null,
			status: row.project.status as FocusContinuityStatus,
			lastActiveAt: row.project.lastActiveAt
				? row.project.lastActiveAt.getTime()
				: null,
			artifactIds: [],
			score: 0,
		};
		if (row.task?.activeArtifactIdsJson) {
			existing.artifactIds.push(
				...parseJsonStringArray(row.task.activeArtifactIdsJson),
			);
		}
		grouped.set(projectId, existing);
	}

	const latestStateEvents = await listLatestMemoryEventsBySubject({
		userId,
		domain: "task",
		eventTypes: PROJECT_STATE_EVENT_TYPES,
		subjectIds: Array.from(grouped.keys()),
	}).catch(() => new Map<string, { eventType: ProjectStateEventType }>());

	return Array.from(grouped.values()).map((project) => {
		const latestEvent = latestStateEvents.get(project.projectId);
		return {
			...project,
			status: resolveProjectContinuityStatus({
				storedStatus: project.status,
				lastActiveAt: project.lastActiveAt,
				latestEventType:
					(latestEvent?.eventType as ProjectStateEventType | undefined) ?? null,
			}),
			artifactIds: Array.from(new Set(project.artifactIds)),
		};
	});
}

async function chooseProjectCandidate(params: {
	userId: string;
	taskState: TaskState;
	projectCandidates: ProjectCandidate[];
}): Promise<ProjectCandidate | null> {
	if (params.projectCandidates.length === 0) return null;

	const ranked = params.projectCandidates
		.map((candidate) => {
			const textScore =
				scoreMatch(
					params.taskState.objective,
					`${candidate.name}\n${candidate.summary ?? ""}`,
				) * 10;
			const artifactScore =
				overlapScore(
					params.taskState.activeArtifactIds,
					candidate.artifactIds,
				) * 18;
			const statusScore =
				candidate.status === "active"
					? 3
					: candidate.status === "dormant"
						? 1
						: 0;
			return {
				...candidate,
				score: textScore + artifactScore + statusScore,
			};
		})
		.sort((left, right) => right.score - left.score);

	const best = ranked[0];
	if (!best || best.score < PROJECT_MATCH_MIN_SCORE) return null;
	const second = ranked[1];
	if (!second || best.score - second.score >= PROJECT_AMBIGUITY_GAP) {
		return best;
	}

	if (!canUseContextSummarizer()) return best;

	type ProjectRoutePayload = {
		projectId?: string;
		confidence?: number;
	};

	try {
		const routed = await requestStructuredControlModel<ProjectRoutePayload>({
			system:
				"Select the best long-term project bucket for the current task. Return strict JSON with projectId and confidence. Prefer continuity only when the task clearly matches an existing project.",
			user: [
				`Current task objective: ${params.taskState.objective}`,
				params.taskState.nextSteps.length > 0
					? `Next steps: ${params.taskState.nextSteps.join(" | ")}`
					: null,
				params.taskState.factsToPreserve.length > 0
					? `Facts: ${params.taskState.factsToPreserve.join(" | ")}`
					: null,
				`Candidate projects: ${JSON.stringify(
					ranked.slice(0, 5).map((candidate) => ({
						projectId: candidate.projectId,
						name: candidate.name,
						summary: candidate.summary,
						score: candidate.score,
					})),
					null,
					2,
				)}`,
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n"),
			maxTokens: 220,
			temperature: 0.0,
		});

		if (
			routed &&
			typeof routed.confidence === "number" &&
			routed.confidence >= RERANK_CONFIDENCE_MIN &&
			typeof routed.projectId === "string"
		) {
			return (
				ranked.find((candidate) => candidate.projectId === routed.projectId) ??
				best
			);
		}
	} catch (error) {
		console.error("[PROJECT_MEMORY] Project router failed:", error);
	}

	return best;
}

async function getLatestStableCheckpoint(
	taskId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ content: taskCheckpoints.content })
		.from(taskCheckpoints)
		.where(
			and(
				eq(taskCheckpoints.taskId, taskId),
				eq(taskCheckpoints.checkpointType, "stable"),
			),
		)
		.orderBy(desc(taskCheckpoints.updatedAt))
		.limit(1);

	return row?.content ?? null;
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

async function getProjectContinuityReferenceContext(params: {
	userId: string;
	conversationId: string;
}): Promise<ProjectContinuityReferenceContext | null> {
	const [currentLink] = await db
		.select({
			projectId: memoryProjectTaskLinks.projectId,
			updatedAt: memoryProjectTaskLinks.updatedAt,
		})
		.from(memoryProjectTaskLinks)
		.where(
			and(
				eq(memoryProjectTaskLinks.userId, params.userId),
				eq(memoryProjectTaskLinks.conversationId, params.conversationId),
			),
		)
		.orderBy(desc(memoryProjectTaskLinks.updatedAt))
		.limit(1);

	if (!currentLink?.projectId) return null;

	const [projectRow] = await db
		.select({
			name: memoryProjects.name,
		})
		.from(memoryProjects)
		.where(
			and(
				eq(memoryProjects.userId, params.userId),
				eq(memoryProjects.projectId, currentLink.projectId),
			),
		)
		.limit(1);

	if (!projectRow) return null;

	const continuityWhere = and(
		eq(memoryProjectTaskLinks.userId, params.userId),
		eq(memoryProjectTaskLinks.projectId, currentLink.projectId),
		ne(memoryProjectTaskLinks.conversationId, params.conversationId),
	);
	const [linkedCountRows, linkedRows] = await Promise.all([
		db
			.select({ siblingCount: count() })
			.from(memoryProjectTaskLinks)
			.where(continuityWhere),
		db
			.select({
				conversationId: memoryProjectTaskLinks.conversationId,
				taskId: memoryProjectTaskLinks.taskId,
				updatedAt: memoryProjectTaskLinks.updatedAt,
			})
			.from(memoryProjectTaskLinks)
			.where(continuityWhere)
			.orderBy(
				desc(memoryProjectTaskLinks.updatedAt),
				asc(memoryProjectTaskLinks.taskId),
			)
			.limit(PROJECT_FOLDER_AWARENESS_LIMIT),
	]);

	if (linkedRows.length === 0) return null;

	const siblingConversationIds = linkedRows.map((row) => row.conversationId);
	const selectedTaskIds = linkedRows.map((row) => row.taskId);
	const [siblingRows, taskRows] = await Promise.all([
		db
			.select({
				conversationId: conversations.id,
				title: conversations.title,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, params.userId),
					inArray(conversations.id, siblingConversationIds),
				),
			),
		db
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
					inArray(conversationTaskStates.taskId, selectedTaskIds),
				),
			)
			.orderBy(
				desc(conversationTaskStates.updatedAt),
				asc(conversationTaskStates.taskId),
			),
	]);

	const conversationById = new Map(
		siblingRows.map((row) => [
			row.conversationId,
			{
				title: row.title,
			},
		]),
	);
	const taskById = new Map<
		string,
		{ taskId: string; conversationId: string; objective: string }
	>();
	for (const row of taskRows) {
		if (isPlaceholderObjective(row.objective)) continue;
		taskById.set(row.taskId, {
			taskId: row.taskId,
			conversationId: row.conversationId,
			objective: clipRequired(
				row.objective,
				PROJECT_FOLDER_AWARENESS_OBJECTIVE_MAX,
			),
		});
	}

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

	const entries: ProjectFolderReferenceEntry[] = [];
	const seenConversationIds = new Set<string>();
	for (const row of linkedRows) {
		if (seenConversationIds.has(row.conversationId)) continue;
		const conversation = conversationById.get(row.conversationId);
		if (!conversation) continue;
		const task = taskById.get(row.taskId) ?? null;
		const summary =
			summaryByConversation.get(row.conversationId) ??
			(task
				? (latestStableCheckpointByTask.get(task.taskId) ??
					latestCheckpointByTask.get(task.taskId) ??
					task.objective)
				: null);
		entries.push({
			conversationId: row.conversationId,
			title: clipRequired(
				conversation.title,
				PROJECT_FOLDER_AWARENESS_TITLE_MAX,
			),
			objective: task?.objective ?? null,
			summary: clipNullable(summary, PROJECT_FOLDER_AWARENESS_SUMMARY_MAX),
		});
		seenConversationIds.add(row.conversationId);
	}

	if (entries.length === 0) return null;
	const siblingCount = linkedCountRows[0]?.siblingCount ?? linkedRows.length;

	return {
		source: "project_continuity",
		projectId: currentLink.projectId,
		projectName: projectRow.name,
		entries,
		omittedSiblingCount: Math.max(0, siblingCount - entries.length),
	};
}

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

	if (!conversationRow) return null;
	if (conversationRow.projectId) {
		const folderContext = await getProjectFolderReferenceContext(params);
		return folderContext
			? { ...folderContext, source: "project_folder" }
			: null;
	}

	return getProjectContinuityReferenceContext(params);
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

function buildProjectEventKey(parts: Array<string | number>): string {
	return parts.join(":");
}

function hashProjectSignalMessage(message: string): string {
	return createHash("sha1")
		.update(normalizeWhitespace(message).toLowerCase())
		.digest("hex")
		.slice(0, 12);
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

export async function syncTaskContinuityFromTaskState(params: {
	userId: string;
	taskState: TaskState;
}): Promise<string | null> {
	if (isPlaceholderObjective(params.taskState.objective)) return null;

	const [conversationRow] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, params.userId),
				eq(conversations.id, params.taskState.conversationId),
			),
		)
		.limit(1);

	if (conversationRow?.projectId) {
		const folderContinuityId =
			await convergeProjectFolderContinuityForTaskState({
				userId: params.userId,
				projectId: conversationRow.projectId,
				taskState: params.taskState,
			});
		if (folderContinuityId) return folderContinuityId;
	}

	const [existingLink, checkpointContent, candidates] = await Promise.all([
		db
			.select({ projectId: memoryProjectTaskLinks.projectId })
			.from(memoryProjectTaskLinks)
			.where(
				and(
					eq(memoryProjectTaskLinks.userId, params.userId),
					eq(memoryProjectTaskLinks.taskId, params.taskState.taskId),
				),
			)
			.limit(1),
		getLatestStableCheckpoint(params.taskState.taskId),
		listProjectCandidates(params.userId),
	]);

	const summary =
		clipNullable(checkpointContent, PROJECT_SUMMARY_MAX) ??
		clipNullable(params.taskState.nextSteps.join(" "), PROJECT_SUMMARY_MAX) ??
		clipNullable(params.taskState.objective, PROJECT_SUMMARY_MAX) ??
		params.taskState.objective;

	let projectId: string | null = existingLink[0]?.projectId ?? null;
	if (!projectId) {
		const chosen = await chooseProjectCandidate({
			userId: params.userId,
			taskState: params.taskState,
			projectCandidates: candidates,
		});
		projectId = chosen?.projectId ?? null;
	}

	const now = new Date();
	const previousProject = projectId
		? (candidates.find((candidate) => candidate.projectId === projectId) ??
			null)
		: null;
	let continuityEvent: {
		eventType: "project_started" | "project_resumed";
		eventKey: string;
	} | null = null;

	if (!projectId) {
		projectId = randomUUID();
		await db.insert(memoryProjects).values({
			projectId,
			userId: params.userId,
			name: clipRequired(params.taskState.objective, PROJECT_NAME_MAX),
			summary,
			status: "active",
			lastActiveAt: now,
			updatedAt: now,
		});
		continuityEvent = {
			eventType: "project_started",
			eventKey: buildProjectEventKey([
				"project_started",
				projectId,
				params.taskState.taskId,
			]),
		};
	} else {
		await db
			.update(memoryProjects)
			.set({
				name: clipRequired(params.taskState.objective, PROJECT_NAME_MAX),
				summary,
				status: "active",
				lastActiveAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProjects.userId, params.userId),
					eq(memoryProjects.projectId, projectId),
				),
			);
		if (previousProject && previousProject.status !== "active") {
			continuityEvent = {
				eventType: "project_resumed",
				eventKey: buildProjectEventKey([
					"project_resumed",
					projectId,
					params.taskState.taskId,
					now.getTime(),
				]),
			};
		}
	}

	await db
		.insert(memoryProjectTaskLinks)
		.values({
			id: randomUUID(),
			projectId,
			taskId: params.taskState.taskId,
			userId: params.userId,
			conversationId: params.taskState.conversationId,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: memoryProjectTaskLinks.taskId,
			set: {
				projectId,
				conversationId: params.taskState.conversationId,
				updatedAt: now,
			},
		});

	await db
		.update(conversations)
		.set({
			updatedAt: now,
		})
		.where(eq(conversations.id, params.taskState.conversationId));

	if (continuityEvent) {
		await recordMemoryEvent({
			eventKey: continuityEvent.eventKey,
			userId: params.userId,
			conversationId: params.taskState.conversationId,
			domain: "task",
			eventType: continuityEvent.eventType,
			subjectId: projectId,
			relatedId: params.taskState.taskId,
			observedAt: now,
			payload: {
				projectId,
				taskId: params.taskState.taskId,
				objective: params.taskState.objective,
				status: "active",
			},
		}).catch((error) =>
			console.error(
				"[PROJECT_MEMORY] Failed to record continuity event:",
				error,
			),
		);
	}

	return projectId;
}

async function convergeProjectFolderContinuityForTaskState(params: {
	userId: string;
	projectId: string;
	taskState: TaskState;
}): Promise<string | null> {
	if (isPlaceholderObjective(params.taskState.objective)) return null;

	const [projectFolder] = await db
		.select({
			id: projects.id,
			name: projects.name,
			canonicalMemoryProjectId: projects.canonicalMemoryProjectId,
		})
		.from(projects)
		.where(
			and(
				eq(projects.userId, params.userId),
				eq(projects.id, params.projectId),
			),
		)
		.limit(1);
	if (!projectFolder) return null;

	const now = new Date();
	const checkpointContent = await getLatestStableCheckpoint(
		params.taskState.taskId,
	);
	const summary =
		clipNullable(checkpointContent, PROJECT_SUMMARY_MAX) ??
		clipNullable(params.taskState.nextSteps.join(" "), PROJECT_SUMMARY_MAX) ??
		clipNullable(params.taskState.objective, PROJECT_SUMMARY_MAX) ??
		params.taskState.objective;
	let reusableProjectId: string | null = null;
	if (!projectFolder.canonicalMemoryProjectId) {
		const [existingLink] = await db
			.select({ projectId: memoryProjectTaskLinks.projectId })
			.from(memoryProjectTaskLinks)
			.where(
				and(
					eq(memoryProjectTaskLinks.userId, params.userId),
					eq(memoryProjectTaskLinks.taskId, params.taskState.taskId),
				),
			)
			.limit(1);
		reusableProjectId = existingLink?.projectId ?? null;

		if (reusableProjectId) {
			const [canonicalOwner] = await db
				.select({ id: projects.id })
				.from(projects)
				.where(
					and(
						eq(projects.userId, params.userId),
						eq(projects.canonicalMemoryProjectId, reusableProjectId),
					),
				)
				.limit(1);
			if (canonicalOwner && canonicalOwner.id !== projectFolder.id) {
				reusableProjectId = null;
			}
		}
	}

	const projectId =
		projectFolder.canonicalMemoryProjectId ?? reusableProjectId ?? randomUUID();
	const shouldCreateMemoryProject =
		!projectFolder.canonicalMemoryProjectId && !reusableProjectId;

	if (shouldCreateMemoryProject) {
		await db.insert(memoryProjects).values({
			projectId,
			userId: params.userId,
			name: clipRequired(projectFolder.name, PROJECT_NAME_MAX),
			summary,
			status: "active",
			lastActiveAt: now,
			updatedAt: now,
		});
	} else {
		await db
			.update(memoryProjects)
			.set({
				name: clipRequired(projectFolder.name, PROJECT_NAME_MAX),
				summary,
				status: "active",
				lastActiveAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProjects.userId, params.userId),
					eq(memoryProjects.projectId, projectId),
				),
			);
	}

	if (!projectFolder.canonicalMemoryProjectId) {
		await db
			.update(projects)
			.set({
				canonicalMemoryProjectId: projectId,
				updatedAt: now,
			})
			.where(
				and(
					eq(projects.userId, params.userId),
					eq(projects.id, projectFolder.id),
				),
			);
	}

	await db
		.insert(memoryProjectTaskLinks)
		.values({
			id: randomUUID(),
			projectId,
			taskId: params.taskState.taskId,
			userId: params.userId,
			conversationId: params.taskState.conversationId,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: memoryProjectTaskLinks.taskId,
			set: {
				projectId,
				conversationId: params.taskState.conversationId,
				updatedAt: now,
			},
		});

	return projectId;
}

export async function convergeProjectFolderContinuityForConversation(params: {
	userId: string;
	conversationId: string;
	projectId: string | null;
	previousProjectId?: string | null;
}): Promise<string | null> {
	if (
		params.previousProjectId &&
		params.previousProjectId !== params.projectId
	) {
		const [previousProjectFolder] = await db
			.select({ canonicalMemoryProjectId: projects.canonicalMemoryProjectId })
			.from(projects)
			.where(
				and(
					eq(projects.userId, params.userId),
					eq(projects.id, params.previousProjectId),
				),
			)
			.limit(1);

		if (previousProjectFolder?.canonicalMemoryProjectId) {
			await db
				.delete(memoryProjectTaskLinks)
				.where(
					and(
						eq(memoryProjectTaskLinks.userId, params.userId),
						eq(memoryProjectTaskLinks.conversationId, params.conversationId),
						eq(
							memoryProjectTaskLinks.projectId,
							previousProjectFolder.canonicalMemoryProjectId,
						),
					),
				);
		}
	}

	if (!params.projectId) return null;

	const [projectFolderRows, taskRows] = await Promise.all([
		db
			.select({
				id: projects.id,
				name: projects.name,
				canonicalMemoryProjectId: projects.canonicalMemoryProjectId,
			})
			.from(projects)
			.where(
				and(
					eq(projects.userId, params.userId),
					eq(projects.id, params.projectId),
				),
			)
			.limit(1),
		db
			.select()
			.from(conversationTaskStates)
			.where(
				and(
					eq(conversationTaskStates.userId, params.userId),
					eq(conversationTaskStates.conversationId, params.conversationId),
				),
			)
			.orderBy(desc(conversationTaskStates.updatedAt))
			.limit(1),
	]);

	const projectFolder = projectFolderRows[0] ?? null;
	const taskRow = taskRows[0] ?? null;
	const taskState = taskRow ? mapTaskState(taskRow) : null;
	if (
		!projectFolder ||
		!taskState ||
		isPlaceholderObjective(taskState.objective)
	) {
		return null;
	}
	return convergeProjectFolderContinuityForTaskState({
		userId: params.userId,
		projectId: projectFolder.id,
		taskState,
	});
}

export async function listFocusContinuityItems(
	userId: string,
): Promise<FocusContinuityItem[]> {
	const rows = await db
		.select({
			project: memoryProjects,
			link: memoryProjectTaskLinks,
			conversationTitle: conversations.title,
		})
		.from(memoryProjects)
		.leftJoin(
			memoryProjectTaskLinks,
			eq(memoryProjects.projectId, memoryProjectTaskLinks.projectId),
		)
		.leftJoin(
			conversations,
			eq(memoryProjectTaskLinks.conversationId, conversations.id),
		)
		.where(eq(memoryProjects.userId, userId))
		.orderBy(desc(memoryProjects.updatedAt));

	if (rows.length === 0) return [];

	const latestStateEvents = await listLatestMemoryEventsBySubject({
		userId,
		domain: "task",
		eventTypes: PROJECT_STATE_EVENT_TYPES,
		subjectIds: Array.from(new Set(rows.map((row) => row.project.projectId))),
	}).catch(() => new Map<string, { eventType: ProjectStateEventType }>());

	const grouped = new Map<string, FocusContinuityItem>();
	for (const row of rows) {
		const latestEvent = latestStateEvents.get(row.project.projectId);
		const existing = grouped.get(row.project.projectId) ?? {
			continuityId: row.project.projectId,
			name: row.project.name,
			summary: row.project.summary ?? null,
			status: resolveProjectContinuityStatus({
				storedStatus: row.project.status as FocusContinuityStatus,
				lastActiveAt: row.project.lastActiveAt
					? row.project.lastActiveAt.getTime()
					: null,
				latestEventType:
					(latestEvent?.eventType as ProjectStateEventType | undefined) ?? null,
			}),
			lastActiveAt: row.project.lastActiveAt
				? row.project.lastActiveAt.getTime()
				: null,
			updatedAt: row.project.updatedAt.getTime(),
			linkedTaskCount: 0,
			conversationTitles: [],
		};
		if (row.link?.taskId) {
			existing.linkedTaskCount += 1;
		}
		if (
			row.conversationTitle &&
			!existing.conversationTitles.includes(row.conversationTitle)
		) {
			existing.conversationTitles.push(row.conversationTitle);
		}
		grouped.set(row.project.projectId, existing);
	}

	return Array.from(grouped.values()).map((item) => ({
		...item,
		conversationTitles: item.conversationTitles.slice(0, 3),
	}));
}

async function getContinuitySummaryForTask(params: {
	userId: string;
	conversationId: string;
	taskId?: string | null;
}): Promise<TaskContinuitySummary | null> {
	let taskId = params.taskId ?? null;

	if (!taskId) {
		const [taskRow] = await db
			.select({ taskId: conversationTaskStates.taskId })
			.from(conversationTaskStates)
			.where(
				and(
					eq(conversationTaskStates.userId, params.userId),
					eq(conversationTaskStates.conversationId, params.conversationId),
				),
			)
			.orderBy(desc(conversationTaskStates.updatedAt))
			.limit(1);
		taskId = taskRow?.taskId ?? null;
	}

	if (!taskId) return null;

	const [projectRow, linkedCountRow] = await Promise.all([
		db
			.select({
				projectId: memoryProjects.projectId,
				name: memoryProjects.name,
				summary: memoryProjects.summary,
				status: memoryProjects.status,
				lastActiveAt: memoryProjects.lastActiveAt,
				updatedAt: memoryProjects.updatedAt,
			})
			.from(memoryProjectTaskLinks)
			.innerJoin(
				memoryProjects,
				eq(memoryProjectTaskLinks.projectId, memoryProjects.projectId),
			)
			.where(
				and(
					eq(memoryProjectTaskLinks.userId, params.userId),
					eq(memoryProjectTaskLinks.taskId, taskId),
				),
			)
			.limit(1),
		db
			.select({
				projectId: memoryProjectTaskLinks.projectId,
				taskId: memoryProjectTaskLinks.taskId,
			})
			.from(memoryProjectTaskLinks)
			.where(eq(memoryProjectTaskLinks.userId, params.userId)),
	]);

	const project = projectRow[0];
	if (!project) return null;

	const latestStateEvents = await listLatestMemoryEventsBySubject({
		userId: params.userId,
		domain: "task",
		eventTypes: PROJECT_STATE_EVENT_TYPES,
		subjectIds: [project.projectId],
	}).catch(() => new Map<string, { eventType: ProjectStateEventType }>());
	const latestEvent = latestStateEvents.get(project.projectId);

	const linkedTaskCount = linkedCountRow.filter(
		(row) => row.projectId === project.projectId,
	).length;

	return {
		continuityId: project.projectId,
		name: project.name,
		summary: project.summary ?? null,
		status: resolveProjectContinuityStatus({
			storedStatus: project.status as FocusContinuityStatus,
			lastActiveAt: project.lastActiveAt
				? project.lastActiveAt.getTime()
				: null,
			latestEventType:
				(latestEvent?.eventType as ProjectStateEventType | undefined) ?? null,
		}),
		linkedTaskCount,
		lastActiveAt: project.lastActiveAt ? project.lastActiveAt.getTime() : null,
		updatedAt: project.updatedAt.getTime(),
	};
}

export async function getTaskContinuitySummary(params: {
	userId: string;
	conversationId: string;
	taskId?: string | null;
}): Promise<TaskContinuitySummary | null> {
	return getContinuitySummaryForTask(params);
}

export async function attachContinuityToTaskState<T extends TaskState | null>(
	userId: string,
	taskState: T,
): Promise<T> {
	if (!taskState) {
		return taskState;
	}

	const continuity = await getTaskContinuitySummary({
		userId,
		conversationId: taskState.conversationId,
		taskId: taskState.taskId,
	}).catch(() => null);

	return {
		...taskState,
		continuity,
	} as T;
}

export async function forgetFocusContinuity(
	userId: string,
	continuityId: string,
): Promise<boolean> {
	const [existing] = await db
		.select({ projectId: memoryProjects.projectId })
		.from(memoryProjects)
		.where(
			and(
				eq(memoryProjects.userId, userId),
				eq(memoryProjects.projectId, continuityId),
			),
		)
		.limit(1);

	if (!existing) return false;

	await db
		.delete(memoryProjects)
		.where(
			and(
				eq(memoryProjects.userId, userId),
				eq(memoryProjects.projectId, continuityId),
			),
		);

	await db
		.delete(memoryEvents)
		.where(
			and(
				eq(memoryEvents.userId, userId),
				eq(memoryEvents.domain, "task"),
				eq(memoryEvents.subjectId, continuityId),
			),
		);

	return true;
}

export async function applyProjectContinuitySignalFromMessage(params: {
	userId: string;
	taskState: TaskState;
	message: string;
}): Promise<string | null> {
	const signal = detectProjectContinuitySignal(params.message);
	if (!signal) return null;

	const rows = await db
		.select({
			projectId: memoryProjects.projectId,
			status: memoryProjects.status,
			lastActiveAt: memoryProjects.lastActiveAt,
		})
		.from(memoryProjectTaskLinks)
		.innerJoin(
			memoryProjects,
			eq(memoryProjectTaskLinks.projectId, memoryProjects.projectId),
		)
		.where(
			and(
				eq(memoryProjectTaskLinks.userId, params.userId),
				eq(memoryProjectTaskLinks.taskId, params.taskState.taskId),
			),
		)
		.limit(1);

	const project = rows[0];
	if (!project?.projectId) return null;

	const latestEvent = (
		await listMemoryEvents({
			userId: params.userId,
			domain: "task",
			eventTypes: PROJECT_STATE_EVENT_TYPES,
			subjectId: project.projectId,
			limit: 1,
		}).catch(() => [])
	)[0];

	if (
		latestEvent?.eventType === signal &&
		((signal === "project_paused" && project.status !== "active") ||
			(signal === "project_resumed" && project.status === "active"))
	) {
		return project.projectId;
	}

	const now = new Date();
	const nextStatus: FocusContinuityStatus =
		signal === "project_paused" ? "dormant" : "active";

	await db
		.update(memoryProjects)
		.set({
			status: nextStatus,
			lastActiveAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(memoryProjects.userId, params.userId),
				eq(memoryProjects.projectId, project.projectId),
			),
		);

	await recordMemoryEvent({
		eventKey: buildProjectEventKey([
			signal,
			project.projectId,
			params.taskState.taskId,
			hashProjectSignalMessage(params.message),
		]),
		userId: params.userId,
		conversationId: params.taskState.conversationId,
		domain: "task",
		eventType: signal,
		subjectId: project.projectId,
		relatedId: params.taskState.taskId,
		observedAt: now,
		payload: {
			projectId: project.projectId,
			taskId: params.taskState.taskId,
			objective: params.taskState.objective,
			message: normalizeWhitespace(params.message),
			status: nextStatus,
			explicitSignal: true,
		},
	}).catch((error) =>
		console.error(
			"[PROJECT_MEMORY] Failed to record project signal event:",
			error,
		),
	);

	return project.projectId;
}

export const syncProjectMemoryFromTaskState = syncTaskContinuityFromTaskState;
export const listProjectMemoryItems = listFocusContinuityItems;
export const forgetProjectMemory = forgetFocusContinuity;

export async function deleteAllProjectMemory(userId: string): Promise<void> {
	await db.delete(memoryProjects).where(eq(memoryProjects.userId, userId));
}

export async function updateProjectMemoryStatuses(
	userId: string,
): Promise<void> {
	const rows = await db
		.select()
		.from(memoryProjects)
		.where(eq(memoryProjects.userId, userId));

	const latestStateEvents = await listLatestMemoryEventsBySubject({
		userId,
		domain: "task",
		eventTypes: PROJECT_STATE_EVENT_TYPES,
		subjectIds: rows.map((row) => row.projectId),
	}).catch(() => new Map<string, { eventType: ProjectStateEventType }>());

	for (const row of rows) {
		const latestEvent = latestStateEvents.get(row.projectId);
		const nextStatus = resolveProjectContinuityStatus({
			storedStatus: row.status as FocusContinuityStatus,
			lastActiveAt: row.lastActiveAt ? row.lastActiveAt.getTime() : null,
			latestEventType:
				(latestEvent?.eventType as ProjectStateEventType | undefined) ?? null,
		});
		if (nextStatus === row.status) continue;
		await db
			.update(memoryProjects)
			.set({
				status: nextStatus,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(memoryProjects.userId, userId),
					eq(memoryProjects.projectId, row.projectId),
				),
			);
		if (
			nextStatus !== "active" &&
			latestEvent?.eventType !== "project_paused"
		) {
			await recordMemoryEvent({
				eventKey: buildProjectEventKey([
					"project_paused",
					row.projectId,
					row.updatedAt.getTime(),
					nextStatus,
				]),
				userId,
				domain: "task",
				eventType: "project_paused",
				subjectId: row.projectId,
				observedAt: new Date(),
				payload: {
					projectId: row.projectId,
					previousStatus: row.status,
					nextStatus,
					projectName: row.name,
				},
			}).catch((error) =>
				console.error("[PROJECT_MEMORY] Failed to record status event:", error),
			);
		}
	}
}

export async function pruneOrphanProjectMemory(userId: string): Promise<void> {
	const rows = await db
		.select({
			projectId: memoryProjects.projectId,
			taskId: memoryProjectTaskLinks.taskId,
		})
		.from(memoryProjects)
		.leftJoin(
			memoryProjectTaskLinks,
			eq(memoryProjects.projectId, memoryProjectTaskLinks.projectId),
		)
		.where(eq(memoryProjects.userId, userId));

	const orphanIds = new Set<string>();
	const linkedIds = new Set<string>();
	for (const row of rows) {
		orphanIds.add(row.projectId);
		if (row.taskId) linkedIds.add(row.projectId);
	}

	const idsToDelete = Array.from(orphanIds).filter(
		(projectId) => !linkedIds.has(projectId),
	);
	if (idsToDelete.length === 0) return;

	await db
		.delete(memoryProjects)
		.where(
			and(
				eq(memoryProjects.userId, userId),
				inArray(memoryProjects.projectId, idsToDelete),
			),
		);
}
