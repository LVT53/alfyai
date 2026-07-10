import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { isRedirect } from "@sveltejs/kit";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Route-level test for the callback's user-binding guard — mirrors
// src/routes/api/oauth/google/callback/callback.test.ts byte-for-byte,
// swapped to the OneDrive adapter: a state signed for one user must never
// let a different signed-in user's session complete the connection, even
// though the state signature itself is valid.

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
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

	dbPath = `./data/test-oauth-onedrive-callback-${randomUUID()}.db`;
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
const GRAPH_ME_URL =
	"https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";

function makeEvent(
	searchParams: Record<string, string>,
	userId: string,
): Parameters<typeof import("./+server").GET>[0] {
	const url = new URL("https://app.example.com/api/oauth/onedrive/callback");
	for (const [key, value] of Object.entries(searchParams)) {
		url.searchParams.set(key, value);
	}
	return {
		request: new Request(url),
		locals: { user: { id: userId } },
		params: {},
		url,
		route: { id: "/api/oauth/onedrive/callback" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub for a handler that only reads url/locals
	} as any;
}

describe("GET /api/oauth/onedrive/callback — user-binding guard", () => {
	it("rejects a state signed for a different user: no connection is created for either user, and it redirects with an error", async () => {
		setConfiguredEnv();
		seedUser("userA");
		seedUser("userB");

		const { signOAuthState } = await import(
			"$lib/server/services/connections/providers/onedrive"
		);
		const { listConnectionsForUser } = await import(
			"$lib/server/services/connections/store"
		);
		const { GET } = await import("./+server");

		// State is signed for userA, but the browser session presenting it
		// belongs to userB (e.g. a stolen/replayed callback URL, or two
		// concurrent OAuth flows in different tabs/sessions).
		const stateForUserA = signOAuthState({
			userId: "userA",
			capabilities: ["files"],
		});

		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const event = makeEvent(
			{ code: "auth-code-123", state: stateForUserA },
			"userB",
		);

		let caught: unknown;
		try {
			await GET(event);
			throw new Error("expected GET to throw a redirect");
		} catch (err) {
			caught = err;
		}

		expect(isRedirect(caught)).toBe(true);
		const redirectErr = caught as { status: number; location: string };
		expect(redirectErr.status).toBe(302);
		expect(redirectErr.location).toContain(
			"error=onedrive_oauth_state_mismatch",
		);

		// The guard must fire before any network call or DB write.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await listConnectionsForUser("userA")).toHaveLength(0);
		expect(await listConnectionsForUser("userB")).toHaveLength(0);
	});

	it("control: the same request completes when state userId matches the session user", async () => {
		setConfiguredEnv();
		seedUser("userA");

		const { signOAuthState } = await import(
			"$lib/server/services/connections/providers/onedrive"
		);
		const { listConnectionsForUser } = await import(
			"$lib/server/services/connections/store"
		);
		const { GET } = await import("./+server");

		const stateForUserA = signOAuthState({
			userId: "userA",
			capabilities: ["files"],
		});

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "access-abc",
					refresh_token: "refresh-xyz",
					expires_in: 3600,
					scope: "offline_access Files.Read",
					token_type: "Bearer",
				});
			}
			if (url === GRAPH_ME_URL) {
				return jsonResponse(200, { mail: "alice@example.com" });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const event = makeEvent(
			{ code: "auth-code-123", state: stateForUserA },
			"userA",
		);

		let caught: unknown;
		try {
			await GET(event);
			throw new Error("expected GET to throw a redirect");
		} catch (err) {
			caught = err;
		}

		expect(isRedirect(caught)).toBe(true);
		const redirectErr = caught as { status: number; location: string };
		expect(redirectErr.location).toContain("connected=onedrive");

		expect(await listConnectionsForUser("userA")).toHaveLength(1);
	});
});
