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
	dbPath = `./data/test-connections-resolve-${randomUUID()}.db`;
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

describe("resolveConnectionsForCapability", () => {
	it("returns [] and needsDisambiguation is false when the user has no connections", async () => {
		const { resolveConnectionsForCapability, needsDisambiguation } =
			await import("./resolve");
		seedUser("userA");

		const result = await resolveConnectionsForCapability("userA", "calendar");
		expect(result).toEqual([]);
		expect(needsDisambiguation(result)).toBe(false);
	});

	it("returns exactly one connected Google calendar connection", async () => {
		const { createConnection } = await import("./store");
		const { resolveConnectionsForCapability, needsDisambiguation } =
			await import("./resolve");
		seedUser("userA");

		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			status: "connected",
			capabilities: ["calendar"],
		});

		const result = await resolveConnectionsForCapability("userA", "calendar");
		expect(result).toEqual([conn]);
		expect(needsDisambiguation(result)).toBe(false);
	});

	it("returns both when two connected Google accounts serve the capability", async () => {
		const { createConnection } = await import("./store");
		const { resolveConnectionsForCapability, needsDisambiguation } =
			await import("./resolve");
		seedUser("userA");

		const connA = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			accountIdentifier: "personal@gmail.com",
			status: "connected",
			capabilities: ["calendar"],
		});
		const connB = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work Google",
			accountIdentifier: "work@gmail.com",
			status: "connected",
			capabilities: ["calendar"],
		});

		const result = await resolveConnectionsForCapability("userA", "calendar");
		expect(result).toHaveLength(2);
		expect(result.map((c) => c.id).sort()).toEqual([connA.id, connB.id].sort());
		expect(needsDisambiguation(result)).toBe(true);
	});

	it("excludes a connection whose status is needs_reauth or disconnected", async () => {
		const { createConnection } = await import("./store");
		const { resolveConnectionsForCapability } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Needs reauth",
			accountIdentifier: "reauth@gmail.com",
			status: "needs_reauth",
			capabilities: ["calendar"],
		});
		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Disconnected",
			accountIdentifier: "disconnected@gmail.com",
			status: "disconnected",
			capabilities: ["calendar"],
		});

		const result = await resolveConnectionsForCapability("userA", "calendar");
		expect(result).toEqual([]);
	});

	it("excludes a connected connection that does not have the capability enabled", async () => {
		const { createConnection } = await import("./store");
		const { resolveConnectionsForCapability } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			status: "connected",
			capabilities: ["contacts"],
		});

		const result = await resolveConnectionsForCapability("userA", "calendar");
		expect(result).toEqual([]);
	});

	it("excludes a connection whose provider does not power the capability", async () => {
		const { createConnection } = await import("./store");
		const { resolveConnectionsForCapability } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "immich",
			label: "Immich",
			status: "connected",
			capabilities: ["calendar"],
		});

		const result = await resolveConnectionsForCapability("userA", "calendar");
		expect(result).toEqual([]);
	});
});

describe("getEnabledConnectionCapabilities", () => {
	it("returns an empty set when the user has no connections", async () => {
		const { getEnabledConnectionCapabilities } = await import("./resolve");
		seedUser("userA");

		const result = await getEnabledConnectionCapabilities("userA");
		expect(result).toEqual(new Set());
	});

	it("includes 'files' when a connected Nextcloud connection has files enabled", async () => {
		const { createConnection } = await import("./store");
		const { getEnabledConnectionCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
		});

		const result = await getEnabledConnectionCapabilities("userA");
		expect(result).toEqual(new Set(["files"]));
	});

	it("excludes 'files' when the Nextcloud connection is not connected", async () => {
		const { createConnection } = await import("./store");
		const { getEnabledConnectionCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "needs_reauth",
			capabilities: ["files"],
		});

		const result = await getEnabledConnectionCapabilities("userA");
		expect(result).toEqual(new Set());
	});

	it("excludes 'files' when the connection does not have it enabled", async () => {
		const { createConnection } = await import("./store");
		const { getEnabledConnectionCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["contacts"],
		});

		const result = await getEnabledConnectionCapabilities("userA");
		expect(result.has("files")).toBe(false);
	});

	it("aggregates capabilities across multiple connected providers", async () => {
		const { createConnection } = await import("./store");
		const { getEnabledConnectionCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
		});
		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			capabilities: ["calendar"],
		});

		const result = await getEnabledConnectionCapabilities("userA");
		expect(result).toEqual(new Set(["files", "calendar"]));
	});
});

describe("getDefaultOnCapabilities", () => {
	it("returns an empty set when the user has no connections", async () => {
		const { getDefaultOnCapabilities } = await import("./resolve");
		seedUser("userA");

		const result = await getDefaultOnCapabilities("userA");
		expect(result).toEqual(new Set());
	});

	it("includes a served capability whose connection has defaultOn=true", async () => {
		const { createConnection } = await import("./store");
		const { getDefaultOnCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
			defaultOn: true,
		});

		const result = await getDefaultOnCapabilities("userA");
		expect(result).toEqual(new Set(["files"]));
	});

	it("excludes a served-but-defaultOff capability", async () => {
		const { createConnection } = await import("./store");
		const { getDefaultOnCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
			defaultOn: false,
		});

		const result = await getDefaultOnCapabilities("userA");
		expect(result).toEqual(new Set());
	});

	it("only includes the defaultOn capability out of several served ones", async () => {
		const { createConnection } = await import("./store");
		const { getDefaultOnCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
			defaultOn: true,
		});
		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			capabilities: ["calendar"],
			defaultOn: false,
		});

		const result = await getDefaultOnCapabilities("userA");
		expect(result).toEqual(new Set(["files"]));
	});
});

describe("resolveActiveCapabilities", () => {
	it("fails closed: drops a requested capability the user does not serve", async () => {
		const { createConnection } = await import("./store");
		const { resolveActiveCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
		});

		const result = await resolveActiveCapabilities("userA", [
			"files",
			"calendar",
		]);
		expect(result).toEqual(new Set(["files"]));
	});

	it("returns an empty set when the client explicitly requests nothing", async () => {
		const { createConnection } = await import("./store");
		const { resolveActiveCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
			defaultOn: true,
		});

		const result = await resolveActiveCapabilities("userA", []);
		expect(result).toEqual(new Set());
	});

	it("falls back to the defaultOn set (not the full served set) when requested is null", async () => {
		const { createConnection } = await import("./store");
		const { resolveActiveCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
			defaultOn: true,
		});
		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			capabilities: ["calendar"],
			defaultOn: false,
		});

		const result = await resolveActiveCapabilities("userA", null);
		expect(result).toEqual(new Set(["files"]));
	});

	it("falls back to the defaultOn set when requested is undefined (older clients)", async () => {
		const { createConnection } = await import("./store");
		const { resolveActiveCapabilities } = await import("./resolve");
		seedUser("userA");

		await createConnection({
			userId: "userA",
			provider: "nextcloud",
			label: "Nextcloud",
			status: "connected",
			capabilities: ["files"],
			defaultOn: true,
		});

		const result = await resolveActiveCapabilities("userA", undefined);
		expect(result).toEqual(new Set(["files"]));
	});
});
