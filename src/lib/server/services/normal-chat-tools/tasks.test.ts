import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	CalDavError,
	caldavListTasks,
} from "$lib/server/services/connections/providers/caldav-tasks";
import {
	TodoistError,
	todoistListProjects,
	todoistListTasks,
} from "$lib/server/services/connections/providers/todoist";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import { runTasksTool, sanitizeTasksToolInput } from "./tasks";

vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/providers/todoist", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/todoist")
	>("$lib/server/services/connections/providers/todoist");
	return {
		...actual,
		todoistListTasks: vi.fn(),
		todoistListProjects: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/providers/caldav-tasks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/caldav-tasks")
	>("$lib/server/services/connections/providers/caldav-tasks");
	return {
		...actual,
		caldavListTasks: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const todoistListTasksMock = vi.mocked(todoistListTasks);
const todoistListProjectsMock = vi.mocked(todoistListProjects);
const caldavListTasksMock = vi.mocked(caldavListTasks);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";
const CLOUD_MODEL_ID = "gpt-cloud";

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "todoist",
		label: "Todoist",
		accountIdentifier: "todoist",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["tasks"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

beforeEach(() => {
	resolveConnectionsForCapabilityMock.mockReset();
	todoistListTasksMock.mockReset();
	todoistListProjectsMock.mockReset();
	caldavListTasksMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
});

describe("sanitizeTasksToolInput", () => {
	it("trims query/projectId/due and drops empty ones", () => {
		expect(
			sanitizeTasksToolInput({
				action: "search_tasks",
				query: "  milk  ",
				projectId: " 2 ",
				due: " 2026-07-11 ",
			}),
		).toEqual({
			action: "search_tasks",
			query: "milk",
			projectId: "2",
			due: "2026-07-11",
		});
	});

	it("omits absent optional fields", () => {
		expect(sanitizeTasksToolInput({ action: "list_tasks" })).toEqual({
			action: "list_tasks",
		});
	});
});

describe("runTasksTool", () => {
	it("returns a graceful note without throwing when there is no Tasks connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.tasks).toEqual([]);
		expect(todoistListTasksMock).not.toHaveBeenCalled();
	});

	it("list_tasks maps Todoist tasks into the normalized TaskItem shape", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		todoistListTasksMock.mockResolvedValue([
			{
				id: "10",
				content: "Buy milk",
				description: "2%",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				due: "2026-07-11",
				labels: [],
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.tasks).toEqual([
			{
				id: "10",
				title: "Buy milk",
				notes: "2%",
				due: "2026-07-11",
				priority: 1,
				url: "https://todoist.com/task/10",
				projectId: "2",
				source: "Todoist",
				connectionId: "conn-1",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Buy milk", url: "https://todoist.com/task/10" },
		]);
		expect(outcome.candidates).toHaveLength(1);
	});

	it("list_tasks passes projectId through and filters by due date client-side", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		todoistListTasksMock.mockResolvedValue([
			{
				id: "10",
				content: "Buy milk",
				description: "",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				due: "2026-07-11",
				labels: [],
			},
			{
				id: "11",
				content: "Buy eggs",
				description: "",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/11",
				due: "2026-07-12",
				labels: [],
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks", projectId: "2", due: "2026-07-11" },
			LOCAL_MODEL_ID,
		);

		expect(todoistListTasksMock).toHaveBeenCalledWith("user-1", "conn-1", {
			projectId: "2",
		});
		expect(outcome.modelPayload.tasks.map((t) => t.id)).toEqual(["10"]);
	});

	it("list_projects maps Todoist projects into the normalized shape", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		todoistListProjectsMock.mockResolvedValue([
			{ id: "1", name: "Inbox", isFavorite: false },
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_projects" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.projects).toEqual([
			{ id: "1", name: "Inbox", source: "Todoist", connectionId: "conn-1" },
		]);
	});

	it("search_tasks matches on title or notes, case-insensitively", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		todoistListTasksMock.mockResolvedValue([
			{
				id: "10",
				content: "Buy milk",
				description: "2% at the store",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				labels: [],
			},
			{
				id: "11",
				content: "Call dentist",
				description: "",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/11",
				labels: [],
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "search_tasks", query: "MILK" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id)).toEqual(["10"]);
	});

	it("aggregates tasks across multiple tasks-capable connections", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-1", label: "Todoist" }),
			makeConn({ id: "conn-2", label: "Todoist (work)" }),
		]);
		todoistListTasksMock.mockImplementation(async (_userId, connectionId) => {
			return connectionId === "conn-1"
				? [
						{
							id: "10",
							content: "Personal task",
							description: "",
							projectId: "2",
							priority: 1,
							url: "https://todoist.com/task/10",
							labels: [],
						},
					]
				: [
						{
							id: "20",
							content: "Work task",
							description: "",
							projectId: "3",
							priority: 1,
							url: "https://todoist.com/task/20",
							labels: [],
						},
					];
		});

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id).sort()).toEqual([
			"10",
			"20",
		]);
	});

	it("an account selector narrows aggregation to just the matching connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-1", label: "Todoist" }),
			makeConn({ id: "conn-2", label: "Todoist (work)" }),
		]);
		todoistListTasksMock.mockImplementation(async (_userId, connectionId) => {
			return connectionId === "conn-1"
				? [
						{
							id: "10",
							content: "Personal task",
							description: "",
							projectId: "2",
							priority: 1,
							url: "https://todoist.com/task/10",
							labels: [],
						},
					]
				: [
						{
							id: "20",
							content: "Work task",
							description: "",
							projectId: "3",
							priority: 1,
							url: "https://todoist.com/task/20",
							labels: [],
						},
					];
		});

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks", account: "Todoist (work)" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id)).toEqual(["20"]);
	});

	it("an account selector matching nothing returns a graceful listing message", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-1", label: "Todoist" }),
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks", account: "google" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Todoist");
		expect(outcome.modelPayload.message).toContain('"google"');
		expect(todoistListTasksMock).not.toHaveBeenCalled();
	});

	it("maps a Todoist needs_reauth error to a graceful failure message", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		todoistListTasksMock.mockRejectedValue(
			new TodoistError("Todoist rejected the stored token", "needs_reauth"),
		);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnect");
	});

	it("list_tasks maps CalDAV VTODOs into the normalized TaskItem shape", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-cd", provider: "caldav", label: "CalDAV" }),
		]);
		caldavListTasksMock.mockResolvedValue([
			{
				id: "todo-1",
				summary: "Renew passport",
				description: "Bring old one",
				due: "2026-07-15",
				status: "NEEDS-ACTION",
				priority: 1,
				url: "https://dav.example.com/tasks/todo-1.ics",
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks).toEqual([
			{
				id: "todo-1",
				title: "Renew passport",
				notes: "Bring old one",
				due: "2026-07-15",
				status: "NEEDS-ACTION",
				priority: 1,
				url: "https://dav.example.com/tasks/todo-1.ics",
				source: "CalDAV",
				connectionId: "conn-cd",
			},
		]);
	});

	it("aggregates tasks across a Todoist AND a CalDAV connection together", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-td", provider: "todoist", label: "Todoist" }),
			makeConn({ id: "conn-cd", provider: "caldav", label: "CalDAV" }),
		]);
		todoistListTasksMock.mockResolvedValue([
			{
				id: "10",
				content: "Todoist task",
				description: "",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				labels: [],
			},
		]);
		caldavListTasksMock.mockResolvedValue([
			{
				id: "todo-1",
				summary: "CalDAV task",
				url: "https://dav.example.com/tasks/todo-1.ics",
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id).sort()).toEqual([
			"10",
			"todo-1",
		]);
	});

	it("maps a CalDAV needs_reauth error to a graceful failure message", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-cd", provider: "caldav", label: "CalDAV" }),
		]);
		caldavListTasksMock.mockRejectedValue(
			new CalDavError(
				"The server rejected the stored app password",
				"needs_reauth",
			),
		);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnect");
	});
});

// ---------------------------------------------------------------------------
// Locality Option A — task titles/notes are sensitive free text and MUST be
// stripped from the model-facing payload when local-distill is on and the
// active model is a cloud model (hard requirement, Task 9a brief).
// ---------------------------------------------------------------------------

describe("runTasksTool — locality Option A distillation gate", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		todoistListTasksMock.mockResolvedValue([
			{
				id: "10",
				content: "Buy anniversary gift for Zsófia",
				description: "Surprise her — check the jewelry store downtown",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				due: "2026-07-11",
				labels: [],
			},
		]);
	});

	it("Option A off: raw task title/notes are returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			CLOUD_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks[0]?.title).toBe(
			"Buy anniversary gift for Zsófia",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw task title/notes are returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks[0]?.title).toBe(
			"Buy anniversary gift for Zsófia",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the WHOLE model-facing payload has no raw task title/notes — tasks array wiped, citations redacted; Sources-tab candidates keep the real values", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One task due tomorrow.",
		});

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			CLOUD_MODEL_ID,
		);

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Zsófia");
		expect(serializedPayload).not.toContain("jewelry store");
		expect(outcome.modelPayload.tasks).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Task 1", url: "" },
		]);
		expect(outcome.modelPayload.message).toContain("One task due tomorrow.");

		// The user's own Sources-tab candidates are a different channel — they
		// keep the real title so the user (not the cloud model) can still see it.
		expect(outcome.candidates[0]?.title).toBe(
			"Buy anniversary gift for Zsófia",
		);
	});

	it("Option A on + cloud model + distill unavailable: tasks are withheld rather than leaked", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			CLOUD_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks).toEqual([]);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain("Zsófia");
		expect(outcome.modelPayload.message).toContain("withheld");
	});

	// Folded-in Task 9a review minor (5b): 9a only exercised a Todoist-sourced
	// task through this gate — this locks in that a CalDAV VTODO-sourced task
	// (title/notes) is wiped the same way under local-distill on + cloud model.
	it("Option A on + cloud model: a CalDAV-sourced task's title/notes are wiped from the model-facing payload too", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-caldav", provider: "caldav", label: "CalDAV" }),
		]);
		caldavListTasksMock.mockResolvedValue([
			{
				id: "todo-1",
				summary: "Renew passport before the trip",
				description: "Bring the old one and 2 passport photos",
				due: "2026-07-15",
				status: "NEEDS-ACTION",
				priority: 1,
				url: "https://dav.example.com/cal/todo-1.ics",
			},
		]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One task due soon.",
		});

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			CLOUD_MODEL_ID,
		);

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Renew passport");
		expect(serializedPayload).not.toContain("passport photos");
		expect(outcome.modelPayload.tasks).toEqual([]);
		expect(outcome.modelPayload.message).toContain("One task due soon.");
		expect(outcome.candidates[0]?.title).toBe("Renew passport before the trip");
	});

	it("also gates list_projects on project names", async () => {
		todoistListProjectsMock.mockResolvedValue([
			{ id: "1", name: "Divorce planning", isFavorite: false },
		]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One private project.",
		});

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_projects" },
			CLOUD_MODEL_ID,
		);

		expect(outcome.modelPayload.projects).toEqual([]);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(
			"Divorce planning",
		);
	});
});
