import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { SessionUser } from "$lib/types";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: "./drizzle" });
	return { sqlite, database };
}

function user(
	overrides: Partial<SessionUser> & Pick<SessionUser, "id" | "role">,
): SessionUser {
	const { id, role, ...rest } = overrides;
	return {
		id,
		email: `${id}@example.com`,
		displayName: id,
		role,
		avatarId: null,
		profilePicture: null,
		titleLanguage: "auto",
		uiLanguage: "en",
		...rest,
	};
}

async function closeServiceDatabase() {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The service may not have opened the DB if a test failed early.
	}
}

function seedAnalyticsRows() {
	const { sqlite, database } = openSeedDatabase();

	database.insert(schema.providers).values({
		id: "provider-abc",
		name: "openrouter",
		displayName: "OpenRouter",
		baseUrl: "https://openrouter.example",
		apiKeyEncrypted: "encrypted",
		apiKeyIv: "iv",
	}).run();

	database
		.insert(schema.usageEvents)
		.values([
			{
				id: "usage-user-may",
				userId: "user-1",
				userEmail: "user@example.com",
				userName: "User One",
				conversationId: "conversation-user-may",
				messageId: "message-user-may",
				modelId: "model1",
				modelDisplayName: "Model One",
				promptTokens: 100,
				cachedInputTokens: 10,
				completionTokens: 50,
				reasoningTokens: 5,
				totalTokens: 155,
				generationTimeMs: 2000,
				billingMonth: "2026-05",
				costUsdMicros: 1_250_000,
				createdAt: new Date("2026-05-10T10:00:00.000Z"),
			},
			{
				id: "usage-user-june",
				userId: "user-1",
				userEmail: "user@example.com",
				userName: "User One",
				conversationId: "conversation-user-june",
				messageId: "message-user-june",
				modelId: "provider:provider-abc",
				providerId: "provider-abc",
				promptTokens: 300,
				completionTokens: 125,
				reasoningTokens: 25,
				totalTokens: 450,
				generationTimeMs: 3000,
				billingMonth: "2026-06",
				costUsdMicros: 2_500_000,
				createdAt: new Date("2026-06-10T10:00:00.000Z"),
			},
			{
				id: "usage-admin-may",
				userId: "admin-1",
				userEmail: "admin@example.com",
				userName: "Admin One",
				conversationId: "conversation-admin-may",
				messageId: "message-admin-may",
				modelId: "model2",
				modelDisplayName: "Model Two",
				promptTokens: 50,
				completionTokens: 50,
				totalTokens: 100,
				generationTimeMs: 1000,
				billingMonth: "2026-05",
				costUsdMicros: 500_000,
				createdAt: new Date("2026-05-11T10:00:00.000Z"),
			},
			{
				id: "usage-erased",
				userId: "erased-1",
				userEmail: "erased@example.com",
				userName: "Erased Person",
				conversationId: "conversation-erased",
				messageId: "message-erased",
				modelId: "model1",
				modelDisplayName: "Model One",
				promptTokens: 999,
				completionTokens: 999,
				totalTokens: 1998,
				billingMonth: "2026-05",
				costUsdMicros: 9_990_000,
				createdAt: new Date("2026-05-12T10:00:00.000Z"),
			},
		])
		.run();

	database
		.insert(schema.analyticsConversations)
		.values([
			{
				id: "analytics-conversation-user-may",
				conversationId: "conversation-user-may",
				userId: "user-1",
				userEmail: "user@example.com",
				userName: "User One",
				title: "User May",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-10T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-user-june",
				conversationId: "conversation-user-june",
				userId: "user-1",
				userEmail: "user@example.com",
				userName: "User One",
				title: "User June",
				billingMonth: "2026-06",
				conversationCreatedAt: new Date("2026-06-10T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-admin-may",
				conversationId: "conversation-admin-may",
				userId: "admin-1",
				userEmail: "admin@example.com",
				userName: "Admin One",
				title: "Admin May",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-11T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-conversation-only",
				conversationId: "conversation-only",
				userId: "conversation-only-user",
				userEmail: "conversation-only@example.com",
				userName: "Conversation Only",
				title: "Conversation Only",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-13T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-erased",
				conversationId: "conversation-erased",
				userId: "erased-1",
				userEmail: "erased@example.com",
				userName: "Erased Person",
				title: "Erased Conversation",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-12T09:00:00.000Z"),
			},
		])
		.run();

	database
		.delete(schema.usageEvents)
		.where(eq(schema.usageEvents.userId, "erased-1"))
		.run();
	database
		.delete(schema.analyticsConversations)
		.where(eq(schema.analyticsConversations.userId, "erased-1"))
		.run();

	sqlite.close();
}

describe("analytics dashboard read model", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-analytics-service-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("returns an empty personal projection when the user has no analytics rows", async () => {
		openSeedDatabase().sqlite.close();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "missing-user", role: "user" }),
		});

		expect(result).toEqual({
			personal: {
				byModel: [],
				byProvider: [],
				totalMessages: 0,
				avgGenerationMs: 0,
				promptTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 0,
				totalCostUsd: 0,
				favoriteModel: null,
				chatCount: 0,
				monthly: [],
			},
			availableMonths: [],
		});
	});

	it("projects personal analytics across months with provider display-name fallback and monthly timeline", async () => {
		seedAnalyticsRows();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "user-1", role: "user" }),
			timeline: "monthly",
		});

		expect(result.system).toBeUndefined();
		expect(result.perUser).toBeUndefined();
		expect(result.systemAvailableMonths).toBeUndefined();
		expect(result.availableMonths).toEqual(["2026-05", "2026-06"]);
		expect(result.personal).toMatchObject({
			totalMessages: 2,
			avgGenerationMs: 2500,
			promptTokens: 400,
			cachedInputTokens: 10,
			outputTokens: 175,
			reasoningTokens: 30,
			totalTokens: 605,
			totalCostUsd: 3.75,
			favoriteModel: "model1",
			chatCount: 2,
		});
		expect(result.personal.byModel).toEqual([
			expect.objectContaining({
				model: "model1",
				displayName: "Model One",
				msgCount: 1,
				totalCostUsd: 1.25,
			}),
			expect.objectContaining({
				model: "provider:provider-abc",
				displayName: "OpenRouter",
				msgCount: 1,
				totalCostUsd: 2.5,
			}),
		]);
		expect(result.personal.byProvider).toEqual([
			expect.objectContaining({
				providerId: "provider-abc",
				displayName: "OpenRouter",
				msgCount: 1,
				totalCostUsd: 2.5,
			}),
			expect.objectContaining({
				providerId: null,
				displayName: "Native Model",
				msgCount: 1,
				totalCostUsd: 1.25,
			}),
		]);
		expect(result.personal.monthly).toEqual([
			expect.objectContaining({
				month: "2026-05",
				messages: 1,
				totalTokens: 155,
				totalCostUsd: 1.25,
			}),
			expect.objectContaining({
				month: "2026-06",
				messages: 1,
				totalTokens: 450,
				totalCostUsd: 2.5,
			}),
		]);
		expect(result.timeline).toEqual([
			{ label: "2026-05", tokens: 155 },
			{ label: "2026-06", tokens: 450 },
		]);
	});

	it("applies the personal month filter and preserves invalid timeline as yearly", async () => {
		seedAnalyticsRows();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "user-1", role: "user" }),
			month: "2026-06",
			timeline: "not-a-real-granularity",
		});

		expect(result.availableMonths).toEqual(["2026-05", "2026-06"]);
		expect(result.personal.totalMessages).toBe(1);
		expect(result.personal.totalCostUsd).toBe(2.5);
		expect(result.personal.monthly).toEqual([
			expect.objectContaining({ month: "2026-06", messages: 1 }),
		]);
		expect(result.timeline).toEqual([{ label: "2026", tokens: 450 }]);
	});

	it("filters admin system analytics by systemMonth independently from personal month", async () => {
		seedAnalyticsRows();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "admin-1", role: "admin" }),
			month: "2026-05",
			systemMonth: "2026-06",
		});

		expect(result.availableMonths).toEqual(["2026-05"]);
		expect(result.systemAvailableMonths).toEqual(["2026-05", "2026-06"]);
		expect(result.personal.totalMessages).toBe(1);
		expect(result.personal.totalCostUsd).toBe(0.5);
		expect(result.system).toMatchObject({
			totalMessages: 1,
			totalCostUsd: 2.5,
			totalUsers: 1,
			totalConversations: 1,
		});
		expect(result.perUser).toEqual([
			expect.objectContaining({
				userId: "user-1",
				displayName: "User One",
				email: "user@example.com",
				messageCount: 1,
				totalCostUsd: 2.5,
				conversationCount: 1,
			}),
		]);
	});

	it("keeps system fields out of non-admin responses even when systemMonth is supplied", async () => {
		seedAnalyticsRows();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "user-1", role: "user" }),
			systemMonth: "2026-05",
		});

		expect(result.system).toBeUndefined();
		expect(result.perUser).toBeUndefined();
		expect(result.systemAvailableMonths).toBeUndefined();
	});

	it("uses conversation snapshots for admin per-user rows and omits erased analytics people", async () => {
		seedAnalyticsRows();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "admin-1", role: "admin" }),
			systemMonth: "2026-05",
		});

		expect(result.perUser).toEqual([
			expect.objectContaining({ userId: "user-1", messageCount: 1 }),
			expect.objectContaining({ userId: "admin-1", messageCount: 1 }),
			expect.objectContaining({
				userId: "conversation-only-user",
				displayName: "Conversation Only",
				email: "conversation-only@example.com",
				messageCount: 0,
				conversationCount: 1,
			}),
		]);
		expect(result.perUser?.map((row) => row.userId)).not.toContain("erased-1");
		expect(JSON.stringify(result)).not.toContain("erased@example.com");
		expect(JSON.stringify(result)).not.toContain("Erased Person");
		expect(JSON.stringify(result)).not.toContain("conversation-erased");
		expect(JSON.stringify(result)).not.toContain("message-erased");
	});

	it("serves mock analytics through the same admin visibility boundary", async () => {
		openSeedDatabase().sqlite.close();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const adminResult = await getAnalyticsDashboardReadModel({
			user: user({ id: "admin-1", role: "admin" }),
			mock: true,
		});
		const userResult = await getAnalyticsDashboardReadModel({
			user: user({ id: "user-1", role: "user" }),
			mock: true,
		});

		expect(adminResult.personal.totalMessages).toBeGreaterThan(0);
		expect(adminResult.system?.totalMessages).toBeGreaterThan(0);
		expect(adminResult.perUser?.length).toBeGreaterThan(0);
		expect(adminResult.perUser?.[0]).not.toHaveProperty("cachedInputTokens");
		expect(adminResult.systemAvailableMonths).toEqual(["2026-04"]);
		expect(userResult.personal.totalMessages).toBeGreaterThan(0);
		expect(userResult.system).toBeUndefined();
		expect(userResult.perUser).toBeUndefined();
		expect(userResult.systemAvailableMonths).toBeUndefined();
	});
});
