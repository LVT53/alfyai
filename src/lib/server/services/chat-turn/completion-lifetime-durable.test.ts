// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { NormalChatContinuationSnapshot } from "../normal-chat-model";

let directory: string,
	database: typeof import("../../db"),
	module: typeof import("./completion-lifetime");
const input = {
	userId: "u",
	conversationId: "c",
	requestId: "synthetic-request",
};
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "task2b-lifetime-"));
	const path = join(directory, "scratch.sqlite");
	const sqlite = new Database(path);
	migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
	sqlite.close();
	vi.resetModules();
	vi.stubEnv("DATABASE_PATH", path);
	database = await import("../../db");
	database.db
		.insert(schema.users)
		.values({ id: "u", email: "synthetic@test.invalid", passwordHash: "x" })
		.run();
	database.db
		.insert(schema.conversations)
		.values({ id: "c", userId: "u", title: "Synthetic" })
		.run();
	database.db
		.insert(schema.providers)
		.values({
			id: "p1",
			name: "first",
			displayName: "First",
			baseUrl: "https://test.invalid",
			apiKeyEncrypted: "x",
			apiKeyIv: "x",
		})
		.run();
	database.db
		.insert(schema.providerModels)
		.values({
			id: "m1",
			providerId: "p1",
			name: "first",
			displayName: "First",
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 2_000_000,
		})
		.run();
	module = await import("./completion-lifetime");
});
afterEach(() => {
	database?.sqlite.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});
function snapshot(
	scope: ReturnType<typeof module.beginCompletionLifetime>["scope"],
	complete: boolean,
): NormalChatContinuationSnapshot {
	return {
		version: 1,
		fidelity: "exact",
		turnId: scope.turnId,
		segmentId: scope.segmentId,
		original: {
			providerId: "p1",
			providerBaseUrl: "https://test.invalid",
			modelName: "first",
			messages: [],
		},
		steps: [],
		prepared: { maxOutputTokens: 1000 },
		pendingImageEntries: [],
		executions: [],
		events: [],
		usage: [
			{
				turnId: scope.turnId,
				segmentId: scope.segmentId,
				attemptId: "a",
				phase: "working",
				providerId: "p1",
				modelId: "provider:p1:m1",
				responseModelId: "first",
				inputTokens: complete ? 100 : null,
				outputTokens: complete ? 20 : null,
				totalTokens: complete ? 120 : null,
				complete,
			},
		],
		sequence: 0,
		nextAttempt: 1,
		workingSteps: 1,
		closingSegments: [],
		deadlineAt: Date.now() + 10000,
		totalTimeoutMs: 10000,
		completion: {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			phase: "working",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "natural_stop",
			closingAttempted: false,
		},
	};
}
const attempt = {
	attemptId: "a",
	phase: "working",
	providerId: "p1",
	modelId: "provider:p1:m1",
	providerModelName: "first",
} as const;
it("keeps delayed message accounting pending until late registered usage settles once", async () => {
	const life = module.beginCompletionLifetime(input);
	await life.register(attempt);
	database.db
		.insert(schema.messages)
		.values({
			id: "m",
			conversationId: "c",
			role: "assistant",
			content: "Canonical",
		})
		.run();
	life.capture(snapshot(life.scope, false));
	await life.finish("m");
	const analytics = await import("../analytics");
	await analytics.recordMessageAnalytics({
		userId: "u",
		conversationId: "c",
		messageId: "m",
		model: "provider:p1:m1",
		turnSegmentId: life.scope.segmentId,
	});
	expect(await analytics.getMessageUsageState("u", "c", "m")).toMatchObject({
		status: "pending",
	});
	life.capture(snapshot(life.scope, true));
	await life.finish("m");
	life.capture(snapshot(life.scope, true));
	await life.finish("m");
	expect(await analytics.getMessageUsageState("u", "c", "m")).toMatchObject({
		status: "ready",
		costUsd: 0.00014,
	});
	expect(database.db.select().from(schema.usageEvents).all()).toHaveLength(1);
});
it("observes an accepted ownerless resumed segment using its durable parent without generating", async () => {
	const life = module.beginCompletionLifetime({
		...input,
		turnId: "parent-turn",
	});
	await life.register(attempt);
	database.sqlite.close();
	vi.resetModules();
	module = await import("./completion-lifetime");
	database = await import("../../db");
	const interrupted = await module.observeCompletionTurn(input);
	expect(interrupted).toMatchObject({
		turnId: "parent-turn",
		segmentId: life.scope.segmentId,
		outcome: "incomplete",
		stopCause: "uncertain_execution",
		attemptIdsJson: '["a"]',
	});
	expect(await module.observeCompletionTurn(input)).toMatchObject({
		settledAt: interrupted?.settledAt,
	});
	expect(() =>
		module.beginCompletionLifetime({ ...input, turnId: "parent-turn" }),
	).toThrow(/existing/i);
});
