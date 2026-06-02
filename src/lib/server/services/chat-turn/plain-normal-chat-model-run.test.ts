import { describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { RuntimeConfig } from "$lib/server/config-store";

const mocks = vi.hoisted(() => ({
	createNormalChatTools: vi.fn(),
	prepareOutboundChatContext: vi.fn(),
	resolveNormalChatModelRunProvider: vi.fn(),
	runPlainNormalChatModelRun: vi.fn(),
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
		runPlainNormalChatModelRun: mocks.runPlainNormalChatModelRun,
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

import { runPlainNormalChatSendModel } from "./plain-normal-chat-model-run";

describe("runPlainNormalChatSendModel", () => {
	beforeEach(() => {
		mocks.createNormalChatTools.mockReset();
		mocks.prepareOutboundChatContext.mockReset();
		mocks.resolveNormalChatModelRunProvider.mockReset();
		mocks.runPlainNormalChatModelRun.mockReset();
		mocks.createNormalChatTools.mockReturnValue({
			tools: { produce_file: { __testTool: true } },
			getToolCalls: () => [],
		});
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue({
			id: "model1",
			name: "model1",
			displayName: "Model One",
			baseUrl: "https://openai-compatible.example/v1",
			modelName: "gpt-4.1",
			apiKey: "model-1-secret",
			maxOutputTokens: 2048,
			reasoningEffort: "high",
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
		});
		mocks.runPlainNormalChatModelRun.mockResolvedValue({
			text: "Answer",
			finishReason: "stop",
			usage: {
				inputTokens: undefined,
				outputTokens: undefined,
				totalTokens: undefined,
			},
			model: {
				providerId: "model1",
				providerName: "model1",
				displayName: "Model One",
				requestedModelName: "gpt-4.1",
				responseModelName: "gpt-4.1",
			},
		});
	});

	it("passes configured reasoning effort and request timeout to the model run", async () => {
		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			thinkingMode: "on",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				providerOptions: {
					model1: { reasoningEffort: "high" },
				},
				abortSignal: expect.any(AbortSignal),
			}),
		);
		const call = mocks.runPlainNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.abortSignal.aborted).toBe(false);
	});

	it("omits plain-run reasoning options when capability evidence rejects reasoning controls", async () => {
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue({
			id: "model1",
			name: "model1",
			displayName: "Model One",
			baseUrl: "https://openai-compatible.example/v1",
			modelName: "gpt-4.1",
			apiKey: "model-1-secret",
			maxOutputTokens: 2048,
			reasoningEffort: "high",
			capabilities: createModelCapabilitySet({
				reasoningControls: {
					state: "not_detected",
					source: "probe",
				},
			}),
		});

		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			thinkingMode: "on",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				providerOptions: undefined,
			}),
		);
	});

	it("passes provider-specific context limits into prompt preparation", async () => {
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
		});

		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
				model1MaxModelContext: 1_000_000,
				model1TargetConstructedContext: 900_000,
				model1CompactionUiThreshold: 800_000,
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
			} as RuntimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				modelId: "provider:provider-1",
				contextLimits: {
					maxModelContext: 1234,
					targetConstructedContext: 345,
					compactionUiThreshold: 678,
				},
			}),
		);
	});

	it("leaves tool choice automatic for explicit file requests after removing produce_file auto-force", async () => {
		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message: "Please create a downloadable PDF report for me",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("leaves tool choice automatic when a file request needs project context first", async () => {
		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message:
				"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("can force the produce_file tool after context-dependent file context is recovered", async () => {
		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message:
				"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
			conversationId: "conv-1",
			modelId: "model1",
			forceProduceFileTool: true,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				toolChoice: { type: "tool", toolName: "produce_file" },
			}),
		);
	});

	it("leaves tool choice automatic for non-file chat requests", async () => {
		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message: "Explain how PDF generation works",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("uses the prepared output token budget as the plain model max output override", async () => {
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
				configuredMaxTokens: 2048,
				effectiveMaxTokens: 777,
				outputReserve: 777,
				outputReserveClamped: true,
			},
		});

		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
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
			} as RuntimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 777,
			}),
		);
	});

	it("returns prefetched forced-search tool calls from prompt preparation", async () => {
		const prefetchedToolCalls = [
			{
				callId: "server-prefetch:research_web:test",
				name: "research_web",
				input: { query: "What changed today?" },
				status: "done" as const,
				outputSummary: "Server-prefetched 1 web source.",
				sourceType: "web" as const,
				candidates: [
					{
						id: "source-1",
						title: "Source One",
						url: "https://example.com/source",
						snippet: null,
						sourceType: "web" as const,
						material: true,
					},
				],
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue:
				"## Current Web Research\n\nEvidence\n\n## Current User Message\nWhat changed today?",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: [],
			prefetchedToolCalls,
		});

		const result = await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
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
			} as RuntimeConfig,
			message: "What changed today?",
			conversationId: "conv-1",
			modelId: "model1",
			forceWebSearch: true,
		});

		expect(result.prefetchedToolCalls).toEqual(prefetchedToolCalls);
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
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

	it("passes normal chat tools into the model run and returns combined tool calls", async () => {
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
		const tools = { produce_file: { __testTool: true } };
		mocks.createNormalChatTools.mockReturnValue({
			tools,
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

		const result = await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
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
			} as RuntimeConfig,
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
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools,
				maxToolSteps: 16,
			}),
		);
		expect(result.normalChatToolCalls).toEqual(normalChatToolCalls);
		expect(result.toolCalls).toEqual([
			...prefetchedToolCalls,
			normalChatToolCalls[0],
		]);
		expect(result.prefetchedToolCalls).toEqual(prefetchedToolCalls);
	});

	it("can disable tools for recovery-only plain model runs", async () => {
		await runPlainNormalChatSendModel({
			userId: "user-1",
			runtimeConfig: {
				requestTimeoutMs: 1_500,
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
			} as RuntimeConfig,
			message: "Answer from already retrieved context",
			conversationId: "conv-1",
			modelId: "model1",
			disableTools: true,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: undefined,
				toolChoice: undefined,
				maxToolSteps: 16,
			}),
		);
	});
});
