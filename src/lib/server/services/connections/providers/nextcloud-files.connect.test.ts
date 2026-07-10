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
	dbPath = `./data/test-connections-nextcloud-${randomUUID()}.db`;
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

describe("nextcloudConnectStart", () => {
	it("parses the login/v2 response into loginUrl/pollToken/pollEndpoint and normalizes a trailing slash", async () => {
		const { nextcloudConnectStart } = await import("./nextcloud-files");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/index.php/login/v2",
				);
				expect(init?.method).toBe("POST");
				const headers = new Headers(init?.headers);
				expect(headers.get("User-Agent")).toBe("AlfyAI");
				return jsonResponse(200, {
					poll: {
						token: "poll-token-abc",
						endpoint: "https://cloud.example.com/index.php/login/v2/poll",
					},
					login: "https://cloud.example.com/index.php/login/v2/flow/42",
				});
			},
		);

		const result = await nextcloudConnectStart("https://cloud.example.com/", {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result).toEqual({
			loginUrl: "https://cloud.example.com/index.php/login/v2/flow/42",
			pollToken: "poll-token-abc",
			pollEndpoint: "https://cloud.example.com/index.php/login/v2/poll",
			serverUrl: "https://cloud.example.com",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("assertPublicHttpsUrl", () => {
	it("accepts a public https URL", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(assertPublicHttpsUrl("https://alfycloud.hu")).toBe(
			"https://alfycloud.hu",
		);
	});

	it("rejects a non-https URL", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("http://alfycloud.hu")).toThrow();
	});

	it("rejects localhost", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("https://localhost")).toThrow();
	});

	it("rejects loopback IPv4", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("https://127.0.0.1")).toThrow();
	});

	it("rejects 10.0.0.0/8 private range", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("https://10.1.2.3")).toThrow();
	});

	it("rejects 192.168.0.0/16 private range", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("https://192.168.1.5")).toThrow();
	});

	it("rejects a non-URL string", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		// "not-a-url" is no longer a good example here: once a scheme-less
		// value is treated as a bare host (see the "accepts a bare host"
		// tests below), a plain label like that is a legitimate single-label
		// hostname. Use input that is still unparseable as a URL even after
		// https:// is prepended (embedded whitespace).
		expect(() => assertPublicHttpsUrl("not a url")).toThrow();
	});

	it("rejects an empty string", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("")).toThrow();
	});

	it("rejects a whitespace-only string", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("   ")).toThrow();
	});

	// --- Bare-host convenience (Task 6) ---------------------------------

	it("prepends https:// to a bare host with no scheme", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(assertPublicHttpsUrl("cloud.example.com")).toBe(
			"https://cloud.example.com",
		);
	});

	it("prepends https:// to a bare host and preserves port/path", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(assertPublicHttpsUrl("cloud.example.com:8443/dav")).toBe(
			"https://cloud.example.com:8443/dav",
		);
	});

	it("trims surrounding whitespace before checking for a scheme", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(assertPublicHttpsUrl("  cloud.example.com  ")).toBe(
			"https://cloud.example.com",
		);
	});

	it("leaves an explicit https:// URL byte-for-byte unchanged", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(assertPublicHttpsUrl("https://cloud.example.com:8443/dav")).toBe(
			"https://cloud.example.com:8443/dav",
		);
	});

	it("still rejects an explicit http:// URL rather than upgrading it", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("http://cloud.example.com")).toThrow();
	});

	it("rejects a bare localhost host", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("localhost")).toThrow();
	});

	it("rejects a bare loopback IPv4 host", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("127.0.0.1")).toThrow();
	});

	it("rejects a bare 10.0.0.0/8 host", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("10.0.0.1")).toThrow();
	});

	it("rejects a bare 192.168.0.0/16 host", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("192.168.1.5")).toThrow();
	});

	it("rejects a bracketed bare IPv6 loopback host", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("[::1]")).toThrow();
	});

	it("rejects an https IPv6 loopback host (scheme present, unchanged behavior)", async () => {
		const { assertPublicHttpsUrl } = await import("./nextcloud-files");
		expect(() => assertPublicHttpsUrl("https://[::1]")).toThrow();
	});
});

describe("nextcloudConnectPoll", () => {
	it("returns { status: 'pending' } on 404 and stores nothing", async () => {
		const { nextcloudConnectPoll } = await import("./nextcloud-files");
		const { listConnectionsForUser } = await import("../store");
		seedUser("userA");

		const fetchMock = vi.fn(async () => new Response("", { status: 404 }));

		const result = await nextcloudConnectPoll({
			userId: "userA",
			serverUrl: "https://cloud.example.com",
			pollToken: "poll-token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result).toEqual({ status: "pending" });
		expect(await listConnectionsForUser("userA")).toEqual([]);
	});

	it("returns { status: 'connected', connection } on 200 and stores the appPassword as the only secret", async () => {
		const { nextcloudConnectPoll } = await import("./nextcloud-files");
		const { getConnectionSecret } = await import("../store");
		seedUser("userA");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/index.php/login/v2/poll",
				);
				expect(init?.method).toBe("POST");
				expect(String(init?.body)).toBe("token=poll-token-abc");
				return jsonResponse(200, {
					server: "https://cloud.example.com",
					loginName: "alice",
					appPassword: "app-password-xyz",
				});
			},
		);

		const result = await nextcloudConnectPoll({
			userId: "userA",
			serverUrl: "https://cloud.example.com",
			pollToken: "poll-token-abc",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(result.status).toBe("connected");
		if (result.status !== "connected") throw new Error("unreachable");

		expect(result.connection.provider).toBe("nextcloud");
		expect(result.connection.accountIdentifier).toBe("alice");
		expect(result.connection.capabilities).toEqual(["files"]);
		expect(result.connection.status).toBe("connected");
		expect(result.connection.hasSecret).toBe(true);
		expect(result.connection.config).toEqual({
			serverUrl: "https://cloud.example.com",
			loginName: "alice",
		});
		expect("secret" in result.connection).toBe(false);
		expect(JSON.stringify(result.connection)).not.toContain("app-password-xyz");

		const decrypted = await getConnectionSecret("userA", result.connection.id);
		expect(decrypted).toBe("app-password-xyz");
	});

	it("derives the poll endpoint from serverUrl and rejects a private serverUrl", async () => {
		const { nextcloudConnectPoll } = await import("./nextcloud-files");
		seedUser("userA");

		const fetchMock = vi.fn(async () => new Response("", { status: 404 }));

		await expect(
			nextcloudConnectPoll({
				userId: "userA",
				serverUrl: "https://192.168.1.5",
				pollToken: "poll-token-abc",
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("treats a malformed 200 body (missing appPassword) as an error and creates no connection", async () => {
		const { nextcloudConnectPoll } = await import("./nextcloud-files");
		const { listConnectionsForUser } = await import("../store");
		seedUser("userA");

		const fetchMock = vi.fn(async () =>
			jsonResponse(200, {
				server: "https://cloud.example.com",
				loginName: "alice",
				// appPassword missing
			}),
		);

		await expect(
			nextcloudConnectPoll({
				userId: "userA",
				serverUrl: "https://cloud.example.com",
				pollToken: "poll-token-abc",
				fetch: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow();

		expect(await listConnectionsForUser("userA")).toEqual([]);
	});

	it("a second successful poll for the same loginName updates the existing connection instead of duplicating it", async () => {
		const { nextcloudConnectPoll } = await import("./nextcloud-files");
		const { listConnectionsForUser, getConnectionSecret } = await import(
			"../store"
		);
		seedUser("userA");

		const firstFetch = vi.fn(async () =>
			jsonResponse(200, {
				server: "https://cloud.example.com",
				loginName: "alice",
				appPassword: "app-password-xyz",
			}),
		);
		const first = await nextcloudConnectPoll({
			userId: "userA",
			serverUrl: "https://cloud.example.com",
			pollToken: "poll-token-abc",
			fetch: firstFetch as unknown as typeof fetch,
		});
		expect(first.status).toBe("connected");
		if (first.status !== "connected") throw new Error("unreachable");

		const secondFetch = vi.fn(async () =>
			jsonResponse(200, {
				server: "https://cloud.example.com",
				loginName: "alice",
				appPassword: "app-password-refreshed",
			}),
		);
		const second = await nextcloudConnectPoll({
			userId: "userA",
			serverUrl: "https://cloud.example.com",
			pollToken: "poll-token-def",
			fetch: secondFetch as unknown as typeof fetch,
		});
		expect(second.status).toBe("connected");
		if (second.status !== "connected") throw new Error("unreachable");

		expect(second.connection.id).toBe(first.connection.id);
		expect(second.connection.status).toBe("connected");

		const rows = await listConnectionsForUser("userA");
		expect(rows).toHaveLength(1);

		const decrypted = await getConnectionSecret("userA", second.connection.id);
		expect(decrypted).toBe("app-password-refreshed");
	});
});

describe("nextcloudFilesAdapter.checkHealth", () => {
	async function seedConnection() {
		const { createConnection } = await import("../store");
		seedUser("userA");
		return createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: "alice",
			capabilities: ["files"],
			status: "connected",
			secret: "app-password-xyz",
			config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
		});
	}

	it("200 -> connected", async () => {
		const { nextcloudFilesAdapter } = await import("./nextcloud-files");
		const conn = await seedConnection();

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://cloud.example.com/ocs/v1.php/cloud/user",
				);
				const headers = new Headers(init?.headers);
				expect(headers.get("OCS-APIRequest")).toBe("true");
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from("alice:app-password-xyz").toString("base64")}`,
				);
				return new Response("", { status: 200 });
			},
		);

		const health = await nextcloudFilesAdapter.checkHealth(
			"app-password-xyz",
			conn,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(health.status).toBe("connected");
	});

	it("401 -> needs_reauth", async () => {
		const { nextcloudFilesAdapter } = await import("./nextcloud-files");
		const conn = await seedConnection();

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		const health = await nextcloudFilesAdapter.checkHealth(
			"app-password-xyz",
			conn,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("app-password-xyz");
	});

	it("500 -> error, no secret in detail", async () => {
		const { nextcloudFilesAdapter } = await import("./nextcloud-files");
		const conn = await seedConnection();

		const fetchMock = vi.fn(async () => new Response("", { status: 500 }));

		const health = await nextcloudFilesAdapter.checkHealth(
			"app-password-xyz",
			conn,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(health.status).toBe("error");
		expect(health.detail).not.toContain("app-password-xyz");
	});
});
