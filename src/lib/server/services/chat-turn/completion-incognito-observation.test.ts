// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { NormalChatContinuationSnapshot } from "../normal-chat-model";

// Review reproducer: what does an observer (Stop handoff, reconnect after the
// replay journal is gone) learn about a FINISHED turn of an incognito
// conversation? The reply is saved; the ledger is skipped for incognito.

let directory: string,
	database: typeof import("../../db"),
	module: typeof import("./completion-lifetime");

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "review-incognito-"));
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
		.values([
			{ id: "tracked", userId: "u", title: "Tracked" },
			{ id: "private", userId: "u", title: "Private", memoryIncognito: true },
		])
		.run();
	module = await import("./completion-lifetime");
});
afterEach(() => {
	database?.sqlite.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function answered(
	scope: ReturnType<typeof module.beginCompletionLifetime>["scope"],
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
		usage: [],
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
			outcome: "stopped",
			stopCause: "user_stop",
			workingStopCause: "user_stop",
			closingAttempted: false,
		},
	};
}

async function finishedTurn(conversationId: string) {
	const input = { userId: "u", conversationId, requestId: "stream-1" };
	const life = module.beginCompletionLifetime(input);
	await life.register({
		attemptId: `${conversationId}-a`,
		phase: "working",
		providerId: "p1",
		modelId: "provider:p1:m1",
		providerModelName: "first",
	});
	database.db
		.insert(schema.messages)
		.values({
			id: `${conversationId}-saved`,
			conversationId,
			role: "assistant",
			content: "Saved partial",
		})
		.run();
	life.capture(answered(life.scope));
	await life.finish(`${conversationId}-saved`);
	return {
		tracked: life.tracked,
		observation: await module.observeCompletionTurn(input),
	};
}

it("a tracked conversation's finished turn is observable as terminal with its saved row", async () => {
	const result = await finishedTurn("tracked");
	expect(result.tracked).toBe(true);
	expect(result.observation).toMatchObject({
		state: "terminal",
		assistantMessageId: "tracked-saved",
		completion: { outcome: "stopped" },
	});
});

it("an incognito conversation's finished turn should also be observable (REVIEW: currently unavailable)", async () => {
	const result = await finishedTurn("private");
	expect(result.tracked).toBe(false);
	// The reply row exists, but the observer is told nothing is known.
	expect(result.observation.state).toBe("terminal");
});

it("incognito receipt survives module restart without accounting rows and stays owner/request scoped", async () => {
	await finishedTurn("private");
	expect(database.db.select().from(schema.normalChatTurns).all()).toEqual([]);
	expect(database.db.select().from(schema.normalChatAttempts).all()).toEqual(
		[],
	);
	vi.resetModules();
	module = await import("./completion-lifetime");
	const input = {
		userId: "u",
		conversationId: "private",
		requestId: "stream-1",
	};
	expect(await module.observeCompletionTurn(input)).toMatchObject({
		state: "terminal",
		assistantMessageId: "private-saved",
	});
	for (const other of [
		{ ...input, userId: "someone-else" },
		{ ...input, conversationId: "tracked" },
		{ ...input, requestId: "other" },
		{ ...input, turnId: "other" },
	]) {
		expect(await module.observeCompletionTurn(other)).toMatchObject({
			state: "unavailable",
		});
	}
	database.db
		.delete(schema.messages)
		.where(eq(schema.messages.id, "private-saved"))
		.run();
	expect(await module.observeCompletionTurn(input)).toMatchObject({
		state: "unavailable",
	});
});
