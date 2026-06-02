import { describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { RuntimeConfig } from "$lib/server/config-store";

const mocks = vi.hoisted(() => ({
	createNormalChatTools: vi.fn(),
	prepareOutboundChatContext: vi.fn(),
	resolveNormalChatModelRunProvider: vi.fn(),
	runStreamingNormalChatModelRun: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-context", () => ({
	prepareOutboundChatContext: mocks.prepareOutboundChatContext,
}));

vi.mock("$lib/server/services/normal-chat-model", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-model")
		>();
	return {
		...actual,
		resolveNormalChatModelRunProvider: mocks.resolveNormalChatModelRunProvider,
		runStreamingNormalChatModelRun: mocks.runStreamingNormalChatModelRun,
	};
});

vi.mock("$lib/server/services/normal-chat-tools", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-tools")
		>();
	return {
		...actual,
		createNormalChatTools: mocks.createNormalChatTools,
	};
});

import { runStreamingNormalChatSendModel } from "./streaming-normal-chat-model-run";

const runtimeConfig = {
	requestTimeoutMs: 1_500,
	model1MaxModelContext: 10_000,
	model1TargetConstructedContext: 8_000,
	model1CompactionUiThreshold: 7_000,
	model1: {
		baseUrl: "https://openai-compatible.example/v1",
		apiKey: "model-1-secret",
		modelName: "gpt-4.1",
		displayName: "Model One",
		systemPrompt: "",
		maxTokens: 2048,
		reasoningEffort: "high",
		thinkingType: null,
	},
	model2: {
		baseUrl: "https://unused.example/v1",
		apiKey: "",
		modelName: "unused",
		displayName: "Unused",
		systemPrompt: "",
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
	},
} as RuntimeConfig;

async function* streamEvents() {
	yield { type: "text_delta" as const, text: "Answer" };
}

describe("runStreamingNormalChatSendModel", () => {
	beforeEach(() => {
		mocks.createNormalChatTools.mockReset();
		mocks.prepareOutboundChatContext.mockReset();
		mocks.resolveNormalChatModelRunProvider.mockReset();
		mocks.runStreamingNormalChatModelRun.mockReset();
		mocks.createNormalChatTools.mockReturnValue({
			tools: { produce_file: { __testTool: true } },
			getToolCalls: () => [],
		});
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "provider-secret",
			maxOutputTokens: 4096,
			maxModelContext: 1234,
			targetConstructedContext: 345,
			compactionUiThreshold: 678,
			reasoningEffort: "medium",
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: [],
		});
		mocks.runStreamingNormalChatModelRun.mockReturnValue(streamEvents());
	});

	it("prepares prompt context with provider limits and force-web prefetch before returning the stream", async () => {
		const prefetchedToolCalls = [
			{
				callId: "server-prefetch:research_web:test",
				name: "research_web",
				input: { query: "What changed today?" },
				status: "done" as const,
				outputSummary: "Server-prefetched 1 web source.",
				sourceType: "web" as const,
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue:
				"## Current Web Research\n\nEvidence\n\n## Current User Message\nWhat changed today?",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: [],
			prefetchedToolCalls,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What changed today?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			forceWebSearch: true,
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "What changed today?",
				sessionId: "conv-1",
				modelId: "provider:provider-1",
				forceWebSearch: true,
				contextLimits: {
					maxModelContext: 1234,
					targetConstructedContext: 345,
					compactionUiThreshold: 678,
				},
				logLabel: "provider streaming request",
			}),
		);
		expect(result.prepared.contextStatus).toEqual({ status: "ready" });
		expect(result.prefetchedToolCalls).toEqual(prefetchedToolCalls);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: expect.stringContaining("## Current Web Research"),
							},
						],
					},
				],
			}),
		);
	});

	it("passes normal chat tools and the prepared output token budget into the streaming model run", async () => {
		const tools = { produce_file: { __testTool: true } };
		mocks.createNormalChatTools.mockReturnValue({
			tools,
			getToolCalls: () => [],
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: [],
			outputTokenBudget: {
				configuredMaxTokens: 4096,
				effectiveMaxTokens: 777,
				outputReserve: 777,
				outputReserveClamped: true,
			},
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Create a report",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.createNormalChatTools).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "normal-chat-turn-1",
		});
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools,
				maxOutputTokens: 777,
				maxToolSteps: 16,
			}),
		);
	});

	it("forces the produce_file tool for explicit downloadable file requests", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Please create a downloadable PDF report for me",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				toolChoice: { type: "tool", toolName: "produce_file" },
			}),
		);
	});

	it("leaves tool choice automatic when a file request needs project context first", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message:
				"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("leaves tool choice automatic for non-file chat requests", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Explain how PDF generation works",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("omits streaming reasoning options when capability evidence rejects reasoning controls", async () => {
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "provider-secret",
			maxOutputTokens: 4096,
			reasoningEffort: "medium",
			capabilities: createModelCapabilitySet({
				reasoningControls: {
					state: "not_detected",
					source: "probe",
				},
			}),
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			thinkingMode: "on",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				providerOptions: undefined,
			}),
		);
	});

	it("exposes prefetched and recorded tool calls while filtering failed calls from the final evidence-ready set", async () => {
		const prefetchedToolCalls = [
			{
				callId: "server-prefetch:research_web:test",
				name: "research_web",
				input: { query: "What changed today?" },
				status: "done" as const,
				outputSummary: "Server-prefetched 1 web source.",
				sourceType: "web" as const,
			},
		];
		const normalChatToolCalls = [
			{
				callId: "call-produce-file-1",
				name: "produce_file",
				input: { requestTitle: "Quarterly report" },
				status: "done" as const,
				outputSummary: "File production job job-1 queued with status pending.",
				sourceType: "tool" as const,
				metadata: {
					jobId: "job-1",
					jobStatus: "pending",
				},
			},
			{
				callId: "call-produce-file-failed",
				name: "produce_file",
				input: { requestTitle: "Failed report" },
				status: "done" as const,
				outputSummary: "File production intake failed",
				sourceType: "tool" as const,
				metadata: {
					ok: false,
					evidenceReady: false,
					intakeStatus: 500,
				},
			},
		];
		mocks.createNormalChatTools.mockReturnValue({
			tools: { produce_file: { __testTool: true } },
			getToolCalls: () => normalChatToolCalls,
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: [],
			prefetchedToolCalls,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Create a report",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(result.prefetchedToolCalls).toEqual(prefetchedToolCalls);
		expect(result.getNormalChatToolCalls()).toEqual(normalChatToolCalls);
		expect(result.getToolCalls()).toEqual([
			...prefetchedToolCalls,
			normalChatToolCalls[0],
		]);
	});
});
