import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseInstance } from "$lib/server/db";
import * as schema from "$lib/server/db/schema";
import {
	BACKGROUND_MEMORY_ADMISSION,
	MEMORY_ADMISSION_HEADERS,
	MEMORY_ADMISSION_WAIT_MS,
	memoryAdmissionFor,
	memoryAdmissionHeaders,
	memoryAdmissionTimeoutMs,
} from "./admission";

let sqlite: Database.Database;
let db: DatabaseInstance;
const tenantId = randomUUID();
beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	db.insert(schema.users)
		.values([
			{ id: "member", email: "member@test.invalid", passwordHash: "h" },
			{ id: "legacy", email: "legacy@test.invalid", passwordHash: "h" },
		])
		.run();
	db.insert(schema.memoryAccounts).values({ userId: "member", tenantId }).run();
});
afterEach(() => sqlite.close());

it("names the three headers the gateway reads", () => {
	expect(MEMORY_ADMISSION_HEADERS).toEqual({
		priority: "X-AlfyAI-Admission-Priority",
		lane: "X-AlfyAI-Admission-Lane",
		waitMs: "X-AlfyAI-Admission-Wait-Ms",
	});
	expect(MEMORY_ADMISSION_WAIT_MS).toEqual({
		interactive: 120_000,
		background: 600_000,
	});
});

it("declares a call's priority, its tenant's lane and its wait", () => {
	const interactive = memoryAdmissionHeaders({
		priority: "interactive",
		tenantId,
	});
	expect(interactive["X-AlfyAI-Admission-Priority"]).toBe("interactive");
	expect(interactive["X-AlfyAI-Admission-Wait-Ms"]).toBe("120000");
	const lane = interactive["X-AlfyAI-Admission-Lane"];
	// A stable digest the gateway can tell tenants apart by, never the id itself.
	expect(lane).toMatch(/^[0-9a-f]{32}$/);
	expect(lane).not.toContain(tenantId.replaceAll("-", "").slice(0, 12));
	const background = memoryAdmissionHeaders({
		priority: "background",
		tenantId,
	});
	expect(background["X-AlfyAI-Admission-Lane"]).toBe(lane);
	expect(background["X-AlfyAI-Admission-Priority"]).toBe("background");
	expect(background["X-AlfyAI-Admission-Wait-Ms"]).toBe("600000");
	expect(
		memoryAdmissionHeaders({ priority: "background", tenantId: randomUUID() })[
			"X-AlfyAI-Admission-Lane"
		],
	).not.toBe(lane);
});

it("leaves the lane out when the call has no tenant", () => {
	expect(memoryAdmissionHeaders(BACKGROUND_MEMORY_ADMISSION)).toEqual({
		"X-AlfyAI-Admission-Priority": "background",
		"X-AlfyAI-Admission-Wait-Ms": "600000",
	});
});

it("finds the tenant of a Memory account, and none for an account without one", () => {
	expect(memoryAdmissionFor("member", "interactive", db)).toEqual({
		priority: "interactive",
		tenantId,
	});
	expect(memoryAdmissionFor("legacy", "background", db)).toEqual({
		priority: "background",
		tenantId: null,
	});
});

it("gives a call its declared wait on top of the model's own three minutes", () => {
	expect(memoryAdmissionTimeoutMs("interactive")).toBe(300_000);
	expect(memoryAdmissionTimeoutMs("background")).toBe(780_000);
});
