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

describe("selectConnection", () => {
	it("returns null when no selector is given", async () => {
		const { selectConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			status: "connected",
			capabilities: ["calendar"],
		});

		expect(selectConnection([conn], undefined)).toBeNull();
		expect(selectConnection([conn], null)).toBeNull();
		expect(selectConnection([conn], "")).toBeNull();
		expect(selectConnection([conn], "   ")).toBeNull();
	});

	it("matches by provider case-insensitively", async () => {
		const { selectConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "me@icloud.com",
			status: "connected",
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			accountIdentifier: "me@gmail.com",
			status: "connected",
			capabilities: ["calendar"],
		});

		expect(selectConnection([apple, google], "GOOGLE")).toEqual(google);
		expect(selectConnection([apple, google], "google")).toEqual(google);
	});

	it("matches by label case-insensitively", async () => {
		const { selectConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "me@icloud.com",
			status: "connected",
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work Google",
			accountIdentifier: "work@gmail.com",
			status: "connected",
			capabilities: ["calendar"],
		});

		expect(selectConnection([apple, google], "apple icloud")).toEqual(apple);
	});

	it("matches by accountIdentifier substring", async () => {
		const { selectConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "me@icloud.com",
			status: "connected",
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work Google",
			accountIdentifier: "work@gmail.com",
			status: "connected",
			capabilities: ["calendar"],
		});

		expect(selectConnection([apple, google], "work@gmail.com")).toEqual(google);
		expect(selectConnection([apple, google], "icloud.com")).toEqual(apple);
	});

	it("prefers an exact provider/label match over a substring match", async () => {
		const { selectConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		// Label "Google Work" CONTAINS "google", but a connection whose
		// provider is exactly "google" should still win over the substring hit.
		const labelContainsGoogle = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Google Work Notes",
			accountIdentifier: "notes@icloud.com",
			status: "connected",
			capabilities: ["calendar"],
		});
		const exactProviderGoogle = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal",
			accountIdentifier: "me@gmail.com",
			status: "connected",
			capabilities: ["calendar"],
		});

		expect(
			selectConnection([labelContainsGoogle, exactProviderGoogle], "google"),
		).toEqual(exactProviderGoogle);
	});

	it("returns null when the selector matches no connection", async () => {
		const { selectConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			capabilities: ["calendar"],
		});

		expect(selectConnection([conn], "microsoft")).toBeNull();
	});
});

describe("pickDefaultConnection", () => {
	it("returns null for an empty list", async () => {
		const { pickDefaultConnection } = await import("./resolve");
		expect(pickDefaultConnection([])).toBeNull();
	});

	it("returns the first connection (alphabetical, from resolveConnectionsForCapability) when not forWrite", async () => {
		const { pickDefaultConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			status: "connected",
			allowWrites: false,
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			allowWrites: true,
			capabilities: ["calendar"],
		});

		expect(pickDefaultConnection([apple, google])).toEqual(apple);
	});

	it("prefers a writes-enabled connection when forWrite is true", async () => {
		const { pickDefaultConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		// Apple sorts first alphabetically but has writes off; Google has
		// writes on. This is the exact scenario from the surfaced bug.
		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			status: "connected",
			allowWrites: false,
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			allowWrites: true,
			capabilities: ["calendar"],
		});

		expect(pickDefaultConnection([apple, google], { forWrite: true })).toEqual(
			google,
		);
	});

	it("falls back to the first connection when forWrite is true but none are writable", async () => {
		const { pickDefaultConnection } = await import("./resolve");
		const { createConnection } = await import("./store");
		seedUser("userA");

		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			status: "connected",
			allowWrites: false,
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Google",
			status: "connected",
			allowWrites: false,
			capabilities: ["calendar"],
		});

		expect(pickDefaultConnection([apple, google], { forWrite: true })).toEqual(
			apple,
		);
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

describe("withCapabilityConnection", () => {
	it("returns a not-connected result (fn never runs) when the user has no connections", async () => {
		const { withCapabilityConnection } = await import("./capability-read");
		seedUser("userA");

		let called = false;
		const result = await withCapabilityConnection(
			"userA",
			"calendar",
			{},
			async () => {
				called = true;
				return "ran";
			},
		);

		expect(called).toBe(false);
		expect(result).toEqual({ kind: "not-connected" });
	});

	it("picks the single connection and surfaces ambiguous=false", async () => {
		const { createConnection } = await import("./store");
		const { withCapabilityConnection } = await import("./capability-read");
		seedUser("userA");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			status: "connected",
			capabilities: ["calendar"],
		});

		const result = await withCapabilityConnection(
			"userA",
			"calendar",
			{},
			async (picked, ctx) => ({ pickedId: picked.id, ...ctx }),
		);

		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("expected ok");
		expect(result.value.pickedId).toBe(conn.id);
		expect(result.value.ambiguous).toBe(false);
		expect(result.value.connections).toHaveLength(1);
	});

	it("selects the account-matched connection when multiple serve the capability", async () => {
		const { createConnection } = await import("./store");
		const { withCapabilityConnection } = await import("./capability-read");
		seedUser("userA");
		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Apple iCloud", // sorts first alphabetically
			status: "connected",
			capabilities: ["calendar"],
		});
		const google = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work Google",
			status: "connected",
			capabilities: ["calendar"],
			accountIdentifier: "work@gmail.com",
		});

		const result = await withCapabilityConnection(
			"userA",
			"calendar",
			{ account: "work@gmail.com" },
			async (picked, ctx) => ({
				pickedId: picked.id,
				ambiguous: ctx.ambiguous,
			}),
		);

		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("expected ok");
		expect(result.value.pickedId).toBe(google.id);
		expect(result.value.ambiguous).toBe(true);
	});

	it("returns a no-match result (fn never runs) when an account is given but matches nothing", async () => {
		const { createConnection } = await import("./store");
		const { withCapabilityConnection } = await import("./capability-read");
		seedUser("userA");
		const a = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			status: "connected",
			capabilities: ["calendar"],
		});
		const b = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			status: "connected",
			capabilities: ["calendar"],
		});

		let called = false;
		const result = await withCapabilityConnection(
			"userA",
			"calendar",
			{ account: "does-not-exist" },
			async () => {
				called = true;
				return "ran";
			},
		);

		expect(called).toBe(false);
		expect(result.kind).toBe("no-match");
		if (result.kind !== "no-match") throw new Error("expected no-match");
		expect(result.selector).toBe("does-not-exist");
		expect(result.connections.map((c) => c.id).sort()).toEqual(
			[a.id, b.id].sort(),
		);
	});

	it("falls back to pickDefault (first by label) for a read with no account", async () => {
		const { createConnection } = await import("./store");
		const { withCapabilityConnection } = await import("./capability-read");
		seedUser("userA");
		const apple = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud", // sorts first
			status: "connected",
			capabilities: ["calendar"],
		});
		await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work Google",
			status: "connected",
			capabilities: ["calendar"],
			allowWrites: true,
		});

		const result = await withCapabilityConnection(
			"userA",
			"calendar",
			{},
			async (picked) => picked.id,
		);

		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("expected ok");
		expect(result.value).toBe(apple.id);
	});

	it("prefers a writable connection over the first-by-label for a write", async () => {
		const { createConnection } = await import("./store");
		const { withCapabilityConnection } = await import("./capability-read");
		seedUser("userA");
		await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud", // sorts first, not writable
			status: "connected",
			capabilities: ["calendar"],
		});
		const writable = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Work Google",
			status: "connected",
			capabilities: ["calendar"],
			allowWrites: true,
		});

		const result = await withCapabilityConnection(
			"userA",
			"calendar",
			{ forWrite: true },
			async (picked) => picked.id,
		);

		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("expected ok");
		expect(result.value).toBe(writable.id);
	});
});
