// A tool call that turns out to be settled (a refusal made before anything ran, or a
// failure of a tool that only reads) does not end the turn: the model reads the
// error, which is written for it, and answers. Through the real prepared owner,
// envelope, recorder and engine, as zz-review-A-prepared.test.ts does for a
// produce_file failure. Production, 13 and 14 Nov 2026: five turns of 55 ended with
// an empty reply and "The model stopped before writing its answer" because a
// refused fetch_url (an address the model made up) or a memory_context call outside
// its scope was recorded as uncertain; a search, a fetch or a picture search that
// timed out or failed upstream would have done the same.
import type { Tool } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { ToolCallRecorder } from "../normal-chat-tools/shared";
import {
	createPlainNormalChatModelRunResult,
	createPlainNormalChatPreparedContext,
	createPlainNormalChatProvider,
	createPlainNormalChatSendModelParams,
} from "./plain-normal-chat-model-run.test-helpers";

const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	runtime: vi.fn(),
	tools: vi.fn(),
	model: vi.fn(),
	admit: vi.fn(),
	record: vi.fn(),
	settle: vi.fn(),
	keepLocal: vi.fn(),
}));
vi.mock("./turn-ledger", () => ({
	admitTurn: mocks.admit,
	recordTurnAttempt: mocks.record,
	settleTurn: mocks.settle,
	observeAbandonedTurn: vi.fn(),
}));
vi.mock("./shared-normal-chat-model-run-helpers", async (original) => ({
	...(await original<
		typeof import("./shared-normal-chat-model-run-helpers")
	>()),
	prepareOutboundContext: mocks.prepare,
	createToolPack: mocks.tools,
	resolveProviderRuntime: (...args: unknown[]) => mocks.runtime(...args),
}));
vi.mock("../connections/resolve", () => ({
	resolveActiveCapabilities: async () => new Set(),
}));
vi.mock("../connections/locality", () => ({
	hasLocalDistillEnabled: mocks.keepLocal,
}));
vi.mock("../normal-chat-model", async (original) => ({
	...(await original<typeof import("../normal-chat-model")>()),
	prepareNormalChatCompletionRun: mocks.model,
}));

import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.keepLocal.mockResolvedValue(false);
	mocks.runtime.mockImplementation(async (params) => ({
		provider: createPlainNormalChatProvider(),
		modelId: "model1",
		modelConfig: params.runtimeConfig.model1,
		baseContextLimits: {
			maxModelContext: params.runtimeConfig.model1MaxModelContext,
			targetConstructedContext:
				params.runtimeConfig.model1TargetConstructedContext,
			compactionUiThreshold: params.runtimeConfig.model1CompactionUiThreshold,
		},
		depthEffort: null,
	}));
	mocks.admit.mockReturnValue({ status: "admitted" });
	mocks.record.mockResolvedValue(undefined);
	mocks.prepare.mockResolvedValue(
		createPlainNormalChatPreparedContext({
			inputValue: "what does the report say?",
			systemPrompt: "original instructions",
		}),
	);
});

/** What a test needs to build one tool the way the real ones are built (normal-chat-tools/index.ts). */
type Kit = {
	recorder: ToolCallRecorder;
	envelope: typeof import("../normal-chat-tools/shared").executeToolWithEnvelope;
	/** The model-safe failure a real tool's `onError` returns, and the row it records. */
	failed: (
		options: { toolCallId: string },
		input: Record<string, unknown>,
		error: unknown,
		metadata?: Record<string, string | number | boolean | null>,
	) => {
		modelPayload: { success: false; error: string };
		entry: ToolCallEntry;
	};
	tool: typeof import("ai").tool;
	z: typeof import("zod").z;
};

/**
 * One turn through the real prepared owner and engine: the model calls the one
 * tool the test builds, then, if it is asked a second time, writes `answer`.
 */
async function runTurnWithTool(params: {
	toolName: string;
	toolInput: Record<string, unknown>;
	answer: string;
	makeTool: (kit: Kit) => Tool;
}) {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const shared = await import("../normal-chat-tools/shared");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const { projectNormalChatOutput } = await import(
		"$lib/shared/normal-chat-output"
	);
	const recorder = shared.createToolCallRecorder();
	let generations = 0;
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const n = generations++;
			if (n === 0)
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: `${params.toolName}-0`,
							toolName: params.toolName,
							input: JSON.stringify(params.toolInput),
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
					usage,
					warnings: [],
				};
			return {
				content: [{ type: "text" as const, text: params.answer }],
				finishReason: { unified: "stop" as const, raw: "stop" },
				usage,
				warnings: [],
			};
		},
	});
	const kit: Kit = {
		recorder,
		envelope: shared.executeToolWithEnvelope,
		failed: (options, input, error, metadata = {}) => {
			const message = shared.modelSafeToolError(error, "the tool failed");
			return {
				modelPayload: { success: false as const, error: message },
				entry: {
					callId: options.toolCallId,
					name: params.toolName,
					input,
					status: "done" as const,
					outputSummary: message,
					sourceType: "web" as const,
					candidates: [],
					metadata: { ok: false, evidenceReady: false, ...metadata },
				},
			};
		},
		tool,
		z,
	};
	mocks.tools.mockResolvedValue({
		stepImages: { drain: () => [] },
		recorder,
		getToolCalls: () => recorder.getEntries(),
		getTurnAsk: () => null,
		tools: { [params.toolName]: params.makeTool(kit) },
	});
	mocks.model.mockImplementation((modelParams) => ({
		runPlain: async () => {
			const driver = runNormalChatCompletion(
				modelParams,
				{
					model,
					maxModelContext: 32000,
					providerOptions: undefined,
					stopWhen: undefined,
					metadata: () => createPlainNormalChatModelRunResult().model,
					mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
				},
				false,
			);
			for (;;) {
				const next = await driver.next();
				if (next.done) return next.value;
			}
		},
		stream: async function* () {},
		getSnapshot: () => null,
	}));

	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await run.runPlain();
	const snapshot = run.receipt.getSnapshot();
	return {
		completion: snapshot?.completion,
		states: snapshot?.executions.map((e) => e.state),
		answer: snapshot ? projectNormalChatOutput(snapshot.events).answer : null,
		generations: () => generations,
		/** What the model was sent the second time it was asked. */
		secondPrompt: () => JSON.stringify(model.doGenerateCalls[1]?.prompt),
	};
}

/** A search that never answers: the envelope's own timeout ends it after 20 ms. */
const neverAnsweringSearch =
	(readOnly: boolean) =>
	({ recorder, envelope, failed, tool, z }: Kit) =>
		tool({
			inputSchema: z.object({ query: z.string() }),
			execute: async (input, options) =>
				envelope({
					toolName: "research_web",
					timeoutMs: 20,
					options,
					recorder,
					readOnly,
					run: async () => {
						await new Promise(() => {});
						throw new Error("unreachable");
					},
					onError: (error) => failed(options, input, error),
				}),
		});

it("lets the model read a fetch_url refused before it fetched anything, and answer", async () => {
	const { FetchUrlRefusedError } = await import(
		"../normal-chat-tools/fetch-url"
	);
	const { allAddressesRefusedMessage } = await import(
		"../url-provenance/refusal-text"
	);
	const answer = "I could not open that page, so here is what I know instead.";

	const turn = await runTurnWithTool({
		toolName: "fetch_url",
		// An address the model made up: neither the person nor a tool gave it.
		toolInput: { urls: ["https://made-up.example/report"] },
		answer,
		// The real envelope and the real refusal error, wired as the real tool is
		// (normal-chat-tools/index.ts): the refusal is thrown before any fetch.
		makeTool: ({ recorder, envelope, failed, tool, z }) =>
			tool({
				inputSchema: z.object({ urls: z.array(z.string()) }),
				execute: async (input, options) =>
					envelope({
						toolName: "fetch_url",
						timeoutMs: 1000,
						options,
						recorder,
						run: async () => {
							throw new FetchUrlRefusedError(
								allAddressesRefusedMessage(input.urls.length),
								input.urls.length,
							);
						},
						onError: (error) =>
							failed(options, input, error, { refusedUrlCount: 1 }),
					}),
			}),
	});

	// The refusal came before any fetch, and the engine knew it: the call is a
	// proven refusal, not an uncertain effect, so the model had its second turn.
	expect(turn.states).toEqual(["definitely_not_executed"]);
	expect(turn.generations()).toBe(2);
	expect(turn.completion).toMatchObject({
		outcome: expect.stringMatching(/^(answered|delivered)$/),
	});
	expect(turn.answer).toBe(answer);
	// The model was shown the refusal, with the way forward written into it.
	expect(turn.secondPrompt()).toContain("call research_web");
});

it("lets the model read the failure of a tool that only reads, and answer", async () => {
	const answer = "The search was unavailable, so here is what I know instead.";

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer,
		makeTool: neverAnsweringSearch(true),
	});

	// The search went out and timed out, so it ran: a settled failure, not a
	// refusal. A search changes nothing when it runs again, so the engine goes on.
	expect(turn.states).toEqual(["failed"]);
	expect(turn.generations()).toBe(2);
	expect(turn.completion).toMatchObject({
		outcome: expect.stringMatching(/^(answered|delivered)$/),
	});
	expect(turn.answer).toBe(answer);
	expect(turn.secondPrompt()).toContain("research_web timed out after 20ms");
});

it("still ends the turn when a tool that did not say it only reads times out", async () => {
	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer: "Never asked for.",
		makeTool: neverAnsweringSearch(false),
	});

	// The same timeout from a tool that has not said it only reads: it may have
	// written before it timed out, so the engine stops there and never asks again.
	expect(turn.states).toEqual(["uncertain"]);
	expect(turn.generations()).toBe(1);
	expect(turn.completion).toMatchObject({
		outcome: "incomplete",
		stopCause: "uncertain_execution",
	});
});
