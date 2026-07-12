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

const USER_ID = "user-1";

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
	dbPath = `./data/test-connections-immich-write-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	seedUser(USER_ID);
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

async function seedImmichConnection(
	params: { withWriteSecret?: boolean } = {},
): Promise<string> {
	const { createConnection, setConnectionWriteSecret } = await import(
		"../store"
	);
	const conn = await createConnection({
		userId: USER_ID,
		provider: "immich",
		label: "Immich",
		accountIdentifier: "alice@example.com",
		capabilities: ["photos"],
		status: "connected",
		allowWrites: true,
		secret: "read-only-key",
		config: { origin: "https://photos.example.com", immichUserId: "user-1" },
	});
	if (params.withWriteSecret !== false) {
		await setConnectionWriteSecret(USER_ID, conn.id, "write-scoped-key");
	}
	return conn.id;
}

function makeOp(connectionId: string): {
	provider: string;
	connectionId: string;
	action: string;
	summary: string;
	reversible: boolean;
	destructive: boolean;
	target: { label: string };
} {
	return {
		provider: "immich",
		connectionId,
		action: "immich.add_to_album",
		summary: 'Add 2 photos to the "AlfyAI" album',
		reversible: true,
		destructive: false,
		target: { label: "AlfyAI album" },
	};
}

describe("immich write-executor — immich.add_to_album", () => {
	it("finds an existing 'AlfyAI' album and PUTs the asset ids, never calling POST /albums", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		const putBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					const headers = new Headers(init?.headers);
					expect(headers.get("x-api-key")).toBe("write-scoped-key");
					return jsonResponse(200, [
						{ id: "album-1", albumName: "AlfyAI", ownerId: "user-1" },
						{ id: "album-2", albumName: "Other", ownerId: "user-1" },
					]);
				}
				if (
					url === "https://photos.example.com/api/albums/album-1/assets" &&
					method === "PUT"
				) {
					const headers = new Headers(init?.headers);
					expect(headers.get("x-api-key")).toBe("write-scoped-key");
					putBodies.push(JSON.parse(String(init?.body)));
					return jsonResponse(200, [
						{ id: "asset-1", success: true },
						{ id: "asset-2", success: true },
					]);
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		expect(executor).toBeDefined();
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({
				assetIds: ["asset-1", "asset-2"],
				albumName: "AlfyAI",
			}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({
			ok: true,
			detail: 'added to "AlfyAI" album',
		});
		expect(putBodies).toEqual([{ ids: ["asset-1", "asset-2"] }]);
		// Never a POST to /api/albums — an existing album was found.
		const postCalls = fetchMock.mock.calls.filter(
			([, init]) => (init as RequestInit | undefined)?.method === "POST",
		);
		expect(postCalls).toHaveLength(0);
	});

	it("creates the 'AlfyAI' album via POST only when GET found none, then PUTs assets to the new album", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		let createBody: unknown;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					return jsonResponse(200, [
						{ id: "album-2", albumName: "Other", ownerId: "user-1" },
					]);
				}
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "POST"
				) {
					createBody = JSON.parse(String(init?.body));
					return jsonResponse(201, { id: "new-album", albumName: "AlfyAI" });
				}
				if (
					url === "https://photos.example.com/api/albums/new-album/assets" &&
					method === "PUT"
				) {
					return jsonResponse(200, [{ id: "asset-1", success: true }]);
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: true, detail: 'added to "AlfyAI" album' });
		expect(createBody).toEqual({ albumName: "AlfyAI" });
	});

	// Regression test: GET /api/albums (with no `shared` filter) returns both
	// the connection's own albums AND albums shared with them by other users.
	// Matching purely on albumName let this executor put photos into a
	// SHARED album named "AlfyAI" owned by someone else, instead of the
	// user's own album — the ownerId must be checked against the
	// connection's own immichUserId before treating a listed album as "the"
	// AlfyAI album.
	it("ignores a same-named album owned by someone else (a shared album) and creates the user's own instead", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		let createBody: unknown;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					// "AlfyAI" here belongs to a DIFFERENT Immich user — e.g. an
					// album someone else shared with this account — and must not
					// be matched even though the name is identical.
					return jsonResponse(200, [
						{
							id: "someone-elses-album",
							albumName: "AlfyAI",
							ownerId: "some-other-user",
						},
					]);
				}
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "POST"
				) {
					createBody = JSON.parse(String(init?.body));
					return jsonResponse(201, {
						id: "my-own-album",
						albumName: "AlfyAI",
					});
				}
				if (
					url === "https://photos.example.com/api/albums/my-own-album/assets" &&
					method === "PUT"
				) {
					return jsonResponse(200, [{ id: "asset-1", success: true }]);
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: true, detail: 'added to "AlfyAI" album' });
		// A new, user-owned album was created rather than reusing the
		// foreign-owned shared album with the same name.
		expect(createBody).toEqual({ albumName: "AlfyAI" });
	});

	it("treats a duplicate-asset response as success, not an error", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					return jsonResponse(200, [
						{ id: "album-1", albumName: "AlfyAI", ownerId: "user-1" },
					]);
				}
				if (
					url === "https://photos.example.com/api/albums/album-1/assets" &&
					method === "PUT"
				) {
					// Immich reports already-present ids as a per-asset failure —
					// this executor must still report overall success.
					return jsonResponse(200, [
						{ id: "asset-1", success: false, error: "duplicate" },
					]);
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: true, detail: 'added to "AlfyAI" album' });
	});

	it("NEVER issues a DELETE, or any request with a force flag, for any URL", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = (init?.method ?? "GET").toUpperCase();
				expect(method).not.toBe("DELETE");
				if (init?.body) {
					const parsed = JSON.parse(String(init.body));
					expect(parsed).not.toHaveProperty("force");
				}
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					return jsonResponse(200, [
						{ id: "album-1", albumName: "AlfyAI", ownerId: "user-1" },
					]);
				}
				if (
					url === "https://photos.example.com/api/albums/album-1/assets" &&
					method === "PUT"
				) {
					return jsonResponse(200, [{ id: "asset-1", success: true }]);
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(fetchMock).toHaveBeenCalled();
		for (const call of fetchMock.mock.calls) {
			const method = (call[1] as RequestInit | undefined)?.method ?? "GET";
			expect(method.toUpperCase()).not.toBe("DELETE");
		}
	});

	it("returns writes_not_provisioned when the connection has no write secret", async () => {
		const connectionId = await seedImmichConnection({ withWriteSecret: false });
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		const fetchMock = vi.fn();
		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "writes_not_provisioned" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a 401 on the assets PUT maps to needs_reauth and marks the connection", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		const { getConnection } = await import("../store");
		await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					return jsonResponse(200, [
						{ id: "album-1", albumName: "AlfyAI", ownerId: "user-1" },
					]);
				}
				if (
					url === "https://photos.example.com/api/albums/album-1/assets" &&
					method === "PUT"
				) {
					return jsonResponse(401, { message: "unauthorized" });
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		const conn = await getConnection(USER_ID, connectionId);
		expect(conn?.status).toBe("needs_reauth");
	});

	// Regression test: a 401 from the write key on GET /api/albums (listing,
	// to find an existing "AlfyAI" album) was previously mapped to a generic
	// request_failed instead of needs_reauth like the assets PUT above — the
	// user got a vague failure instead of being told to reconnect.
	it("a 401 on the albums GET (listing) maps to needs_reauth and marks the connection", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		const { getConnection } = await import("../store");
		await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					return jsonResponse(401, { message: "unauthorized" });
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		const conn = await getConnection(USER_ID, connectionId);
		expect(conn?.status).toBe("needs_reauth");
	});

	// Regression test: same generic-request_failed bug, but on the POST
	// /api/albums (create) call that runs when no existing "AlfyAI" album was
	// found.
	it("a 401 on the albums POST (create) maps to needs_reauth and marks the connection", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		const { getConnection } = await import("../store");
		await import("./immich");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "GET"
				) {
					return jsonResponse(200, [
						{ id: "album-2", albumName: "Other", ownerId: "user-1" },
					]);
				}
				if (
					url === "https://photos.example.com/api/albums" &&
					method === "POST"
				) {
					return jsonResponse(401, { message: "unauthorized" });
				}
				throw new Error(`Unexpected fetch: ${method} ${url}`);
			},
		);

		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			makeOp(connectionId) as never,
			JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		const conn = await getConnection(USER_ID, connectionId);
		expect(conn?.status).toBe("needs_reauth");
	});

	it("an unsupported action returns unsupported_operation without calling fetch", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		const fetchMock = vi.fn();
		const executor = getWriteExecutor("immich");
		const result = await executor?.execute(
			USER_ID,
			connectionId,
			{
				...makeOp(connectionId),
				action: "immich.delete_asset",
			} as never,
			JSON.stringify({ assetIds: ["asset-1"] }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Item 1 (hardening): a reachable-but-hung Immich server must not stall a
	// pending-write confirmation — the album-lookup GET is bounded by this
	// module's own fetchWithTimeout (~15s). This injected fetch NEVER
	// resolves on its own (proving the abort signal is actually threaded
	// through to fetchImpl); it only rejects, with an AbortError-named error,
	// once its `signal` fires — which fake-timers advancing past the timeout
	// triggers. The result is the module's ordinary request_failed outcome,
	// the same one an immediate network failure on that GET would produce.
	it("aborts a hung album-lookup request after the timeout and surfaces request_failed", async () => {
		const connectionId = await seedImmichConnection();
		const { getWriteExecutor } = await import("../write-executors");
		await import("./immich");

		vi.useFakeTimers();
		try {
			const hangingFetch = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							const abortErr = new Error("The operation was aborted");
							abortErr.name = "AbortError";
							reject(abortErr);
						});
					}),
			);

			const executor = getWriteExecutor("immich");
			const resultPromise = executor?.execute(
				USER_ID,
				connectionId,
				makeOp(connectionId) as never,
				JSON.stringify({ assetIds: ["asset-1"], albumName: "AlfyAI" }),
				{ fetch: hangingFetch as unknown as typeof fetch },
			);
			const assertion = expect(resultPromise).resolves.toEqual({
				ok: false,
				reason: "request_failed",
			});

			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;

			expect(hangingFetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
