import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Every turn-acknowledgment call funnels through this one control-model
// entrypoint, exactly like the memory-control-model adapter's own test
// mocks it — see memory-control-model.test.ts for the sibling pattern.
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function controlModelResult(overrides: {
	text: string;
	modelId?: string;
	modelDisplayName?: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}) {
	return {
		text: overrides.text,
		rawResponse: null,
		modelId: overrides.modelId ?? "model2",
		modelDisplayName: overrides.modelDisplayName ?? "Model Two",
		usage: overrides.usage ?? {
			promptTokens: 40,
			completionTokens: 12,
			totalTokens: 52,
		},
	};
}

describe("resolveTurnAcknowledgment", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-turn-acknowledgment-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		sendJsonControlMessageMock.mockReset();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// db module may not have been imported by this test
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort
		}
	});

	it("returns the intent class and verbatim topic, and records a cost row", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"intentClass":"research","topic":"the weather in Paris"}',
			}),
		);

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		const result = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "Can you check the weather in Paris tomorrow?",
		});

		expect(result).toEqual({
			intentClass: "research",
			topic: "the weather in Paris",
		});

		// Positional + option contract: (message, "model2", options).
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);
		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{
				thinkingMode?: string;
				temperature?: number;
				jsonSchema?: { name?: string };
				signal?: AbortSignal;
			},
		];
		expect(message).toBe("Can you check the weather in Paris tomorrow?");
		expect(modelId).toBe("model2");
		expect(options.thinkingMode).toBe("off");
		expect(options.temperature).toBe(0);
		expect(options.jsonSchema?.name).toBe("turn_acknowledgment");
		expect(options.signal).toBeInstanceOf(AbortSignal);

		// ADR-0047 — spend recorded through the shared control-model cost path,
		// as a usage_events row with a feature-prefixed synthetic messageId
		// (never a real message id, so it can never collide with the turn's
		// own message-analytics row).
		const rows = new Database(dbPath)
			.prepare(
				"SELECT message_id, model_id, prompt_tokens, completion_tokens, total_tokens, cost_usd_micros FROM usage_events",
			)
			.all() as Array<{
			message_id: string;
			model_id: string;
			prompt_tokens: number;
			completion_tokens: number;
			total_tokens: number;
			cost_usd_micros: number;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].message_id).toMatch(/^control:turn_acknowledgment:/);
		expect(rows[0].model_id).toBe("model2");
		expect(rows[0].prompt_tokens).toBe(40);
		expect(rows[0].completion_tokens).toBe(12);
		expect(rows[0].total_tokens).toBe(52);
	});

	it("drops a topic that is not a verbatim substring of the user's message (honesty rule)", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				// The model paraphrased instead of copying verbatim.
				text: '{"intentClass":"research","topic":"French weather conditions"}',
			}),
		);

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		const result = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "Can you check the weather in Paris tomorrow?",
		});

		expect(result).toEqual({ intentClass: "research" });
	});

	it("re-slices the topic from the original message rather than trusting the model's own casing", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"intentClass":"code","topic":"REACT HOOKS"}',
			}),
		);

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		const result = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "Help me debug react hooks in this component",
		});

		expect(result).toEqual({ intentClass: "code", topic: "react hooks" });
	});

	it("rejects an intent class outside the closed enum", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"intentClass":"shopping","topic":"shoes"}',
			}),
		);

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		const result = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "Help me find shoes",
		});

		expect(result).toBeNull();
	});

	it("recovers a JSON envelope wrapped in stray prose", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: 'Sure, here is the classification: {"intentClass":"plan"} done.',
			}),
		);

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		const result = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "Help me plan a trip",
		});

		expect(result).toEqual({ intentClass: "plan" });
	});

	it("returns null on malformed JSON without throwing", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({ text: "not json at all" }),
		);

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		await expect(
			resolveTurnAcknowledgment({
				userId: "u1",
				conversationId: "conv-1",
				message: "Hello there",
			}),
		).resolves.toBeNull();
	});

	it("falls back silently to null on control-model rejection/timeout — never throws, turn proceeds", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockRejectedValue(new Error("upstream timeout"));

		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");
		await expect(
			resolveTurnAcknowledgment({
				userId: "u1",
				conversationId: "conv-1",
				message: "Hello there",
			}),
		).resolves.toBeNull();

		// No spend recorded for a call that never produced a usable response.
		const count = (
			new Database(dbPath)
				.prepare("SELECT COUNT(*) AS n FROM usage_events")
				.get() as { n: number }
		).n;
		expect(count).toBe(0);
	});

	it("returns null immediately for an empty/whitespace-only message without calling the control model", async () => {
		openSeedDatabase().sqlite.close();
		const { resolveTurnAcknowledgment } = await import("./turn-acknowledgment");

		const result = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "   ",
		});

		expect(result).toBeNull();
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
	});

	it("enforces a hard concurrency cap — never queues behind a full instance", async () => {
		openSeedDatabase().sqlite.close();
		const {
			MAX_CONCURRENT_TURN_ACKNOWLEDGMENT_CALLS,
			resolveTurnAcknowledgment,
		} = await import("./turn-acknowledgment");

		const releases: Array<() => void> = [];
		sendJsonControlMessageMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(() =>
						resolve(controlModelResult({ text: '{"intentClass":"chat"}' })),
					);
				}),
		);

		// Saturate the cap with calls that never resolve until we say so.
		// Started one at a time, each awaited up to the point it has actually
		// reached the (mocked) control model, so both are genuinely in-flight
		// (pending, unresolved, counted) by the time the over-cap call below
		// races them — without two first-time dynamic imports of the same
		// module landing in the exact same microtask, which is a Vitest/Vite
		// SSR module-cache hazard, not a property of the code under test.
		const inFlight: Array<Promise<unknown>> = [];
		for (let i = 0; i < MAX_CONCURRENT_TURN_ACKNOWLEDGMENT_CALLS; i += 1) {
			const callsBefore = sendJsonControlMessageMock.mock.calls.length;
			inFlight.push(
				resolveTurnAcknowledgment({
					userId: "u1",
					conversationId: "conv-1",
					message: `in-flight message ${i}`,
				}),
			);
			await vi.waitFor(() =>
				expect(sendJsonControlMessageMock.mock.calls.length).toBe(
					callsBefore + 1,
				),
			);
		}

		// One more call over the cap: must resolve to null WITHOUT ever
		// attempting a network call — proven by the call count below, not by
		// timing.
		const callCountBeforeOverCap = sendJsonControlMessageMock.mock.calls.length;
		const overCapResult = await resolveTurnAcknowledgment({
			userId: "u1",
			conversationId: "conv-1",
			message: "one too many",
		});

		expect(overCapResult).toBeNull();
		expect(sendJsonControlMessageMock.mock.calls.length).toBe(
			callCountBeforeOverCap,
		);

		// Drain the in-flight calls so the module's counter returns to zero and
		// nothing leaks into the next test.
		for (const release of releases) release();
		await Promise.all(inFlight);
	});
});

describe("extractVerbatimTopic", () => {
	it("matches case-insensitively and re-slices the exact original casing", async () => {
		const { extractVerbatimTopic } = await import("./turn-acknowledgment");
		expect(
			extractVerbatimTopic("PARIS trip", "Planning a Paris Trip next month"),
		).toBe("Paris Trip");
	});

	it("returns undefined when the candidate is not a substring of the message", async () => {
		const { extractVerbatimTopic } = await import("./turn-acknowledgment");
		expect(extractVerbatimTopic("Tokyo trip", "Planning a Paris trip")).toBe(
			undefined,
		);
	});

	it("returns undefined for an empty or whitespace-only candidate", async () => {
		const { extractVerbatimTopic } = await import("./turn-acknowledgment");
		expect(extractVerbatimTopic("", "Planning a Paris trip")).toBe(undefined);
		expect(extractVerbatimTopic("   ", "Planning a Paris trip")).toBe(
			undefined,
		);
		expect(extractVerbatimTopic(undefined, "Planning a Paris trip")).toBe(
			undefined,
		);
	});
});
