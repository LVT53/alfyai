import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { SessionUser } from "$lib/server/services/auth-types";

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

	// Identity now lives only on `users` and is resolved at read time; the
	// analytics rollups carry no email/name. Seed the people whose identity the
	// dashboard should resolve. `erased-1` is intentionally absent (erased): its
	// analytics rows are deleted below and it has no `users` row, so it can never
	// be reidentified.
	const now = new Date("2026-05-01T00:00:00.000Z");
	database
		.insert(schema.users)
		.values([
			{
				id: "user-1",
				email: "user@example.com",
				name: "User One",
				passwordHash: "hash",
				role: "user",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "admin-1",
				email: "admin@example.com",
				name: "Admin One",
				passwordHash: "hash",
				role: "admin",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "conversation-only-user",
				email: "conversation-only@example.com",
				name: "Conversation Only",
				passwordHash: "hash",
				role: "user",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	database
		.insert(schema.providers)
		.values({
			id: "provider-abc",
			name: "openrouter",
			displayName: "OpenRouter",
			baseUrl: "https://openrouter.example",
			apiKeyEncrypted: "encrypted",
			apiKeyIv: "iv",
		})
		.run();

	database
		.insert(schema.usageEvents)
		.values([
			{
				id: "usage-user-may",
				userId: "user-1",
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
				title: "User May",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-10T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-user-june",
				conversationId: "conversation-user-june",
				userId: "user-1",
				title: "User June",
				billingMonth: "2026-06",
				conversationCreatedAt: new Date("2026-06-10T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-admin-may",
				conversationId: "conversation-admin-may",
				userId: "admin-1",
				title: "Admin May",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-11T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-conversation-only",
				conversationId: "conversation-only",
				userId: "conversation-only-user",
				title: "Conversation Only",
				billingMonth: "2026-05",
				conversationCreatedAt: new Date("2026-05-13T09:00:00.000Z"),
			},
			{
				id: "analytics-conversation-erased",
				conversationId: "conversation-erased",
				userId: "erased-1",
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

	it("resolves per-user identity from users at read time and renders a deleted user's leftover rows anonymously", async () => {
		seedAnalyticsRows();
		// The analytics rollups store only an opaque userId — verify no identity
		// column survives on the row itself.
		const usageColumns = new Database(dbPath)
			.prepare("PRAGMA table_info(usage_events)")
			.all()
			.map((column) => (column as { name: string }).name);
		expect(usageColumns).not.toContain("user_email");
		expect(usageColumns).not.toContain("user_name");

		// Simulate a user whose `users` row is gone (deleted) while usage rows
		// remain: read-time resolution must render them anonymously (opaque
		// userId, empty email) rather than via a frozen person-linked snapshot.
		const teardown = new Database(dbPath);
		teardown.pragma("foreign_keys = OFF");
		teardown.prepare("DELETE FROM users WHERE id = ?").run("user-1");
		teardown.close();

		const { getAnalyticsDashboardReadModel } = await import("./analytics");
		const result = await getAnalyticsDashboardReadModel({
			user: user({ id: "admin-1", role: "admin" }),
			systemMonth: "2026-05",
		});

		const anonymized = result.perUser?.find((row) => row.userId === "user-1");
		expect(anonymized).toMatchObject({
			userId: "user-1",
			displayName: "user-1",
			email: "",
		});
		const anonymizedSummary = result.analyticsUsers?.find(
			(row) => row.userId === "user-1",
		);
		expect(anonymizedSummary).toMatchObject({
			userId: "user-1",
			email: null,
			name: null,
		});
		// admin-1 still has a users row, so it still resolves to real identity.
		expect(
			result.perUser?.find((row) => row.userId === "admin-1"),
		).toMatchObject({ displayName: "Admin One", email: "admin@example.com" });
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

	describe("recordParallelUsage", () => {
		it("records a flat-cost Parallel usage event with a unique synthetic message id per call", async () => {
			openSeedDatabase().sqlite.close();
			const { recordParallelUsage } = await import("./analytics");

			await recordParallelUsage({
				userId: "user-1",
				conversationId: "conversation-1",
				tool: "research_web",
			});
			await recordParallelUsage({
				userId: "user-1",
				conversationId: "conversation-1",
				tool: "research_web",
			});
			await recordParallelUsage({
				userId: "user-1",
				conversationId: "conversation-1",
				tool: "fetch_url",
			});

			const rows = new Database(dbPath)
				.prepare(
					"SELECT message_id, model_id, model_display_name, provider_display_name, cost_usd_micros, usage_source, prompt_tokens, total_tokens, billing_month FROM usage_events ORDER BY model_id, message_id",
				)
				.all() as Array<{
				message_id: string;
				model_id: string;
				model_display_name: string;
				provider_display_name: string;
				cost_usd_micros: number;
				usage_source: string;
				prompt_tokens: number;
				total_tokens: number;
				billing_month: string;
			}>;

			expect(rows).toHaveLength(3);
			// Synthetic message ids never collide, so a second call is never
			// swallowed by the messageId unique index.
			expect(new Set(rows.map((row) => row.message_id)).size).toBe(3);
			for (const row of rows) {
				expect(row.message_id).toMatch(/^parallel:/);
				expect(row.cost_usd_micros).toBe(1000);
				expect(row.provider_display_name).toBe("Parallel");
				expect(row.usage_source).toBe("provider");
				expect(row.prompt_tokens).toBe(0);
				expect(row.total_tokens).toBe(0);
				expect(row.billing_month).toBe(new Date().toISOString().slice(0, 7));
			}

			const turbo = rows.filter((row) => row.model_id === "parallel:turbo");
			expect(turbo).toHaveLength(2);
			expect(turbo[0]?.model_display_name).toBe("Parallel Turbo");
			const extract = rows.filter((row) => row.model_id === "parallel:extract");
			expect(extract).toHaveLength(1);
			expect(extract[0]?.model_display_name).toBe("Parallel Extract");
		});

		it("skips recording when userId is missing", async () => {
			openSeedDatabase().sqlite.close();
			const { recordParallelUsage } = await import("./analytics");

			await recordParallelUsage({
				userId: "",
				conversationId: "conversation-1",
				tool: "research_web",
			});

			const count = (
				new Database(dbPath)
					.prepare("SELECT COUNT(*) AS n FROM usage_events")
					.get() as { n: number }
			).n;
			expect(count).toBe(0);
		});
	});

	describe("recordControlModelUsage", () => {
		it("records a priced usage_events row with a unique feature-prefixed synthetic message id", async () => {
			openSeedDatabase().sqlite.close();
			const { recordControlModelUsage } = await import("./analytics");

			await recordControlModelUsage({
				userId: "user-1",
				conversationId: "conversation-1",
				feature: "turn_acknowledgment",
				modelId: "model2",
				modelDisplayName: "Model Two",
				promptTokens: 40,
				completionTokens: 12,
				totalTokens: 52,
			});
			await recordControlModelUsage({
				userId: "user-1",
				conversationId: "conversation-1",
				feature: "turn_acknowledgment",
				modelId: "model2",
				modelDisplayName: "Model Two",
				promptTokens: 30,
				completionTokens: 10,
				totalTokens: 40,
			});

			const rows = new Database(dbPath)
				.prepare(
					"SELECT message_id, model_id, model_display_name, prompt_tokens, completion_tokens, total_tokens, usage_source, billing_month FROM usage_events ORDER BY message_id",
				)
				.all() as Array<{
				message_id: string;
				model_id: string;
				model_display_name: string;
				prompt_tokens: number;
				completion_tokens: number;
				total_tokens: number;
				usage_source: string;
				billing_month: string;
			}>;

			expect(rows).toHaveLength(2);
			// Synthetic message ids never collide, so a second call is never
			// swallowed by the messageId unique index.
			expect(new Set(rows.map((row) => row.message_id)).size).toBe(2);
			for (const row of rows) {
				expect(row.message_id).toMatch(/^control:turn_acknowledgment:/);
				expect(row.model_id).toBe("model2");
				expect(row.model_display_name).toBe("Model Two");
				expect(row.usage_source).toBe("provider");
				expect(row.billing_month).toBe(new Date().toISOString().slice(0, 7));
			}
			const totals = rows.map((row) => row.total_tokens).sort();
			expect(totals).toEqual([40, 52]);
		});

		it("records zeroed usage rather than skipping when no usage was reported, so call counts stay accurate", async () => {
			openSeedDatabase().sqlite.close();
			const { recordControlModelUsage } = await import("./analytics");

			await recordControlModelUsage({
				userId: "user-1",
				conversationId: "conversation-1",
				feature: "turn_acknowledgment",
				modelId: "model2",
			});

			const row = new Database(dbPath)
				.prepare(
					"SELECT prompt_tokens, completion_tokens, total_tokens, cost_usd_micros FROM usage_events",
				)
				.get() as {
				prompt_tokens: number;
				completion_tokens: number;
				total_tokens: number;
				cost_usd_micros: number;
			};

			expect(row).toEqual({
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
				cost_usd_micros: 0,
			});
		});

		it("skips recording when userId is missing", async () => {
			openSeedDatabase().sqlite.close();
			const { recordControlModelUsage } = await import("./analytics");

			await recordControlModelUsage({
				userId: "",
				conversationId: "conversation-1",
				feature: "turn_acknowledgment",
				modelId: "model2",
			});

			const count = (
				new Database(dbPath)
					.prepare("SELECT COUNT(*) AS n FROM usage_events")
					.get() as { n: number }
			).n;
			expect(count).toBe(0);
		});
	});

	describe("parallelBreakdown", () => {
		function parallelRow(overrides: {
			id: string;
			modelId: string;
			billingMonth: string;
			costUsdMicros: number;
		}) {
			return {
				id: overrides.id,
				userId: "user-1",
				conversationId: "conversation-1",
				messageId: `parallel:${overrides.id}`,
				modelId: overrides.modelId,
				billingMonth: overrides.billingMonth,
				costUsdMicros: overrides.costUsdMicros,
			};
		}

		it("aggregates turbo/extract calls and flat cost by billing month, ignoring non-parallel rows", async () => {
			const { sqlite, database } = openSeedDatabase();
			database
				.insert(schema.usageEvents)
				.values([
					parallelRow({
						id: "p1",
						modelId: "parallel:turbo",
						billingMonth: "2026-05",
						costUsdMicros: 1000,
					}),
					parallelRow({
						id: "p2",
						modelId: "parallel:turbo",
						billingMonth: "2026-05",
						costUsdMicros: 1000,
					}),
					parallelRow({
						id: "p3",
						modelId: "parallel:extract",
						billingMonth: "2026-05",
						costUsdMicros: 1000,
					}),
					parallelRow({
						id: "p4",
						modelId: "parallel:turbo",
						billingMonth: "2026-06",
						costUsdMicros: 1000,
					}),
					parallelRow({
						id: "n1",
						modelId: "model1",
						billingMonth: "2026-06",
						costUsdMicros: 5000,
					}),
				])
				.run();
			const rows = database.select().from(schema.usageEvents).all();
			sqlite.close();

			const { parallelBreakdown } = await import("./analytics");
			const result = parallelBreakdown(rows);

			expect(result.totalTurboCalls).toBe(3);
			expect(result.totalExtractCalls).toBe(1);
			expect(result.totalCostUsd).toBe(0.004);
			expect(result.monthly).toEqual([
				{ month: "2026-05", turboCalls: 2, extractCalls: 1, costUsd: 0.003 },
				{ month: "2026-06", turboCalls: 1, extractCalls: 0, costUsd: 0.001 },
			]);
		});
	});

	it("surfaces an admin-only parallel breakdown wired into the system read model", async () => {
		const { sqlite, database } = openSeedDatabase();
		database
			.insert(schema.usageEvents)
			.values([
				{
					id: "parallel-turbo-1",
					userId: "user-1",
					conversationId: "conversation-user-may",
					messageId: "parallel:turbo-1",
					modelId: "parallel:turbo",
					modelDisplayName: "Parallel Turbo",
					providerDisplayName: "Parallel",
					usageSource: "provider",
					billingMonth: "2026-05",
					costUsdMicros: 1000,
				},
				{
					id: "parallel-extract-1",
					userId: "user-1",
					conversationId: "conversation-user-may",
					messageId: "parallel:extract-1",
					modelId: "parallel:extract",
					modelDisplayName: "Parallel Extract",
					providerDisplayName: "Parallel",
					usageSource: "provider",
					billingMonth: "2026-05",
					costUsdMicros: 1000,
				},
			])
			.run();
		sqlite.close();
		const { getAnalyticsDashboardReadModel } = await import("./analytics");

		const adminResult = await getAnalyticsDashboardReadModel({
			user: user({ id: "admin-1", role: "admin" }),
			systemMonth: "2026-05",
		});
		expect(adminResult.system?.parallel).toEqual({
			monthly: [
				{ month: "2026-05", turboCalls: 1, extractCalls: 1, costUsd: 0.002 },
			],
			totalTurboCalls: 1,
			totalExtractCalls: 1,
			totalCostUsd: 0.002,
		});
		// The parallel rows also fold into the existing model breakdown with a
		// readable display name.
		expect(adminResult.system?.byModel).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					model: "parallel:turbo",
					displayName: "Parallel Turbo",
				}),
				expect.objectContaining({
					model: "parallel:extract",
					displayName: "Parallel Extract",
				}),
			]),
		);

		const userResult = await getAnalyticsDashboardReadModel({
			user: user({ id: "user-1", role: "user" }),
		});
		expect(userResult.system).toBeUndefined();
	});

	// M1 — server stream-timeline marks persisted to messageAnalytics.
	// See ADR-0042's amendment: firstByteMs/firstThinkingMs/firstTokenMs are
	// SERVER-side marks (ms since turn start), never browser-network-inclusive.
	describe("recordMessageAnalytics timing marks (M1)", () => {
		function seedMessageForAnalytics() {
			const { sqlite, database } = openSeedDatabase();
			const now = new Date("2026-05-01T00:00:00.000Z");
			database
				.insert(schema.users)
				.values({
					id: "user-1",
					email: "user@example.com",
					name: "User One",
					passwordHash: "hash",
					role: "user",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			database
				.insert(schema.conversations)
				.values({
					id: "conversation-1",
					userId: "user-1",
					title: "Timing marks conversation",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			database
				.insert(schema.messages)
				.values({
					id: "assistant-message-1",
					conversationId: "conversation-1",
					role: "assistant",
					content: "Paris.",
					createdAt: now,
				})
				.run();
			sqlite.close();
		}

		function readMessageAnalyticsRow() {
			return new Database(dbPath)
				.prepare(
					"SELECT first_byte_ms, first_thinking_ms, first_token_ms, generation_time_ms FROM message_analytics WHERE message_id = ?",
				)
				.get("assistant-message-1") as
				| {
						first_byte_ms: number | null;
						first_thinking_ms: number | null;
						first_token_ms: number | null;
						generation_time_ms: number | null;
				  }
				| undefined;
		}

		it("writes non-null firstByteMs/firstThinkingMs/firstTokenMs for a completed turn", async () => {
			seedMessageForAnalytics();
			const { recordMessageAnalytics } = await import("./analytics");

			await recordMessageAnalytics({
				messageId: "assistant-message-1",
				conversationId: "conversation-1",
				userId: "user-1",
				model: "model-1",
				generationTimeMs: 2200,
				firstByteMs: 42,
				firstThinkingMs: 44,
				firstTokenMs: 55,
			});

			const row = readMessageAnalyticsRow();
			expect(row).toMatchObject({
				first_byte_ms: 42,
				first_thinking_ms: 44,
				first_token_ms: 55,
				generation_time_ms: 2200,
			});
		});

		it("records only the marks a stopped/errored turn reached, leaving the rest null, without throwing", async () => {
			seedMessageForAnalytics();
			const { recordMessageAnalytics } = await import("./analytics");

			await expect(
				recordMessageAnalytics({
					messageId: "assistant-message-1",
					conversationId: "conversation-1",
					userId: "user-1",
					model: "model-1",
					firstByteMs: 40,
					firstThinkingMs: 61,
					// firstTokenMs never reached — the stream was stopped before any
					// visible token was produced.
				}),
			).resolves.toBeUndefined();

			const row = readMessageAnalyticsRow();
			expect(row).toMatchObject({
				first_byte_ms: 40,
				first_thinking_ms: 61,
				first_token_ms: null,
			});
		});

		it("ADR-0042 invariant: malformed timing marks (NaN/negative/non-number) degrade to null instead of throwing", async () => {
			seedMessageForAnalytics();
			const { recordMessageAnalytics } = await import("./analytics");

			await expect(
				recordMessageAnalytics({
					messageId: "assistant-message-1",
					conversationId: "conversation-1",
					userId: "user-1",
					model: "model-1",
					firstByteMs: Number.NaN,
					firstThinkingMs: -12,
					// biome-ignore lint/suspicious/noExplicitAny: exercising a malformed upstream value on purpose to prove the guard never throws.
					firstTokenMs: "55" as any,
				}),
			).resolves.toBeUndefined();

			const row = readMessageAnalyticsRow();
			expect(row).toMatchObject({
				first_byte_ms: null,
				first_thinking_ms: null,
				first_token_ms: null,
			});
		});

		function readUsageEventTotals() {
			return new Database(dbPath)
				.prepare(
					"SELECT prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, usage_source FROM usage_events WHERE message_id = ?",
				)
				.get("assistant-message-1") as
				| {
						prompt_tokens: number;
						completion_tokens: number;
						reasoning_tokens: number;
						total_tokens: number;
						usage_source: string;
				  }
				| undefined;
		}

		it("does not add reasoning on top of provider completion tokens (which already include it)", async () => {
			seedMessageForAnalytics();
			const { recordMessageAnalytics } = await import("./analytics");

			await recordMessageAnalytics({
				messageId: "assistant-message-1",
				conversationId: "conversation-1",
				userId: "user-1",
				model: "model-1",
				promptTokens: 1,
				completionTokens: 1,
				reasoningTokens: 300,
				providerUsage: {
					promptTokens: 1_000,
					completionTokens: 500,
					source: "provider",
				},
			});

			expect(readUsageEventTotals()).toMatchObject({
				prompt_tokens: 1_000,
				completion_tokens: 500,
				reasoning_tokens: 300,
				total_tokens: 1_500,
				usage_source: "provider",
			});
		});

		it("adds estimated reasoning tokens when the completion count is our own visible-text estimate", async () => {
			seedMessageForAnalytics();
			const { recordMessageAnalytics } = await import("./analytics");

			await recordMessageAnalytics({
				messageId: "assistant-message-1",
				conversationId: "conversation-1",
				userId: "user-1",
				model: "model-1",
				promptTokens: 1_000,
				completionTokens: 200,
				reasoningTokens: 300,
			});

			expect(readUsageEventTotals()).toMatchObject({
				prompt_tokens: 1_000,
				completion_tokens: 200,
				reasoning_tokens: 300,
				total_tokens: 1_500,
				usage_source: "estimated",
			});
		});
	});

	// Analytics overhaul (backend half) — availability resolution, latency
	// percentiles/reasoning averages, admin-only filters, and the new
	// tools/commandsAndSkills/latencyByPromptBucket sections.
	describe("Analytics overhaul (backend half)", () => {
		function seedOverhaulFixtures() {
			const { sqlite, database } = openSeedDatabase();
			const now = new Date("2026-05-01T00:00:00.000Z");

			database
				.insert(schema.users)
				.values([
					{
						id: "user-1",
						email: "user-1@example.com",
						name: "User One",
						passwordHash: "hash",
						role: "user",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "user-2",
						email: "user-2@example.com",
						name: "User Two",
						passwordHash: "hash",
						role: "user",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "admin-1",
						email: "admin-1@example.com",
						name: "Admin One",
						passwordHash: "hash",
						role: "admin",
						createdAt: now,
						updatedAt: now,
					},
				])
				.run();

			database
				.insert(schema.providers)
				.values({
					id: "provider-x",
					name: "provider-x",
					displayName: "Provider X",
					baseUrl: "https://provider-x.example",
					apiKeyEncrypted: "encrypted",
					apiKeyIv: "iv",
					enabled: 1,
				})
				.run();
			database
				.insert(schema.providerModels)
				.values([
					{
						id: "model-active-id",
						providerId: "provider-x",
						name: "active-model",
						displayName: "Active Model",
						enabled: 1,
					},
					{
						id: "model-disabled-id",
						providerId: "provider-x",
						name: "disabled-model",
						displayName: "Disabled Model",
						enabled: 0,
					},
				])
				.run();

			database
				.insert(schema.conversations)
				.values({
					id: "conv-1",
					userId: "user-1",
					title: "Overhaul conversation",
					createdAt: now,
					updatedAt: now,
				})
				.run();

			const messageIds = ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"];
			database
				.insert(schema.messages)
				.values(
					messageIds.map((id) => ({
						id,
						conversationId: "conv-1",
						role: "assistant" as const,
						content: "response",
						createdAt: now,
					})),
				)
				.run();

			database
				.insert(schema.usageEvents)
				.values([
					{
						id: "usage-a",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-a",
						modelId: "model1",
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						billingMonth: "2026-05",
						costUsdMicros: 100_000,
						createdAt: now,
					},
					{
						id: "usage-b",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-b",
						modelId: "provider:provider-x:model-active-id",
						providerId: "provider-x",
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						billingMonth: "2026-05",
						costUsdMicros: 200_000,
						createdAt: now,
					},
					{
						id: "usage-c",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-c",
						modelId: "provider:provider-x:model-disabled-id",
						providerId: "provider-x",
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						billingMonth: "2026-05",
						costUsdMicros: 300_000,
						createdAt: now,
					},
					{
						id: "usage-d",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-d",
						modelId: "provider:provider-x:missing-model-id",
						providerId: "provider-x",
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						billingMonth: "2026-05",
						costUsdMicros: 400_000,
						createdAt: now,
					},
					{
						id: "usage-e",
						userId: "user-2",
						conversationId: "conv-1",
						messageId: "msg-e",
						modelId: "model1",
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						billingMonth: "2026-05",
						costUsdMicros: 500_000,
						createdAt: now,
					},
				])
				.run();

			database
				.insert(schema.messageAnalytics)
				.values([
					{
						id: "ma-a",
						messageId: "msg-a",
						userId: "user-1",
						model: "model1",
						promptTokens: 5_000,
						reasoningTokens: 10,
						firstTokenMs: 100,
						generationTimeMs: 200,
					},
					{
						id: "ma-b",
						messageId: "msg-b",
						userId: "user-1",
						model: "provider:provider-x:model-active-id",
						promptTokens: 15_000,
						reasoningTokens: 20,
						firstTokenMs: 300,
						generationTimeMs: 400,
					},
					{
						id: "ma-c",
						messageId: "msg-c",
						userId: "user-1",
						model: "provider:provider-x:model-disabled-id",
						promptTokens: 50_000,
						reasoningTokens: 30,
						firstTokenMs: 500,
						generationTimeMs: 600,
					},
					{
						id: "ma-d",
						messageId: "msg-d",
						userId: "user-1",
						model: "provider:provider-x:missing-model-id",
						promptTokens: 100_000,
						reasoningTokens: 40,
						firstTokenMs: 700,
						generationTimeMs: 800,
					},
				])
				.run();

			database
				.insert(schema.activityEvents)
				.values([
					{
						id: "activity-tool-1",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-a",
						kind: "tool_call",
						name: "research_web",
						status: "done",
						durationMs: 120,
						modelId: "model1",
						createdAt: now,
					},
					{
						id: "activity-tool-2",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-b",
						kind: "tool_call",
						name: "research_web",
						status: "failed",
						durationMs: 80,
						modelId: "provider:provider-x:model-active-id",
						createdAt: now,
					},
					{
						id: "activity-tool-3",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-c",
						kind: "tool_call",
						name: "fetch_url",
						status: "cached",
						durationMs: 10,
						modelId: "provider:provider-x:model-disabled-id",
						createdAt: now,
					},
					{
						id: "activity-skill-1",
						userId: "user-1",
						conversationId: "conv-1",
						messageId: "msg-a",
						kind: "skill_use",
						name: "outline-skill",
						status: "done",
						modelId: "model1",
						createdAt: now,
					},
					{
						id: "activity-command-1",
						userId: "user-1",
						conversationId: "conv-1",
						kind: "composer_command",
						name: "model",
						status: "done",
						createdAt: now,
					},
					{
						id: "activity-follow-up-1",
						userId: "user-1",
						conversationId: "conv-1",
						kind: "follow_up_click",
						name: "Tell me more",
						status: "done",
						createdAt: now,
					},
					{
						id: "activity-answer-now-1",
						userId: "user-1",
						conversationId: "conv-1",
						kind: "answer_now",
						name: "answer_now",
						status: "done",
						createdAt: now,
					},
					// A different user/month — excluded by default filters below.
					{
						id: "activity-other-user",
						userId: "user-2",
						conversationId: "conv-1",
						kind: "composer_command",
						name: "attach",
						status: "done",
						createdAt: new Date("2026-06-01T00:00:00.000Z"),
					},
				])
				.run();

			sqlite.close();
		}

		it("resolves model availability as active/disabled/removed against providers/provider_models", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
			});

			const byModel = new Map(
				result.system?.byModel.map((row) => [row.model, row]),
			);
			expect(byModel.get("model1")).toMatchObject({ availability: "active" });
			expect(byModel.get("provider:provider-x:model-active-id")).toMatchObject({
				availability: "active",
			});
			expect(
				byModel.get("provider:provider-x:model-disabled-id"),
			).toMatchObject({ availability: "disabled" });
			expect(byModel.get("provider:provider-x:missing-model-id")).toMatchObject(
				{ availability: "removed" },
			);
		});

		it("joins message_analytics for per-model latency percentiles and reasoning-token average", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
			});

			const byModel = new Map(
				result.system?.byModel.map((row) => [row.model, row]),
			);
			// A single message per model group: p50 === p90 === that message's mark.
			expect(byModel.get("model1")).toMatchObject({
				firstTokenP50Ms: 100,
				firstTokenP90Ms: 100,
				generationP50Ms: 200,
				avgReasoningTokens: 10,
			});
			expect(byModel.get("provider:provider-x:model-active-id")).toMatchObject({
				firstTokenP50Ms: 300,
				firstTokenP90Ms: 300,
				generationP50Ms: 400,
				avgReasoningTokens: 20,
			});
		});

		it("honours the userId/modelId/providerId admin filters on the system section", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const byUser = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
				userId: "user-2",
			});
			expect(byUser.system?.totalMessages).toBe(1);
			expect(byUser.system?.byModel.map((row) => row.model)).toEqual([
				"model1",
			]);

			const byModelId = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
				modelId: "provider:provider-x:model-active-id",
			});
			expect(byModelId.system?.totalMessages).toBe(1);

			const byProviderId = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
				providerId: "provider-x",
			});
			expect(byProviderId.system?.totalMessages).toBe(3);
		});

		it("ignores the userId/modelId/providerId filters for a non-admin caller", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "user-1", role: "user" }),
				month: "2026-05",
				userId: "user-2",
			});

			// The personal section is always the caller's own data regardless of
			// an admin-only filter a non-admin caller has no business setting.
			expect(result.personal.totalMessages).toBe(4);
			expect(result.system).toBeUndefined();
		});

		it("builds the tools summary from activity_events, honouring the month filter", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
			});

			const tools = new Map(result.tools?.map((row) => [row.name, row]));
			expect(tools.get("research_web")).toMatchObject({
				calls: 2,
				failed: 1,
				cached: 0,
			});
			expect(tools.get("fetch_url")).toMatchObject({
				calls: 1,
				failed: 0,
				cached: 1,
				p50DurationMs: 10,
			});
		});

		it("builds the commandsAndSkills summary excluding tool_call rows", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
			});

			expect(result.commandsAndSkills).toEqual(
				expect.arrayContaining([
					{ kind: "skill_use", name: "outline-skill", count: 1 },
					{ kind: "composer_command", name: "model", count: 1 },
					{ kind: "follow_up_click", name: "Tell me more", count: 1 },
					{ kind: "answer_now", name: "answer_now", count: 1 },
				]),
			);
			expect(result.commandsAndSkills).toHaveLength(4);
			// The June row for user-2 is excluded by the systemMonth filter, and
			// tool_call rows never appear here regardless.
			expect(
				result.commandsAndSkills?.some((row) => row.name === "attach"),
			).toBe(false);
		});

		it("buckets latencyByPromptBucket by each message's prompt-token count", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
			});

			const buckets = new Map(
				result.latencyByPromptBucket?.map((row) => [row.bucket, row]),
			);
			expect(buckets.get("<10k")).toMatchObject({
				n: 1,
				firstTokenP50Ms: 100,
				firstTokenP90Ms: 100,
				reasoningTokensMedian: 10,
			});
			expect(buckets.get("10-30k")).toMatchObject({
				n: 1,
				firstTokenP50Ms: 300,
			});
			expect(buckets.get("30-60k")).toMatchObject({
				n: 1,
				firstTokenP50Ms: 500,
			});
			expect(buckets.get("60-120k")).toMatchObject({
				n: 1,
				firstTokenP50Ms: 700,
			});
			expect(buckets.get(">120k")).toMatchObject({
				n: 0,
				firstTokenP50Ms: null,
				firstTokenP90Ms: null,
				reasoningTokensMedian: null,
			});
		});

		// The documented contract on AnalyticsByModelRow (and its client
		// mirror) is: an UNDEFINED latency/reasoning field means no
		// message_analytics rows joined for that model at all, so the admin
		// table can blank the cell instead of printing a misleading zero.
		it("leaves avgReasoningTokens undefined for a model with no message_analytics rows", async () => {
			seedOverhaulFixtures();
			const { sqlite, database } = openSeedDatabase();
			database
				.insert(schema.usageEvents)
				.values({
					id: "usage-parallel",
					userId: "user-1",
					conversationId: "conv-1",
					// Parallel usage carries a synthetic message id that never
					// joins message_analytics — the shape most likely to hit
					// this path in production.
					messageId: "parallel:turbo-1",
					modelId: "parallel:turbo",
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					billingMonth: "2026-05",
					costUsdMicros: 10_000,
					createdAt: new Date("2026-05-01T00:00:00.000Z"),
				})
				.run();
			sqlite.close();

			const { getAnalyticsDashboardReadModel } = await import("./analytics");
			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "admin-1", role: "admin" }),
				systemMonth: "2026-05",
			});

			const row = result.system?.byModel.find(
				(entry) => entry.model === "parallel:turbo",
			);
			// A "parallel:*" model is not a provider_models row and stays active.
			expect(row).toMatchObject({
				availability: "active",
				firstTokenP50Ms: null,
				firstTokenP90Ms: null,
				generationP50Ms: null,
			});
			expect(row?.avgReasoningTokens).toBeUndefined();
		});

		// Reviewer follow-up (whole-table reads): the dashboard used to SELECT
		// every row of activity_events and message_analytics on every GET and
		// throw most of them away. Both are now narrowed in SQL, and
		// activity_events — which only ever feeds admin-only sections — is not
		// queried at all for a non-admin caller.
		describe("query narrowing", () => {
			async function withCapturedSql<T>(
				run: (analytics: typeof import("./analytics")) => Promise<T>,
			): Promise<{ result: T; statements: string[] }> {
				const analytics = await import("./analytics");
				const { sqlite } = await import("$lib/server/db");
				const statements: string[] = [];
				const original = sqlite.prepare.bind(sqlite);
				const spy = vi.spyOn(sqlite, "prepare").mockImplementation(((
					sql: string,
				) => {
					statements.push(sql);
					return original(sql);
				}) as typeof sqlite.prepare);
				try {
					return { result: await run(analytics), statements };
				} finally {
					spy.mockRestore();
				}
			}

			it("never queries activity_events for a non-admin caller", async () => {
				seedOverhaulFixtures();

				const { result, statements } = await withCapturedSql((analytics) =>
					analytics.getAnalyticsDashboardReadModel({
						user: user({ id: "user-1", role: "user" }),
						month: "2026-05",
					}),
				);

				expect(statements.length).toBeGreaterThan(0);
				expect(
					statements.filter((sql) => sql.includes('"activity_events"')),
				).toEqual([]);
				expect(result.tools).toBeUndefined();
				expect(result.commandsAndSkills).toBeUndefined();
			});

			it("pushes the month window and the user filter into the activity_events query", async () => {
				seedOverhaulFixtures();

				const { result, statements } = await withCapturedSql((analytics) =>
					analytics.getAnalyticsDashboardReadModel({
						user: user({ id: "admin-1", role: "admin" }),
						systemMonth: "2026-05",
						userId: "user-1",
					}),
				);

				const activitySql = statements.filter((sql) =>
					sql.includes('from "activity_events"'),
				);
				expect(activitySql.length).toBeGreaterThan(0);
				for (const sql of activitySql) {
					expect(sql).toContain('"activity_events"."created_at" >=');
					expect(sql).toContain('"activity_events"."created_at" <');
					expect(sql).toContain('"activity_events"."user_id" =');
				}
				// user-2's June composer_command sits outside both the month window
				// and the user filter, so it is never loaded, let alone returned.
				expect(
					result.commandsAndSkills?.some((row) => row.name === "attach"),
				).toBe(false);
			});

			it("narrows message_analytics to the in-scope message ids instead of reading the table", async () => {
				seedOverhaulFixtures();

				const { statements } = await withCapturedSql((analytics) =>
					analytics.getAnalyticsDashboardReadModel({
						user: user({ id: "admin-1", role: "admin" }),
						systemMonth: "2026-05",
					}),
				);

				const messageAnalyticsSql = statements.filter((sql) =>
					sql.includes('from "message_analytics"'),
				);
				expect(messageAnalyticsSql.length).toBeGreaterThan(0);
				for (const sql of messageAnalyticsSql) {
					expect(sql).toContain('"message_analytics"."message_id" in');
				}
			});

			// Behavioural half of the same fix: whatever the query strategy, a row
			// recorded outside the requested month must not reach the read model.
			it("returns no activity or usage from outside the requested month window", async () => {
				seedOverhaulFixtures();
				const { sqlite, database } = openSeedDatabase();
				database
					.insert(schema.activityEvents)
					.values({
						id: "activity-out-of-window",
						userId: "user-1",
						conversationId: "conv-1",
						kind: "tool_call",
						name: "out_of_window_tool",
						status: "done",
						durationMs: 5,
						modelId: "model1",
						createdAt: new Date("2026-04-30T23:59:59.000Z"),
					})
					.run();
				sqlite.close();

				const { getAnalyticsDashboardReadModel } = await import("./analytics");
				const result = await getAnalyticsDashboardReadModel({
					user: user({ id: "admin-1", role: "admin" }),
					systemMonth: "2026-05",
				});

				expect(
					result.tools?.some((row) => row.name === "out_of_window_tool"),
				).toBe(false);
				expect(
					result.commandsAndSkills?.some((row) => row.name === "attach"),
				).toBe(false);
			});
		});

		it("omits the admin-only activity sections for a non-admin caller", async () => {
			seedOverhaulFixtures();
			const { getAnalyticsDashboardReadModel } = await import("./analytics");

			const result = await getAnalyticsDashboardReadModel({
				user: user({ id: "user-1", role: "user" }),
				month: "2026-05",
			});

			expect(result.tools).toBeUndefined();
			expect(result.commandsAndSkills).toBeUndefined();
			expect(result.latencyByPromptBucket).toBeUndefined();
			expect(result.analyticsUsers).toBeUndefined();
			expect(result.perUser).toBeUndefined();
		});
	});
});
