import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { ConnectionPublic } from "../store";
import type { WriteOperation } from "../write-guard";

// executeNextcloudWrite (below) loads the connection + decrypts its secret
// via the real store layer, so this whole file runs against a throwaway
// sqlite db per test — same harness as store.test.ts. The adapter-level
// tests (nextcloudPutFile/MoveFile/DeleteFile) never touch the store, so
// this setup is a no-op overhead for them, not a behavior change.
let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

beforeEach(() => {
	dbPath = `./data/test-nextcloud-write-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user-1@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

const CONN_CONFIG = {
	serverUrl: "https://cloud.example.com",
	loginName: "alice",
};

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: true,
		writeAllowlist: ["/AlfyAI"],
		capabilities: ["files"],
		config: CONN_CONFIG,
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Adapter-level tests (nextcloudPutFile / nextcloudMoveFile /
// nextcloudDeleteFile) — mocked fetch only, no DB involved.
// ---------------------------------------------------------------------------

describe("nextcloudPutFile", () => {
	it("small payload: issues a single PUT and returns the etag", async () => {
		const { nextcloudPutFile } = await import("./nextcloud-files");
		const conn = makeConn();
		const bytes = new TextEncoder().encode("hello world");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice/Documents/note.txt",
				);
				expect(init?.method).toBe("PUT");
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from("alice:app-password-xyz").toString("base64")}`,
				);
				expect(
					Buffer.from(init?.body as Uint8Array).equals(Buffer.from(bytes)),
				).toBe(true);
				return new Response(null, {
					status: 201,
					headers: { ETag: '"new-etag"' },
				});
			},
		);

		const result = await nextcloudPutFile(
			conn,
			"app-password-xyz",
			"Documents/note.txt",
			bytes,
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.etag).toBe('"new-etag"');
	});

	it("large payload: uses chunked upload v2 (MKCOL -> PUT chunks -> MOVE .file)", async () => {
		const { nextcloudPutFile } = await import("./nextcloud-files");
		const conn = makeConn();
		const bytes = new Uint8Array(25); // 3 chunks at chunkedThreshold-forcing size 10

		const calls: { method: string; url: string }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ method: String(init?.method), url: String(input) });
				if (init?.method === "MKCOL") {
					return new Response(null, { status: 201 });
				}
				if (init?.method === "MOVE") {
					const headers = new Headers(init?.headers);
					expect(headers.get("Destination")).toBe(
						"https://cloud.example.com/remote.php/dav/files/alice/big.bin",
					);
					return new Response(null, {
						status: 201,
						headers: { ETag: '"assembled-etag"' },
					});
				}
				// chunk PUTs
				return new Response(null, { status: 201 });
			},
		);

		// chunkedThreshold much smaller than CHUNK_SIZE_BYTES default (5MB) is
		// fine — the adapter only uses CHUNK_SIZE_BYTES for slicing, threshold
		// only decides single-PUT vs chunked.
		const result = await nextcloudPutFile(
			conn,
			"app-password-xyz",
			"big.bin",
			bytes,
			{ fetch: fetchMock as unknown as typeof fetch, chunkedThreshold: 10 },
		);

		expect(calls[0]?.method).toBe("MKCOL");
		expect(calls[0]?.url).toContain("/remote.php/dav/uploads/alice/");

		const putCalls = calls.filter((c) => c.method === "PUT");
		expect(putCalls.length).toBeGreaterThanOrEqual(1);
		for (const c of putCalls) {
			expect(c.url).toContain(calls[0]?.url);
		}

		const moveCall = calls[calls.length - 1];
		expect(moveCall?.method).toBe("MOVE");
		expect(moveCall?.url).toBe(`${calls[0]?.url}/.file`);

		expect(result.etag).toBe('"assembled-etag"');
	});

	it("a 412 on a conditional (If-Match) write throws etag_mismatch and never falls back to an unconditional PUT", async () => {
		const { nextcloudPutFile, NextcloudFilesError } = await import(
			"./nextcloud-files"
		);
		const conn = makeConn();
		const bytes = new TextEncoder().encode("new content");

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("If-Match")).toBe('"old-etag"');
				return new Response(null, { status: 412 });
			},
		);

		let caught: unknown;
		try {
			await nextcloudPutFile(
				conn,
				"app-password-xyz",
				"Documents/note.txt",
				bytes,
				{
					fetch: fetchMock as unknown as typeof fetch,
					ifMatch: '"old-etag"',
				},
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(NextcloudFilesError);
		expect((caught as InstanceType<typeof NextcloudFilesError>).code).toBe(
			"etag_mismatch",
		);
		// Exactly one request was made — no follow-up unconditional PUT.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects a traversal path before any fetch is made", async () => {
		const { nextcloudPutFile } = await import("./nextcloud-files");
		const conn = makeConn();
		const fetchMock = vi.fn();

		await expect(
			nextcloudPutFile(
				conn,
				"app-password-xyz",
				"../../etc/passwd",
				new Uint8Array([1, 2, 3]),
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("nextcloudDeleteFile", () => {
	it("issues a WebDAV DELETE to the file URL (goes to trash, no permanent-delete param)", async () => {
		const { nextcloudDeleteFile } = await import("./nextcloud-files");
		const conn = makeConn();

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice/Documents/old.txt",
				);
				expect(String(input)).not.toContain("permanent");
				expect(init?.method).toBe("DELETE");
				return new Response(null, { status: 204 });
			},
		);

		await nextcloudDeleteFile(conn, "app-password-xyz", "Documents/old.txt", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects a traversal path before any fetch is made", async () => {
		const { nextcloudDeleteFile } = await import("./nextcloud-files");
		const conn = makeConn();
		const fetchMock = vi.fn();

		await expect(
			nextcloudDeleteFile(conn, "app-password-xyz", "../secret.txt", {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("nextcloudMoveFile", () => {
	it("sends Destination + Overwrite:F by default", async () => {
		const { nextcloudMoveFile } = await import("./nextcloud-files");
		const conn = makeConn();

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice/Documents/old.txt",
				);
				expect(init?.method).toBe("MOVE");
				const headers = new Headers(init?.headers);
				expect(headers.get("Destination")).toBe(
					"https://cloud.example.com/remote.php/dav/files/alice/Documents/new.txt",
				);
				expect(headers.get("Overwrite")).toBe("F");
				return new Response(null, { status: 201 });
			},
		);

		await nextcloudMoveFile(
			conn,
			"app-password-xyz",
			"Documents/old.txt",
			"Documents/new.txt",
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("a 412 (overwrite refused) throws a typed conflict error", async () => {
		const { nextcloudMoveFile, NextcloudFilesError } = await import(
			"./nextcloud-files"
		);
		const conn = makeConn();

		const fetchMock = vi.fn(async () => new Response(null, { status: 412 }));

		let caught: unknown;
		try {
			await nextcloudMoveFile(
				conn,
				"app-password-xyz",
				"Documents/old.txt",
				"Documents/new.txt",
				{ fetch: fetchMock as unknown as typeof fetch },
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(NextcloudFilesError);
		expect((caught as InstanceType<typeof NextcloudFilesError>).code).toBe(
			"conflict",
		);
	});

	it("honors opts.overwrite by sending Overwrite:T", async () => {
		const { nextcloudMoveFile } = await import("./nextcloud-files");
		const conn = makeConn();

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("Overwrite")).toBe("T");
				return new Response(null, { status: 204 });
			},
		);

		await nextcloudMoveFile(
			conn,
			"app-password-xyz",
			"Documents/old.txt",
			"Documents/new.txt",
			{ fetch: fetchMock as unknown as typeof fetch, overwrite: true },
		);
	});

	it("rejects a traversal path before any fetch is made", async () => {
		const { nextcloudMoveFile } = await import("./nextcloud-files");
		const conn = makeConn();
		const fetchMock = vi.fn();

		await expect(
			nextcloudMoveFile(conn, "app-password-xyz", "../a.txt", "b.txt", {
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// executeNextcloudWrite — guarded service tests. These need a real (sqlite)
// store since the function loads the connection + decrypts the secret via
// the store layer, same harness as store.test.ts.
// ---------------------------------------------------------------------------

describe("executeNextcloudWrite", () => {
	async function seedConnection(
		overrides: { allowWrites?: boolean; writeAllowlist?: string[] } = {},
	): Promise<string> {
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "user-1",
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: "alice",
			capabilities: ["files"],
			status: "connected",
			secret: "app-password-xyz",
			allowWrites: overrides.allowWrites ?? true,
			writeAllowlist: overrides.writeAllowlist ?? ["/AlfyAI"],
			config: CONN_CONFIG,
		});
		return conn.id;
	}

	it("refuses when allowWrites is not true, and never calls the adapter fetch", async () => {
		const { executeNextcloudWrite } = await import("./nextcloud-files");
		const connectionId = await seedConnection({ allowWrites: false });

		const fetchMock = vi.fn();

		const result = await executeNextcloudWrite(
			"user-1",
			connectionId,
			{
				kind: "put",
				requestedPath: "/AlfyAI/note.txt",
				bytes: new TextEncoder().encode("hi"),
				contentSummary: "hi",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "writes_disabled" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("put with no requestedPath lands under the allowlist default area", async () => {
		const { executeNextcloudWrite } = await import("./nextcloud-files");
		const connectionId = await seedConnection({
			allowWrites: true,
			writeAllowlist: ["/AlfyAI"],
		});

		let putUrl = "";
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				putUrl = String(input);
				expect(init?.method).toBe("PUT");
				return new Response(null, { status: 201, headers: { ETag: '"e1"' } });
			},
		);

		const result = await executeNextcloudWrite(
			"user-1",
			connectionId,
			{
				kind: "put",
				bytes: new TextEncoder().encode("hi"),
				contentSummary: "hi",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: true, etag: '"e1"' });
		expect(putUrl).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI",
		);
	});

	it("propagates a typed adapter error (etag_mismatch) as {ok:false, reason} without leaking the password", async () => {
		const { executeNextcloudWrite } = await import("./nextcloud-files");
		const connectionId = await seedConnection();

		const fetchMock = vi.fn(async () => new Response(null, { status: 412 }));

		const result = await executeNextcloudWrite(
			"user-1",
			connectionId,
			{
				kind: "put",
				requestedPath: "/AlfyAI/note.txt",
				bytes: new TextEncoder().encode("hi"),
				ifMatch: '"stale"',
				contentSummary: "hi",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "etag_mismatch" });
		expect(JSON.stringify(result)).not.toContain("app-password-xyz");
	});

	it("move and delete requests reach the adapter with the connection's decrypted secret", async () => {
		const { executeNextcloudWrite } = await import("./nextcloud-files");
		const connectionId = await seedConnection();

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from("alice:app-password-xyz").toString("base64")}`,
				);
				return new Response(null, { status: 204 });
			},
		);

		const moveResult = await executeNextcloudWrite(
			"user-1",
			connectionId,
			{ kind: "move", fromPath: "/AlfyAI/a.txt", toPath: "/AlfyAI/b.txt" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(moveResult).toEqual({ ok: true });

		const deleteResult = await executeNextcloudWrite(
			"user-1",
			connectionId,
			{ kind: "delete", path: "/AlfyAI/b.txt" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(deleteResult).toEqual({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// Registered write-executor mapping (toNextcloudWriteRequest) — GAP A1. The
// mapping used to hard-refuse anything that wasn't "files.put"
// (`if (op.action !== "files.put") return null`), so a proposed move/delete
// could never execute even after confirm. These prove the mapping now routes
// "files.move" and "files.delete" onto the existing NextcloudWriteRequest
// variants and actually issues the MOVE/DELETE on confirm.
// ---------------------------------------------------------------------------
describe("nextcloud registered write executor — move/delete mapping (GAP A1)", () => {
	async function seedConnection(): Promise<string> {
		const { createConnection } = await import("../store");
		const conn = await createConnection({
			userId: "user-1",
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: "alice",
			capabilities: ["files"],
			status: "connected",
			secret: "app-password-xyz",
			allowWrites: true,
			writeAllowlist: ["/AlfyAI"],
			config: CONN_CONFIG,
		});
		return conn.id;
	}

	async function nextcloudExecutor() {
		// Importing the module runs its top-level registerWriteExecutor side
		// effect.
		await import("./nextcloud-files");
		const { getWriteExecutor } = await import("../write-executors");
		const executor = getWriteExecutor("nextcloud");
		if (!executor) throw new Error("nextcloud write executor not registered");
		return executor;
	}

	it("maps a files.move op (content = {fromPath,toPath}) onto a WebDAV MOVE", async () => {
		const connectionId = await seedConnection();
		const executor = await nextcloudExecutor();

		let sawMethod = "";
		let sawUrl = "";
		let sawDestination: string | null = null;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				sawMethod = init?.method ?? "";
				sawUrl = String(input);
				sawDestination = new Headers(init?.headers).get("Destination");
				return new Response(null, { status: 201 });
			},
		);

		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.move",
			summary: "Move a.txt to /AlfyAI/b.txt",
			reversible: true,
			destructive: false,
			target: { path: "/AlfyAI/b.txt", withinAllowlist: true },
		};
		const result = await executor.execute(
			"user-1",
			connectionId,
			op,
			JSON.stringify({ fromPath: "/AlfyAI/a.txt", toPath: "/AlfyAI/b.txt" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: true });
		expect(sawMethod).toBe("MOVE");
		expect(sawUrl).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/a.txt",
		);
		expect(sawDestination).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/b.txt",
		);
	});

	it("maps a files.delete op onto a WebDAV DELETE at op.target.path", async () => {
		const connectionId = await seedConnection();
		const executor = await nextcloudExecutor();

		let sawMethod = "";
		let sawUrl = "";
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				sawMethod = init?.method ?? "";
				sawUrl = String(input);
				return new Response(null, { status: 204 });
			},
		);

		const op: WriteOperation = {
			provider: "nextcloud",
			connectionId,
			action: "files.delete",
			summary: "Move old.txt to trash",
			reversible: true,
			destructive: true,
			target: { path: "/AlfyAI/old.txt", withinAllowlist: true },
		};
		const result = await executor.execute("user-1", connectionId, op, "", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result).toEqual({ ok: true });
		expect(sawMethod).toBe("DELETE");
		expect(sawUrl).toBe(
			"https://cloud.example.com/remote.php/dav/files/alice/AlfyAI/old.txt",
		);
		expect(sawUrl).not.toContain("permanent");
	});
});
