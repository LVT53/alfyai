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
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { createPendingWrite } from "../connections/pending-writes";
import {
	googleListTaskLists,
	googleListTasks,
	prepareGoogleTaskWrite,
} from "../connections/providers/google-tasks";
import { reasonCodeOf } from "./shared";
import { runTasksTool, sanitizeTasksToolInput } from "./tasks";

// These tests drive the tool's core directly, outside the envelope a real call
// runs in, to look at what a summary does to the payload. The mark the envelope
// carries is not what they are about (connector-distill.test.ts and
// shared.test.ts hold it), and a summary asked for with no call to mark is
// refused (ADR-0068), so the call is stood in for.
vi.mock("../connections/pending-writes", () => ({
	createPendingWrite: vi.fn(),
}));
vi.mock("../connections/providers/google-tasks", () => ({
	googleListTaskLists: vi.fn(),
	googleListTasks: vi.fn(),
	prepareGoogleTaskWrite: vi.fn(),
}));

vi.mock("./shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("./shared")>()),
	isInsideToolCall: () => true,
	markCallLocallyDistilled: vi.fn(),
}));

vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: vi.fn(),
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
		provider: "caldav",
		label: "CalDAV",
		accountIdentifier: "caldav",
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
	caldavListTasksMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
});

describe("sanitizeTasksToolInput", () => {
	it("trims query/due and drops empty ones", () => {
		expect(
			sanitizeTasksToolInput({
				action: "search_tasks",
				query: "  milk  ",
				due: " 2026-07-11 ",
			}),
		).toEqual({
			action: "search_tasks",
			query: "milk",
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
		expect(caldavListTasksMock).not.toHaveBeenCalled();
		// The row says why from a code beside the payload; the payload the model
		// reads is byte for byte what it always was.
		expect(reasonCodeOf(outcome.modelPayload)).toBe("not_connected");
		expect(JSON.stringify(outcome.modelPayload)).toBe(
			JSON.stringify({
				success: false,
				name: "tasks",
				sourceType: "tool",
				action: "list_tasks",
				message:
					"You don't have a Tasks connection set up yet. Connect Google Tasks or a CalDAV account in Settings to view your tasks.",
				tasks: [],
				projects: [],
				citations: [],
			}),
		);
	});

	it("list_tasks maps CalDAV VTODOs into the normalized TaskItem shape", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
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

		expect(outcome.modelPayload.success).toBe(true);
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
				connectionId: "conn-1",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{
				label: "Renew passport",
				url: "https://dav.example.com/tasks/todo-1.ics",
			},
		]);
		expect(outcome.candidates).toHaveLength(1);
	});

	it("list_tasks filters by due date client-side", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		caldavListTasksMock.mockResolvedValue([
			{
				id: "todo-1",
				summary: "Buy milk",
				due: "2026-07-11",
				url: "https://dav.example.com/tasks/todo-1.ics",
			},
			{
				id: "todo-2",
				summary: "Buy eggs",
				due: "2026-07-12",
				url: "https://dav.example.com/tasks/todo-2.ics",
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks", due: "2026-07-11" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id)).toEqual(["todo-1"]);
	});

	it("search_tasks matches on title or notes, case-insensitively", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		caldavListTasksMock.mockResolvedValue([
			{
				id: "todo-1",
				summary: "Buy milk",
				description: "2% at the store",
				url: "https://dav.example.com/tasks/todo-1.ics",
			},
			{
				id: "todo-2",
				summary: "Call dentist",
				url: "https://dav.example.com/tasks/todo-2.ics",
			},
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "search_tasks", query: "MILK" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id)).toEqual(["todo-1"]);
	});

	it("aggregates tasks across multiple tasks-capable connections", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-1", label: "CalDAV" }),
			makeConn({ id: "conn-2", label: "CalDAV (work)" }),
		]);
		caldavListTasksMock.mockImplementation(async (_userId, connectionId) => {
			return connectionId === "conn-1"
				? [
						{
							id: "10",
							summary: "Personal task",
							url: "https://dav.example.com/tasks/10.ics",
						},
					]
				: [
						{
							id: "20",
							summary: "Work task",
							url: "https://dav.example.com/tasks/20.ics",
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
			makeConn({ id: "conn-1", label: "CalDAV" }),
			makeConn({ id: "conn-2", label: "CalDAV (work)" }),
		]);
		caldavListTasksMock.mockImplementation(async (_userId, connectionId) => {
			return connectionId === "conn-1"
				? [
						{
							id: "10",
							summary: "Personal task",
							url: "https://dav.example.com/tasks/10.ics",
						},
					]
				: [
						{
							id: "20",
							summary: "Work task",
							url: "https://dav.example.com/tasks/20.ics",
						},
					];
		});

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks", account: "CalDAV (work)" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.tasks.map((t) => t.id)).toEqual(["20"]);
	});

	it("an account selector matching nothing returns a graceful listing message", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			makeConn({ id: "conn-1", label: "CalDAV" }),
		]);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks", account: "google" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("CalDAV");
		expect(outcome.modelPayload.message).toContain('"google"');
		expect(caldavListTasksMock).not.toHaveBeenCalled();
		expect(reasonCodeOf(outcome.modelPayload)).toBe("no_such_account");
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
		expect(reasonCodeOf(outcome.modelPayload)).toBe("needs_reconnect");
	});

	it.each([
		[
			"a CalDAV connection that is gone",
			new CalDavError("gone", "connection_not_found"),
			"not_connected",
		],
		[
			"a CalDAV server that did not answer",
			new CalDavError("down", "request_failed"),
			"account_unreachable",
		],
		[
			"a stored configuration that is broken",
			new CalDavError("bad", "invalid_config"),
			"not_set_up",
		],
		[
			"an error that is not the provider's",
			new Error("boom"),
			"account_unreachable",
		],
	] as const)("names %s", async (_label, error, code) => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		caldavListTasksMock.mockRejectedValue(error);

		const outcome = await runTasksTool(
			"user-1",
			{ action: "list_tasks" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(reasonCodeOf(outcome.modelPayload)).toBe(code);
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
		caldavListTasksMock.mockResolvedValue([
			{
				id: "todo-1",
				summary: "Buy anniversary gift for Zsófia",
				description: "Surprise her — check the jewelry store downtown",
				due: "2026-07-11",
				url: "https://dav.example.com/tasks/todo-1.ics",
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
		// The cloud model got none of the details: the row says so (beside the
		// payload, never in it).
		expect(reasonCodeOf(outcome.modelPayload)).toBe("details_withheld");
		expect(JSON.stringify(outcome.modelPayload)).not.toContain(
			"details_withheld",
		);
	});
});

describe("Google Tasks", () => {
	const google = makeConn({
		provider: "google",
		label: "Google",
		accountIdentifier: "work@example.com",
		allowWrites: true,
		oauthScopes: ["https://www.googleapis.com/auth/tasks"],
	});
	beforeEach(() => {
		vi.mocked(prepareGoogleTaskWrite).mockReset();
		vi.mocked(createPendingWrite).mockReset();
		resolveConnectionsForCapabilityMock.mockResolvedValue([google]);
	});
	it("returns list and task IDs for subsequent targeted actions", async () => {
		vi.mocked(googleListTaskLists).mockResolvedValue([
			{ id: "list", title: "Personal" },
		]);
		vi.mocked(googleListTasks).mockResolvedValue([
			{
				id: "done",
				title: "Call completed",
				status: "completed",
				projectId: "list",
				projectName: "Personal",
			},
			{
				id: "one",
				title: "Call back",
				projectId: "list",
				projectName: "Personal",
			},
		]);
		const lists = await runTasksTool(
			"user-1",
			{ action: "list_task_lists" },
			LOCAL_MODEL_ID,
		);
		expect(lists.modelPayload.projects).toEqual([
			{
				id: "list",
				name: "Personal",
				source: "Google",
				connectionId: google.id,
			},
		]);
		const tasks = await runTasksTool(
			"user-1",
			{ action: "search_tasks", query: "call", listId: "list" },
			LOCAL_MODEL_ID,
		);
		expect(tasks.modelPayload.tasks).toHaveLength(1);
		expect(tasks.modelPayload.tasks[0]).toMatchObject({
			id: "one",
			projectId: "list",
			source: "Google",
		});
	});
	it("distinguishes an unrecognized list from an empty matching list", async () => {
		vi.mocked(googleListTaskLists).mockResolvedValue([
			{ id: "list", title: "Work" },
		]);
		vi.mocked(googleListTasks).mockResolvedValue([]);
		const missing = await runTasksTool(
			"user-1",
			{ action: "list_tasks", listId: "gone" },
			LOCAL_MODEL_ID,
		);
		expect(reasonCodeOf(missing.modelPayload)).toBe("item_not_found");
		const empty = await runTasksTool(
			"user-1",
			{ action: "list_tasks", listId: "list" },
			LOCAL_MODEL_ID,
		);
		expect(empty.modelPayload).toMatchObject({ success: true, tasks: [] });
	});
	it("gates cloud access to task list names", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });
		vi.mocked(googleListTaskLists).mockResolvedValue([
			{ id: "list", title: "Personal matter" },
		]);
		const result = await runTasksTool(
			"user-1",
			{ action: "list_task_lists" },
			CLOUD_MODEL_ID,
		);
		expect(JSON.stringify(result.modelPayload)).not.toContain(
			"Personal matter",
		);
		expect(result.modelPayload.projects).toEqual([]);
	});
	it.each([
		"create_task",
		"update_task",
		"complete_task",
		"delete_task",
	] as const)(
		"schedules %s for the same chat and hides provider data from the model",
		async (action) => {
			const op = {
				provider: "google",
				connectionId: google.id,
				action: `tasks.${action}`,
				reversible: false,
				destructive: false,
				summary: "A private list and task title",
				target: { id: "task", label: "Private task" },
			};
			const preview = {
				title: op.summary,
				detail: "Private title",
				reversible: false,
				destructive: false,
				withinAllowlist: null,
				warnings: [],
			};
			vi.mocked(prepareGoogleTaskWrite).mockResolvedValue({
				op,
				content: "private-content",
				preview,
			});
			vi.mocked(createPendingWrite).mockResolvedValue({ id: "write", preview });
			const input =
				action === "create_task"
					? { title: "Buy fruit" }
					: action === "update_task"
						? { taskId: "task", notes: "" }
						: { taskId: "task" };
			const result = await runTasksTool(
				"user-1",
				{ action, listId: "list", ...input },
				CLOUD_MODEL_ID,
				"chat",
			);
			expect(createPendingWrite).toHaveBeenCalledWith(
				"user-1",
				expect.objectContaining({
					op,
					content: "private-content",
					conversationId: "chat",
				}),
			);
			expect(result.modelPayload.pendingWriteId).toBe("write");
			expect(JSON.stringify(result.modelPayload)).not.toMatch(/private/i);
		},
	);
	it("asks which Google account when more than one could receive the write", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			google,
			{ ...google, id: "2", accountIdentifier: "other@example.com" },
		]);
		const result = await runTasksTool(
			"user-1",
			{
				action: "delete_task",
				account: "google",
				listId: "one",
				taskId: "task",
			},
			LOCAL_MODEL_ID,
		);
		expect(reasonCodeOf(result.modelPayload)).toBe("no_such_account");
		expect(prepareGoogleTaskWrite).not.toHaveBeenCalled();
	});
	it("checks the edit toggle before doing any provider work", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			{ ...google, allowWrites: false },
		]);
		const result = await runTasksTool(
			"user-1",
			{ action: "complete_task", listId: "one", taskId: "task" },
			LOCAL_MODEL_ID,
		);
		expect(reasonCodeOf(result.modelPayload)).toBe("writes_turned_off");
		expect(prepareGoogleTaskWrite).not.toHaveBeenCalled();
	});
});
