import { createHash } from "node:crypto";
import { z } from "zod";
import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
import { type ConnectionPublic, getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import { buildWritePreview, type WriteOperation } from "../write-guard";
import {
	googleServiceAccessToken,
	googleServiceCanModify,
} from "./google-service-token";

type Options = { fetch?: typeof fetch };
const root = "https://tasks.googleapis.com/tasks/v1";
const listsPath = "/users/@me/lists";
const identifier = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[\w+=@:.~-]+$/)
	.refine((value) => value !== "." && value !== "..");
const taskList = z.object({ id: identifier, title: z.string() });
type TaskList = z.infer<typeof taskList>;
const task = z.object({
	id: identifier,
	title: z.string(),
	notes: z.string().optional(),
	due: z.iso.datetime({ offset: true }).optional(),
	status: z.enum(["needsAction", "completed"]).optional(),
	etag: z.string().optional(),
	assignmentInfo: z.object({}).optional(),
});
type Task = z.infer<typeof task>;
const actions = [
	"create_task",
	"update_task",
	"complete_task",
	"delete_task",
] as const;
const inputSchema = z.object({
	action: z.enum(actions),
	listId: identifier,
	taskId: identifier.optional(),
	title: z.string().trim().min(1).max(1024).optional(),
	notes: z.string().max(8192).optional(),
	due: z.iso.date().nullable().optional(),
});
type Input = z.infer<typeof inputSchema>;
const validAction = (input: Input) => {
	const edited =
		input.title !== undefined ||
		input.notes !== undefined ||
		input.due !== undefined;
	switch (input.action) {
		case "create_task":
			return !input.taskId && !!input.title;
		case "update_task":
			return !!input.taskId && edited;
		default:
			return !!input.taskId && !edited;
	}
};
const input = inputSchema.strict().refine(validAction);
const confirmed = inputSchema
	.extend({ listTitle: z.string() })
	.strict()
	.refine(validAction);
const taskPath = (listId: string, taskId?: string) => {
	const path = `/lists/${encodeURIComponent(identifier.parse(listId))}/tasks`;
	return taskId === undefined
		? path
		: `${path}/${encodeURIComponent(identifier.parse(taskId))}`;
};
function fail(code: string): never {
	throw new ConnectionHttpError(
		"Google Tasks request could not be completed",
		code,
	);
}
async function request(
	token: string,
	path: string,
	opts: Options,
	init: RequestInit = {},
) {
	const response = await providerFetch(root + path, {
		...opts,
		...init,
		redirect: "error",
		headers: { ...bearerAuthHeader(token), ...init.headers },
	});
	if (response.ok) return response;
	const errors: Record<number, string> = {
		401: "needs_reauth",
		403: "access_denied",
		404: "not_found",
		410: "not_found",
		412: "item_changed",
	};
	return fail(errors[response.status] ?? "request_failed");
}
async function pages<T>(
	token: string,
	path: string,
	query: Record<string, string>,
	schema: z.ZodType<T>,
	opts: Options,
) {
	const params = new URLSearchParams({ ...query, maxResults: "100" });
	const pageSchema = z.object({
		items: z.array(schema).optional(),
		nextPageToken: z.string().optional(),
	});
	const items: T[] = [];
	const seen = new Set<string>();
	for (;;) {
		const res = await request(token, `${path}?${params}`, opts);
		const page = pageSchema.parse(await res.json());
		if (page.items) items.push(...page.items);
		if (!page.nextPageToken) return items;
		// Do not describe a partial provider response as a complete list.
		if (seen.size >= 100 || seen.has(page.nextPageToken))
			fail("request_failed");
		seen.add(page.nextPageToken);
		params.set("pageToken", page.nextPageToken);
	}
}
export async function googleListTaskLists(
	conn: ConnectionPublic,
	opts: Options = {},
) {
	const token = await googleServiceAccessToken("tasks", conn, opts);
	return pages(
		token,
		listsPath,
		{ fields: "nextPageToken,items(id,title)" },
		taskList,
		opts,
	);
}
export async function googleListTasks(
	conn: ConnectionPublic,
	lists: TaskList[],
	opts: Options = {},
) {
	const token = await googleServiceAccessToken("tasks", conn, opts);
	async function inList(list: TaskList) {
		const rows = await pages(
			token,
			taskPath(list.id),
			{
				showAssigned: "true",
				showCompleted: "false",
				showHidden: "false",
				fields: "nextPageToken,items(id,title,notes,due,status)",
			},
			task,
			opts,
		);
		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			projectId: list.id,
			projectName: list.title,
			...(row.notes ? { notes: row.notes } : {}),
			...(row.due ? { due: row.due.slice(0, 10) } : {}),
			...(row.status ? { status: row.status } : {}),
		}));
	}
	const results: Awaited<ReturnType<typeof inList>> = [];
	for (let offset = 0; offset < lists.length; offset += 4) {
		const group = await Promise.all(
			lists.slice(offset, offset + 4).map(inList),
		);
		for (const rows of group) results.push(...rows);
	}
	return results;
}

// Tasks responses can carry an unquoted opaque ETag. If-Match requires a
// single strong, quoted validator; "*" would authorize an intervening edit.
function strongEtag(value?: string) {
	if (!value) return fail("item_changed");
	const raw =
		value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
	if (
		!/^[!#-~]{1,512}$/.test(raw) ||
		raw === "*" ||
		raw.includes('"') ||
		raw.startsWith("W/")
	)
		return fail("item_changed");
	return `"${raw}"`;
}
const taskVerbs = {
	create_task: "Create",
	update_task: "Update",
	complete_task: "Complete",
	delete_task: "Delete",
};
export async function prepareGoogleTaskWrite(
	conn: ConnectionPublic,
	proposal: Input,
	opts: Options = {},
) {
	const parsed = input.safeParse(proposal);
	if (!parsed.success) return fail("invalid_input");
	const changes = parsed.data;
	if (!googleServiceCanModify(conn, "tasks")) return fail("writes_disabled");
	const token = await googleServiceAccessToken("tasks", conn, opts, "modify");
	const list = taskList.parse(
		await (
			await request(
				token,
				`${listsPath}/${encodeURIComponent(changes.listId)}?fields=id,title`,
				opts,
			)
		).json(),
	);
	if (list.id !== changes.listId) return fail("not_found");
	let existing: Task | undefined;
	if (changes.taskId) {
		existing = task.parse(
			await (
				await request(
					token,
					`${taskPath(list.id, changes.taskId)}?fields=id,title,etag,assignmentInfo`,
					opts,
				)
			).json(),
		);
		if (existing.id !== changes.taskId) return fail("not_found");
		// Deleting an assignment also deletes its source in Docs or Chat Spaces.
		if (existing.assignmentInfo && changes.action === "delete_task")
			return fail("assigned_task_delete");
	}
	const label = existing?.title ?? changes.title;
	const content = JSON.stringify({ ...changes, listTitle: list.title });
	const op: WriteOperation = {
		provider: "google",
		connectionId: conn.id,
		action: `tasks.${changes.action}`,
		summary: `${taskVerbs[changes.action]} “${label}” in “${list.title}”`,
		target: {
			parentId: list.id,
			id: existing?.id,
			label,
			etag: existing ? strongEtag(existing.etag) : undefined,
		},
		reversible:
			changes.action === "create_task" || changes.action === "complete_task",
		destructive:
			changes.action === "delete_task" || changes.action === "update_task",
		payloadFingerprint: fingerprint(content),
	};
	return { op, content, preview: buildWritePreview(op) };
}
function fingerprint(content: string) {
	return createHash("sha256").update(content).digest("hex");
}
export const executeGoogleTaskWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts = {},
) => {
	try {
		const conn = await getConnection(userId, connectionId);
		if (
			conn?.provider !== "google" ||
			conn.status !== "connected" ||
			op.provider !== "google" ||
			op.connectionId !== connectionId ||
			!googleServiceCanModify(conn, "tasks")
		)
			return { ok: false, reason: "writes_disabled" };
		const changes = confirmed.parse(JSON.parse(content));
		if (
			op.action !== `tasks.${changes.action}` ||
			op.target?.parentId !== changes.listId ||
			op.target?.id !== changes.taskId ||
			op.payloadFingerprint !== fingerprint(content)
		)
			return { ok: false, reason: "invalid_input" };
		const token = await googleServiceAccessToken("tasks", conn, opts, "modify");
		const deleting = changes.action === "delete_task";
		const method = deleting
			? "DELETE"
			: changes.action === "create_task"
				? "POST"
				: "PATCH";
		const body =
			changes.action === "complete_task"
				? { status: "completed" }
				: {
						title: changes.title,
						notes: changes.notes,
						due: changes.due ? `${changes.due}T00:00:00.000Z` : changes.due,
					};
		await request(token, taskPath(changes.listId, changes.taskId), opts, {
			method,
			headers: {
				...(deleting ? {} : { "Content-Type": "application/json" }),
				...(changes.taskId ? { "If-Match": strongEtag(op.target.etag) } : {}),
			},
			...(deleting ? {} : { body: JSON.stringify(body) }),
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof ConnectionHttpError ? err.code : "request_failed",
		};
	}
};
