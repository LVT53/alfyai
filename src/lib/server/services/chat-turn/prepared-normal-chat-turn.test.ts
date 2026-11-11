import { beforeEach, expect, it, vi } from "vitest";
import {
	createPlainNormalChatModelRunResult,
	createPlainNormalChatPreparedContext,
	createPlainNormalChatProvider,
	createPlainNormalChatRuntimeConfig,
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
	mocks.runtime.mockImplementation(async (params) => {
		const provider = createPlainNormalChatProvider();
		return {
			provider,
			modelId: "model1",
			modelConfig: params.runtimeConfig.model1,
			baseContextLimits: {
				maxModelContext: params.runtimeConfig.model1MaxModelContext,
				targetConstructedContext:
					params.runtimeConfig.model1TargetConstructedContext,
				compactionUiThreshold: params.runtimeConfig.model1CompactionUiThreshold,
			},
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

// The external preparation boundary uses the real context-budget owner, while
// the actual prepared owner and real SDK completion engine remain under test.
async function reserveFixture(
	options: {
		configured?: number | null;
		providerCap?: number;
		capacity?: number;
		target?: number;
		closing?: boolean;
		runtimeCapacity?: number;
	} = {},
) {
	const { deriveModelContextBudget } = await import("./context-budget");
	const { MockLanguageModelV3 } = await import("ai/test");
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const capacity = options.capacity ?? 8192;
	const provider = createPlainNormalChatProvider({
		maxModelContext: capacity,
		maxOutputTokens: options.providerCap,
	});
	const config = createPlainNormalChatRuntimeConfig();
	const runtime = {
		provider,
		modelId: "model1",
		depthEffort: null,
		modelConfig: { ...config.model1, maxTokens: options.configured },
		baseContextLimits: {
			maxModelContext: options.runtimeCapacity ?? capacity,
			targetConstructedContext:
				options.target ??
				Math.floor((options.runtimeCapacity ?? capacity) * 0.9),
			compactionUiThreshold: Math.floor(
				(options.runtimeCapacity ?? capacity) * 0.8,
			),
		},
	};
	mocks.runtime.mockResolvedValue(runtime);
	mocks.prepare.mockImplementation(async (_params, actual) => {
		const budget = deriveModelContextBudget({
			...actual.baseContextLimits,
			maxTokens: actual.modelConfig.maxTokens,
		});
		return createPlainNormalChatPreparedContext({
			inputValue: "Tiny input",
			systemPrompt: "Tiny instructions",
			turnGuidance: "",
			contextLimits: actual.baseContextLimits,
			outputTokenBudget: {
				configuredMaxTokens: budget.configuredMaxTokens,
				effectiveMaxTokens: budget.effectiveMaxTokens,
				outputReserve: budget.outputReserve,
				outputReserveClamped: budget.outputReserveClamped,
			},
		});
	});
	const sdkCaps: Array<number | undefined> = [];
	let generations = 0;
	const model = new MockLanguageModelV3({
		doGenerate: async (call) => {
			sdkCaps.push(call.maxOutputTokens);
			generations++;
			return {
				content: [{ type: "text", text: "Answer" }],
				finishReason: {
					unified: options.closing && generations === 1 ? "length" : "stop",
					raw: options.closing && generations === 1 ? "length" : "stop",
				},
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
		doStream: async (call) => {
			sdkCaps.push(call.maxOutputTokens);
			generations++;
			const reason = options.closing && generations === 1 ? "length" : "stop";
			return {
				stream: new ReadableStream<
					import("@ai-sdk/provider").LanguageModelV3StreamPart
				>({
					start(c) {
						c.enqueue({ type: "stream-start", warnings: [] });
						c.enqueue({ type: "text-start", id: "b" });
						c.enqueue({ type: "text-delta", id: "b", delta: "Answer" });
						c.enqueue({ type: "text-end", id: "b" });
						c.enqueue({
							type: "finish",
							finishReason: { unified: reason, raw: reason },
							usage: {
								inputTokens: {
									total: 1,
									noCache: 1,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						});
						c.close();
					},
				}),
			};
		},
	});
	mocks.model.mockImplementation((params) => {
		const make = (streaming: boolean) =>
			runNormalChatCompletion(
				params,
				{
					model,
					maxModelContext: params.provider.maxModelContext,
					providerOptions: params.resolveProviderOptions?.(params.provider),
					stopWhen: undefined,
					metadata: () => createPlainNormalChatModelRunResult().model,
					mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
				},
				streaming,
			);
		return {
			runPlain: async () => {
				const driver = make(false);
				for (;;) {
					const next = await driver.next();
					if (next.done) return next.value;
				}
			},
			stream: () => make(true),
			getSnapshot: () => null,
		};
	});
	return { sdkCaps, runtime, config };
}

it.each([
	"plain",
	"stream",
] as const)("resolves an absent cap before preparation and sends that exact reserve to the real SDK (%s)", async (mode) => {
	const fixture = await reserveFixture({ configured: null });
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	if (mode === "plain") await run.runPlain();
	else
		for await (const _event of run.stream().stream) {
		}
	expect(mocks.prepare.mock.calls[0][1].modelConfig.maxTokens).toBe(820);
	expect(fixture.runtime.modelConfig.maxTokens).toBeNull();
	expect(mocks.model.mock.calls[0][0].maxOutputTokens).toBe(820);
	expect(fixture.sdkCaps).toEqual([820]);
	expect(run.receipt.getSnapshot()?.prepared.maxOutputTokens).toBe(820);
	expect(run.receipt.getSnapshot()?.completion?.outcome).toBe("answered");
});
it.each([
	{ configured: 777, providerCap: 321, expected: 777 },
	{ configured: null, providerCap: 321, expected: 321 },
	{ configured: undefined, providerCap: undefined, expected: 820 },
	{ configured: NaN, providerCap: Infinity, expected: 820 },
	{ configured: Infinity, providerCap: 321, expected: 321 },
	{ configured: 5000, providerCap: undefined, target: 7000, expected: 1192 },
])("keeps configured/provider/default precedence and existing preparation clamps ($configured/$providerCap)", async ({
	expected,
	...options
}) => {
	const fixture = await reserveFixture(options);
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await run.runPlain();
	expect(mocks.model.mock.calls[0][0].maxOutputTokens).toBe(expected);
	expect(fixture.sdkCaps).toEqual([expected]);
	expect(
		mocks.model.mock.calls[0][0].completionPolicy.contextProvenance.prepared
			.outputTokenBudget,
	).toMatchObject({ effectiveMaxTokens: expected, outputReserve: expected });
	expect(run.receipt.getSnapshot()?.prepared.maxOutputTokens).toBe(expected);
});
it.each([
	"plain",
	"stream",
] as const)("freezes the same effective reserve for working and closing (%s)", async (mode) => {
	const fixture = await reserveFixture({ configured: null, closing: true });
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	if (mode === "plain") await run.runPlain();
	else
		for await (const _event of run.stream().stream) {
		}
	expect(fixture.sdkCaps).toEqual([820, 820]);
	expect(run.receipt.getSnapshot()?.completion).toMatchObject({
		outcome: "answered",
		closingAttempted: true,
	});
	expect(run.receipt.getSnapshot()?.prepared.maxOutputTokens).toBe(820);
});
it("uses the existing provider-first context window for the fallback rather than a larger runtime placeholder", async () => {
	const fixture = await reserveFixture({
		capacity: 8192,
		runtimeCapacity: 262144,
		configured: null,
	});
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await run.runPlain();
	expect(mocks.prepare.mock.calls[0][1].modelConfig.maxTokens).toBe(820);
	expect(fixture.sdkCaps).toEqual([820]);
	expect(run.receipt.getSnapshot()?.completion?.outcome).toBe("answered");
});
it("keeps tiny actual capacity refusal before the SDK", async () => {
	const fixture = await reserveFixture({ capacity: 128, configured: 777 });
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await run.runPlain();
	expect(fixture.sdkCaps).toEqual([]);
	expect(run.receipt.getSnapshot()?.completion?.stopCause).toBe(
		"context_capacity",
	);
});
it.each([
	null,
	undefined,
	NaN,
	Infinity,
	"missing_prepared",
] as const)("repairs a legacy absent/invalid captured reserve without rebuilding evidence (%s)", async (legacyCap) => {
	const fixture = await reserveFixture({ configured: null });
	const first = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await first.runPlain();
	const captured = first.receipt.getSnapshot();
	if (!captured) throw new Error("Missing snapshot");
	if (legacyCap === "missing_prepared")
		Reflect.deleteProperty(captured, "prepared");
	else Reflect.set(captured.prepared, "maxOutputTokens", legacyCap);
	const provenance = captured.original.provenance;
	if (
		!provenance ||
		typeof provenance !== "object" ||
		!("prepared" in provenance) ||
		!provenance.prepared ||
		typeof provenance.prepared !== "object"
	)
		throw new Error("Missing captured provenance");
	Reflect.deleteProperty(provenance.prepared, "outputTokenBudget");
	const resumed = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({ continuationSnapshot: captured }),
	);
	await resumed.runPlain();
	expect(mocks.prepare).toHaveBeenCalledOnce();
	expect(fixture.sdkCaps).toEqual([820, 820]);
	expect(resumed.receipt.getSnapshot()?.prepared.maxOutputTokens).toBe(820);
	expect(resumed.receipt.getSnapshot()?.original.messages).toEqual(
		captured.original.messages,
	);
	expect(
		mocks.model.mock.calls.at(-1)?.[0].completionPolicy.contextProvenance
			.prepared.outputTokenBudget,
	).toMatchObject({ effectiveMaxTokens: 820, outputReserve: 820 });
});
it("refuses a smaller resumed destination without lowering the captured cap", async () => {
	const fixture = await reserveFixture({ configured: null });
	const first = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams(),
	);
	await first.runPlain();
	const captured = first.receipt.getSnapshot();
	if (!captured) throw new Error("Missing snapshot");
	mocks.runtime.mockResolvedValue({
		...fixture.runtime,
		provider: { ...fixture.runtime.provider, maxModelContext: 4500 },
		baseContextLimits: {
			...fixture.runtime.baseContextLimits,
			maxModelContext: 4500,
		},
	});
	const resumed = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({ continuationSnapshot: captured }),
	);
	await resumed.runPlain();
	expect(fixture.sdkCaps).toEqual([820]);
	expect(mocks.model.mock.calls.at(-1)?.[0].maxOutputTokens).toBe(820);
	expect(resumed.receipt.getSnapshot()?.completion?.stopCause).toBe(
		"context_capacity",
	);
	expect(mocks.prepare).toHaveBeenCalledOnce();
});

it("permits typed local-only image projection but refuses unprojectable original private context", async () => {
	await prepareNormalChatTurn(createPlainNormalChatSendModelParams());
	const args = mocks.model.mock.calls.at(-1)?.[0];
	const attempt = await args.completionPolicy.forAttempt({
		provider: args.provider,
		modelId: "model1",
		phase: "working",
		attemptId: "a",
		toolsAllowed: false,
		snapshot: {},
	});
	const messages = [{ role: "user", content: "safe projected entry" }];
	const snapshot = {
		steps: [{ imageEntries: [{ localOnly: true }] }],
		pendingImageEntries: [],
	};
	const provider = { ...args.provider, baseUrl: "https://cloud.example/v1" };
	expect(
		attempt.projectContext({ snapshot, messages, system: "public", provider }),
	).toEqual({ system: "public", messages });
	// The separately captured original preparation has no safe reconstruction path.
	const input = createPlainNormalChatSendModelParams();
	const localRuntime = await mocks.runtime(input);
	mocks.runtime.mockResolvedValue({
		...localRuntime,
		provider: { ...localRuntime.provider, baseUrl: "http://127.0.0.1/v1" },
	});
	mocks.keepLocal.mockResolvedValue(true);
	await prepareNormalChatTurn(input);
	const privateArgs = mocks.model.mock.calls.at(-1)?.[0];
	const privateAttempt = await privateArgs.completionPolicy.forAttempt({
		provider,
		modelId: "model1",
		phase: "closing",
		attemptId: "b",
		toolsAllowed: false,
		snapshot: {},
	});
	expect(
		privateAttempt.projectContext({
			snapshot,
			messages,
			system: "private",
			provider,
		}),
	).toBeNull();
});

it.each([
	"success",
	"throw-after-success",
] as const)("keeps actual plain SDK execution records and reused-ID uncertainty (%s)", async (mode) => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const { createToolCallRecorder, executeToolWithEnvelope } = await import(
		"../normal-chat-tools/shared"
	);
	const { runNormalChatCompletion } = await import(
		"../normal-chat-model/completion"
	);
	const recorder = createToolCallRecorder();
	let generations = 0;
	let executions = 0;
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			const step = generations++;
			const call = step === 0 || (mode === "throw-after-success" && step === 1);
			return {
				content: call
					? [
							{
								type: "tool-call" as const,
								toolCallId: "python-391",
								toolName: "run_python",
								input: JSON.stringify({ code: "print(17 * 23)" }),
							},
						]
					: [{ type: "text" as const, text: "PRODUCT391" }],
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
	mocks.tools.mockResolvedValue({
		stepImages: { drain: () => [] },
		getToolCalls: () => recorder.getEntries(),
		getTurnAsk: () => null,
		tools: {
			run_python: tool({
				inputSchema: z.object({ code: z.string() }),
				execute: async (input, options) => {
					executions++;
					if (mode === "throw-after-success" && executions > 1)
						throw new Error("Synthetic failure before recorder");
					return executeToolWithEnvelope({
						toolName: "run_python",
						options,
						recorder,
						timeoutMs: 1000,
						run: async () => {
							return {
								modelPayload: { success: true, stdout: "391", exitCode: 0 },
								entry: {
									name: "run_python",
									callId: options.toolCallId,
									input,
									status: "done",
									outputSummary: "run_python finished: exit code 0.",
									metadata: { ok: true, exitCode: 0 },
								},
							};
						},
						onError: () => ({
							modelPayload: { success: false },
							entry: {
								name: "run_python",
								callId: options.toolCallId,
								input,
								status: "failed",
								metadata: { ok: false },
							},
						}),
					});
				},
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
	const result = await run.runPlain();
	if (mode === "throw-after-success") {
		expect(executions).toBe(2);
		expect(generations).toBe(2);
		expect(recorder.getEntries()).toHaveLength(1);
		expect(recorder.getEntries()[0].status).toBe("done");
		expect(run.receipt.getSnapshot()?.executions.map((e) => e.state)).toEqual([
			"succeeded",
			"uncertain",
		]);
		expect(run.receipt.getSnapshot()?.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "uncertain_execution",
			closingAttempted: false,
		});
		return;
	}
	expect(executions).toBe(1);
	expect(result.text).toBe("PRODUCT391");
	expect(result.normalChatToolCalls).toMatchObject([
		{
			name: "run_python",
			callId: "python-391",
			status: "done",
			metadata: { ok: true },
		},
	]);
	expect(result.toolCalls).toEqual(result.normalChatToolCalls);
	expect(result.serverSegments).toEqual(
		result.normalChatToolCalls?.map((entry) => ({
			type: "tool_call",
			...entry,
		})),
	);
	expect(result.serverSegments?.[0]).toMatchObject({
		type: "tool_call",
		name: "run_python",
		callId: "python-391",
		status: "done",
		metadata: { ok: true, exitCode: 0 },
	});
});

it("never inherits refusal certainty through reused call IDs or another attempt pack", async () => {
	const { createToolCallRecorder } = await import(
		"../normal-chat-tools/shared"
	);
	const first = createToolCallRecorder();
	const second = createToolCallRecorder();
	const refused = { status: "failed", code: "invalid_tool_input" };
	const entry = {
		name: "produce_file",
		callId: "same-id",
		input: {},
		status: "failed" as const,
		metadata: { intakeStatus: 422 },
	};
	first.record(entry, { state: "definitely_not_executed", result: refused });
	const pack = (recorder: typeof first) => ({
		tools: {},
		recorder,
		getToolCalls: () => recorder.getEntries(),
		getTurnAsk: () => null,
		stepImages: { drain: () => [] },
	});
	mocks.tools
		.mockResolvedValueOnce(pack(first))
		.mockResolvedValueOnce(pack(second));
	await prepareNormalChatTurn(createPlainNormalChatSendModelParams());
	const owner = mocks.model.mock.calls.at(-1)?.[0].completionPolicy;
	const args = {
		provider: createPlainNormalChatProvider(),
		modelId: "model1",
		phase: "working",
		attemptId: "first",
		toolsAllowed: true,
		snapshot: {},
	};
	const execution = { callId: "same-id", toolName: "produce_file" };
	const a = await owner.forAttempt(args);
	expect(
		a.classifyExecution(execution, { success: true, output: refused }),
	).toBe("definitely_not_executed");
	const unknown = { ...refused };
	first.record(entry);
	expect(
		a.classifyExecution(execution, { success: true, output: unknown }),
	).toBe("uncertain");
	const b = await owner.forAttempt({
		...args,
		provider: { ...args.provider, id: "second" },
		modelId: "model2",
		attemptId: "second",
	});
	second.record(entry);
	expect(
		b.classifyExecution(execution, { success: true, output: refused }),
	).toBe("uncertain");
	expect(
		b.classifyExecution(execution, { success: true, output: unknown }),
	).toBe("uncertain");
});

it.each([
	"openai",
	"deepseek",
] as const)("captures native prefetch once from %s and projects only that exchange for each destination", async (initialFamily) => {
	const baseRuntime = await mocks.runtime(
		createPlainNormalChatSendModelParams(),
	);
	mocks.runtime.mockResolvedValue({
		...baseRuntime,
		provider: {
			...baseRuntime.provider,
			name: initialFamily,
			modelName: initialFamily === "deepseek" ? "deepseek-flash" : "gpt-test",
			baseUrl:
				initialFamily === "deepseek"
					? "https://api.deepseek.com"
					: "https://api.openai.com/v1",
		},
	});
	const pair = [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "prefetch-1",
					toolName: "fetch_url",
					input: { urls: ["https://public.invalid"] },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "prefetch-1",
					toolName: "fetch_url",
					output: {
						type: "json",
						value: {
							answer: "CAPTURED-EVIDENCE",
							urls: ["https://public.invalid"],
						},
					},
				},
			],
		},
	] as const;
	mocks.prepare.mockResolvedValue(
		createPlainNormalChatPreparedContext({
			inputValue: "User intent stays exact",
			prefetchedToolMessages: structuredClone(pair) as never,
			prefetchedToolCalls: [
				{
					callId: "prefetch-1",
					name: "fetch_url",
					input: {},
					status: "done",
					outputSummary: "CAPTURED-EVIDENCE",
				},
			],
		}),
	);
	await prepareNormalChatTurn(createPlainNormalChatSendModelParams());
	expect(mocks.prepare.mock.calls[0][5]).toBe("native");
	const args = mocks.model.mock.calls.at(-1)?.[0];
	const native = {
		...args.provider,
		name: "openai",
		modelName: "gpt-test",
		baseUrl: "https://api.openai.com/v1",
	};
	const flatten = {
		...native,
		id: "ds",
		name: "deepseek",
		modelName: "deepseek-flash",
		baseUrl: "https://api.deepseek.com",
	};
	const other = [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "real-tool",
					toolName: "lookup",
					input: {},
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "real-tool",
					toolName: "lookup",
					output: { type: "text", value: "REAL-RESULT" },
				},
			],
		},
	];
	const messages = [...args.messages, ...other];
	// Images and the exact user text are never rebuilt while rebinding evidence.
	messages[0] = {
		role: "user",
		content: [
			...messages[0].content,
			{
				type: "image",
				image: new Uint8Array([1, 2, 3]),
				mediaType: "image/png",
			},
		],
	};
	const before = JSON.stringify(messages);
	for (const [provider, id] of [
		[flatten, "a"],
		[native, "b"],
		[flatten, "c"],
	] as const) {
		const policy = await args.completionPolicy.forAttempt({
			provider,
			modelId: id,
			phase: "closing",
			attemptId: id,
			toolsAllowed: false,
			snapshot: {},
		});
		const projected = policy.projectContext({
			snapshot: {},
			system: "system",
			messages,
			provider,
		});
		expect(projected.messages[0]).toEqual(messages[0]);
		expect(projected.messages.slice(-2)).toEqual(other);
		if (provider === flatten) {
			expect(projected.messages).toHaveLength(messages.length - 1);
			expect(projected.messages[1]).toMatchObject({
				role: "user",
				content: expect.stringContaining("CAPTURED-EVIDENCE"),
			});
			expect(JSON.stringify(projected.messages)).not.toContain(
				'"toolCallId":"prefetch-1"',
			);
		} else expect(projected.messages).toEqual(messages);
	}
	expect(JSON.stringify(messages)).toBe(before);
	expect(mocks.prepare).toHaveBeenCalledOnce();
});

it.each([
	"runtime",
	"preparation",
] as const)("does not continue preparation after abort during %s", async (stage) => {
	const controller = new AbortController();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const current =
		stage === "runtime"
			? mocks.runtime.getMockImplementation()
			: mocks.prepare.getMockImplementation();
	const prepared = createPlainNormalChatPreparedContext();
	if (stage === "runtime")
		mocks.runtime.mockImplementation(async (...args) => {
			await held;
			if (!current) throw new Error("Missing runtime fixture");
			return current(...args);
		});
	else
		mocks.prepare.mockImplementation(async () => {
			await held;
			return prepared;
		});
	const pending = prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({ signal: controller.signal }),
	);
	await vi.waitFor(() =>
		expect(
			stage === "runtime" ? mocks.runtime : mocks.prepare,
		).toHaveBeenCalledOnce(),
	);
	controller.abort(new Error("cancelled preparation"));
	release();
	await expect(pending).rejects.toThrow("cancelled preparation");
	expect(mocks.tools).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});
