// A tool call that turns out to be settled (a refusal made before anything ran, or a
// failure of a tool that only reads) does not end the turn: the model reads the
// error, which is written for it, and answers. Through the real prepared owner,
// envelope, recorder and engine, as zz-review-A-prepared.test.ts does for a
// produce_file failure. Production, 13 and 14 Nov 2026: five turns of 55 ended with
// an empty reply and "The model stopped before writing its answer" because a
// refused fetch_url (an address the model made up) or a memory_context call outside
// its scope was recorded as uncertain; a search, a fetch or a picture search that
// timed out or failed upstream would have done the same.
//
// The same goes for a call of such a tool that the engine's own WORKING DEADLINE
// cuts off (the turn's total less its reserve for the closing): the call is a
// settled failure, so the engine reaches its one tools-disabled closing and the
// model answers with what it has. A stop of the person, or any abort that is not
// that timer, keeps the call uncertain, and so does the cut of a tool that did
// not say it only reads.
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Tool } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { TurnDeadlineReason } from "$lib/server/utils/turn-deadline-reason";
import type { NormalChatCompletionDependencies } from "../normal-chat-model/completion";
import { isRetryableNormalChatFallbackError } from "../normal-chat-model/failover";
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

/** What the engine is handed besides the turn: a mock model, and a failover hook when the test has one. */
function engineDependencies(
	forModel: import("ai/test").MockLanguageModelV3,
): NormalChatCompletionDependencies {
	return {
		model: forModel,
		maxModelContext: 32000,
		providerOptions: undefined,
		stopWhen: undefined,
		metadata: () => createPlainNormalChatModelRunResult().model,
		mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
	};
}

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

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
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
	/** Runs beside the turn once it is under way: a test stops the turn or moves the clock from here. */
	whileRunning?: () => Promise<void>;
	/** The person's own signal, the one Stop aborts. */
	signal?: AbortSignal;
	/**
	 * Fake only what the engine's deadline reads (`setTimeout`, `Date`): a cut by
	 * the working deadline then needs no waiting, and no load can make the closing
	 * miss the little time the deadline leaves it.
	 */
	fakeClock?: boolean;
	/** Model Run's failover hook; without one the turn has no fallback provider. */
	fallback?: NormalChatCompletionDependencies["fallback"];
	/**
	 * Run the turn as the browser's chat runs it, through `streamText`, which cuts a
	 * stream short the moment its signal aborts, instead of `generateText`.
	 */
	streaming?: boolean;
	/**
	 * The model's second call (after the tool's step) never answers: it fails with
	 * the reason its signal was aborted with, as a provider's request does when the
	 * turn's clock aborts it. The call after that, the closing, answers.
	 */
	secondCallHangsUntilAborted?: boolean;
	/** Told when the model is called, with the number of the call (0 is the first). */
	onModelCall?: (n: number) => void;
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
	const toolCall = {
		type: "tool-call" as const,
		toolCallId: `${params.toolName}-0`,
		toolName: params.toolName,
		input: JSON.stringify(params.toolInput),
	};
	const streamOf = (parts: LanguageModelV3StreamPart[]) =>
		new ReadableStream<LanguageModelV3StreamPart>({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			},
		});
	const model = new MockLanguageModelV3({
		doGenerate: async (callOptions) => {
			const n = generations++;
			params.onModelCall?.(n);
			if (n === 0)
				return {
					content: [toolCall],
					finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
					usage,
					warnings: [],
				};
			if (n === 1 && params.secondCallHangsUntilAborted)
				return await new Promise<never>((_, reject) => {
					callOptions.abortSignal?.addEventListener(
						"abort",
						() => reject(callOptions.abortSignal?.reason),
						{ once: true },
					);
				});
			return {
				content: [{ type: "text" as const, text: params.answer }],
				finishReason: { unified: "stop" as const, raw: "stop" },
				usage,
				warnings: [],
			};
		},
		doStream: async (callOptions) => {
			const n = generations++;
			params.onModelCall?.(n);
			if (n === 0)
				return {
					stream: streamOf([
						toolCall,
						{
							type: "finish",
							usage,
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
						},
					]),
				};
			if (n === 1 && params.secondCallHangsUntilAborted)
				return {
					stream: new ReadableStream<LanguageModelV3StreamPart>({
						start(controller) {
							callOptions.abortSignal?.addEventListener(
								"abort",
								() => controller.error(callOptions.abortSignal?.reason),
								{ once: true },
							);
						},
					}),
				};
			return {
				stream: streamOf([
					{ type: "text-start", id: "answer" },
					{ type: "text-delta", id: "answer", delta: params.answer },
					{ type: "text-end", id: "answer" },
					{
						type: "finish",
						usage,
						finishReason: { unified: "stop", raw: "stop" },
					},
				]),
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
					...engineDependencies(model),
					fallback: params.fallback,
				},
				false,
			);
			for (;;) {
				const next = await driver.next();
				if (next.done) return next.value;
			}
		},
		stream: async function* () {
			yield* runNormalChatCompletion(
				modelParams,
				{ ...engineDependencies(model), fallback: params.fallback },
				true,
			);
		},
		getSnapshot: () => null,
	}));

	if (params.fakeClock)
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const events: Array<{ type: string; callId?: string; toolName?: string }> =
		[];
	let run: Awaited<ReturnType<typeof prepareNormalChatTurn>>;
	try {
		run = await prepareNormalChatTurn(
			createPlainNormalChatSendModelParams({ signal: params.signal }),
		);
		const consume = async () => {
			if (params.streaming)
				for await (const event of run.stream().stream) events.push(event);
			else await run.runPlain();
		};
		await Promise.all([consume(), params.whileRunning?.()]);
	} finally {
		if (params.fakeClock) vi.useRealTimers();
	}
	const snapshot = run.receipt.getSnapshot();
	const sentToModel = () =>
		params.streaming ? model.doStreamCalls : model.doGenerateCalls;
	return {
		completion: snapshot?.completion,
		states: snapshot?.executions.map((e) => e.state),
		answer: snapshot ? projectNormalChatOutput(snapshot.events).answer : null,
		generations: () => generations,
		/** What the streaming run told the browser, in order; a plain send has none. */
		events,
		/** What the model was sent the second time it was asked. */
		secondPrompt: () => JSON.stringify(sentToModel()[1]?.prompt),
		/** The same, as the messages themselves. */
		secondPromptMessages: () => sentToModel()[1]?.prompt ?? [],
	};
}

/**
 * A search that never answers. The envelope's own timeout ends it after
 * `timeoutMs` (20 ms unless the test says more), and `onStart` tells the test
 * that the call is running.
 */
const neverAnsweringSearch =
	(call: { readOnly: boolean; timeoutMs?: number; onStart?: () => void }) =>
	({ recorder, envelope, failed, tool, z }: Kit) =>
		tool({
			inputSchema: z.object({ query: z.string() }),
			execute: async (input, options) =>
				envelope({
					toolName: "research_web",
					timeoutMs: call.timeoutMs ?? 20,
					options,
					recorder,
					readOnly: call.readOnly,
					run: async () => {
						call.onStart?.();
						await new Promise(() => {});
						throw new Error("unreachable");
					},
					onError: (error) => failed(options, input, error),
				}),
		});

/** A search that answers at once, with one source. */
const instantSearch = ({ recorder, envelope, failed, tool, z }: Kit) =>
	tool({
		inputSchema: z.object({ query: z.string() }),
		execute: async (input, options) =>
			envelope({
				toolName: "research_web",
				timeoutMs: 1_000,
				options,
				recorder,
				readOnly: true,
				run: async () => ({
					modelPayload: { success: true, sources: ["one source"] },
					entry: {
						callId: options.toolCallId,
						name: "research_web",
						input,
						status: "done" as const,
						outputSummary: "one source",
						sourceType: "web" as const,
						candidates: [],
						metadata: { ok: true },
					},
				}),
				onError: (error) => failed(options, input, error),
			}),
	});

/**
 * A search that is still running when the turn's own clock or the person cuts
 * it off: its own timeout is a minute, far past the turn's 1.5 s.
 */
function aSearchStillRunning(readOnly: boolean) {
	let started!: () => void;
	const hasStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	return {
		hasStarted,
		makeTool: neverAnsweringSearch({
			readOnly,
			timeoutMs: 60_000,
			onStart: started,
		}),
	};
}

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
		makeTool: neverAnsweringSearch({ readOnly: true }),
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
		makeTool: neverAnsweringSearch({ readOnly: false }),
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

// A call that is still RUNNING when the engine's working deadline arrives (a
// turn's total less its reserve for the closing: three quarters of the harness
// turn's 1.5 s) is cut off by the engine's own timer. Production, 13 and 14 Nov
// 2026: the same empty reply and "The model stopped before writing its answer" a
// refused call gave, because a call the turn's own abort cut off was always
// recorded as uncertain, and the engine ends a turn at the first uncertain call.
const PAST_THE_WORKING_DEADLINE_MS = 1_200;

// The browser's chat runs through `streamText`, which cuts its stream short the
// moment the signal aborts (and drops what was still on its way); a plain send
// runs through `generateText`. The engine reads both, so each case runs on both.
const transports = [
	["a plain send", false],
	["the streaming chat", true],
] as const;

it.each(
	transports,
)("lets the model answer when the working deadline cuts off a call that only reads (%s)", async (_transport, streaming) => {
	const answer =
		"The search did not come back in time, so here is what I know instead.";
	const search = aSearchStillRunning(true);

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer,
		makeTool: search.makeTool,
		fakeClock: true,
		streaming,
		whileRunning: async () => {
			await search.hasStarted;
			await vi.advanceTimersByTimeAsync(PAST_THE_WORKING_DEADLINE_MS);
		},
	});

	// The search was running when the working deadline cut it off. It only reads,
	// so running it again changes nothing a person could lose: a settled failure,
	// and the engine goes on to its one tools-disabled closing.
	expect(turn.states).toEqual(["failed"]);
	expect(turn.generations()).toBe(2);
	expect(turn.completion).toMatchObject({
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "deadline",
		closingAttempted: true,
	});
	expect(turn.answer).toBe(answer);
	// The closing was sent the call with a result that says it ended at the
	// deadline, and the instruction that tools are gone.
	const results = turn
		.secondPromptMessages()
		.flatMap((message) => (message.role === "tool" ? message.content : []));
	expect(results).toEqual([
		expect.objectContaining({ toolCallId: "research_web-0" }),
	]);
	expect(JSON.stringify(results)).toContain("deadline");
	expect(turn.secondPrompt()).toContain("Tools are unavailable");
});

it.each(
	transports,
)("still ends the turn when the working deadline cuts off a call that did not say it only reads (%s)", async (_transport, streaming) => {
	const search = aSearchStillRunning(false);

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer: "Never asked for.",
		makeTool: search.makeTool,
		fakeClock: true,
		streaming,
		whileRunning: async () => {
			await search.hasStarted;
			await vi.advanceTimersByTimeAsync(PAST_THE_WORKING_DEADLINE_MS);
		},
	});

	// A tool that has not said it only reads may have written before it was cut
	// off: the engine stops there, as it always did, and never asks again.
	expect(turn.states).toEqual(["uncertain"]);
	expect(turn.generations()).toBe(1);
	expect(turn.completion).toMatchObject({
		outcome: "incomplete",
		stopCause: "uncertain_execution",
	});
});

it.each(
	transports,
)("keeps a stop that cuts off a call that only reads a stop, and the call uncertain (%s)", async (_transport, streaming) => {
	const { UserStopReason } = await import("./active-streams");
	const stop = new AbortController();
	const search = aSearchStillRunning(true);

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer: "Never asked for.",
		makeTool: search.makeTool,
		signal: stop.signal,
		streaming,
		whileRunning: async () => {
			await search.hasStarted;
			stop.abort(new UserStopReason());
		},
	});

	// The person's Stop is not the engine's deadline: the turn is stopped, and what
	// the stop cut off is not recorded as a settled failure.
	expect(turn.completion).toMatchObject({
		outcome: "stopped",
		stopCause: "user_stop",
	});
	expect(turn.states).toEqual(["uncertain"]);
	expect(turn.generations()).toBe(1);
});

it.each(
	transports,
)("closes on the same provider after the cut, with a fallback provider configured (%s)", async (_transport, streaming) => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const answer = "The search did not come back in time.";
	const backup = new MockLanguageModelV3({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "The fallback answered." }],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage,
			warnings: [],
		}),
	});
	// Model Run offers a fallback only for an error its own classifier calls
	// retryable (normal-chat-model/index.ts, resolveNormalChatFallbackProvider):
	// a provider that timed out, rate-limited, or failed upstream. The engine's own
	// deadline is none of those, so the turn must not leave its provider (possibly
	// a cloud one) for it.
	const fallback = vi.fn(async (error: unknown) =>
		isRetryableNormalChatFallbackError(error)
			? {
					provider: createPlainNormalChatProvider({
						id: "model2",
						name: "model2",
						modelName: "backup",
					}),
					modelId: "model2" as const,
					dependencies: engineDependencies(backup),
				}
			: null,
	);
	const search = aSearchStillRunning(true);

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer,
		makeTool: search.makeTool,
		fakeClock: true,
		streaming,
		fallback,
		whileRunning: async () => {
			await search.hasStarted;
			await vi.advanceTimersByTimeAsync(PAST_THE_WORKING_DEADLINE_MS);
		},
	});

	expect(turn.answer).toBe(answer);
	expect(turn.generations()).toBe(2);
	expect(backup.doGenerateCalls).toHaveLength(0);
	expect(backup.doStreamCalls).toHaveLength(0);
});

/** The tool events the browser was sent, as `type:callId`, in order. */
function toolEventsOf(events: Array<{ type: string; callId?: string }>) {
	return events
		.filter(
			(event) =>
				event.type === "tool_call" ||
				event.type === "tool_result" ||
				event.type === "tool_error",
		)
		.map((event) => `${event.type}:${event.callId}`);
}

it("tells the browser how the cut call ended, so its row does not stay running (the streaming chat)", async () => {
	const search = aSearchStillRunning(true);

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer: "The search did not come back in time.",
		makeTool: search.makeTool,
		fakeClock: true,
		streaming: true,
		whileRunning: async () => {
			await search.hasStarted;
			await vi.advanceTimersByTimeAsync(PAST_THE_WORKING_DEADLINE_MS);
		},
	});

	// The SDK closes its stream the moment the signal aborts and drops what was on
	// its way, the call's own tool-result part among it. The browser's row for the
	// call stays "running" until an event says how it ended, and a saved reply with
	// a row still running gets no follow-up chips: the engine says it itself.
	expect(toolEventsOf(turn.events)).toEqual([
		"tool_call:research_web-0",
		"tool_result:research_web-0",
	]);
	const types = turn.events.map((event) => event.type);
	expect(types.indexOf("tool_result")).toBeLessThan(
		types.indexOf("text_delta"),
	);
});

it("closes no call the browser was never told about: the clock runs out before the call's own part arrives (the streaming chat)", async () => {
	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer: "The search did not come back in time.",
		// The clock runs out inside the call itself, before the SDK has handed the
		// call's part to the engine, and the SDK drops the parts that follow an abort.
		makeTool: neverAnsweringSearch({
			readOnly: true,
			timeoutMs: 60_000,
			onStart: () => {
				vi.advanceTimersByTime(PAST_THE_WORKING_DEADLINE_MS);
			},
		}),
		fakeClock: true,
		streaming: true,
	});

	// The engine settled the call, and went on to its closing.
	expect(turn.states).toEqual(["failed"]);
	expect(turn.completion).toMatchObject({ outcome: "answered" });
	// A row is only ever closed after it was opened.
	const opened = new Set<string>();
	for (const event of toolEventsOf(turn.events)) {
		const [type, callId] = event.split(":");
		if (type === "tool_call") opened.add(callId);
		else expect(opened.has(callId)).toBe(true);
	}
});

it("says how a call ended once: a search that failed by its own timeout (the streaming chat)", async () => {
	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer: "The search was unavailable.",
		makeTool: neverAnsweringSearch({ readOnly: true }),
		streaming: true,
	});

	// Here the SDK delivered the call's result itself, so nothing is added to it.
	expect(toolEventsOf(turn.events)).toEqual([
		"tool_call:research_web-0",
		"tool_result:research_web-0",
	]);
});

it.each(
	transports,
)("closes on the same provider when the working deadline cuts the model call after a finished search, with a fallback provider configured (%s)", async (_transport, streaming) => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const answer = "Here is what I found before the time ran out.";
	const backup = new MockLanguageModelV3({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "The fallback answered." }],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage,
			warnings: [],
		}),
	});
	// The error here is the reason itself: the provider's request fails with the
	// reason its signal was aborted with, and Model Run's own classifier decides
	// whether that is a provider failing (a retryable error) or not.
	const fallback = vi.fn(async (error: unknown) =>
		isRetryableNormalChatFallbackError(error)
			? {
					provider: createPlainNormalChatProvider({
						id: "model2",
						name: "model2",
						modelName: "backup",
					}),
					modelId: "model2" as const,
					dependencies: engineDependencies(backup),
				}
			: null,
	);
	let secondCallStarted!: () => void;
	const hasSecondCall = new Promise<void>((resolve) => {
		secondCallStarted = resolve;
	});

	const turn = await runTurnWithTool({
		toolName: "research_web",
		toolInput: { query: "the report" },
		answer,
		makeTool: instantSearch,
		fakeClock: true,
		streaming,
		fallback,
		secondCallHangsUntilAborted: true,
		onModelCall: (n) => {
			if (n === 1) secondCallStarted();
		},
		whileRunning: async () => {
			await hasSecondCall;
			await vi.advanceTimersByTimeAsync(PAST_THE_WORKING_DEADLINE_MS);
		},
	});

	// Search, the model call the deadline cut, and the closing, on one provider.
	expect(turn.states).toEqual(["succeeded"]);
	expect(turn.generations()).toBe(3);
	expect(turn.completion).toMatchObject({
		outcome: "answered",
		stopCause: "natural_stop",
		workingStopCause: "deadline",
		closingAttempted: true,
	});
	expect(turn.answer).toBe(answer);
	// The hook was asked, about the engine's own reason, and said no.
	expect(fallback).toHaveBeenCalledTimes(1);
	expect(fallback.mock.calls[0]?.[0]).toBeInstanceOf(TurnDeadlineReason);
	expect(backup.doGenerateCalls).toHaveLength(0);
	expect(backup.doStreamCalls).toHaveLength(0);
});
