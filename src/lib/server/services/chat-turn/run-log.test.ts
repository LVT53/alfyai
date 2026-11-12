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

// The anonymous run record: one row per model run, no user, conversation or
// message id, kept when the chat is deleted and written for incognito chats too.
let directory: string;
let database: typeof import("../../db");
let lifetime: typeof import("./completion-lifetime");
let ledger: typeof import("./turn-ledger");
let info: ReturnType<typeof vi.spyOn>;
const input = { userId: "u", conversationId: "c", requestId: "request-one" };
const attempt = {
	attemptId: "a",
	phase: "working",
	providerId: "p1",
	modelId: "provider:p1:m1",
	providerModelName: "first",
} as const;

beforeEach(async () => {
	info = vi.spyOn(console, "info").mockImplementation(() => {});
	directory = mkdtempSync(join(tmpdir(), "run-log-"));
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
	lifetime = await import("./completion-lifetime");
	ledger = await import("./turn-ledger");
});
afterEach(() => {
	info.mockRestore();
	vi.useRealTimers();
	database?.sqlite.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

const runs = () => database.db.select().from(schema.normalChatRunLog).all();
const attemptsOf = (row: { attemptsJson: string }) =>
	JSON.parse(row.attemptsJson) as Array<Record<string, unknown>>;

/** A capture holding one attempt "a": ended well, or failed with no usage. */
function snapshot(
	scope: { turnId: string; segmentId: string },
	how: "answered" | "failed" = "answered",
	attemptId = "a",
): NormalChatContinuationSnapshot {
	const answered = how === "answered";
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
				attemptId,
				phase: "working",
				providerId: "p1",
				modelId: "provider:p1:m1",
				responseModelId: "first",
				inputTokens: answered ? 100 : null,
				outputTokens: answered ? 20 : null,
				totalTokens: answered ? 120 : null,
				complete: answered,
				...(answered
					? {}
					: {
							outcome: "failed" as const,
							safeStopCause: "transport_error" as const,
						}),
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
			outcome: answered ? "answered" : "failed",
			stopCause: answered ? "natural_stop" : "transport_error",
			workingStopCause: answered ? "natural_stop" : "transport_error",
			closingAttempted: false,
		},
	};
}

function saveReply(id = "m") {
	database.db
		.insert(schema.messages)
		.values({ id, conversationId: "c", role: "assistant", content: "Reply" })
		.run();
}

it("opens a record with a fresh id when the lifetime begins, names the model at registration, and settles it with the ledger", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.parse("2026-11-12T10:00:00Z"));
	const life = lifetime.beginCompletionLifetime(input);
	expect(runs()).toEqual([
		expect.objectContaining({
			tracked: true,
			segmentId: life.scope.segmentId,
			settledAt: null,
			outcome: null,
			attemptsJson: "[]",
		}),
	]);
	expect(runs()[0].id).not.toBe(life.scope.segmentId);
	// A run that never settles still names its model.
	await life.register(attempt);
	expect(attemptsOf(runs()[0])).toEqual([
		expect.objectContaining({
			attemptId: "a",
			phase: "working",
			providerId: "p1",
			modelId: "provider:p1:m1",
			providerModelName: "first",
			outcome: null,
			usageFinal: false,
		}),
	]);
	vi.setSystemTime(Date.parse("2026-11-12T10:00:01.500Z"));
	life.capture(snapshot(life.scope));
	saveReply();
	await life.finish("m", {
		firstByteMs: 15,
		firstTokenMs: 50,
		generationTimeMs: 200,
	});
	const [row] = runs();
	expect(row).toMatchObject({
		tracked: true,
		segmentId: life.scope.segmentId,
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "natural_stop",
		phase: "working",
		closingAttempted: false,
		recoveryCount: 0,
		saved: true,
		firstByteMs: 15,
		firstThinkingMs: null,
		firstTokenMs: 50,
		generationTimeMs: 200,
	});
	expect(row.settledAt).toBeInstanceOf(Date);
	expect(attemptsOf(row)).toEqual([
		{
			attemptId: "a",
			phase: "working",
			providerId: "p1",
			modelId: "provider:p1:m1",
			providerModelName: "first",
			outcome: null,
			safeStopCause: null,
			inputTokens: 100,
			outputTokens: 20,
			reasoningTokens: null,
			totalTokens: 120,
			usageFinal: true,
			generationTimeMs: 1500,
			costUsdMicros: 140,
		},
	]);
	// Whatever else it holds, it holds no person, chat or message identity.
	expect(
		Object.keys(row).filter((key) => /user|conversation|message/i.test(key)),
	).toEqual([]);
});

it("records an incognito run with no id that could join it to the chat, and still writes no ledger or billing row", async () => {
	database.sqlite
		.prepare("UPDATE conversations SET memory_incognito = 1 WHERE id = ?")
		.run("c");
	const life = lifetime.beginCompletionLifetime(input);
	expect(life.tracked).toBe(false);
	await life.register(attempt);
	life.capture(snapshot(life.scope));
	await life.finish();
	await life.finish();
	const [row] = runs();
	expect(runs()).toHaveLength(1);
	expect(row).toMatchObject({
		tracked: false,
		segmentId: null,
		outcome: "answered",
		stopCause: "natural_stop",
		phase: "working",
		saved: false,
	});
	expect(row.settledAt).toBeInstanceOf(Date);
	expect(attemptsOf(row)).toEqual([
		expect.objectContaining({
			attemptId: null,
			modelId: "provider:p1:m1",
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			usageFinal: true,
		}),
	]);
	const text = JSON.stringify(row);
	for (const joinable of [
		life.scope.segmentId,
		life.scope.turnId,
		"request-one",
	])
		expect(text).not.toContain(joinable);
	expect(database.db.select().from(schema.normalChatTurns).all()).toEqual([]);
	expect(database.db.select().from(schema.normalChatAttempts).all()).toEqual(
		[],
	);
	expect(database.db.select().from(schema.usageEvents).all()).toEqual([]);
	// The status line covers it too, once, with no segment and no attempt ids.
	expect(
		info.mock.calls
			.map((call: unknown[]) => String(call[0]))
			.filter((line: string) => line.startsWith("[TURN_SETTLED]")),
	).toEqual([
		"[TURN_SETTLED] segment=- outcome=answered stop=natural_stop working=natural_stop phase=working closing=0 recovery=0 accounting=- attempts=working:-:-:provider:p1:m1",
	]);
});

it("outlives the deletion of its message, its conversation and its person, while the ledger goes", async () => {
	const life = lifetime.beginCompletionLifetime(input);
	await life.register(attempt);
	life.capture(snapshot(life.scope));
	saveReply();
	await life.finish("m");
	const before = runs();
	expect(database.db.select().from(schema.normalChatTurns).all()).toHaveLength(
		1,
	);
	database.sqlite.prepare("DELETE FROM messages WHERE id = ?").run("m");
	expect(runs()).toEqual(before);
	database.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run("c");
	database.sqlite.prepare("DELETE FROM users WHERE id = ?").run("u");
	expect(database.db.select().from(schema.normalChatTurns).all()).toEqual([]);
	expect(database.db.select().from(schema.normalChatAttempts).all()).toEqual(
		[],
	);
	expect(runs()).toEqual(before);
});

it("records a failed outcome and an incomplete one", async () => {
	const failed = lifetime.beginCompletionLifetime(input);
	await failed.register(attempt);
	failed.capture(snapshot(failed.scope, "failed"));
	await failed.finish();
	const never = lifetime.beginCompletionLifetime({
		...input,
		requestId: "request-two",
	});
	await never.register({ ...attempt, attemptId: "b" });
	await never.finish();
	const [first, second] = runs();
	expect(first).toMatchObject({
		outcome: "failed",
		stopCause: "transport_error",
		workingStopCause: "transport_error",
	});
	expect(attemptsOf(first)).toEqual([
		expect.objectContaining({
			outcome: "failed",
			safeStopCause: "transport_error",
			usageFinal: false,
			inputTokens: null,
		}),
	]);
	expect(second).toMatchObject({
		outcome: "incomplete",
		stopCause: "uncertain_execution",
		workingStopCause: "uncertain_execution",
	});
});

it("changes nothing on a second finish, and fills the saved reply and the timing in once", async () => {
	const life = lifetime.beginCompletionLifetime(input);
	await life.register(attempt);
	life.capture(snapshot(life.scope));
	await life.finish();
	const settled = runs()[0];
	expect(settled).toMatchObject({ saved: false, firstByteMs: null });
	await life.finish();
	expect(runs()[0]).toEqual(settled);
	saveReply();
	await life.finish("m", { firstByteMs: 15, generationTimeMs: 200 });
	expect(runs()[0]).toEqual({
		...settled,
		saved: true,
		firstByteMs: 15,
		generationTimeMs: 200,
	});
	const filled = runs()[0];
	await life.finish("m", {
		firstByteMs: 99,
		firstTokenMs: 98,
		generationTimeMs: 97,
	});
	// What was set stays; only what was still empty can be filled.
	expect(runs()[0]).toEqual({ ...filled, firstTokenMs: 98 });
});

it("never fails or delays the turn when the record cannot be written", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	database.sqlite.exec(
		"CREATE TRIGGER fail_open BEFORE INSERT ON normal_chat_run_log BEGIN SELECT RAISE(ABORT, 'offline'); END",
	);
	const first = lifetime.beginCompletionLifetime(input);
	await first.register(attempt);
	first.capture(snapshot(first.scope));
	await expect(first.finish()).resolves.toBeUndefined();
	expect(runs()).toEqual([]);
	database.sqlite.exec("DROP TRIGGER fail_open");
	database.sqlite.exec(
		"CREATE TRIGGER fail_update BEFORE UPDATE ON normal_chat_run_log BEGIN SELECT RAISE(ABORT, 'offline'); END",
	);
	const second = lifetime.beginCompletionLifetime({
		...input,
		requestId: "request-two",
	});
	await second.register({ ...attempt, attemptId: "b" });
	second.capture(snapshot(second.scope, "answered", "b"));
	await expect(second.finish()).resolves.toBeUndefined();
	expect(runs()[0].settledAt).toBeNull();
	// Both turns settled in the ledger as usual, and the warnings name no content.
	expect(database.db.select().from(schema.normalChatTurns).all()).toHaveLength(
		2,
	);
	expect(
		database.db
			.select()
			.from(schema.normalChatTurns)
			.all()
			.every((turn) => turn.outcome === "answered"),
	).toBe(true);
	const lines = warn.mock.calls.map(([line]) => String(line));
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines)
		expect(line).toMatch(/^\[RUN_LOG\] write failed op=\w+ code=\S+$/);
	warn.mockRestore();
});

it("settles the record of a turn the ledger finds abandoned", async () => {
	const life = lifetime.beginCompletionLifetime(input);
	await life.register(attempt);
	// Another process asks, and this run's owner is not among the live ones.
	ledger.observeAbandonedTurn(life.scope, []);
	const [row] = runs();
	expect(row).toMatchObject({
		tracked: true,
		outcome: "incomplete",
		stopCause: "uncertain_execution",
		workingStopCause: "uncertain_execution",
		phase: "working",
		saved: false,
	});
	expect(row.settledAt).toBeInstanceOf(Date);
	expect(attemptsOf(row)).toEqual([
		expect.objectContaining({ attemptId: "a", modelId: "provider:p1:m1" }),
	]);
});

it("still settles the record from memory when the ledger cannot settle (its chat was deleted mid-run), and finish fails as before", async () => {
	const life = lifetime.beginCompletionLifetime(input);
	await life.register(attempt);
	life.capture(snapshot(life.scope));
	// Let the ledger take the capture, so nothing is queued when the chat goes.
	await new Promise((resolve) => setTimeout(resolve, 0));
	database.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run("c");
	expect(database.db.select().from(schema.normalChatTurns).all()).toEqual([]);
	await expect(life.finish()).rejects.toThrow(/scope/i);
	const [row] = runs();
	expect(row).toMatchObject({
		tracked: true,
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "natural_stop",
		phase: "working",
	});
	expect(row.settledAt).toBeInstanceOf(Date);
	expect(attemptsOf(row)).toEqual([
		expect.objectContaining({
			attemptId: "a",
			modelId: "provider:p1:m1",
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			usageFinal: true,
		}),
	]);
});
