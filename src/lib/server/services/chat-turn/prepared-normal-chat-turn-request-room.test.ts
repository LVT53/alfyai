// A context built up to its budget, end to end: the real prepared turn, the real
// context preparation (prepareOutboundContext and prepareOutboundChatContext
// with their stages), the real tool pack with every connector on, and the real
// engine check (normal-chat-model/completion.ts). Only what is outside them is
// stood in for: the provider's HTTP (a mock model), the provider lookup, the
// database reads of the turn, and the context builder (buildConstructedContext),
// which here builds history to the target it is handed, as the real one does
// when a conversation is long enough to fill it.
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	deriveModelContextLimits,
	type ModelContextLimits,
} from "$lib/model-context-defaults";
import { estimateTokenCount } from "$lib/utils/tokens";
import { emptyTurnPictureIndex } from "../images/turn-pictures";
import { CONTEXT_GUARD_MARGIN_TOKENS } from "../normal-chat-model/context-guard";
import { noTurnImages } from "../vision/turn-images";
import {
	deriveModelContextBudget,
	resolveCompletionMaxTokens,
} from "./context-budget";
import { estimateHistoryMessagesTokens } from "./conversation-history";
import {
	createPlainNormalChatModelRunResult,
	createPlainNormalChatProvider,
	createPlainNormalChatRuntimeConfig,
	createPlainNormalChatSendModelParams,
} from "./plain-normal-chat-model-run.test-helpers";

const ALL_CONNECTORS = [
	"files",
	"calendar",
	"email",
	"photos",
	"media",
	"location",
	"contacts",
	"repos",
	"tasks",
] as const;

const mocks = vi.hoisted(() => ({
	buildContext: vi.fn(),
	runtime: vi.fn(),
	run: vi.fn(),
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
vi.mock("../connections/resolve", () => ({
	resolveActiveCapabilities: async () => new Set(ALL_CONNECTORS),
}));
vi.mock("../connections/locality", () => ({
	hasLocalDistillEnabled: async () => false,
}));
// The standing instructions, the clock, the skills, the connectors' live block,
// the compression snapshots and the picture descriptions are other tests'
// subjects (and the database's): none of them is read here.
vi.mock("$lib/server/services/instructions", () => ({
	resolveTurnInstructions: async () => null,
}));
vi.mock("./turn-time-zone", () => ({ resolveTurnTimeZone: async () => null }));
vi.mock("$lib/server/services/skills/prompt-context", () => ({
	listSkillCatalogueEntries: async () => [],
	buildSkillCatalogueBlock: () => null,
	SKILL_DRAFT_GUIDANCE: "",
}));
vi.mock("$lib/server/services/skills/user-skills", () => ({
	seedBuiltInSystemSkillDefinitions: async () => {},
}));
vi.mock("$lib/server/services/vision/describe", () => ({
	scheduleImageDescriptions: vi.fn(),
}));
vi.mock("./proactive-connector-context", () => ({
	buildProactiveConnectorContext: async () => null,
}));
vi.mock("../context-compression", () => ({
	getLatestValidContextCompressionSnapshot: async () => null,
	listContextCompressionSnapshots: async () => [],
	listContextCompressionSourceMessages: async () => [],
	runContextCompression: vi.fn(),
}));
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: vi.fn(async () => {
		throw new Error("no control model in this test");
	}),
}));
vi.mock("./context-selection", async (original) => ({
	...(await original<typeof import("./context-selection")>()),
	buildConstructedContext: mocks.buildContext,
}));
vi.mock("./shared-normal-chat-model-run-helpers", async (original) => ({
	...(await original<
		typeof import("./shared-normal-chat-model-run-helpers")
	>()),
	resolveProviderRuntime: (...args: unknown[]) => mocks.runtime(...args),
}));
vi.mock("../normal-chat-model", async (original) => ({
	...(await original<typeof import("../normal-chat-model")>()),
	prepareNormalChatCompletionRun: mocks.run,
}));

import { runNormalChatCompletion } from "../normal-chat-model/completion";
import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";
import { prepareOutboundContext } from "./shared-normal-chat-model-run-helpers";

const MESSAGE = "Carry on from where we left off.";
/** What a builder leaves unfilled so the turn's own clock line cannot tip a boundary. */
const SLACK_TOKENS = 16;

// Synthetic filler: one estimated token per word.
function words(count: number): string {
	return "word ".repeat(count).trim();
}

/** History whose estimated size (what the engine counts) is exactly `tokens`. */
function historyOf(tokens: number): ModelMessage[] {
	const turn = 1_000;
	const messages: ModelMessage[] = [];
	let left = tokens;
	while (left >= turn + 4 + 5) {
		messages.push({
			role: messages.length % 2 === 0 ? "user" : "assistant",
			content: words(turn),
		});
		left -= turn + 4;
	}
	if (left >= 5)
		messages.push({
			role: messages.length % 2 === 0 ? "user" : "assistant",
			content: words(left - 4),
		});
	return messages;
}

function constructed(history: ModelMessage[]) {
	return {
		inputValue: `## Current User Message\n${MESSAGE}`,
		historyMessages: history,
		historyWindow: { includedTurnCount: history.length, omittedTurnCount: 0 },
		contextStatus: undefined,
		taskState: null,
		contextDebug: null,
		contextTraceSections: [],
		turnImages: noTurnImages(),
		turnPictures: emptyTurnPictureIndex(),
		_reuseData: undefined,
	};
}

type Window = {
	capacity: number;
	/** MODEL_n_TARGET_CONSTRUCTED_CONTEXT; absent is the default ratio. */
	target?: number;
	/** MODEL_n_MAX_TOKENS; absent is the application reserve. */
	cap?: number;
};

async function fixture(window: Window) {
	const limits = deriveModelContextLimits({
		maxModelContext: window.capacity,
		targetConstructedContext: window.target,
	});
	const provider = createPlainNormalChatProvider({
		maxModelContext: window.capacity,
		maxOutputTokens: window.cap,
	});
	const config = createPlainNormalChatRuntimeConfig({
		requestTimeoutMs: 60_000,
	});
	const modelConfig = { ...config.model1, maxTokens: window.cap ?? null };
	mocks.runtime.mockResolvedValue({
		provider,
		modelId: "model1",
		depthEffort: null,
		modelConfig,
		baseContextLimits: limits,
	});

	// What the turn adds to the history the builder fills, measured on the real
	// preparation (the same call the turn makes, without the room): the system
	// prompt, and the message with its guidance.
	mocks.buildContext.mockResolvedValueOnce(constructed([]));
	const probeParams = createPlainNormalChatSendModelParams({
		message: MESSAGE,
		user: { id: "user-1" },
	});
	const probe = await prepareOutboundContext(
		probeParams,
		{ ...(await mocks.runtime(probeParams)), modelConfig },
		null,
		new Set(ALL_CONNECTORS),
		"probe",
		"native",
	);
	const sent: ModelMessage = {
		role: "user",
		content: `${probe.inputValue}\n\n${probe.turnGuidance}`,
	};
	const standing =
		estimateTokenCount(probe.systemPrompt) +
		estimateHistoryMessagesTokens([sent], estimateTokenCount);

	// What the builder was handed, and what it built.
	const handed: {
		limits?: ModelContextLimits;
		maxTokens?: number | null;
		built?: number;
		toolCount?: number;
	} = {};
	mocks.buildContext.mockImplementation(async (params) => {
		const target = params.contextLimits.targetConstructedContext;
		const history = historyOf(Math.max(0, target - standing - SLACK_TOKENS));
		handed.limits = params.contextLimits;
		handed.maxTokens = params.modelConfig?.maxTokens ?? null;
		handed.built =
			standing + estimateHistoryMessagesTokens(history, estimateTokenCount);
		return constructed(history);
	});

	const requests: Array<number | undefined> = [];
	const answer = (streaming: boolean) =>
		streaming
			? {
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
								finishReason: { unified: "stop", raw: "stop" },
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
				}
			: {
					content: [{ type: "text" as const, text: "Answer" }],
					finishReason: { unified: "stop" as const, raw: "stop" },
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 1, text: 1, reasoning: 0 },
					},
					warnings: [],
				};
	const model = new MockLanguageModelV3({
		doGenerate: async (call) => {
			requests.push(call.maxOutputTokens);
			return answer(false) as never;
		},
		doStream: async (call) => {
			requests.push(call.maxOutputTokens);
			return answer(true) as never;
		},
	});
	mocks.run.mockImplementation((params) => {
		handed.toolCount = params.tools ? Object.keys(params.tools).length : 0;
		const make = (streaming: boolean) =>
			runNormalChatCompletion(
				params,
				{
					model,
					maxModelContext: params.provider.maxModelContext,
					providerOptions: undefined,
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

	const reserve = deriveModelContextBudget({
		...limits,
		maxTokens: resolveCompletionMaxTokens({
			maxModelContext: window.capacity,
			maxTokens: window.cap,
		}),
	}).effectiveMaxTokens;
	return { limits, handed, requests, reserve, standing };
}

async function runTurn(
	mode: "plain" | "stream",
	overrides: Parameters<typeof createPlainNormalChatSendModelParams>[0] = {},
) {
	const run = await prepareNormalChatTurn(
		createPlainNormalChatSendModelParams({
			message: MESSAGE,
			user: { id: "user-1" },
			runtimeConfig: { requestTimeoutMs: 60_000 },
			...overrides,
		}),
	);
	if (mode === "plain") await run.runPlain();
	else
		for await (const _event of run.stream().stream) {
		}
	return { completion: run.receipt.getSnapshot()?.completion, run };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.buildContext.mockReset();
	mocks.admit.mockReturnValue({ status: "admitted" });
	mocks.record.mockResolvedValue(undefined);
});

describe("a context built up to its budget, with the real tool catalogue", () => {
	// The scenario first: 131,072 on the default ratios, which left no room for
	// the margin, let alone the catalogue.
	it.each([
		"plain",
		"stream",
	] as const)("goes out as one provider request on a 131,072 window on the default ratios (%s)", async (mode) => {
		const f = await fixture({ capacity: 131_072 });
		const { completion, run } = await runTurn(mode);

		expect(completion?.stopCause).not.toBe("context_capacity");
		expect(completion).toMatchObject({ outcome: "answered" });
		expect(f.requests).toHaveLength(1);

		// The premise: the builder filled the target it was handed (to within the
		// slack), the catalogue is the real one with every connector on, and the
		// default target was held back for it.
		const target = f.handed.limits?.targetConstructedContext ?? 0;
		expect(f.handed.built).toBeGreaterThan(target - SLACK_TOKENS * 2);
		expect(f.handed.built).toBeLessThanOrEqual(target);
		expect(f.handed.toolCount).toBeGreaterThanOrEqual(20);
		expect(f.limits.targetConstructedContext).toBe(117_964);
		expect(target).toBeLessThan(117_964);

		// What the page and the snapshot report is the number it was built to.
		const prepared = run.receipt.getSnapshot()?.original.provenance as {
			prepared: {
				contextLimits: ModelContextLimits;
				outputTokenBudget: { effectiveMaxTokens: number };
			};
		};
		expect(prepared.prepared.contextLimits).toEqual(f.handed.limits);
		expect(
			prepared.prepared.contextLimits.compactionUiThreshold,
		).toBeLessThanOrEqual(target);
		expect(prepared.prepared.outputTokenBudget.effectiveMaxTokens).toBe(
			f.reserve,
		);
		expect(f.requests).toEqual([f.reserve]);
	});

	it.each([
		{ name: "146,000 on the default ratios", window: { capacity: 146_000 } },
		{
			name: "262,144 with the built-in slot's explicit 235,929 target and no cap",
			window: { capacity: 262_144, target: 235_929 },
		},
		{
			name: "262,144 with a 24,576 cap on the default ratios",
			window: { capacity: 262_144, cap: 24_576 },
		},
		{
			name: "146,000 with an explicit 102,200 target (it already fits)",
			window: { capacity: 146_000, target: 102_200 },
		},
	])("goes out as one provider request on $name", async ({ window }) => {
		const f = await fixture(window);
		const { completion } = await runTurn("plain");

		expect(completion).toMatchObject({ outcome: "answered" });
		expect(f.requests).toHaveLength(1);
		const target = f.handed.limits?.targetConstructedContext ?? 0;
		expect(f.handed.built).toBeGreaterThan(target - SLACK_TOKENS * 2);
		// A configuration that already left the room is built to its own target.
		if (window.target === 102_200) expect(f.handed.limits).toEqual(f.limits);
	});

	it("goes out without tools, leaving the margin alone", async () => {
		const f = await fixture({ capacity: 131_072 });
		const { completion } = await runTurn("plain", { disableTools: true });

		expect(f.handed.toolCount).toBe(0);
		expect(f.handed.limits?.targetConstructedContext).toBe(
			131_072 - (f.reserve ?? 0) - CONTEXT_GUARD_MARGIN_TOKENS,
		);
		expect(completion).toMatchObject({ outcome: "answered" });
		expect(f.requests).toHaveLength(1);
	});

	it("is still refused before any provider request when the window cannot hold the catalogue", async () => {
		const f = await fixture({ capacity: 8_192 });
		const { completion } = await runTurn("plain");

		expect(f.handed.limits?.targetConstructedContext).toBe(1);
		expect(completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "context_capacity",
		});
		expect(f.requests).toHaveLength(0);
	});
});
