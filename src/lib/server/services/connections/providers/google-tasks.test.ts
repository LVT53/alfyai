import { beforeEach, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { getConnection } from "../store";
import {
	googleServiceAccessToken,
	googleServiceCanModify,
} from "./google-service-token";
import {
	executeGoogleTaskWrite,
	googleListTaskLists,
	googleListTasks,
	prepareGoogleTaskWrite,
} from "./google-tasks";

vi.mock("../store", () => ({ getConnection: vi.fn() }));
vi.mock("./google-service-token", () => ({
	googleServiceAccessToken: vi.fn(),
	googleServiceCanModify: vi.fn(),
}));
const conn = {
	id: "c",
	userId: "u",
	provider: "google",
	status: "connected",
} as ConnectionPublic;
const list = { id: "list1", title: "Errands" };
const task = {
	id: "t1",
	title: "Return books",
	etag: "revision.1",
	due: "2026-12-01T00:00:00.000Z",
	status: "needsAction",
};
beforeEach(() => {
	vi.mocked(getConnection).mockResolvedValue(conn);
	vi.mocked(googleServiceAccessToken).mockResolvedValue("token");
	vi.mocked(googleServiceCanModify).mockReturnValue(true);
});
it("follows list and task pagination, keeps list identity and date-only due dates", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ items: [list], nextPageToken: "p" }))
		.mockResolvedValueOnce(Response.json({}))
		.mockResolvedValueOnce(Response.json({ items: [task], nextPageToken: "x" }))
		.mockResolvedValueOnce(Response.json({}));
	const lists = await googleListTaskLists(conn, { fetch });
	expect(lists).toEqual([list]);
	expect(await googleListTasks(conn, lists, { fetch })).toMatchObject([
		{
			id: "t1",
			projectId: "list1",
			projectName: "Errands",
			title: "Return books",
			due: "2026-12-01",
		},
	]);
	const params = new URL(fetch.mock.calls[3][0]).searchParams;
	expect(params.get("showCompleted")).toBe("false");
	expect(params.get("showHidden")).toBe("false");
	expect(params.get("showAssigned")).toBe("true");
	expect(params.get("pageToken")).toBe("x");
});
it("confirms a single dated edit with exact list, task and version, retaining omitted fields", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(list))
		.mockResolvedValueOnce(Response.json(task))
		.mockResolvedValueOnce(Response.json(task));
	const { op, content } = await prepareGoogleTaskWrite(
		conn,
		{ action: "update_task", listId: list.id, taskId: "t1", due: "2026-12-02" },
		{ fetch },
	);
	expect(JSON.parse(content).listTitle).toBe("Errands");
	expect(op.target?.label).toBe(task.title);
	expect(
		await executeGoogleTaskWrite("u", "c", op, content, { fetch }),
	).toMatchObject({ ok: true });
	expect(fetch.mock.calls.at(-1)).toEqual([
		expect.stringContaining("/lists/list1/tasks/t1"),
		expect.objectContaining({
			method: "PATCH",
			headers: expect.objectContaining({ "If-Match": '"revision.1"' }),
			body: JSON.stringify({ due: "2026-12-02T00:00:00.000Z" }),
		}),
	]);
	const changed = { ...op, target: { ...op.target, id: "different" } };
	expect(
		(await executeGoogleTaskWrite("u", "c", changed, content, { fetch })).ok,
	).toBe(false);
	expect(fetch).toHaveBeenCalledTimes(3);
});
it("rejects unsafe ids and impossible dates before contacting Google", async () => {
	const fetch = vi.fn();
	for (const input of [
		{ listId: "..", due: "2026-11-01" },
		{ listId: "list1", due: "2026-02-30" },
	]) {
		await expect(
			prepareGoogleTaskWrite(
				conn,
				{ ...input, action: "create_task", title: "Plan" },
				{ fetch },
			),
		).rejects.toThrow();
	}
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	[
		"create_task",
		"POST",
		{ title: "New task", notes: "Remember", due: "2028-02-29" },
		{ title: "New task", notes: "Remember", due: "2028-02-29T00:00:00.000Z" },
	],
	[
		"update_task",
		"PATCH",
		{ taskId: "t1", notes: "", due: null },
		{ notes: "", due: null },
	],
	["complete_task", "PATCH", { taskId: "t1" }, { status: "completed" }],
	["delete_task", "DELETE", { taskId: "t1" }, undefined],
] as const)(
	"proposes %s without writing and sends only the confirmed edit",
	async (action, method, fields, expected) => {
		const fetch = vi.fn().mockResolvedValueOnce(Response.json(list));
		if (action !== "create_task")
			fetch.mockResolvedValueOnce(Response.json(task));
		fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const { op, content } = await prepareGoogleTaskWrite(
			conn,
			{ action, listId: "list1", ...fields },
			{ fetch },
		);
		expect(
			fetch.mock.calls.every(
				(call) => !call[1]?.method || call[1].method === "GET",
			),
		).toBe(true);
		expect(
			await executeGoogleTaskWrite("u", "c", op, content, { fetch }),
		).toEqual({ ok: true });
		const [url, init] = fetch.mock.calls[fetch.mock.calls.length - 1];
		expect(url).toBe(
			"https://tasks.googleapis.com/tasks/v1/lists/list1/tasks" +
				(action === "create_task" ? "" : "/t1"),
		);
		expect(init.method).toBe(method);
		expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(
			expected,
		);
		expect(init.headers["If-Match"]).toBe(
			action === "create_task" ? undefined : '"revision.1"',
		);
	},
);
it("honors permission revocation after preview and a changed task version", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(list))
		.mockResolvedValueOnce(Response.json(task))
		.mockResolvedValueOnce(new Response(null, { status: 412 }));
	const { op, content } = await prepareGoogleTaskWrite(
		conn,
		{ action: "delete_task", taskId: "t1", listId: "list1" },
		{ fetch },
	);
	vi.mocked(googleServiceCanModify).mockReturnValueOnce(false);
	expect(
		await executeGoogleTaskWrite("u", "c", op, content, { fetch }),
	).toEqual({ ok: false, reason: "writes_disabled" });
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(
		await executeGoogleTaskWrite("u", "c", op, content, { fetch }),
	).toEqual({ ok: false, reason: "item_changed" });
});
it("prevents removal of the original Docs/Spaces task through an assignment", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(list))
		.mockResolvedValueOnce(
			Response.json({ ...task, assignmentInfo: { surfaceType: "DOCUMENT" } }),
		);
	await expect(
		prepareGoogleTaskWrite(
			conn,
			{ action: "delete_task", taskId: "t1", listId: "list1" },
			{ fetch },
		),
	).rejects.toMatchObject({ code: "assigned_task_delete" });
});
