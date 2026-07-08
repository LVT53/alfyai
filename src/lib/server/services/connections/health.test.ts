import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { ConnectionAdapter } from "./registry";

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
	dbPath = `./data/test-connections-health-${randomUUID()}.db`;
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

function makeFakeAdapter(
	checkHealth: ConnectionAdapter["checkHealth"],
): ConnectionAdapter {
	return {
		provider: "nextcloud",
		checkHealth,
	};
}

describe("connections adapter registry", () => {
	beforeEach(async () => {
		const { __resetConnectionAdaptersForTest } = await import("./adapters");
		__resetConnectionAdaptersForTest();
	});

	it("register + get returns the adapter; unknown provider returns null; list reflects registrations", async () => {
		const {
			registerConnectionAdapter,
			getConnectionAdapter,
			listRegisteredAdapterProviders,
		} = await import("./adapters");

		expect(getConnectionAdapter("nextcloud")).toBeNull();
		expect(listRegisteredAdapterProviders()).toEqual([]);

		const fake = makeFakeAdapter(async () => ({
			status: "connected",
			detail: null,
		}));
		registerConnectionAdapter(fake);

		expect(getConnectionAdapter("nextcloud")).toBe(fake);
		expect(getConnectionAdapter("google")).toBeNull();
		expect(listRegisteredAdapterProviders()).toEqual(["nextcloud"]);
	});
});

describe("checkConnectionHealth", () => {
	beforeEach(async () => {
		const { __resetConnectionAdaptersForTest } = await import("./adapters");
		__resetConnectionAdaptersForTest();
	});

	async function seedConnectionWithSecret() {
		const { createConnection } = await import("./store");
		seedUser("userA");
		seedUser("userB");
		const conn = await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "A's Nextcloud",
			secret: "s3cret-token",
		});
		return conn;
	}

	it("happy path: connected status is returned and persisted", async () => {
		const { registerConnectionAdapter } = await import("./adapters");
		const { checkConnectionHealth } = await import("./health");
		const { getConnection } = await import("./store");
		const conn = await seedConnectionWithSecret();

		registerConnectionAdapter(
			makeFakeAdapter(async () => ({ status: "connected", detail: null })),
		);

		const result = await checkConnectionHealth("userA", conn.id);
		expect(result).toEqual({ status: "connected", detail: null });

		const persisted = await getConnection("userA", conn.id);
		expect(persisted?.status).toBe("connected");
		expect(persisted?.statusDetail).toBeNull();
	});

	it("needs_reauth status is returned and persisted", async () => {
		const { registerConnectionAdapter } = await import("./adapters");
		const { checkConnectionHealth } = await import("./health");
		const { getConnection } = await import("./store");
		const conn = await seedConnectionWithSecret();

		registerConnectionAdapter(
			makeFakeAdapter(async () => ({
				status: "needs_reauth",
				detail: "token expired",
			})),
		);

		const result = await checkConnectionHealth("userA", conn.id);
		expect(result).toEqual({ status: "needs_reauth", detail: "token expired" });

		const persisted = await getConnection("userA", conn.id);
		expect(persisted?.status).toBe("needs_reauth");
		expect(persisted?.statusDetail).toBe("token expired");
	});

	it("adapter throwing yields a non-throwing error result with no secret leaked", async () => {
		const { registerConnectionAdapter } = await import("./adapters");
		const { checkConnectionHealth } = await import("./health");
		const { getConnection } = await import("./store");
		const conn = await seedConnectionWithSecret();

		registerConnectionAdapter(
			makeFakeAdapter(async () => {
				throw new Error("boom: connection refused");
			}),
		);

		const result = await checkConnectionHealth("userA", conn.id);
		expect(result?.status).toBe("error");
		expect(result?.detail).toContain("boom: connection refused");
		expect(result?.detail).not.toContain("s3cret-token");

		const persisted = await getConnection("userA", conn.id);
		expect(persisted?.status).toBe("error");
		expect(persisted?.statusDetail).not.toContain("s3cret-token");
	});

	it("no adapter registered for the provider returns a non-throwing result and persists it", async () => {
		const { checkConnectionHealth } = await import("./health");
		const { getConnection } = await import("./store");
		const conn = await seedConnectionWithSecret();

		const result = await checkConnectionHealth("userA", conn.id);
		expect(result).not.toBeNull();
		expect(["error", "needs_reauth"]).toContain(result?.status);
		expect(result?.detail).toBeTruthy();

		const persisted = await getConnection("userA", conn.id);
		expect(persisted?.status).toBe(result?.status);
		expect(persisted?.statusDetail).toBe(result?.detail);
	});

	it("connection id not owned by the user returns null and does not mutate the row", async () => {
		const { registerConnectionAdapter } = await import("./adapters");
		const { checkConnectionHealth } = await import("./health");
		const { getConnection } = await import("./store");
		const conn = await seedConnectionWithSecret();

		registerConnectionAdapter(
			makeFakeAdapter(async () => ({ status: "connected", detail: null })),
		);

		const result = await checkConnectionHealth("userB", conn.id);
		expect(result).toBeNull();

		const stillA = await getConnection("userA", conn.id);
		expect(stillA?.status).toBe("disconnected");
		expect(stillA?.statusDetail).toBeNull();
	});
});
