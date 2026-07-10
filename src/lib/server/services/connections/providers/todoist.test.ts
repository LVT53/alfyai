import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function seedUser(userId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-connections-todoist-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const USER_ID = "userA";
const API_ROOT = "https://api.todoist.com/rest/v2";

async function seedTodoistConnection(overrides: { token?: string } = {}) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: USER_ID,
		provider: "todoist",
		label: "Todoist",
		accountIdentifier: "todoist",
		capabilities: ["tasks"],
		status: "connected",
		secret: overrides.token ?? "todoist_secret_token",
		config: {},
	});
}

// ---------------------------------------------------------------------------
// todoistConnect
// ---------------------------------------------------------------------------

describe("todoistConnect", () => {
	it("validates the token against /projects and stores it (never plaintext-logged)", async () => {
		seedUser(USER_ID);
		const { todoistConnect } = await import("./todoist");
		const { getConnectionSecret } = await import("../store");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer token-abc");
				if (url === `${API_ROOT}/projects`) {
					return jsonResponse(200, [{ id: "1", name: "Inbox" }]);
				}
				throw new Error(`unexpected url ${url}`);
			},
		);

		const { connection } = await todoistConnect({
			userId: USER_ID,
			token: "token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("todoist");
		expect(connection.capabilities).toEqual(["tasks"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		// The raw token must never appear anywhere in the stored/serialized DTO.
		expect(JSON.stringify(connection)).not.toContain("token-abc");

		const decrypted = await getConnectionSecret(USER_ID, connection.id);
		expect(decrypted).toBe("token-abc");
	});

	it("a 401 on /projects surfaces a clear invalid_token error with no token in the message", async () => {
		seedUser(USER_ID);
		const { todoistConnect, TodoistError } = await import("./todoist");

		const fetchMock = vi.fn(async () => jsonResponse(401, {}));

		try {
			await todoistConnect({
				userId: USER_ID,
				token: "wrong-token",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected todoistConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(TodoistError);
			expect((err as InstanceType<typeof TodoistError>).code).toBe(
				"invalid_token",
			);
			expect((err as Error).message).not.toContain("wrong-token");
		}
	});

	it("requires a non-empty token without ever calling fetch", async () => {
		seedUser(USER_ID);
		const { todoistConnect, TodoistError } = await import("./todoist");
		const fetchMock = vi.fn();

		try {
			await todoistConnect({
				userId: USER_ID,
				token: "   ",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected todoistConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(TodoistError);
			expect((err as InstanceType<typeof TodoistError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("re-connecting updates the existing connection instead of creating a duplicate", async () => {
		seedUser(USER_ID);
		const { todoistConnect } = await import("./todoist");
		const { listConnectionsForUser } = await import("../store");

		const fetchMock = vi.fn(async () => jsonResponse(200, []));

		const first = await todoistConnect({
			userId: USER_ID,
			token: "token-one",
			fetch: fetchMock as unknown as typeof fetch,
		});
		const second = await todoistConnect({
			userId: USER_ID,
			token: "token-two",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const all = await listConnectionsForUser(USER_ID);
		expect(all.filter((c) => c.provider === "todoist")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("todoistListProjects / todoistListTasks / todoistGetTask", () => {
	it("lists projects", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistListProjects } = await import("./todoist");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, [
				{ id: "1", name: "Inbox", color: "grey", is_favorite: false },
				{ id: "2", name: "Work", color: "red", is_favorite: true },
			]),
		);

		const projects = await todoistListProjects(USER_ID, conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(projects).toEqual([
			{ id: "1", name: "Inbox", isFavorite: false },
			{ id: "2", name: "Work", isFavorite: true },
		]);
	});

	it("lists tasks, optionally scoped to a project", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistListTasks } = await import("./todoist");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toBe(`${API_ROOT}/tasks?project_id=2`);
			return jsonResponse(200, [
				{
					id: "10",
					content: "Buy milk",
					description: "",
					project_id: "2",
					priority: 1,
					url: "https://todoist.com/task/10",
					due: { date: "2026-07-11", string: "tomorrow" },
					labels: ["errand"],
				},
			]);
		});

		const tasks = await todoistListTasks(
			USER_ID,
			conn.id,
			{ projectId: "2" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(tasks).toEqual([
			{
				id: "10",
				content: "Buy milk",
				description: "",
				projectId: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				due: "2026-07-11",
				labels: ["errand"],
			},
		]);
	});

	it("maps a 401 to needs_reauth and persists it on the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistListTasks, TodoistError } = await import("./todoist");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => jsonResponse(401, {}));

		try {
			await todoistListTasks(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected todoistListTasks to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(TodoistError);
			expect((err as InstanceType<typeof TodoistError>).code).toBe(
				"needs_reauth",
			);
		}
		const updated = await getConnection(USER_ID, conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});

	it("reads a single task by id", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistGetTask } = await import("./todoist");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe(`${API_ROOT}/tasks/10`);
			return jsonResponse(200, {
				id: "10",
				content: "Buy milk",
				description: "2%",
				project_id: "2",
				priority: 1,
				url: "https://todoist.com/task/10",
				due: null,
				labels: [],
			});
		});

		const task = await todoistGetTask(USER_ID, conn.id, "10", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(task).toEqual({
			id: "10",
			content: "Buy milk",
			description: "2%",
			projectId: "2",
			priority: 1,
			url: "https://todoist.com/task/10",
			labels: [],
		});
	});

	it("never leaks a non-2xx response body", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistListTasks, TodoistError } = await import("./todoist");

		const fetchMock = vi.fn(
			async () =>
				new Response("<html>secret internal error trace</html>", {
					status: 500,
				}),
		);

		try {
			await todoistListTasks(
				USER_ID,
				conn.id,
				{},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected todoistListTasks to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(TodoistError);
			expect((err as Error).message).not.toContain("secret internal error");
		}
	});
});

// ---------------------------------------------------------------------------
// checkHealth (adapter)
// ---------------------------------------------------------------------------

describe("todoist checkHealth", () => {
	it("reports connected on a 200 /projects response", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistAdapter } = await import("./todoist");

		const fetchMock = vi.fn(async () => jsonResponse(200, []));

		const result = await todoistAdapter.checkHealth(
			"todoist_secret_token",
			conn,
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ status: "connected", detail: null });
	});

	it("reports needs_reauth on a 401", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistAdapter } = await import("./todoist");

		const fetchMock = vi.fn(async () => jsonResponse(401, {}));

		const result = await todoistAdapter.checkHealth(
			"todoist_secret_token",
			conn,
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.status).toBe("needs_reauth");
	});

	it("reports error on other failures without leaking a raw body", async () => {
		seedUser(USER_ID);
		const conn = await seedTodoistConnection();
		const { todoistAdapter } = await import("./todoist");

		const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));

		const result = await todoistAdapter.checkHealth(
			"todoist_secret_token",
			conn,
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.status).toBe("error");
	});

	expectRequiresSecret();
});

function expectRequiresSecret() {
	it("requiresSecret is true", async () => {
		const { todoistAdapter } = await import("./todoist");
		expect(todoistAdapter.requiresSecret).toBe(true);
	});
}
