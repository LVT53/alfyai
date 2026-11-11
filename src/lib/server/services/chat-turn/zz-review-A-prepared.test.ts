// Adversarial review A reproducers through the real prepared owner. A failure is a finding.
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
			inputValue: "make the report",
			systemPrompt: "original instructions",
		}),
	);
});

it("lets the model see and correct a settled produce_file failure (the tool's own same-turn retry budget)", async () => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const { createToolCallRecorder, executeToolWithEnvelope } = await import(
		"../normal-chat-tools/shared"
	);
	const {
		buildProduceFileFailedPayload,
		buildProduceFileSucceededPayload,
		createProduceFileToolCallEntry,
		summarizeProduceFileResult,
	} = await import("../normal-chat-tools/produce-file");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const recorder = createToolCallRecorder();
	let generations = 0;
	let submissions = 0;
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const n = generations++;
			if (n < 2)
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: `pf-${n}`,
							toolName: "produce_file",
							input: JSON.stringify({ attempt: n }),
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
					usage,
					warnings: [],
				};
			return {
				content: [{ type: "text" as const, text: "Your report is ready." }],
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
			produce_file: tool({
				inputSchema: z.object({ attempt: z.number() }),
				execute: async (input, options) =>
					executeToolWithEnvelope({
						toolName: "produce_file",
						options,
						recorder,
						timeoutMs: 1000,
						run: async () => {
							submissions++;
							// The durable ledger's terminal verdict, exactly as the real tool
							// builds it: the program ran and failed; the model may correct it.
							const payload =
								input.attempt === 0
									? buildProduceFileFailedPayload({
											jobId: "job-0",
											errorCode: "program_execution_failed",
											message: "Traceback: NameError: name 'df' is not defined",
										})
									: buildProduceFileSucceededPayload({
											jobId: "job-1",
											files: [
												{
													filename: "report.pdf",
													mimeType: "application/pdf",
													sizeBytes: 10,
												},
											],
										});
							return {
								modelPayload: payload,
								entry: createProduceFileToolCallEntry({
									callId: options.toolCallId,
									input: {} as never,
									payload,
									outputSummary: summarizeProduceFileResult(payload),
								}),
							};
						},
						onError: () => {
							throw new Error("not expected");
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
	console.info(
		"REVIEW-A observed",
		JSON.stringify({
			completion: snapshot?.completion,
			states: snapshot?.executions.map((e) => e.state),
			answer: snapshot
				? (
						await import("$lib/shared/normal-chat-output")
					).projectNormalChatOutput(snapshot.events).answer
				: null,
		}),
	);
	// The verdict was a settled, durable failure, not an in-flight effect.
	expect(recorder.getEntries()[0]).toMatchObject({
		status: "failed",
		metadata: { ok: false, jobStatus: "failed", retryable: true },
	});
	expect({
		completion: snapshot?.completion,
		states: snapshot?.executions.map((e) => e.state),
		generations,
		submissions,
	}).toMatchObject({
		completion: { outcome: expect.stringMatching(/^(answered|delivered)$/) },
		generations: 3,
		submissions: 2,
	});
});
