import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Task 8 Finding A (robustness review) — regression test for the OneDrive
// read-path double token-refresh bug: a "read" tool action stats the path
// (the isDirectory guard in files.ts) and then downloads it, and — before
// the fix — each of those two Microsoft Graph calls independently minted a
// fresh access token via onedriveRefreshAccessToken. Because Microsoft
// ROTATES refresh tokens on every use, two refreshes for what is
// conceptually one read doubled vault writes and opened a race where two
// concurrent reads on the same connection could each invalidate the other's
// just-stored refresh token (spurious needs_reauth).
//
// Unlike files.test.ts (which mocks the entire onedrive.ts module so it can
// assert dispatch), this test exercises the REAL onedrive.ts adapter and the
// REAL connections/store.ts (backed by a real sqlite DB, mirroring
// onedrive.test.ts's own setup) end to end through the real runFilesTool, so
// the count of POSTs to Microsoft's token endpoint reflects actual
// production behavior rather than a mocked stand-in. Only connection
// selection (resolve.ts) and the Option A local-distill gate (locality.ts)
// are mocked — neither is relevant to this bug.

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: vi.fn(),
		needsDisambiguation: vi.fn(),
	};
});

vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
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

const ENV_KEYS = [
	"ONEDRIVE_CLIENT_ID",
	"ONEDRIVE_CLIENT_SECRET",
	"ALFYAI_API_SIGNING_KEY",
];

function setConfiguredEnv() {
	process.env.ONEDRIVE_CLIENT_ID = "test-client-id";
	process.env.ONEDRIVE_CLIENT_SECRET = "test-client-secret";
	process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
}

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	for (const key of ENV_KEYS) delete process.env[key];

	dbPath = `./data/test-files-onedrive-read-token-${randomUUID()}.db`;
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
	for (const key of ENV_KEYS) delete process.env[key];
	vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function seedConnection() {
	seedUser("userA");
	const { createConnection } = await import(
		"$lib/server/services/connections/store"
	);
	return createConnection({
		userId: "userA",
		provider: "onedrive",
		label: "OneDrive",
		accountIdentifier: "alice@example.com",
		capabilities: ["files"],
		status: "connected",
		secret: JSON.stringify({
			refreshToken: "refresh-xyz",
			accessToken: "old-access",
		}),
		config: {},
		oauthScopes: ["Files.Read"],
		// Expired on purpose — onedriveRefreshAccessToken always refreshes
		// unconditionally on a read regardless of this, but keeping it in the
		// past mirrors the realistic case the bug report was filed against.
		tokenExpiresAt: Math.floor(Date.now() / 1000) - 10,
	});
}

describe("runFilesTool — OneDrive read resolves the access token exactly once (Task 8 Finding A)", () => {
	it("a 'read' action refreshes the OneDrive access token exactly once even though it stats then downloads", async () => {
		setConfiguredEnv();
		const conn = await seedConnection();

		const { resolveConnectionsForCapability, needsDisambiguation } =
			await import("$lib/server/services/connections/resolve");
		vi.mocked(resolveConnectionsForCapability).mockResolvedValue([conn]);
		vi.mocked(needsDisambiguation).mockReturnValue(false);

		const { hasLocalDistillEnabled } = await import(
			"$lib/server/services/connections/locality"
		);
		vi.mocked(hasLocalDistillEnabled).mockResolvedValue(false);

		let tokenCalls = 0;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === TOKEN_URL) {
					tokenCalls += 1;
					return jsonResponse(200, {
						access_token: "fresh-access",
						expires_in: 3600,
						// Microsoft rotates the refresh token on every use — a second
						// refresh here would silently replace the one the first
						// refresh just stored (the exact vault-churn/race this fix
						// closes).
						refresh_token: `refresh-rotated-${tokenCalls}`,
					});
				}
				if (url === `${GRAPH_BASE}/me/drive/root:/notes/todo.txt`) {
					return jsonResponse(200, {
						name: "todo.txt",
						size: 5,
						file: { mimeType: "text/plain" },
						lastModifiedDateTime: "2024-01-02T00:00:00Z",
					});
				}
				if (url === `${GRAPH_BASE}/me/drive/root:/notes/todo.txt:/content`) {
					const headers = new Headers(init?.headers);
					expect(headers.get("Authorization")).toBe("Bearer fresh-access");
					return new Response("hello", { status: 200 });
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { runFilesTool } = await import("./files");

		const outcome = await runFilesTool(
			"userA",
			{ action: "read", path: "notes/todo.txt" },
			"model1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results[0]?.content).toBe("hello");
		expect(tokenCalls).toBe(1);
	});
});
