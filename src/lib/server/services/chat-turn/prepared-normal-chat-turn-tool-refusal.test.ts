// A tool that turns a call down before it dispatches anything ran nothing, so the
// turn goes on: the model reads the refusal, which is written for it, and answers.
// Through the real prepared owner, envelope, recorder and engine, as
// zz-review-A-prepared.test.ts does for a produce_file failure. Production, 13 and
// 14 Nov 2026: five turns of 55 ended with an empty reply and "The model stopped
// before writing its answer" because a refused fetch_url (an address the model made
// up) or a memory_context call outside its scope was recorded as uncertain.
import { beforeEach, expect, it, vi } from "vitest";
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

it("lets the model read a fetch_url refused before it fetched anything, and answer", async () => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const {
		createToolCallRecorder,
		executeToolWithEnvelope,
		modelSafeToolError,
	} = await import("../normal-chat-tools/shared");
	const { FetchUrlRefusedError } = await import(
		"../normal-chat-tools/fetch-url"
	);
	const { allAddressesRefusedMessage } = await import(
		"../url-provenance/refusal-text"
	);
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const { projectNormalChatOutput } = await import(
		"$lib/shared/normal-chat-output"
	);
	const recorder = createToolCallRecorder();
	let generations = 0;
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	const answer = "I could not open that page, so here is what I know instead.";
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const n = generations++;
			if (n === 0)
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: "fetch-0",
							toolName: "fetch_url",
							// An address the model made up: neither the person nor a tool gave it.
							input: JSON.stringify({
								urls: ["https://made-up.example/report"],
							}),
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
					usage,
					warnings: [],
				};
			return {
				content: [{ type: "text" as const, text: answer }],
				finishReason: { unified: "stop" as const, raw: "stop" },
				usage,
				warnings: [],
			};
		},
	});
	mocks.tools.mockResolvedValue({
		stepImages: { drain: () => [] },
		recorder,
		getToolCalls: () => recorder.getEntries(),
		getTurnAsk: () => null,
		tools: {
			// The real envelope and the real refusal error, wired as the real tool is
			// (normal-chat-tools/index.ts): the refusal is thrown before any fetch.
			fetch_url: tool({
				inputSchema: z.object({ urls: z.array(z.string()) }),
				execute: async (input, options) =>
					executeToolWithEnvelope({
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
						onError: (error) => {
							const message = modelSafeToolError(error, "fetch_url failed");
							return {
								modelPayload: { success: false as const, error: message },
								entry: {
									callId: options.toolCallId,
									name: "fetch_url",
									input,
									status: "done" as const,
									outputSummary: message,
									sourceType: "web" as const,
									candidates: [],
									metadata: {
										ok: false,
										evidenceReady: false,
										refusedUrlCount: 1,
									},
								},
							};
						},
					}),
			}),
		},
	});
	mocks.model.mockImplementation((params) => ({
		runPlain: async () => {
			const driver = runNormalChatCompletion(
				params,
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

	// The refusal came before any fetch, and the engine knew it: the call is a
	// proven refusal, not an uncertain effect, so the model had its second turn.
	expect(snapshot?.executions.map((e) => e.state)).toEqual([
		"definitely_not_executed",
	]);
	expect(generations).toBe(2);
	expect(snapshot?.completion).toMatchObject({
		outcome: expect.stringMatching(/^(answered|delivered)$/),
	});
	expect(
		snapshot ? projectNormalChatOutput(snapshot.events).answer : null,
	).toBe(answer);
	// The model was shown the refusal, with the way forward written into it.
	expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
		"call research_web",
	);
});
