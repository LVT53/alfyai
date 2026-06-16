import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { SessionUser } from "$lib/types";

let dbPath: string;

function seedAnalyticsDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.usageEvents)
		.values([
			{
				id: "usage-admin-march",
				userId: "admin-1",
				userEmail: "admin@example.com",
				userName: "Admin",
				conversationId: "conversation-admin-march",
				messageId: "message-admin-march",
				modelId: "model1",
				modelDisplayName: "Model 1",
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
				billingMonth: "2026-03",
				costUsdMicros: 1_000_000,
				createdAt: new Date("2026-03-10T10:00:00.000Z"),
			},
			{
				id: "usage-user-june",
				userId: "user-2",
				userEmail: "user@example.com",
				userName: "User",
				conversationId: "conversation-user-june",
				messageId: "message-user-june",
				modelId: "model2",
				modelDisplayName: "Model 2",
				promptTokens: 400,
				completionTokens: 200,
				totalTokens: 600,
				billingMonth: "2026-06",
				costUsdMicros: 2_500_000,
				createdAt: new Date("2026-06-10T10:00:00.000Z"),
			},
		])
		.run();

	db.insert(schema.analyticsConversations)
		.values([
			{
				id: "analytics-conversation-admin-march",
				conversationId: "conversation-admin-march",
				userId: "admin-1",
				userEmail: "admin@example.com",
				userName: "Admin",
				title: "Admin March",
				billingMonth: "2026-03",
				conversationCreatedAt: new Date("2026-03-10T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-user-june",
				conversationId: "conversation-user-june",
				userId: "user-2",
				userEmail: "user@example.com",
				userName: "User",
				title: "User June",
				billingMonth: "2026-06",
				conversationCreatedAt: new Date("2026-06-10T09:00:00.000Z"),
			},
		])
		.run();

	sqlite.close();
}

async function closeServiceDatabase() {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The route may not have opened the service DB if setup failed.
	}
}

function adminUser(): SessionUser {
	return {
		id: "admin-1",
		email: "admin@example.com",
		displayName: "Admin",
		role: "admin",
		avatarId: null,
		profilePicture: null,
		titleLanguage: "auto",
		uiLanguage: "en",
	};
}

describe("GET /api/analytics", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-analytics-route-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedAnalyticsDatabase();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("lets admins filter system analytics by all-user months independently of personal analytics", async () => {
		const { GET } = await import("./+server");
		const response = await GET({
			url: new URL("http://localhost/api/analytics?systemMonth=2026-06"),
			locals: { user: adminUser() },
		} as Parameters<typeof GET>[0]);

		const body = await response.json();

		expect(body.availableMonths).toEqual(["2026-03"]);
		expect(body.systemAvailableMonths).toEqual(["2026-03", "2026-06"]);
		expect(body.personal.totalMessages).toBe(1);
		expect(body.personal.totalCostUsd).toBe(1);
		expect(body.system.totalMessages).toBe(1);
		expect(body.system.totalCostUsd).toBe(2.5);
		expect(body.system.totalUsers).toBe(1);
		expect(body.perUser).toEqual([
			expect.objectContaining({
				userId: "user-2",
				messageCount: 1,
				totalCostUsd: 2.5,
			}),
		]);
	});
});
