import { beforeEach, expect, it, vi } from "vitest";
import {
	createPlainNormalChatModelRunResult,
	createPlainNormalChatPreparedContext,
	createPlainNormalChatProvider,
	createPlainNormalChatSendModelParams,
} from "./plain-normal-chat-model-run.test-helpers";
import {
	buildReasoningDepthProviderOptions,
	resolveReasoningDepthEffort,
} from "./reasoning-depth-effort";

const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	runtime: vi.fn(),
	tools: vi.fn(),
	model: vi.fn(),
	admit: vi.fn(),
	record: vi.fn(),
	settle: vi.fn(),
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
	hasLocalDistillEnabled: async () => false,
}));
vi.mock("../normal-chat-model", async (original) => ({
	...(await original<typeof import("../normal-chat-model")>()),
	prepareNormalChatCompletionRun: mocks.model,
}));

import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.runtime.mockImplementation(async (params) => {
		const provider = createPlainNormalChatProvider();
		return {
			provider,
			modelId: "model1",
			depthEffort: params.depthMetadata
				? resolveReasoningDepthEffort({
						depthMetadata: params.depthMetadata,
						provider,
					})
				: null,
		};
	});
	mocks.admit.mockReturnValue({ status: "admitted" });
	mocks.record.mockResolvedValue(undefined);
	mocks.prepare.mockResolvedValue(
		createPlainNormalChatPreparedContext({
			inputValue: "original INLINE full prefetch",
			systemPrompt: "original instructions",
		}),
	);
	mocks.tools.mockResolvedValue({
		tools: {},
		stepImages: { drain: () => [] },
		getToolCalls: () => [],
		getTurnAsk: () => null,
	});
	mocks.model.mockReturnValue({
		runPlain: async () => createPlainNormalChatModelRunResult(),
		stream: async function* () {},
		getSnapshot: () => null,
	});
});
it("prepares full input once and shares one single-use model handle", async () => {
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await run.runPlain();
	expect(mocks.prepare).toHaveBeenCalledOnce();
	expect(mocks.model).toHaveBeenCalledOnce();
	expect(mocks.model.mock.calls[0][0]).toMatchObject({
		system: "original instructions",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "original INLINE full prefetch" }],
			},
		],
	});
	expect(run.receipt.segmentId).toEqual(expect.any(String));
});
it("refuses model construction on admission storage failure", async () => {
	mocks.admit.mockImplementation(() => {
		throw new Error("storage unavailable");
	});
	await expect(
		prepareNormalChatTurn(createPlainNormalChatSendModelParams()),
	).rejects.toThrow("storage unavailable");
	expect(mocks.prepare).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});
it("binds an effective model tool pack and preregisters before granting dispatch", async () => {
	await prepareNormalChatTurn(createPlainNormalChatSendModelParams());
	const policy = mocks.model.mock.calls[0][0].completionPolicy;
	const provider = {
		...createPlainNormalChatProvider(),
		id: "other",
		modelName: "other",
	};
	await policy.forAttempt({
		provider,
		modelId: "model2",
		phase: "working",
		attemptId: "attempt",
		toolsAllowed: true,
		snapshot: {},
	});
	expect(mocks.tools.mock.calls.at(-1)?.[3]).toBe("model2");
	expect(mocks.record).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({
			attemptId: "attempt",
			providerId: "other",
			modelId: "model2",
			providerModelName: "other",
			usageFinal: false,
		}),
	);
});

it("runs a human-authorized second creation without replaying the first and blocks retained uncertainty", async () => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const { buildAskResumeCapture, buildAskResumeSnapshot } = await import(
		"./ask-capture"
	);
	let dispatches = 0,
		generations = 0,
		proposals = 0;
	let lastAdapter:
		| import("../normal-chat-model").NormalChatAttemptPolicy
		| undefined;
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const n = generations++;
			const call =
				n === 0 || n === 2
					? {
							type: "tool-call" as const,
							toolCallId: "reused-provider-id",
							toolName: "create_artifact",
							input: "{}",
						}
					: n === 1
						? {
								type: "tool-call" as const,
								toolCallId: "ask",
								toolName: "ask_user",
								input: "{}",
							}
						: n === 3
							? {
									type: "tool-call" as const,
									toolCallId: "email",
									toolName: "email",
									input: "{}",
								}
							: null;
			return {
				content: call
					? [call]
					: [{ type: "text" as const, text: "Second ready." }],
				finishReason: {
					unified: call ? ("tool-calls" as const) : ("stop" as const),
					raw: call ? "tool_calls" : "stop",
				},
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
	});
	mocks.tools.mockImplementation(async () => {
		const rows: import("../messages-types").ToolCallEntry[] = [];
		return {
			stepImages: { drain: () => [] },
			getToolCalls: () => rows,
			getTurnAsk: () => null,
			tools: {
				create_artifact: tool({
					inputSchema: z.object({}),
					execute: async (_input, options) => {
						dispatches++;
						rows.push({
							name: "create_artifact",
							callId: options.toolCallId,
							input: {},
							status: "done",
							metadata: { ok: true, artifactId: `artifact-${dispatches}` },
						});
						return { success: true, artifactId: `artifact-${dispatches}` };
					},
				}),
				ask_user: tool({
					inputSchema: z.object({}),
					execute: async (_input, options) => {
						rows.push({
							name: "ask_user",
							callId: options.toolCallId,
							input: {},
							status: "done",
							metadata: { paused: true },
						});
						return { status: "waiting_for_user" };
					},
				}),
				email: tool({
					inputSchema: z.object({}),
					execute: async (_input, options) => {
						proposals++;
						rows.push({
							name: "email",
							callId: options.toolCallId,
							input: {},
							status: "done",
							metadata: { ok: true },
						});
						return { success: true, pendingWriteId: "pending-confirmation" };
					},
				}),
			},
		};
	});
	mocks.model.mockImplementation((params) => {
		const original = params.completionPolicy.forAttempt;
		params.completionPolicy.forAttempt = async (
			context: Parameters<typeof original>[0],
		) => {
			const adapter = await original(context);
			lastAdapter = adapter ?? undefined;
			return adapter;
		};
		return {
			runPlain: async () => {
				const driver = runNormalChatCompletion(
					params,
					{
						model,
						maxModelContext: 32000,
						providerOptions: undefined,
						metadata: () => createPlainNormalChatModelRunResult().model,
						mapUsage: () => ({
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
						}),
						stopWhen: ({ steps }) =>
							steps
								.at(-1)
								?.toolResults.some((r) => r.toolName === "ask_user") ?? false,
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
		};
	});
	const first = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({ canPause: true }),
	);
	const firstResult = await first.runPlain();
	const paused = first.receipt.getSnapshot();
	expect(paused?.completion?.outcome).toBe("paused");
	expect(dispatches).toBe(1);
	const capture = buildAskResumeCapture({
		continuationGiven: [],
		responseMessages:
			paused?.steps
				.filter((step) => step.segmentId === paused.segmentId)
				.flatMap((step) => step.response) ?? [],
		toolCalls: firstResult.normalChatToolCalls ?? [],
		priorResults: [],
		snapshot: paused,
	});
	const snapshot = buildAskResumeSnapshot(capture, "ask", {
		status: "answered",
		answers: [],
		note: "The user authorized the second creation.",
	});
	const second = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({
			canPause: true,
			continuationSnapshot: snapshot,
		}),
	);
	await second.runPlain();
	await second.runPlain();
	expect(dispatches).toBe(2);
	expect(generations).toBe(5);
	expect(proposals).toBe(1);
	expect(mocks.prepare).toHaveBeenCalledOnce();
	const old = snapshot?.executions[0];
	if (!old) throw new Error("missing retained execution");
	expect(lastAdapter?.authorizeExecution?.(old, [old])).toEqual({
		kind: "reuse",
		executionId: old.executionId,
	});
	expect(
		second.receipt
			.getSnapshot()
			?.executions.find((e) => e.toolName === "email"),
	).toMatchObject({
		state: "succeeded",
		output: { success: true, pendingWriteId: "pending-confirmation" },
		delivered: false,
	});
	if (!snapshot) throw new Error("missing exact snapshot");
	snapshot.executions[0].state = "uncertain";
	const blocked = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({
			canPause: true,
			continuationSnapshot: snapshot,
		}),
	);
	await blocked.runPlain();
	expect(dispatches).toBe(2);
	expect(generations).toBe(5);
	expect(blocked.receipt.getSnapshot()?.completion?.stopCause).toBe(
		"uncertain_execution",
	);
});
it("keeps explicit answer control bytes until the shared finalizer can extract them", async () => {
	const answer =
		'Answer<skill_control_v1>{"version":1,"operations":[]}</skill_control_v1>';
	mocks.model.mockImplementation((params) => ({
		runPlain: async () => {
			const { turnId, segmentId } = params.completionPolicy;
			const scope = {
				version: 1 as const,
				turnId,
				segmentId,
				attemptId: "a",
				stepId: "step",
				phase: "closing" as const,
			};
			const completion = {
				version: 1 as const,
				turnId,
				segmentId,
				phase: "closing" as const,
				outcome: "answered" as const,
				stopCause: "natural_stop" as const,
				workingStopCause: "tool_budget" as const,
				closingAttempted: true,
			};
			const continuation: import("../normal-chat-model").NormalChatContinuationSnapshot =
				{
					version: 1,
					fidelity: "exact",
					turnId,
					segmentId,
					original: {
						providerId: "model1",
						providerBaseUrl: params.provider.baseUrl,
						modelName: params.provider.modelName,
						messages: params.messages,
					},
					steps: [],
					prepared: { maxOutputTokens: 1000 },
					pendingImageEntries: [],
					executions: [],
					usage: [],
					events: [
						{
							...scope,
							sequence: 0,
							type: "block_start",
							blockId: "b",
							nativeId: "b",
							kind: "text",
							role: "answer",
						},
						{
							...scope,
							sequence: 1,
							type: "block_delta",
							blockId: "b",
							text: answer,
						},
					],
					sequence: 2,
					nextAttempt: 1,
					workingSteps: 0,
					closingSegments: [segmentId],
					deadlineAt: Date.now() + 10000,
					totalTimeoutMs: 10000,
					completion,
				};
			return {
				...createPlainNormalChatModelRunResult(),
				text: "Answer",
				continuation,
				completion,
			};
		},
		stream: async function* () {},
		getSnapshot: () => null,
	}));
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	expect((await run.runPlain()).text).toBe(answer);
});
it.each([
	"success",
	"repeat",
	"stopped",
] as const)("retains working-step Skill Control through the actual prepared/model path (%s)", async (mode) => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const { UserStopReason } = await import("./active-streams");
	const payload = JSON.stringify({
		version: 1,
		operations: [
			{
				operationId: "working-op",
				kind: "skill_draft",
				draft: {
					id: "working-skill",
					displayName: "Working skill",
					description: "A synthetic working-step draft",
					instructions: "Write the requested answer.",
					activationExamples: ["Write the answer"],
				},
			},
		],
	});
	const envelope = `<skill_control_v1>${payload}</skill_control_v1>`;
	const abort = new AbortController();
	let generations = 0,
		executions = 0;
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const first = generations++ === 0;
			return {
				content: first
					? [
							{ type: "text" as const, text: `Working prose${envelope}` },
							{
								type: "tool-call" as const,
								toolCallId: "read",
								toolName: "research_web",
								input: "{}",
							},
						]
					: [
							{
								type: "text" as const,
								text: `Answer${mode === "repeat" ? envelope : ""}`,
							},
						],
				finishReason: {
					unified: first ? ("tool-calls" as const) : ("stop" as const),
					raw: first ? "tool_calls" : "stop",
				},
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
	});
	mocks.tools.mockImplementation(async () => {
		const rows: import("../messages-types").ToolCallEntry[] = [];
		return {
			stepImages: { drain: () => [] },
			getToolCalls: () => rows,
			getTurnAsk: () => null,
			tools: {
				research_web: tool({
					inputSchema: z.object({}),
					execute: async (_input, options) => {
						executions++;
						rows.push({
							name: "research_web",
							callId: options.toolCallId,
							input: {},
							status: "done",
							metadata: { ok: true },
						});
						if (mode === "stopped") abort.abort(new UserStopReason());
						return { success: true, evidence: "Full synthetic result" };
					},
				}),
			},
		};
	});
	mocks.model.mockImplementation((params) => ({
		runPlain: async () => {
			const driver = runNormalChatCompletion(
				params,
				{
					model,
					maxModelContext: 32000,
					providerOptions: undefined,
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
		createPlainNormalChatSendModelParams({ signal: abort.signal }),
	);
	const result = await run.runPlain();
	expect(executions).toBe(1);
	expect(run.receipt.skillControl?.operations).toHaveLength(
		mode === "stopped" ? 0 : 1,
	);
	expect(result.text).not.toContain("Working prose");
	if (mode !== "stopped") {
		expect(result.text.startsWith("Answer")).toBe(true);
		expect(generations).toBe(2);
	} else expect(run.receipt.getSnapshot()?.completion?.outcome).toBe("stopped");
});

it.each([
	false,
	true,
])("keeps captured v2 defaults but respects validated explicit depth overrides (%s)", async (explicit) => {
	const oldDepth = {
		requested: "quick" as const,
		appliedProfile: "off" as const,
		fallback: false,
	};
	const newDepth = {
		requested: "thorough" as const,
		appliedProfile: "standard" as const,
		fallback: false,
	};
	const first = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({
			depthMetadata: oldDepth,
			thinkingMode: "off",
		}),
	);
	const original = mocks.model.mock.calls.at(-1)?.[0];
	await first.runPlain();
	const snapshot: import("../normal-chat-model").NormalChatContinuationSnapshot =
		{
			version: 1,
			fidelity: "exact",
			turnId: "t",
			segmentId: "old",
			original: {
				providerId: "model1",
				providerBaseUrl: "https://test.invalid",
				modelName: "gpt-4.1",
				system: original.system,
				messages: original.messages,
				provenance: original.completionPolicy.contextProvenance,
			},
			steps: [],
			prepared: { maxOutputTokens: 100 },
			pendingImageEntries: [],
			executions: [],
			events: [],
			usage: [],
			sequence: 0,
			nextAttempt: 0,
			workingSteps: 0,
			closingSegments: [],
			deadlineAt: Date.now() + 10000,
			totalTimeoutMs: 10000,
		};
	const resumed = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({
			continuationSnapshot: snapshot,
			resumeDepthOverride: explicit,
			depthMetadata: newDepth,
			thinkingMode: "on",
		}),
	);
	const effective = mocks.model.mock.calls.at(-1)?.[0];
	const expected = resolveReasoningDepthEffort({
		depthMetadata: explicit ? newDepth : oldDepth,
		provider: createPlainNormalChatProvider(),
	});
	expect(effective.maxToolSteps).toBe(expected.maxToolSteps);
	expect(
		effective.resolveProviderOptions(createPlainNormalChatProvider()),
	).toEqual(
		buildReasoningDepthProviderOptions(
			createPlainNormalChatProvider(),
			expected,
		),
	);
	expect(
		effective.completionPolicy.contextProvenance.settings.depthMetadata
			.requested,
	).toBe(explicit ? "thorough" : "quick");
	expect(effective.messages).toEqual(original.messages);
	expect(effective.system).toBe(original.system);
	expect(mocks.prepare).toHaveBeenCalledOnce();
	await resumed.runPlain();
});

it.each([
	{ capacity: 8192, maxTokens: 777, expectedCalls: 1 },
	{ capacity: 8192, maxTokens: null, expectedCalls: 0 },
	{ capacity: 128, maxTokens: 777, expectedCalls: 0 },
])("binds the prepared output reserve and preserves pre-SDK capacity refusal ($capacity/$maxTokens)", async ({
	capacity,
	maxTokens,
	expectedCalls,
}) => {
	const { deriveModelContextBudget } = await import("./context-budget");
	const { MockLanguageModelV3 } = await import("ai/test");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const provider = createPlainNormalChatProvider({
		maxModelContext: capacity,
		maxOutputTokens: undefined,
	});
	mocks.runtime.mockResolvedValue({
		provider,
		modelId: "model1",
		depthEffort: null,
	});
	const budget = deriveModelContextBudget({
		maxModelContext: capacity,
		maxTokens,
	});
	mocks.prepare.mockResolvedValue(
		createPlainNormalChatPreparedContext({
			inputValue: "Tiny input",
			systemPrompt: "Tiny instructions",
			turnGuidance: "",
			outputTokenBudget: {
				configuredMaxTokens: budget.configuredMaxTokens,
				effectiveMaxTokens: budget.effectiveMaxTokens,
				outputReserve: budget.outputReserve,
				outputReserveClamped: budget.outputReserveClamped,
			},
		}),
	);
	const generate = vi.fn(async (options: { maxOutputTokens?: number }) => {
		expect(options.maxOutputTokens).toBe(budget.effectiveMaxTokens);
		return {
			content: [{ type: "text" as const, text: "Answer" }],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		};
	});
	const model = new MockLanguageModelV3({ doGenerate: generate });
	mocks.model.mockImplementation((params) => ({
		runPlain: async () => {
			const driver = runNormalChatCompletion(
				params,
				{
					model,
					maxModelContext: params.provider.maxModelContext,
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
	const prepared = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await prepared.runPlain();
	const effective = mocks.model.mock.calls.at(-1)?.[0];
	expect(effective.provider.maxModelContext).toBe(capacity);
	expect(effective.maxOutputTokens).toBe(budget.effectiveMaxTokens);
	expect(generate).toHaveBeenCalledTimes(expectedCalls);
	expect(prepared.receipt.getSnapshot()?.completion).toMatchObject(
		expectedCalls
			? { outcome: "answered", stopCause: "natural_stop" }
			: {
					outcome: "incomplete",
					stopCause: "context_capacity",
					closingAttempted: false,
				},
	);
	if (!expectedCalls)
		expect(prepared.receipt.getSnapshot()?.steps).toHaveLength(0);
	if (maxTokens === null) expect(budget.outputReserve).toBe(0);
	else expect(budget.effectiveMaxTokens).toBeGreaterThan(0);
});
