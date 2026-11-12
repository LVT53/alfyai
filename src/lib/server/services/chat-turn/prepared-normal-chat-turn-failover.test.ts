// Provider failover through the real prepared-turn owner, the real completion
// engine and the real AI SDK, with fake providers behind `fetch`: what the
// owner binds to the fallback (its own tool set, its own context projection),
// what the ledger records for each attempt, and how Stop and refusals end a
// failover. The engine's own failover contract is in
// tests/integration/normal-chat-completion-failover.test.ts.
import { type ModelMessage, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolCallEntry } from "../messages-types";
import {
	failWith,
	fakeNetwork,
	hang,
	httpFailure,
	modelRow,
	providerRecord,
	respond,
	TRANSPORTS,
	type Transport,
	timeoutError,
} from "../normal-chat-model/failover.test-helpers";
import {
	createPlainNormalChatPreparedContext,
	createPlainNormalChatProvider,
	createPlainNormalChatSendModelParams,
} from "./plain-normal-chat-model-run.test-helpers";

const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	runtime: vi.fn(),
	tools: vi.fn(),
	admit: vi.fn(),
	record: vi.fn(),
	settle: vi.fn(),
	keepLocal: vi.fn(),
}));
const records = vi.hoisted(() => ({
	providers: new Map<string, unknown>(),
	models: new Map<string, Array<Record<string, unknown>>>(),
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
vi.mock("../providers", () => ({
	getProviderByName: async () => null,
	getProviderWithSecrets: async (id: string) =>
		records.providers.get(id) ?? null,
	decryptApiKey: () => "synthetic",
}));
vi.mock("../provider-models", () => ({
	listEnabledProviderModels: async (id: string) => records.models.get(id) ?? [],
	getProviderModel: async (id: string) =>
		[...records.models.values()].flat().find((m) => m.id === id) ?? null,
}));

import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";

const PRIMARY = "completion.invalid";
const LOCAL_PRIMARY = "10.0.0.5:8000";
const FALLBACK = "fallback.invalid";
const FALLBACK_MODEL = "provider:fb:fbm";
// A tool-call/result pair the app's own prefetch put before the model: the
// destination decides how it is written (native messages, or one evidence note).
const PREFETCH: ModelMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "prefetch-1",
				toolName: "fetch_url",
				input: { url: "https://example.invalid/page" },
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
				output: { type: "text", value: "PREFETCHED-PAGE" },
			},
		],
	},
];
const WINDOW = {
	maxModelContext: 32000,
	compactionUiThreshold: 25600,
	targetConstructedContext: 28800,
};

type Options = {
	/** The fallback is a different family from the primary (DeepSeek writes the prefetch as one note). */
	deepseekFallback?: boolean;
	prefetch?: boolean;
	/** The primary runs on the person's own box and the person keeps connector data local. */
	localPrimaryKeptLocal?: boolean;
	fallbackWindow?: number;
	message?: string;
	failover?: boolean;
};

function setup(transport: Transport, options: Options = {}) {
	const network = fakeNetwork(transport);
	const ran = { primary: 0, fallback: 0 };
	const packsBuiltFor: string[] = [];
	const abort = new AbortController();
	records.providers.set("fb", {
		...providerRecord("fb", FALLBACK),
		...(options.deepseekFallback ? { name: "deepseek" } : {}),
	});
	records.models.set("fb", [
		modelRow("fbm", "fb", {
			name: options.deepseekFallback ? "deepseek-v4-flash" : "fallback-model",
			maxModelContext: options.fallbackWindow ?? 32000,
		}),
	]);
	const primaryProvider = createPlainNormalChatProvider({
		id: "model1",
		name: "model1",
		baseUrl: options.localPrimaryKeptLocal
			? `http://${LOCAL_PRIMARY}/v1`
			: `https://${PRIMARY}/v1`,
		modelName: "primary-model",
		maxModelContext: 32000,
		maxOutputTokens: 1000,
	});
	mocks.keepLocal.mockResolvedValue(options.localPrimaryKeptLocal === true);
	mocks.runtime.mockImplementation(async (params) => ({
		provider: primaryProvider,
		modelId: "model1",
		modelConfig: { ...params.runtimeConfig.model1, maxTokens: 1000 },
		baseContextLimits: WINDOW,
		depthEffort: null,
	}));
	mocks.prepare.mockResolvedValue(
		createPlainNormalChatPreparedContext({
			inputValue: options.message ?? "Find it",
			systemPrompt: "SYSTEM-PROMPT",
			turnGuidance: "",
			contextLimits: WINDOW,
			...(options.prefetch ? { prefetchedToolMessages: PREFETCH } : {}),
		}),
	);
	mocks.tools.mockImplementation(
		async (
			_params: unknown,
			_turnId: unknown,
			_effort: unknown,
			modelId: string,
		) => {
			packsBuiltFor.push(modelId);
			const side = modelId === "model1" ? "primary" : "fallback";
			const rows: ToolCallEntry[] = [];
			const name = side === "primary" ? "lookup" : "fallback_lookup";
			return {
				stepImages: { drain: () => [] },
				getToolCalls: () => rows,
				getTurnAsk: () => null,
				tools: {
					[name]: tool({
						inputSchema: z.object({}),
						execute: async (_input, execution) => {
							ran[side]++;
							rows.push({
								name,
								callId: execution.toolCallId,
								input: {},
								status: "done",
								metadata: { ok: true },
							});
							return { fact: "SETTLED-EVIDENCE" };
						},
					}),
				},
			};
		},
	);
	vi.stubGlobal("fetch", network.fetch);
	const params = createPlainNormalChatSendModelParams({
		signal: abort.signal,
		runtimeConfig: {
			requestTimeoutMs: 600000,
			model1MaxModelContext: 32000,
			modelTimeoutFailoverEnabled: options.failover ?? true,
			modelTimeoutFailoverTargetModel: FALLBACK_MODEL as never,
			modelTimeoutFailoverTimeoutMs: 10000,
		},
	});
	const run = async () => {
		const turn = await prepareNormalChatTurn(params);
		if (transport === "plain") await turn.runPlain();
		else
			for await (const _event of turn.stream().stream) {
			}
		return turn;
	};
	return {
		network,
		ran,
		packsBuiltFor,
		abort,
		run,
		/** One row per attempt the ledger was told about, as it ended. */
		get ledger() {
			const last = new Map<string, Record<string, unknown>>();
			for (const [, attempt] of mocks.record.mock.calls)
				last.set(attempt.attemptId, attempt);
			return [...last.values()].map((a) => ({
				provider: a.providerId,
				model: a.modelId,
				phase: a.phase,
				outcome: a.outcome,
				stop: a.safeStopCause,
				input: a.inputTokens,
				final: a.usageFinal,
			}));
		},
	};
}

const toolNames = (body: Record<string, unknown>) =>
	((body.tools as Array<{ function: { name: string } }> | undefined) ?? []).map(
		(t) => t.function.name,
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.admit.mockReturnValue({ status: "admitted" });
	mocks.record.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	records.providers.clear();
	records.models.clear();
});

describe.each(
	TRANSPORTS,
)("failover through the prepared turn (%s)", (transport) => {
	it("first output never arrives: the fallback gets its own tool set and its own projection, and the ledger holds one working attempt per provider", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const t = setup(transport, { deepseekFallback: true, prefetch: true });
		t.network.script(PRIMARY, hang);
		t.network.script(
			FALLBACK,
			(c) =>
				respond(c.transport, { call: { id: "fb-1", name: "fallback_lookup" } }),
			(c) => respond(c.transport, { text: "fallback answer" }),
		);
		const done = t.run();
		await vi.waitFor(() => expect(t.network.to(PRIMARY)).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		const turn = await done;
		expect(t.network.to(PRIMARY)).toHaveLength(1);
		expect(t.network.to(FALLBACK)).toHaveLength(2);
		// Its own tool set, built for the model it runs on.
		expect(t.packsBuiltFor).toEqual(["model1", FALLBACK_MODEL]);
		expect(toolNames(t.network.to(PRIMARY)[0].body)).toEqual(["lookup"]);
		expect(toolNames(t.network.to(FALLBACK)[0].body)).toEqual([
			"fallback_lookup",
		]);
		expect(t.ran).toEqual({ primary: 0, fallback: 1 });
		// Its own projection of the prefetch: native messages for the primary, one note for DeepSeek.
		const first = JSON.stringify(t.network.to(PRIMARY)[0].body.messages);
		const second = JSON.stringify(t.network.to(FALLBACK)[0].body.messages);
		expect(first).toContain('"tool_calls"');
		expect(first).toContain("PREFETCHED-PAGE");
		expect(second).not.toContain('"tool_calls"');
		expect(second).toContain("Server-prefetched page evidence");
		expect(second).toContain("PREFETCHED-PAGE");
		expect(turn.receipt.getSnapshot()?.completion).toMatchObject({
			phase: "working",
			outcome: "answered",
			stopCause: "natural_stop",
			closingAttempted: false,
		});
		expect(t.ledger).toEqual([
			{
				provider: "model1",
				model: "model1",
				phase: "working",
				outcome: "failed",
				stop: "transport_error",
				input: null,
				final: false,
			},
			{
				provider: "fb",
				model: FALLBACK_MODEL,
				phase: "working",
				outcome: "answered",
				stop: "natural_stop",
				input: 20,
				final: true,
			},
		]);
	});

	it("a provider error after a tool settled: one closing on the fallback with no tool set, the settled evidence in its own projection", async () => {
		const t = setup(transport, { deepseekFallback: true, prefetch: true });
		t.network.script(
			PRIMARY,
			(c) => respond(c.transport, { call: "lookup-1" }),
			failWith(timeoutError),
		);
		t.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "closing answer" }),
		);
		const turn = await t.run();
		expect(t.packsBuiltFor).toEqual(["model1"]);
		expect(t.network.to(FALLBACK)).toHaveLength(1);
		const closing = t.network.to(FALLBACK)[0];
		expect(closing.body.tools).toBeUndefined();
		expect(closing.text).toContain("SETTLED-EVIDENCE");
		expect(closing.text).toContain("Server-prefetched page evidence");
		expect(t.ran).toEqual({ primary: 1, fallback: 0 });
		expect(turn.receipt.getSnapshot()?.completion).toMatchObject({
			phase: "closing",
			outcome: "answered",
			workingStopCause: "transport_error",
			closingAttempted: true,
		});
		expect(
			t.ledger.map((a) => [a.provider, a.phase, a.outcome, a.stop]),
		).toEqual([
			["model1", "working", "failed", "transport_error"],
			["fb", "closing", "answered", "natural_stop"],
		]);
	});

	it("the fallback fails too: the turn is settled as an explicit failure after a bounded number of attempts", async () => {
		const t = setup(transport);
		t.network.script(PRIMARY, () => httpFailure(503));
		t.network.script(
			FALLBACK,
			() => httpFailure(503),
			() => httpFailure(503),
			() => httpFailure(503),
		);
		const turn = await t.run();
		expect(t.network.calls.length).toBeLessThanOrEqual(3);
		expect(turn.receipt.getSnapshot()?.completion).toMatchObject({
			outcome: "failed",
			stopCause: "transport_error",
		});
		expect(mocks.settle).toHaveBeenCalledTimes(1);
		expect(mocks.settle.mock.calls[0][1]).toMatchObject({
			outcome: "failed",
			stopCause: "transport_error",
		});
		expect(t.ledger.every((a) => a.outcome === "failed")).toBe(true);
	});

	it("failover switched off: a provider error asks no fallback", async () => {
		const t = setup(transport, { failover: false });
		t.network.script(
			PRIMARY,
			() => httpFailure(503),
			() => httpFailure(503),
		);
		t.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await t.run();
		expect(t.network.to(FALLBACK)).toHaveLength(0);
	});
});

describe.each(
	TRANSPORTS,
)("the owner refuses a fallback that cannot take the context (%s)", (transport) => {
	const when = [
		["before any tool ran", false],
		["after a tool settled", true],
	] as const;

	it.each(
		when,
	)("a cloud fallback for a local run whose connector data stays local (%s): an explicit refusal, nothing sent", async (_label, afterTool) => {
		const t = setup(transport, { localPrimaryKeptLocal: true });
		t.network.script(
			LOCAL_PRIMARY,
			...(afterTool
				? [
						(c: { transport: Transport }) =>
							respond(c.transport, { call: "lookup-1" }),
					]
				: []),
			() => httpFailure(503),
		);
		t.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		const turn = await t.run();
		expect(t.network.to(FALLBACK)).toHaveLength(0);
		expect(turn.receipt.getSnapshot()?.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "incompatible_continuation",
		});
	});

	it.each(
		when,
	)("a window too small for the context (%s): an explicit refusal, nothing sent, nothing cut", async (_label, afterTool) => {
		const message = `${"word ".repeat(1500)}end`;
		const t = setup(transport, { fallbackWindow: 6100, message });
		t.network.script(
			PRIMARY,
			...(afterTool
				? [
						(c: { transport: Transport }) =>
							respond(c.transport, { call: "lookup-1" }),
					]
				: []),
			() => httpFailure(503),
		);
		t.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		const turn = await t.run();
		expect(t.network.to(FALLBACK)).toHaveLength(0);
		const snapshot = turn.receipt.getSnapshot();
		expect(snapshot?.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "context_capacity",
		});
		expect(JSON.stringify(snapshot?.original.messages)).toContain(message);
	});
});
