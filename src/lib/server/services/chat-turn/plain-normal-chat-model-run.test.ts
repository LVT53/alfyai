import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	createPlainNormalChatModelRunResult,
	createPlainNormalChatPreparedContext,
	createPlainNormalChatProvider,
	createPlainNormalChatSendModelParams,
} from "./plain-normal-chat-model-run.test-helpers";

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

function runSubject(
	overrides: Partial<
		Omit<Parameters<typeof runPlainNormalChatSendModel>[0], "runtimeConfig">
	> & {
		runtimeConfig?: Partial<RuntimeConfig>;
	} = {},
) {
	return runPlainNormalChatSendModel(
		createPlainNormalChatSendModelParams(overrides),
	);
}

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
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue(
			createPlainNormalChatProvider(),
		);
		mocks.prepareOutboundChatContext.mockResolvedValue(
			createPlainNormalChatPreparedContext(),
		);
		mocks.runPlainNormalChatModelRun.mockResolvedValue(
			createPlainNormalChatModelRunResult(),
		);
	});

	it("passes configured reasoning effort and request timeout to the model run", async () => {
		await runSubject({
			thinkingMode: "on",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resolveProviderOptions: expect.any(Function),
				abortSignal: expect.any(AbortSignal),
			}),
		);
		const call = mocks.runPlainNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.abortSignal.aborted).toBe(false);
		expect(call.resolveProviderOptions(call.provider)).toEqual({
			model1: { reasoningEffort: "high" },
		});
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

		await runSubject({
			thinkingMode: "on",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resolveProviderOptions: expect.any(Function),
			}),
		);
		const call = mocks.runPlainNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.resolveProviderOptions(call.provider)).toBeUndefined();
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

		await runSubject({
			modelId: "provider:provider-1",
			runtimeConfig: {
				model1MaxModelContext: 1_000_000,
				model1TargetConstructedContext: 900_000,
				model1CompactionUiThreshold: 800_000,
			},
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
			return createPlainNormalChatPreparedContext();
		});

		await runSubject({
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
				completedAt: 14,
				durationMs: 4,
			},
			{
				stageId: "prompt_budget" as const,
				activityClass: "budgeting" as const,
				status: "done" as const,
				startedAt: 20,
				completedAt: 29,
				durationMs: 9,
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue(
			createPlainNormalChatPreparedContext({
				contextPreparationTimings,
			}),
		);

		const result = await runSubject();

		expect(result.contextPreparationTimings).toEqual(contextPreparationTimings);
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				contextPreparationTimings: expect.anything(),
			}),
		);
	});

	it("leaves tool choice automatic for explicit file requests after removing produce_file auto-force", async () => {
		await runSubject({
			message: "Please create a downloadable PDF report for me",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("leaves tool choice automatic when a file request needs project context first", async () => {
		await runSubject({
			message:
				"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("can force the produce_file tool after context-dependent file context is recovered", async () => {
		await runSubject({
			message:
				"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
			forceProduceFileTool: true,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				toolChoice: { type: "tool", toolName: "produce_file" },
			}),
		);
	});

	it("leaves tool choice automatic for non-file chat requests", async () => {
		await runSubject({
			message: "Explain how PDF generation works",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("uses the prepared output token budget as the plain model max output override", async () => {
		mocks.prepareOutboundChatContext.mockResolvedValue({
			...createPlainNormalChatPreparedContext(),
			outputTokenBudget: {
				configuredMaxTokens: 2048,
				effectiveMaxTokens: 777,
				outputReserve: 777,
				outputReserveClamped: true,
			},
		});

		await runSubject();

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 777,
			}),
		);
	});

	it("applies resolved depth effort before the plain model run", async () => {
		const depthMetadata = {
			requested: "auto" as const,
			appliedProfile: "extended" as const,
			fallback: false,
			signals: {
				groundingNeed: "useful" as const,
				contextBreadth: "broad" as const,
				outputRoom: "expanded" as const,
				toolUse: "source_heavy" as const,
			},
		};
		mocks.prepareOutboundChatContext.mockResolvedValue({
			...createPlainNormalChatPreparedContext(),
			outputTokenBudget: {
				configuredMaxTokens: 2048,
				effectiveMaxTokens: 1900,
				outputReserve: 1900,
				outputReserveClamped: true,
			},
		});

		const result = await runSubject({
			message: "Compare the current options with citations.",
			depthMetadata,
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextLimits: {
					maxModelContext: 10_000,
					targetConstructedContext: 8_000,
					compactionUiThreshold: 7_000,
				},
				modelConfig: expect.objectContaining({
					maxTokens: 2048,
				}),
				reasoningDepthEffort: expect.objectContaining({
					maxToolSteps: 22,
					webSourceBudget: {
						maxSources: 8,
						sourceExpansion: true,
					},
				}),
			}),
		);
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 1900,
				maxToolSteps: 22,
			}),
		);
		const call = mocks.runPlainNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.resolveProviderOptions(call.provider)).toEqual({
			model1: { reasoningEffort: "medium" },
		});
		expect(result.depthMetadata?.appliedEffort).toMatchObject({
			providerReasoning: {
				thinkingMode: "on",
				reasoningEffort: "medium",
			},
			outputTokens: {
				effectiveMaxTokens: 1900,
				outputReserve: 1900,
				clamped: true,
			},
			tools: {
				maxToolSteps: 22,
				maxWebSources: 8,
				sourceExpansion: true,
			},
		});
	});

	it("proceeds with broad but answerable high-cost work instead of asking unnecessarily", async () => {
		const result = await runSubject({
			message:
				"Research all viable platform options and build a complete migration plan.",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				signals: {
					contextBreadth: "broad",
					outputRoom: "expanded",
					toolUse: "source_heavy",
				},
			},
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalled();
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalled();
		expect(result.text).toBe("Answer");
		expect(result.depthMetadata).not.toHaveProperty("clarification");
	});

	it("proceeds with a visible assumption prefix when the user asks the model to assume", async () => {
		const result = await runSubject({
			message:
				"Research all viable platform options and build a complete migration plan. Use your best judgment.",
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

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalled();
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalled();
		expect(result.text).toBe(
			"Depth Assumption: I will use the most generally useful target and decision criteria.\n\nAnswer",
		);
		expect(result.depthMetadata?.clarification).toMatchObject({
			outcome: "proceed_with_assumption",
			reason: "user_requested_assumption",
			language: "en",
			assumption:
				"I will use the most generally useful target and decision criteria",
		});
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
			...createPlainNormalChatPreparedContext(),
			inputValue:
				"## Current Web Research\n\nEvidence\n\n## Current User Message\nWhat changed today?",
			prefetchedToolCalls,
		});

		const result = await runSubject({
			message: "What changed today?",
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
			...createPlainNormalChatPreparedContext(),
			prefetchedToolCalls,
		});

		const result = await runSubject({
			message: "Create a report",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.createNormalChatTools).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "normal-chat-turn-1",
			language: "hu",
		});
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools,
				maxToolSteps: 20,
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
		await runSubject({
			message: "Answer from already retrieved context",
			disableTools: true,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: undefined,
				toolChoice: undefined,
				maxToolSteps: 20,
			}),
		);
	});
});
