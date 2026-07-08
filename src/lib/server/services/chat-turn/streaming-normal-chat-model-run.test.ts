import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { RuntimeConfig } from "$lib/server/config-store";

const mocks = vi.hoisted(() => ({
	createNormalChatTools: vi.fn(),
	getEnabledConnectionCapabilities: vi.fn(),
	prepareOutboundChatContext: vi.fn(),
	resolveNormalChatModelRunProvider: vi.fn(),
	runStreamingNormalChatModelRun: vi.fn(),
}));

vi.mock("$lib/server/services/connections/resolve", () => ({
	getEnabledConnectionCapabilities: mocks.getEnabledConnectionCapabilities,
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
		mocks.getEnabledConnectionCapabilities.mockReset();
		mocks.prepareOutboundChatContext.mockReset();
		mocks.resolveNormalChatModelRunProvider.mockReset();
		mocks.runStreamingNormalChatModelRun.mockReset();
		mocks.getEnabledConnectionCapabilities.mockResolvedValue(new Set());
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __testTool: true },
				produce_file: { __testTool: true },
				read_generated_file: { __testTool: true },
			},
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

	it("forwards typed context preparation activity without exposing stage labels as response activity text", async () => {
		const contextPreparationActivity = vi.fn();
		const responseActivity = vi.fn();
		mocks.prepareOutboundChatContext.mockImplementation(async (params) => {
			params.onContextPreparationActivity?.({
				stageId: "plan",
				status: "started",
			});
			params.onContextPreparationActivity?.({
				stageId: "plan",
				status: "done",
			});
			params.onContextPreparationActivity?.({
				stageId: "prompt_budget",
				status: "started",
			});
			params.onContextPreparationActivity?.({
				stageId: "prompt_budget",
				status: "done",
			});
			return {
				inputValue: "Prepared user prompt",
				systemPrompt: "Prepared system prompt",
				contextStatus: undefined,
				taskState: null,
				contextDebug: null,
				contextTraceSections: [],
				contextLimits: {
					maxModelContext: 10_000,
					compactionUiThreshold: 7_000,
					targetConstructedContext: 8_000,
				},
			};
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			onContextPreparationActivity: contextPreparationActivity,
			onResponseActivity: responseActivity,
		});

		expect(
			contextPreparationActivity.mock.calls.map(([activity]) => activity),
		).toEqual([
			{ stageId: "plan", status: "started" },
			{ stageId: "plan", status: "done" },
			{ stageId: "prompt_budget", status: "started" },
			{ stageId: "prompt_budget", status: "done" },
		]);
		expect(responseActivity.mock.calls.map(([entry]) => entry)).toEqual([
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "planning",
			},
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "planning",
			},
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "budgeting",
			},
			{
				id: "context-preparing",
				kind: "context",
				status: "done",
				contextPreparationClass: "budgeting",
			},
		]);
		expect(
			responseActivity.mock.calls.map(([entry]) => entry.id),
		).not.toContain("plan");
		expect(
			responseActivity.mock.calls.map(([entry]) => entry.id),
		).not.toContain("prompt_budget");
		expect(responseActivity.mock.calls.every(([entry]) => !entry.label)).toBe(
			true,
		);
		expect(responseActivity.mock.calls.every(([entry]) => !entry.detail)).toBe(
			true,
		);
	});

	it("exposes context-preparation timings without passing them to provider transport", async () => {
		const contextPreparationTimings = [
			{
				stageId: "plan" as const,
				activityClass: "planning" as const,
				status: "done" as const,
				startedAt: 10,
				completedAt: 15,
				durationMs: 5,
			},
			{
				stageId: "prompt_budget" as const,
				activityClass: "budgeting" as const,
				status: "done" as const,
				startedAt: 20,
				completedAt: 28,
				durationMs: 8,
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			contextPreparationTimings,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(result.prepared.contextPreparationTimings).toEqual(
			contextPreparationTimings,
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				contextPreparationTimings: expect.anything(),
			}),
		);
	});

	it("passes normal chat tools and the prepared output token budget into the streaming model run", async () => {
		const tools = {
			research_web: { __testTool: true },
			produce_file: { __testTool: true },
			read_generated_file: { __testTool: true },
		};
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
			message: "Create a downloadable PDF report",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				fileProductionToolsAvailable: true,
			}),
		);
		expect(mocks.createNormalChatTools).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "normal-chat-turn-1",
			language: "hu",
			enabledConnectionCapabilities: new Set(),
		});
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools,
				maxOutputTokens: 777,
				maxToolSteps: 20,
			}),
		);
	});

	it("exposes the files tool when the connections resolver reports the files capability enabled", async () => {
		mocks.getEnabledConnectionCapabilities.mockResolvedValue(
			new Set(["files"]),
		);
		mocks.createNormalChatTools.mockImplementation((ctx) => ({
			tools: {
				research_web: { __testTool: true },
				...(ctx.enabledConnectionCapabilities?.has("files")
					? { files: { __testTool: true } }
					: {}),
			},
			getToolCalls: () => [],
		}));

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.getEnabledConnectionCapabilities).toHaveBeenCalledWith(
			"user-1",
		);
		expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: new Set(["files"]),
			}),
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: expect.objectContaining({
					files: { __testTool: true },
				}),
			}),
		);
	});

	it("hides the files tool when the connections resolver reports no enabled capabilities", async () => {
		mocks.getEnabledConnectionCapabilities.mockResolvedValue(new Set());
		mocks.createNormalChatTools.mockImplementation((ctx) => ({
			tools: {
				research_web: { __testTool: true },
				...(ctx.enabledConnectionCapabilities?.has("files")
					? { files: { __testTool: true } }
					: {}),
			},
			getToolCalls: () => [],
		}));

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: new Set(),
			}),
		);
		const call = mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.tools).not.toHaveProperty("files");
	});

	it("hides file-production tools for ordinary prose streaming requests", async () => {
		const tools = {
			research_web: { __testTool: true },
			memory_context: { __testTool: true },
			produce_file: { __testTool: true },
			read_generated_file: { __testTool: true },
		};
		mocks.createNormalChatTools.mockReturnValue({
			tools,
			getToolCalls: () => [],
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message:
				"Draft a concise engineering decision memo with Context, Decision, Consequences, and Rollout sections.",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				fileProductionToolsAvailable: false,
			}),
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: {
					research_web: { __testTool: true },
					memory_context: { __testTool: true },
				},
			}),
		);
	});

	it("applies resolved depth effort before the streaming model run", async () => {
		const depthMetadata = {
			requested: "auto" as const,
			appliedProfile: "maximum" as const,
			fallback: false,
			signals: {
				groundingNeed: "required" as const,
				contextBreadth: "broad" as const,
				outputRoom: "expanded" as const,
				toolUse: "source_heavy" as const,
			},
		};
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			outputTokenBudget: {
				configuredMaxTokens: 4096,
				effectiveMaxTokens: 3500,
				outputReserve: 3500,
				outputReserveClamped: true,
			},
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Investigate the current options with sources.",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			depthMetadata,
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextLimits: {
					maxModelContext: 1234,
					targetConstructedContext: 345,
					compactionUiThreshold: 678,
				},
				modelConfig: expect.objectContaining({
					maxTokens: 4096,
				}),
				reasoningDepthEffort: expect.objectContaining({
					maxToolSteps: 28,
					webSourceBudget: {
						maxSources: 12,
						sourceExpansion: true,
					},
				}),
			}),
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 3500,
				maxToolSteps: 28,
			}),
		);
		const call = mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.resolveProviderOptions(call.provider)).toEqual({
			fireworks: { reasoningEffort: "medium" },
		});
		expect(result.depthMetadata?.appliedEffort).toMatchObject({
			outputTokens: {
				effectiveMaxTokens: 3500,
				outputReserve: 3500,
				clamped: true,
			},
			grounding: {
				guidance: "strict",
				externalEvidence: "required",
			},
			tools: {
				maxToolSteps: 28,
				maxWebSources: 12,
				sourceExpansion: true,
			},
		});
	});

	it("proceeds with broad but answerable high-cost streaming work instead of asking unnecessarily", async () => {
		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message:
				"Research all viable platform options and build a complete migration plan.",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "maximum",
				fallback: false,
				signals: {
					contextBreadth: "broad",
					outputRoom: "expanded",
					toolUse: "source_heavy",
				},
			},
		});

		const events = [];
		for await (const event of result.stream) {
			events.push(event);
		}

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalled();
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalled();
		expect(events).toEqual([{ type: "text_delta", text: "Answer" }]);
		expect(result.depthMetadata).not.toHaveProperty("clarification");
	});

	it("leaves tool choice automatic for explicit file requests after removing produce_file auto-force", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Please create a downloadable PDF report for me",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
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
				resolveProviderOptions: expect.any(Function),
			}),
		);
		const call = mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.resolveProviderOptions(call.provider)).toBeUndefined();
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
			tools: {
				research_web: { __testTool: true },
				produce_file: { __testTool: true },
				read_generated_file: { __testTool: true },
			},
			getToolCalls: () => normalChatToolCalls,
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			prefetchedToolCalls,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Create a downloadable PDF report",
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
