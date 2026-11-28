import { z } from "zod";
import {
	CalDavError,
	caldavListTasks,
} from "$lib/server/services/connections/providers/caldav-tasks";
import {
	matchingConnections,
	resolveConnectionsForCapability,
	selectConnection,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ConnectorReasonCode } from "$lib/shared/tool-reasons";
import { createPendingWrite } from "../connections/pending-writes";
import { ConnectionHttpError } from "../connections/provider-http";
import { googleServiceCanModify } from "../connections/providers/google-service-token";
import {
	googleListTaskLists,
	googleListTasks,
	prepareGoogleTaskWrite,
} from "../connections/providers/google-tasks";
import { idempotencyKey } from "../connections/write-guard";

import { applyLocalDistillGate } from "./connector-distill";
import {
	connectorReasonForAdapterError,
	noMatchingConnectionMessage,
	withReasonCode,
} from "./shared";

export const tasksToolInputSchema = z.object({
	action: z.enum([
		"list_tasks",
		"search_tasks",
		"list_task_lists",
		"create_task",
		"update_task",
		"complete_task",
		"delete_task",
	]),
	query: z.string().optional(),
	due: z.string().nullable().optional(),
	account: z.string().optional(),
	listId: z.string().trim().min(1).optional(),
	taskId: z.string().trim().min(1).optional(),
	title: z.string().trim().min(1).max(1024).optional(),
	notes: z.string().max(8192).optional(),
});

export type TasksToolInput = z.infer<typeof tasksToolInputSchema>;

export function sanitizeTasksToolInput(input: TasksToolInput): TasksToolInput {
	return {
		...input,
		...(input.query !== undefined ? { query: input.query.trim() } : {}),
		...(typeof input.due === "string" ? { due: input.due.trim() } : {}),
		...(input.account !== undefined ? { account: input.account.trim() } : {}),
	};
}

export type TasksCitation = { label: string; url: string };

// One task as surfaced to the model, normalized from a CalDAV VTODO's
// SUMMARY/DESCRIPTION. `title`/`notes` are the sensitive
// free-text fields the Option-A gate below strips; `source`/`connectionId`
// are structural (which connection this task came from), not sensitive.
export type TaskItem = {
	id: string;
	title: string;
	notes?: string;
	due?: string;
	status?: string;
	priority?: number;
	url?: string;
	projectId?: string;
	projectName?: string;
	source: string;
	connectionId: string;
};

export type TaskProjectItem = {
	id: string;
	name: string;
	source: string;
	connectionId: string;
};

export type TasksToolModelPayload = {
	success: boolean;
	name: "tasks";
	sourceType: "tool";
	action: TasksToolInput["action"];
	message: string;
	tasks: TaskItem[];
	projects: TaskProjectItem[];
	pendingWriteId?: string;
	citations: TasksCitation[];
};

export type TasksToolOutcome = {
	modelPayload: TasksToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

function taskCitation(task: TaskItem): TasksCitation {
	return { label: task.title, url: task.url ?? "" };
}

function toCandidate(task: TaskItem, index: number): ToolEvidenceCandidate {
	return {
		id: `tasks:${task.connectionId}:${task.id}:${index}`,
		title: task.title,
		url: task.url ?? "",
		snippet: [task.notes, task.due, task.projectName]
			.filter((value): value is string => Boolean(value))
			.join(" · "),
		sourceType: "tool",
	};
}

function buildPayload(params: {
	success: boolean;
	action: TasksToolInput["action"];
	message: string;
	tasks?: TaskItem[];
	projects?: TaskProjectItem[];
	pendingWriteId?: string;
	/** Why the call did not work, for the row; it rides beside the payload, never in it. */
	reason?: TaskReason;
}): TasksToolOutcome {
	const tasks = params.tasks ?? [];
	const citations = tasks.map(taskCitation);
	const modelPayload: TasksToolModelPayload = {
		success: params.success,
		name: "tasks",
		sourceType: "tool",
		action: params.action,
		message: params.message,
		tasks,
		projects: params.projects ?? [],
		...(params.pendingWriteId ? { pendingWriteId: params.pendingWriteId } : {}),
		citations,
	};
	return {
		modelPayload: params.reason
			? withReasonCode(modelPayload, params.reason)
			: modelPayload,
		candidates: [
			...tasks.map(toCandidate),
			...(params.projects ?? []).map((project) => ({
				id: `tasks:${project.connectionId}:list:${project.id}`,
				title: project.name,
				url: "",
				snippet: "",
				sourceType: "tool" as const,
			})),
		],
	};
}

type TaskReason =
	| ConnectorReasonCode
	| "task_access_denied"
	| "task_changed"
	| "assigned_task_delete";
function mapAdapterError(err: unknown): {
	message: string;
	code: TaskReason;
} {
	const code = connectorReasonForAdapterError(err);
	if (err instanceof ConnectionHttpError) {
		switch (err.code) {
			case "access_denied":
				return {
					code: "task_access_denied",
					message: "Google denied access to this task or list.",
				};
			case "assigned_task_delete":
				return {
					code: "assigned_task_delete",
					message:
						"Delete assigned tasks in their original Google Docs or Chat context.",
				};
			case "item_changed":
				return {
					code: "task_changed",
					message: "The task changed. Look it up again.",
				};
			case "invalid_input":
				return {
					code: "request_adjusted",
					message:
						"Check the task fields and identifiers; use YYYY-MM-DD for a due date.",
				};
		}
	}
	if (err instanceof CalDavError) {
		switch (err.code) {
			case "needs_reauth":
				return {
					message:
						"Your CalDAV connection needs to be reconnected before I can access your tasks. Please reconnect it in Settings.",
					code,
				};
			case "connection_not_found":
				return {
					message:
						"Your CalDAV connection couldn't be found. Please reconnect it in Settings.",
					code,
				};
			default:
				return {
					message:
						"I couldn't reach your CalDAV server right now. Please try again in a moment.",
					code,
				};
		}
	}
	return {
		message:
			"I couldn't look up your tasks right now. Please try again in a moment.",
		code,
	};
}

// Google task lists carry IDs for filtering and later confirmed edits.
// CalDAV has no separate "project" concept exposed by this connector (each
// task list IS a collection of VTODOs with no further grouping — see
// caldavListTasks's doc comment).
async function listTasksForConnection(
	userId: string,
	conn: ConnectionPublic,
	listId?: string,
): Promise<TaskItem[] | null> {
	if (conn.provider === "google") {
		const lists = await googleListTaskLists(conn);
		const selected = listId
			? lists.filter((list) => list.id === listId)
			: lists;
		if (listId && !selected.length) return null;
		const tasks = await googleListTasks(conn, selected);
		return tasks
			.filter((task) => task.status !== "completed")
			.map((task) => ({
				...task,
				source: conn.label,
				connectionId: conn.id,
			}));
	}
	if (listId) return null;
	if (conn.provider === "caldav") {
		const tasks = await caldavListTasks(userId, conn.id);
		return tasks.map((task) => ({
			id: task.id,
			title: task.summary,
			...(task.description ? { notes: task.description } : {}),
			...(task.due ? { due: task.due } : {}),
			...(task.status ? { status: task.status } : {}),
			...(task.priority !== undefined ? { priority: task.priority } : {}),
			url: task.url,
			source: conn.label,
			connectionId: conn.id,
		}));
	}
	return [];
}

function isOverdue(due: string | undefined, today: string): boolean {
	if (!due) return false;
	return due < today;
}

function matchesDueFilter(task: TaskItem, due: string): boolean {
	if (due.toLowerCase() === "overdue") {
		const today = new Date().toISOString().slice(0, 10);
		return isOverdue(task.due, today);
	}
	return task.due === due;
}

function matchesQuery(task: TaskItem, query: string): boolean {
	const q = query.toLowerCase();
	return (
		task.title.toLowerCase().includes(q) ||
		(task.notes ?? "").toLowerCase().includes(q)
	);
}

// ---------------------------------------------------------------------------
// Locality Option A — task titles/notes are sensitive free text (same
// posture as calendar.ts's summary/location and contacts.ts's whole-payload
// gate). Every action that can carry raw task text is gated on its
// own most-sensitive field(s) before a cloud model ever sees it:
//   - list_tasks/search_tasks: task title + notes.
// `outcome.candidates` (the user's own Sources-tab list, built from the
// original unredacted data before this gate ever runs) is left untouched —
// it's the user's own data on their own screen, a different channel from
// what reaches the (cloud) model. Citation labels ARE redacted (they embed
// the same title text being stripped).
// ---------------------------------------------------------------------------

const WITHHELD_TASKS_MESSAGE =
	"These tasks couldn't be privately summarized for a cloud model, so their details were withheld. Switch to a local model to view them, or try again.";

function distillTasksReadOutcome(params: {
	userId: string;
	modelId: string;
	input: TasksToolInput;
	outcome: TasksToolOutcome;
}): Promise<TasksToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	const payload = outcome.modelPayload;

	// list_tasks / search_tasks
	const redactedCitations = (): TasksCitation[] =>
		payload.citations.map((_citation, index) => ({
			label: `Task ${index + 1}`,
			url: "",
		}));
	return applyLocalDistillGate({
		outcome,
		userId,
		modelId,
		capability: "tasks",
		userQuestion: input.query ?? "",
		rawText: [
			...payload.tasks.map((task) =>
				[task.title, task.notes, task.projectName].filter(Boolean).join(" — "),
			),
			...payload.projects.map((project) => project.name),
		].join("\n"),
		onDistilled: (o, distilled) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: `${o.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`,
				tasks: [],
				projects: [],
				citations: redactedCitations(),
			},
		}),
		onUnavailable: (o) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: WITHHELD_TASKS_MESSAGE,
				tasks: [],
				projects: [],
				citations: redactedCitations(),
			},
		}),
	});
}

async function readTasks(
	userId: string,
	connections: ConnectionPublic[],
	input: TasksToolInput,
): Promise<TasksToolOutcome> {
	const groups = await Promise.all(
		connections.map((conn) =>
			listTasksForConnection(userId, conn, input.listId),
		),
	);
	if (input.listId && groups.every((group) => group === null))
		return buildPayload({
			action: input.action,
			success: false,
			reason: "item_not_found",
			message:
				"That Google task list was not found in the selected accounts. Use list_task_lists to look it up again.",
		});
	const search = input.action === "search_tasks";
	const tasks = groups
		.flatMap((group) => group ?? [])
		.filter(
			(task) =>
				(!search || !input.query || matchesQuery(task, input.query)) &&
				(!input.due || matchesDueFilter(task, input.due)),
		);
	const message = tasks.length
		? `Found ${tasks.length} ${search ? "matching " : ""}${tasks.length === 1 ? "task" : "tasks"}.`
		: search
			? "No tasks found matching your search."
			: "No tasks found.";
	return buildPayload({ success: true, action: input.action, message, tasks });
}

async function proposeTask(
	userId: string,
	connections: ConnectionPublic[],
	input: TasksToolInput,
	action: "create_task" | "update_task" | "complete_task" | "delete_task",
	conversationId?: string | null,
) {
	const fail = (reason: ConnectorReasonCode, message: string) =>
		buildPayload({ action, success: false, reason, message });
	const supported = connections.filter((conn) => conn.provider === "google");
	if (!supported.length)
		return fail(
			"read_only_account",
			"Only Google Tasks supports task changes.",
		);
	if (supported.length !== 1)
		return fail(
			"no_such_account",
			"Ask which Google account to change, then pass its email as account.",
		);
	const conn = supported[0];
	if (!googleServiceCanModify(conn, "tasks"))
		return fail(
			conn.allowWrites ? "read_only_account" : "writes_turned_off",
			"Enable task editing and allow writes for this Google account in Connections.",
		);
	if (
		!input.listId ||
		(action === "create_task" ? !input.title : !input.taskId)
	)
		return fail(
			"request_adjusted",
			"Use a task list ID from list_task_lists, a title for a new task, or the task ID for an existing task.",
		);
	if (
		action === "update_task" &&
		input.title === undefined &&
		input.notes === undefined &&
		input.due === undefined
	)
		return fail(
			"request_adjusted",
			"Specify which title, notes, or due date should change.",
		);
	const { op, content, preview } = await prepareGoogleTaskWrite(conn, {
		action,
		listId: input.listId,
		taskId: input.taskId,
		title: input.title,
		notes: input.notes,
		due: input.due,
	});
	const pending = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content,
		preview,
		idempotencyKey: idempotencyKey(op),
		conversationId,
	});
	return buildPayload({
		action,
		success: true,
		pendingWriteId: pending.id,
		message:
			"The Google Tasks change is pending. Ask the user to confirm it on the card.",
	});
}

export async function runTasksTool(
	userId: string,
	input: TasksToolInput,
	modelId: string,
	conversationId?: string | null,
): Promise<TasksToolOutcome> {
	const allConnections = await resolveConnectionsForCapability(userId, "tasks");
	if (allConnections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Tasks connection set up yet. Connect Google Tasks or a CalDAV account in Settings to view your tasks.",
			reason: "not_connected",
		});
	}

	try {
		if (
			input.action === "create_task" ||
			input.action === "update_task" ||
			input.action === "complete_task" ||
			input.action === "delete_task"
		) {
			const matches = input.account
				? matchingConnections(allConnections, input.account)
				: allConnections;
			if (!matches.length)
				return buildPayload({
					success: false,
					action: input.action,
					reason: "no_such_account",
					message: noMatchingConnectionMessage(
						"Tasks",
						input.account ?? "",
						allConnections,
					),
				});
			return await proposeTask(
				userId,
				matches,
				input,
				input.action,
				conversationId,
			);
		}
		let connections = allConnections;
		if (input.account) {
			const selected = selectConnection(allConnections, input.account);
			if (!selected) {
				return buildPayload({
					success: false,
					action: input.action,
					message: noMatchingConnectionMessage(
						"Tasks",
						input.account,
						allConnections,
					),
					reason: "no_such_account",
				});
			}
			connections = [selected];
		}

		if (input.action === "list_task_lists") {
			const google = connections.filter((c) => c.provider === "google");
			if (!google.length)
				return buildPayload({
					success: false,
					action: input.action,
					reason: "not_supported",
					message: "Task list discovery requires a Google Tasks account.",
				});
			const projects = (
				await Promise.all(
					google.map(async (conn) =>
						(
							await googleListTaskLists(conn)
						).map((list) => ({
							id: list.id,
							name: list.title,
							connectionId: conn.id,
							source: conn.label,
						})),
					),
				)
			).flat();
			const outcome = buildPayload({
				success: true,
				action: input.action,
				projects,
				message: `Found ${projects.length} Google task lists.`,
			});
			return distillTasksReadOutcome({ userId, modelId, input, outcome });
		}
		const outcome = await readTasks(userId, connections, input);
		return distillTasksReadOutcome({ userId, modelId, input, outcome });
	} catch (err) {
		const failure = mapAdapterError(err);
		return buildPayload({
			success: false,
			action: input.action,
			message: failure.message,
			reason: failure.code,
		});
	}
}
