import { z } from "zod";
import {
	CalDavError,
	caldavListTasks,
} from "$lib/server/services/connections/providers/caldav-tasks";
import {
	resolveConnectionsForCapability,
	selectConnection,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { applyLocalDistillGate } from "./connector-distill";
import { noMatchingConnectionMessage } from "./shared";

// Read-only by construction for v1: the action enum only ever lists read
// actions over the CalDAV VTODO source this tool aggregates — same posture
// as repos.ts's GitHub-only read set.
export const tasksToolInputSchema = z.object({
	action: z.enum(["list_tasks", "list_projects", "search_tasks"]),
	// Free-text search for "search_tasks" — matched against a task's title
	// and notes, client-side (neither provider offers a reliable
	// cross-server free-text search primitive, same rationale as
	// apple-caldav.ts's appleSearchContacts).
	query: z.string().optional(),
	projectId: z.string().optional(),
	// A due-date filter as "YYYY-MM-DD" (exact match against a task's due
	// date) — case-insensitively also accepts the literal "overdue", meaning
	// "due date is before today".
	due: z.string().optional(),
	// Multi-connection disambiguation — by default this tool AGGREGATES
	// across every tasks-capable connection (see runTasksTool's doc comment).
	// `account`, when given, narrows that aggregation down to ONE specific
	// connection (a provider name, connection label, or account identifier —
	// see selectConnection in resolve.ts) instead of combining every source.
	account: z.string().optional(),
});

export type TasksToolInput = z.infer<typeof tasksToolInputSchema>;

export function sanitizeTasksToolInput(input: TasksToolInput): TasksToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.projectId ? { projectId: input.projectId.trim() } : {}),
		...(input.due ? { due: input.due.trim() } : {}),
		...(input.account ? { account: input.account.trim() } : {}),
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
}): TasksToolOutcome {
	const tasks = params.tasks ?? [];
	const citations = tasks.map(taskCitation);
	return {
		modelPayload: {
			success: params.success,
			name: "tasks",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			tasks,
			projects: params.projects ?? [],
			citations,
		},
		candidates: tasks.map(toCandidate),
	};
}

function mapAdapterError(err: unknown): string {
	if (err instanceof CalDavError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your CalDAV connection needs to be reconnected before I can access your tasks. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your CalDAV connection couldn't be found. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your CalDAV server right now. Please try again in a moment.";
		}
	}
	return "I couldn't look up your tasks right now. Please try again in a moment.";
}

// Per-connection task listing — CalDAV VTODOs (providers/caldav-tasks.ts).
// CalDAV has no separate "project" concept exposed by this connector (each
// task list IS a collection of VTODOs with no further grouping — see
// caldavListTasks's doc comment), so a CalDAV task's `projectId` is simply
// omitted and the `params.projectId` filter is a no-op for CalDAV.
async function listTasksForConnection(
	userId: string,
	conn: ConnectionPublic,
	_params: { projectId?: string },
): Promise<TaskItem[]> {
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

// CalDAV has no distinct "project" resource for this connector (see
// listTasksForConnection's doc comment), so list_projects currently never
// surfaces any projects.
async function listProjectsForConnection(
	_userId: string,
	_conn: ConnectionPublic,
): Promise<TaskProjectItem[]> {
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
// gate). Every action that can carry raw task/project text is gated on its
// own most-sensitive field(s) before a cloud model ever sees it:
//   - list_tasks/search_tasks: task title + notes.
//   - list_projects: project name (also arbitrary user-authored free text —
//     e.g. "Job search Q3" is as sensitive as a task title).
// `outcome.candidates` (the user's own Sources-tab list, built from the
// original unredacted data before this gate ever runs) is left untouched —
// it's the user's own data on their own screen, a different channel from
// what reaches the (cloud) model. Citation labels ARE redacted (they embed
// the same title text being stripped).
// ---------------------------------------------------------------------------

const WITHHELD_TASKS_MESSAGE =
	"These tasks couldn't be privately summarized for a cloud model, so their details were withheld. Switch to a local model to view them, or try again.";
const WITHHELD_PROJECTS_MESSAGE =
	"These project names couldn't be privately summarized for a cloud model, so they were withheld. Switch to a local model to view them, or try again.";

function distillTasksReadOutcome(params: {
	userId: string;
	modelId: string;
	input: TasksToolInput;
	outcome: TasksToolOutcome;
}): Promise<TasksToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	const payload = outcome.modelPayload;

	if (payload.action === "list_projects") {
		return applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "tasks",
			userQuestion: input.query ?? "",
			rawText: payload.projects.map((project) => project.name).join("\n"),
			onDistilled: (o, distilled) => ({
				...o,
				modelPayload: {
					...o.modelPayload,
					message: `${o.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`,
					projects: [],
				},
			}),
			onUnavailable: (o) => ({
				...o,
				modelPayload: {
					...o.modelPayload,
					message: WITHHELD_PROJECTS_MESSAGE,
					projects: [],
				},
			}),
		});
	}

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
		rawText: payload.tasks
			.map((task) => [task.title, task.notes].filter(Boolean).join(" — "))
			.join("\n"),
		onDistilled: (o, distilled) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: `${o.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`,
				tasks: [],
				citations: redactedCitations(),
			},
		}),
		onUnavailable: (o) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: WITHHELD_TASKS_MESSAGE,
				tasks: [],
				citations: redactedCitations(),
			},
		}),
	});
}

async function runListTasks(
	userId: string,
	connections: ConnectionPublic[],
	input: TasksToolInput,
): Promise<TasksToolOutcome> {
	const allTasks: TaskItem[] = [];
	for (const conn of connections) {
		allTasks.push(
			...(await listTasksForConnection(userId, conn, {
				...(input.projectId ? { projectId: input.projectId } : {}),
			})),
		);
	}
	const tasks = input.due
		? allTasks.filter((task) => matchesDueFilter(task, input.due as string))
		: allTasks;
	const message =
		tasks.length === 0
			? "No tasks found."
			: `Found ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}.`;
	return buildPayload({ success: true, action: "list_tasks", message, tasks });
}

async function runListProjects(
	userId: string,
	connections: ConnectionPublic[],
): Promise<TasksToolOutcome> {
	const projects: TaskProjectItem[] = [];
	for (const conn of connections) {
		projects.push(...(await listProjectsForConnection(userId, conn)));
	}
	const message =
		projects.length === 0
			? "No projects found."
			: `Found ${projects.length} ${projects.length === 1 ? "project" : "projects"}.`;
	return buildPayload({
		success: true,
		action: "list_projects",
		message,
		projects,
	});
}

async function runSearchTasks(
	userId: string,
	connections: ConnectionPublic[],
	input: TasksToolInput,
): Promise<TasksToolOutcome> {
	const allTasks: TaskItem[] = [];
	for (const conn of connections) {
		allTasks.push(
			...(await listTasksForConnection(userId, conn, {
				...(input.projectId ? { projectId: input.projectId } : {}),
			})),
		);
	}
	let tasks = allTasks;
	if (input.query)
		tasks = tasks.filter((task) => matchesQuery(task, input.query as string));
	if (input.due)
		tasks = tasks.filter((task) => matchesDueFilter(task, input.due as string));
	const message =
		tasks.length === 0
			? `No tasks found matching your search.`
			: `Found ${tasks.length} matching ${tasks.length === 1 ? "task" : "tasks"}.`;
	return buildPayload({
		success: true,
		action: "search_tasks",
		message,
		tasks,
	});
}

// Dispatches to list_tasks/list_projects/search_tasks across every
// tasks-capable (CalDAV) connection, aggregated — same "combine,
// don't disambiguate" posture as contacts.ts, since a user may reasonably
// want a single "what's on my plate" view across more than one task
// source), degrading gracefully (never throwing) so a connection or lookup
// problem never aborts the chat turn, and applying the same Option-A
// local-distillation posture as contacts.ts/calendar.ts before any raw task
// text reaches a cloud model. An explicit `account` selector (multi-
// connection disambiguation) narrows this aggregation down to just the one
// matching connection instead of combining every source — see
// selectConnection in resolve.ts.
export async function runTasksTool(
	userId: string,
	input: TasksToolInput,
	modelId: string,
): Promise<TasksToolOutcome> {
	const allConnections = await resolveConnectionsForCapability(userId, "tasks");
	if (allConnections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Tasks connection set up yet. Connect a CalDAV account in Settings to view your tasks.",
		});
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
			});
		}
		connections = [selected];
	}

	try {
		if (input.action === "list_projects") {
			const outcome = await runListProjects(userId, connections);
			return distillTasksReadOutcome({ userId, modelId, input, outcome });
		}
		if (input.action === "search_tasks") {
			const outcome = await runSearchTasks(userId, connections, input);
			return distillTasksReadOutcome({ userId, modelId, input, outcome });
		}
		const outcome = await runListTasks(userId, connections, input);
		return distillTasksReadOutcome({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
