import type {
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
	LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { Tool, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { projectNormalChatOutput } from "$lib/shared/normal-chat-output";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	type NormalChatCompletionDependencies,
	runNormalChatCompletion,
} from "../normal-chat-model/completion";
import {
	parseNormalChatContinuation,
	serializeNormalChatContinuation,
} from "../normal-chat-model/continuation-codec";
import { createNormalChatTools } from "../normal-chat-tools";
import {
	getReadResultGrant,
	markBudgetedReadTool,
	type ReadResultGrant,
	supportsReadResultBudget,
} from "../normal-chat-tools/model-payload-budget";
import {
	createToolCallRecorder,
	stableStringify,
	type ToolCallRecorder,
} from "../normal-chat-tools/shared";
import {
	buildToolResultCacheKey,
	resetToolResultCacheForTests,
	setCachedToolResult,
} from "../normal-chat-tools/tool-result-cache";
import {
	baseGroundedWebDiagnostics,
	type GroundedWebResult,
} from "../parallel-search/types";
import { createStepImageQueue } from "../vision/step-images";
import {
	createPlainNormalChatPreparedContext,
	createPlainNormalChatProvider,
	createPlainNormalChatSendModelParams,
} from "./plain-normal-chat-model-run.test-helpers";

const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	runtime: vi.fn(),
	pack: vi.fn(),
	model: vi.fn(),
	research: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("./turn-ledger", () => ({
	admitTurn: () => ({ status: "admitted" }),
	recordTurnAttempt: async () => {},
	settleTurn: async () => {},
	observeAbandonedTurn: vi.fn(),
}));
vi.mock("./shared-normal-chat-model-run-helpers", async (original) => ({
	...(await original<
		typeof import("./shared-normal-chat-model-run-helpers")
	>()),
	prepareOutboundContext: mocks.prepare,
	resolveProviderRuntime: mocks.runtime,
	createToolPack: mocks.pack,
}));
vi.mock("../normal-chat-model", async (original) => ({
	...(await original<typeof import("../normal-chat-model")>()),
	prepareNormalChatCompletionRun: mocks.model,
}));
vi.mock("../connections/resolve", async (original) => ({
	...(await original<typeof import("../connections/resolve")>()),
	resolveActiveCapabilities: async () => new Set(),
}));
vi.mock("../connections/locality", async (original) => ({
	...(await original<typeof import("../connections/locality")>()),
	hasLocalDistillEnabled: async () => false,
}));
vi.mock("../parallel-search/research", () => ({
	researchWebViaParallel: mocks.research,
}));
vi.mock("../parallel-search/fetch-url", () => ({
	fetchUrlViaParallel: mocks.fetch,
}));
vi.mock("../analytics", async (original) => ({
	...(await original<typeof import("../analytics")>()),
	recordParallelUsage: async () => {},
}));
vi.mock("$lib/server/config-store", async (original) => {
	const actual = await original<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getConfig: () => ({
			...actual.getConfig(),
			parallelApiKey: "synthetic",
			parallelBaseUrl: "https://parallel.invalid",
		}),
	};
});

import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const url = "https://selected.example/page";
const denialCallId = "call_8d47e29b6c12457c91a0e35f";
const denialQuery =
	"What do the official SvelteKit docs say about loading data on the server?";
function candidate(query: string): GroundedWebResult {
	const sources = Array.from({ length: 40 }, (_, i) => ({
		id: `s${i}`,
		title: `Source ${i}`,
		url: i === 0 ? url : `https://source${i}.example/page`,
		provider: "parallel",
		authorityClass: "standard",
		authorityScore: 50,
		snippet: `Visible ${i}`,
		highlights: ["NEVER_EXPOSE_RAW_HIGHLIGHT"],
		providerRank: i,
		publishedAt: null,
		updatedAt: null,
	}));
	return {
		query,
		queries: [{ query }],
		sources,
		evidence: sources.map((source) => ({
			id: `${source.id}e`,
			sourceId: source.id,
			title: source.title,
			url: source.url,
			provider: "parallel",
			quote: "Exact supported evidence. ".repeat(900),
			score: 1,
		})),
		answerBrief: {
			markdown: `OMITTED_BRIEF_FACT ${"large fetched body ".repeat(20_000)}`,
			instructions: [],
		},
		diagnostics: baseGroundedWebDiagnostics({
			fetchedSourceCount: 40,
			evidenceCandidateCount: 40,
		}),
	};
}
function stream(parts: LanguageModelV3StreamPart[]) {
	return new ReadableStream<LanguageModelV3StreamPart>({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetToolResultCacheForTests();
	mocks.prepare.mockResolvedValue(
		createPlainNormalChatPreparedContext({
			inputValue: `Read ${url}`,
			systemPrompt: "Use only the exposed evidence.",
		}),
	);
	mocks.runtime.mockImplementation(async (params) => ({
		provider: createPlainNormalChatProvider({
			maxOutputTokens: 4096,
			maxModelContext: 32000,
		}),
		modelId: "model1",
		modelConfig: params.runtimeConfig.model1,
		baseContextLimits: {
			maxModelContext: 32000,
			targetConstructedContext: 20000,
			compactionUiThreshold: 24000,
		},
		depthEffort: null,
	}));
	mocks.research.mockImplementation(async (input) => candidate(input.query));
	mocks.fetch.mockImplementation(async () => candidate(url));
});

async function runPrepared(settings: {
	streaming: boolean;
	kind:
		| "single"
		| "sequential"
		| "parallel"
		| "error"
		| "empty"
		| "denial"
		| "reasoning"
		| "cache"
		| "validation";
	reverse?: boolean;
	warmCache?: boolean;
}) {
	const base = createToolCallRecorder();
	const observed: Array<{ payload: unknown; name: string }> = [];
	const recorder: ToolCallRecorder = {
		...base,
		observeResult: ({ payload, toolName }) =>
			observed.push({ payload, name: toolName }),
	};
	const grants: Array<{ name: string; grant: ReadResultGrant | undefined }> =
		[];
	const returned: unknown[] = [];
	const wire: LanguageModelV3CallOptions[] = [];
	let upstream = 0;
	const expected =
		settings.kind === "parallel" ? (settings.warmCache ? 2 : 3) : 1;
	const releases: Array<() => void> = [];
	const read = async (query: string) => {
		upstream++;
		if (settings.kind === "error") throw new Error("upstream failed");
		if (settings.kind === "validation") {
			const result = candidate(query);
			result.evidence[0].quote = JSON.parse("42");
			return result;
		}
		if (settings.kind === "empty")
			return { ...candidate(query), sources: [], evidence: [] };
		if (settings.reverse) {
			await new Promise<void>((resolve) => {
				releases.push(resolve);
				if (releases.length === expected)
					for (const release of [...releases].reverse()) release();
			});
		}
		return candidate(query);
	};
	mocks.research.mockImplementation((input) => read(input.query));
	mocks.fetch.mockImplementation(() => read(url));
	if (settings.warmCache)
		setCachedToolResult(
			buildToolResultCacheKey({
				conversationId: `bounded-${settings.kind}`,
				toolName: "research_web",
				input: { query: "query 0-2" },
			}),
			{ result: candidate("query 0-2"), pages: [], pageCandidates: [] },
		);
	const all = createNormalChatTools({
		userId: "user-1",
		conversationId: `bounded-${settings.kind}`,
		turnId: "t",
		requestText: `Read ${url}`,
		recorder,
		stepImages: createStepImageQueue(),
	});
	const tools: ToolSet = {};
	for (const name of ["research_web", "fetch_url"]) {
		const original: Tool | undefined =
			all.tools[name as keyof typeof all.tools];
		if (!original) throw new Error(`Expected ${name} factory tool`);
		expect(supportsReadResultBudget(original)).toBe(true);
		const execute = original.execute;
		tools[name] = markBudgetedReadTool({
			...original,
			execute: async (input, options) => {
				grants.push({ name, grant: getReadResultGrant(options) });
				const output = await execute?.(input, options);
				returned.push(output);
				return output;
			},
		});
	}
	mocks.pack.mockResolvedValue({
		...all,
		tools,
		stepImages: createStepImageQueue(),
	});
	let n = 0;
	const outputFor = (options: LanguageModelV3CallOptions) => {
		wire.push(options);
		const step = n++;
		const working = options.tools && options.tools.length > 0;
		if (
			working &&
			(step === 0 ||
				((settings.kind === "sequential" || settings.kind === "cache") &&
					step < 2))
		) {
			const count = settings.kind === "parallel" ? 3 : 1;
			const content = Array.from({ length: count }, (_, i) => ({
				type: "tool-call" as const,
				toolCallId: settings.kind === "denial" ? denialCallId : `c${step}-${i}`,
				toolName: i === 1 ? "fetch_url" : "research_web",
				input: JSON.stringify(
					i === 1
						? { urls: [url] }
						: {
								query:
									settings.kind === "cache"
										? "cached query"
										: settings.kind === "denial"
											? denialQuery
											: `query ${step}-${i}`,
							},
				),
			}));
			return {
				content:
					settings.kind === "reasoning"
						? [
								{
									type: "reasoning" as const,
									text: "retained reasoning ".repeat(30_000),
								},
								...content,
							]
						: content,
				finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
				usage,
				warnings: [],
			};
		}
		return {
			content: [
				{ type: "text" as const, text: "Answer from bounded evidence." },
			],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage,
			warnings: [],
		};
	};
	const model = new MockLanguageModelV3({
		doGenerate: async (options) => outputFor(options),
		doStream: async (options) => {
			const result = outputFor(options);
			const parts: LanguageModelV3StreamPart[] = result.content.flatMap(
				(part): LanguageModelV3StreamPart[] =>
					part.type === "text"
						? [
								{ type: "text-start", id: "text" },
								{ type: "text-delta", id: "text", delta: part.text },
								{ type: "text-end", id: "text" },
							]
						: part.type === "reasoning"
							? [
									{ type: "reasoning-start", id: "r" },
									{ type: "reasoning-delta", id: "r", delta: part.text },
									{ type: "reasoning-end", id: "r" },
								]
							: [part],
			);
			return {
				stream: stream([
					...parts,
					{ type: "finish", usage, finishReason: result.finishReason },
				]),
			};
		},
	});
	const dependencies: NormalChatCompletionDependencies = {
		model,
		maxModelContext: settings.kind === "denial" ? 8500 : 32000,
		providerOptions: undefined,
		stopWhen: undefined,
		metadata: () => ({
			modelId: "model1",
			providerId: "model1",
			providerName: "model1",
			displayName: "Model One",
			requestedModelName: "gpt-4.1",
			responseModelName: "gpt-4.1",
		}),
		mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
	};
	mocks.model.mockImplementation((params) => ({
		runPlain: async () => {
			const run = runNormalChatCompletion(
				{
					...params,
					maxToolSteps:
						settings.kind === "sequential" || settings.kind === "cache" ? 2 : 1,
				},
				dependencies,
				false,
			);
			for (;;) {
				const next = await run.next();
				if (next.done) return next.value;
			}
		},
		stream: () =>
			runNormalChatCompletion(
				{
					...params,
					maxToolSteps:
						settings.kind === "sequential" || settings.kind === "cache" ? 2 : 1,
				},
				dependencies,
				true,
			),
		getSnapshot: () => null,
	}));
	const prepared = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({
			runtimeConfig: {
				requestTimeoutMs: 300000,
				model1MaxModelContext: 32000,
				model1: {
					...createPlainNormalChatSendModelParams().runtimeConfig.model1,
					maxTokens: 4096,
				},
			},
		}),
	);
	if (settings.streaming)
		for await (const _event of prepared.stream().stream) {
		}
	else await prepared.runPlain();
	const snapshot = prepared.receipt.getSnapshot();
	if (!snapshot)
		throw new Error("Prepared turn must retain its completion snapshot");
	return {
		snapshot,
		wire,
		grants,
		observed,
		returned,
		base,
		upstream,
		model,
		dependencies,
	};
}

describe("Task 2 real SDK / prepared bounded web chain", () => {
	it.each([false, true])(
		"bounds largest single/sequential/parallel NEW reads and closes losslessly (stream=%s)",
		async (streaming) => {
			for (const kind of ["single", "sequential", "parallel"] as const) {
				resetToolResultCacheForTests();
				const run = await runPrepared({ streaming, kind });
				expect(run.snapshot.completion).toMatchObject({
					outcome: "answered",
					closingAttempted: true,
				});
				expect(projectNormalChatOutput(run.snapshot.events).answer).toBe(
					"Answer from bounded evidence.",
				);
				expect(run.upstream).toBe(
					kind === "parallel" ? 3 : kind === "sequential" ? 2 : 1,
				);
				expect(
					run.snapshot.executions.map((e) => ({
						tool: e.toolName,
						state: e.state,
						failure:
							(e.output as { coverage?: string })?.coverage === "none"
								? e.output
								: undefined,
					})),
				).toEqual(
					run.snapshot.executions.map((e) => ({
						tool: e.toolName,
						state: "succeeded",
						failure: undefined,
					})),
				);
				for (const execution of run.snapshot.executions) {
					const observed = run.observed.find(
						(o) =>
							JSON.stringify(o.payload) === JSON.stringify(execution.output),
					);
					expect(observed).toBeTruthy();
					expect(execution.modelOutput).toEqual({
						type: "json",
						value: observed?.payload,
					});
					const finalPrompt = run.wire.at(-1)?.prompt;
					const results = finalPrompt
						?.filter((m) => m.role === "tool")
						.flatMap((m) => m.content);
					expect(
						results?.find(
							(part): part is LanguageModelV3ToolResultPart =>
								part.type === "tool-result" &&
								part.toolCallId === execution.callId,
						)?.output,
					).toEqual(execution.modelOutput);
					expect(JSON.stringify(execution.output)).not.toContain(
						"OMITTED_BRIEF_FACT",
					);
				}
				expect(run.wire.filter((call) => !call.tools?.length)).toHaveLength(1);
				const captured = parseNormalChatContinuation(
					serializeNormalChatContinuation(run.snapshot),
				);
				expect(captured.executions).toEqual(run.snapshot.executions);
			}
		},
	);
	it("keeps proposal leases and views identical under reversed upstream completion", async () => {
		const first = await runPrepared({ streaming: false, kind: "parallel" });
		resetToolResultCacheForTests();
		const reversed = await runPrepared({
			streaming: false,
			kind: "parallel",
			reverse: true,
		});
		expect(reversed.grants.map((g) => g.grant?.maxPayloadTokens)).toEqual(
			first.grants.map((g) => g.grant?.maxPayloadTokens),
		);
		expect(reversed.snapshot.executions.map((e) => e.output)).toEqual(
			first.snapshot.executions.map((e) => e.output),
		);
	});
	it.each([false, true])(
		"keeps returned failure and upstream error settled through the exact prepared result (stream=%s)",
		async (streaming) => {
			for (const kind of ["error", "empty", "validation"] as const) {
				const run = await runPrepared({ streaming, kind });
				expect(run.snapshot.completion).toMatchObject({
					outcome: "answered",
					closingAttempted: true,
				});
				const execution = run.snapshot.executions[0];
				expect(execution.state).toBe("failed");
				expect(execution.output).toMatchObject({
					success: false,
					coverage: "none",
					bounded: true,
				});
				expect(run.base.getExecutionCertainty?.(run.returned[0])).toBe(
					"failed",
				);
				expect(run.observed[0].payload).toBe(run.returned[0]);
				expect(execution.modelOutput).toEqual({
					type: "json",
					value: run.returned[0],
				});
				expect(
					run.wire
						.at(-1)
						?.prompt.filter((message) => message.role === "tool")
						.flatMap((message) => message.content)
						.find(
							(part): part is LanguageModelV3ToolResultPart =>
								part.type === "tool-result" &&
								part.toolCallId === execution.callId,
						)?.output,
				).toEqual(execution.modelOutput);
				expect(
					estimateTokenCount(stableStringify(run.returned[0])),
				).toBeLessThanOrEqual(
					run.grants[0].grant?.maxFailurePayloadTokens ?? 0,
				);
			}
		},
	);
	it.each([false, true])(
		"counts accumulated retained reasoning and refuses an oversized next dispatch (stream=%s)",
		async (streaming) => {
			const run = await runPrepared({ streaming, kind: "reasoning" });
			expect(run.wire).toHaveLength(1);
			expect(run.snapshot.completion).toMatchObject({
				stopCause: "context_capacity",
				closingAttempted: true,
			});
			expect(JSON.stringify(run.snapshot.steps)).toContain(
				"retained reasoning",
			);
		},
	);
});

it.each([false, true])(
	"Task 2 resizes cached results under new step leases without changing old captures (stream=%s)",
	async (streaming) => {
		const run = await runPrepared({ streaming, kind: "cache" });
		expect(run.upstream).toBe(1);
		expect(run.grants[1].grant?.maxPayloadTokens).toBeLessThan(
			run.grants[0].grant?.maxPayloadTokens ?? 0,
		);
		expect(run.snapshot.executions[1].output).toMatchObject({
			cached: true,
			bounded: true,
		});
		expect(run.snapshot.executions[0].output).not.toHaveProperty("cached");
		expect(run.snapshot.executions.map((e) => e.output)).toEqual(run.returned);
		expect(run.snapshot.completion?.outcome).toBe("answered");
	},
);

it.each([false, true])(
	"Task 2 funds an ordinary unfunded proposal refusal before upstream work and closes (stream=%s)",
	async (streaming) => {
		const run = await runPrepared({ streaming, kind: "denial" });
		expect(run.grants[0]?.grant?.maxFailurePayloadTokens).toBeGreaterThan(0);

		expect(run.grants[0]?.grant).toMatchObject({
			kind: "denied",
			maxPayloadTokens: 0,
		});
		expect(run.upstream).toBe(0);
		expect(run.snapshot.executions[0].state).toBe("definitely_not_executed");
		expect(run.snapshot.executions[0].output).toMatchObject({
			bounded: true,
			coverage: "none",
			success: false,
		});
		expect(run.base.getExecutionCertainty?.(run.returned[0])).toBe(
			"definitely_not_executed",
		);
		const execution = run.snapshot.executions[0];
		expect(execution.callId).toBe(denialCallId);
		expect(execution.input).toEqual({ query: denialQuery });
		expect(run.base.getEntries()).toHaveLength(1);
		expect(run.base.getEntries()[0]).toMatchObject({
			callId: denialCallId,
			input: { query: denialQuery },
			candidates: [],
		});
		expect(run.observed[0]?.payload).toBe(run.returned[0]);
		expect(execution.output).toEqual(run.returned[0]);
		expect(execution.modelOutput).toEqual({
			type: "json",
			value: run.returned[0],
		});
		expect(
			run.wire
				.at(-1)
				?.prompt.filter((message) => message.role === "tool")
				.flatMap((message) => message.content)
				.find(
					(part): part is LanguageModelV3ToolResultPart =>
						part.type === "tool-result" && part.toolCallId === denialCallId,
				)?.output,
		).toEqual(execution.modelOutput);
		expect(run.wire[0]?.maxOutputTokens).toBe(
			run.snapshot.prepared.maxOutputTokens,
		);

		expect(run.snapshot.completion).toMatchObject({
			outcome: "answered",
			workingStopCause: "context_capacity",
			closingAttempted: true,
		});
	},
);

it("Task 2 keeps admitted views exact on human reuse without a new lease or upstream read", async () => {
	const prior = await runPrepared({ streaming: false, kind: "single" });
	const before = serializeNormalChatContinuation(prior.snapshot);
	let reads = 0;
	const reuseTool = markBudgetedReadTool({
		inputSchema: z.object({ query: z.string() }),
		execute: async () => {
			reads++;
			throw new Error("reuse must not read");
		},
	});
	let calls = 0;
	const model = new MockLanguageModelV3({
		doGenerate: async () =>
			calls++ === 0
				? {
						content: [
							{
								type: "tool-call",
								toolCallId: "reuse",
								toolName: "research_web",
								input: JSON.stringify({ query: "reuse selected view" }),
							},
						],
						finishReason: { unified: "tool-calls", raw: "tool_calls" },
						usage,
						warnings: [],
					}
				: {
						content: [{ type: "text", text: "Reused exact evidence." }],
						finishReason: { unified: "stop", raw: "stop" },
						usage,
						warnings: [],
					},
	});
	let captured = prior.snapshot;
	const run = runNormalChatCompletion(
		{
			provider: createPlainNormalChatProvider({
				maxOutputTokens: 4096,
				maxModelContext: 32000,
			}),
			messages: prior.snapshot.original.messages,
			maxToolSteps: 1,
			completionPolicy: {
				turnId: prior.snapshot.turnId,
				segmentId: "human-resume",
				continuation: parseNormalChatContinuation(before),
				continuationKind: "user_resume",
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
				onSnapshot: (snapshot) => {
					captured = snapshot;
				},
				forAttempt: () => ({
					tools: { research_web: reuseTool },
					authorizeExecution: () => ({
						kind: "reuse",
						executionId: prior.snapshot.executions[0].executionId,
					}),
				}),
			},
		},
		{ ...prior.dependencies, model },
		false,
	);
	for (;;) {
		if ((await run.next()).done) break;
	}
	expect(reads).toBe(0);
	expect(captured.executions.at(-1)?.output).toEqual(
		prior.snapshot.executions[0].output,
	);
	expect(captured.executions.at(-1)?.modelOutput).toEqual(
		prior.snapshot.executions[0].modelOutput,
	);
	expect(serializeNormalChatContinuation(prior.snapshot)).toBe(before);
	expect(captured.completion?.outcome).toBe("answered");
});

it("Task 2 refuses a destination projection instead of forwarding or rebuilding a bounded capture", async () => {
	const prior = await runPrepared({ streaming: false, kind: "single" });
	const before = serializeNormalChatContinuation(prior.snapshot);
	const cloud = new MockLanguageModelV3({
		doGenerate: async () => {
			throw new Error("private context must not dispatch");
		},
	});
	const run = runNormalChatCompletion(
		{
			provider: createPlainNormalChatProvider({
				id: "cloud",
				baseUrl: "https://cloud.invalid",
				maxOutputTokens: 4096,
			}),
			messages: prior.snapshot.original.messages,
			completionPolicy: {
				turnId: prior.snapshot.turnId,
				segmentId: "denied-destination",
				continuation: parseNormalChatContinuation(before),
				continuationKind: "user_resume",
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
				forAttempt: () => ({ projectContext: () => null }),
			},
		},
		{ ...prior.dependencies, model: cloud },
		false,
	);
	let outcome:
		| import("../normal-chat-model").PlainNormalChatModelRunResult
		| undefined;
	for (;;) {
		const next = await run.next();
		if (next.done) {
			outcome = next.value;
			break;
		}
	}
	expect(outcome?.completion?.stopCause).toBe("incompatible_continuation");
	expect(cloud.doGenerateCalls).toEqual([]);
	expect(serializeNormalChatContinuation(prior.snapshot)).toBe(before);
});

it("Task 2 cache hits settling before in-flight reads cannot change proposal leases or selection", async () => {
	const first = await runPrepared({
		streaming: false,
		kind: "parallel",
		warmCache: true,
	});
	resetToolResultCacheForTests();
	const reversed = await runPrepared({
		streaming: false,
		kind: "parallel",
		warmCache: true,
		reverse: true,
	});
	expect(first.upstream).toBe(2);
	expect(reversed.upstream).toBe(2);
	expect(reversed.grants.map((g) => g.grant?.maxPayloadTokens)).toEqual(
		first.grants.map((g) => g.grant?.maxPayloadTokens),
	);
	expect(reversed.snapshot.executions.map((e) => e.output)).toEqual(
		first.snapshot.executions.map((e) => e.output),
	);
	expect(reversed.snapshot.executions[2].output).toHaveProperty("cached", true);
});
