// Provider failover through the real completion engine and the real AI SDK,
// with fake providers behind `fetch`. Production runs with failover on
// (MODEL_TIMEOUT_FAILOVER_ENABLED, a 10 s first-output timeout, a provider model
// as the target), so each scenario is driven the way production meets it, on
// both transports where it can happen at all.
import { tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelId } from "$lib/model-types";
import { getConfig } from "$lib/server/config-store";
import type { NormalChatContinuationSnapshot } from "$lib/server/services/normal-chat-model";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";

const records = vi.hoisted(() => ({
	providers: new Map<string, unknown>(),
	models: new Map<string, Array<Record<string, unknown>>>(),
	// While set, the provider lookup waits: the moment a failover target is being resolved.
	gate: null as Promise<void> | null,
	waiting: 0,
	// While set, the fallback's stored key cannot be read.
	brokenKey: false,
}));
vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: async () => null,
	getProviderWithSecrets: async (id: string) => {
		if (records.gate) {
			records.waiting++;
			await records.gate;
		}
		return records.providers.get(id) ?? null;
	},
	decryptApiKey: () => {
		if (records.brokenKey)
			throw new Error("the stored key cannot be decrypted");
		return "synthetic";
	},
}));
vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: async (id: string) => records.models.get(id) ?? [],
	getProviderModel: async (id: string) =>
		[...records.models.values()].flat().find((m) => m.id === id) ?? null,
}));

import {
	runPlainNormalChatModelRun,
	runStreamingNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";

import {
	answerAfter,
	type Ctx,
	dyingWire,
	failWith,
	fakeNetwork,
	hang,
	httpFailure,
	messagesOf,
	modelRow,
	providerRecord,
	respond,
	TRANSPORTS,
	type Transport,
	timeoutError,
} from "$lib/server/services/normal-chat-model/failover.test-helpers";

const primary = {
	id: "p",
	name: "openai",
	displayName: "Primary",
	baseUrl: "https://completion.invalid/v1",
	modelName: "primary-model",
	apiKey: "synthetic",
	requestTimeoutMs: 300000,
	maxOutputTokens: 1000,
	maxModelContext: 32000,
};
const PRIMARY = "completion.invalid";
const FALLBACK = "fallback.invalid";
const SPECIFIC = "specific.invalid";
type Options = {
	/** Source model with a per-model fallback, then the global target: the chain's two hops. */
	chain?: boolean;
	failover?: boolean;
	fallbackWindow?: number;
	message?: string;
	refuseFallbackProjection?: boolean;
	/** What the primary's tool does instead of returning its evidence. */
	primaryTool?: () => Promise<unknown>;
};
function setup(transport: Transport, options: Options = {}) {
	const network = fakeNetwork(transport);
	const ran = { primary: 0, fallback: 0 };
	const output: NormalChatOutputEvent[] = [];
	let snapshot: NormalChatContinuationSnapshot | undefined;
	const abort = new AbortController();
	const hooks: {
		event?: (event: NormalChatOutputEvent) => void;
		snapshot?: (snapshot: NormalChatContinuationSnapshot) => void;
		attempt?: (providerId: string) => void | Promise<void>;
	} = {};
	records.providers.set("fb", providerRecord("fb", FALLBACK));
	records.models.set("fb", [
		modelRow("fbm", "fb", {
			name: "fallback-model",
			maxModelContext: options.fallbackWindow ?? 32000,
		}),
	]);
	if (options.chain) {
		records.providers.set("source", providerRecord("source", PRIMARY));
		records.providers.set("specific", providerRecord("specific", SPECIFIC));
		records.models.set("source", [
			modelRow("source-model", "source", {
				fallbackProviderModelId: "specific-model",
			}),
		]);
		records.models.set("specific", [modelRow("specific-model", "specific")]);
	}
	const source = options.chain
		? { ...primary, id: "source", modelName: "source-model" }
		: primary;
	const lookup = (
		side: "primary" | "fallback",
		result: unknown,
		run?: () => Promise<unknown>,
	) =>
		tool({
			inputSchema: z.object({}),
			execute: async () => {
				ran[side]++;
				return run ? run() : result;
			},
		});
	const config = getConfig();
	const args = {
		provider: source,
		modelId: (options.chain
			? "provider:source:source-model"
			: "model1") as ModelId,
		runtimeConfig: {
			...config,
			modelTimeoutFailoverEnabled: options.failover ?? true,
			modelTimeoutFailoverTargetModel: "provider:fb:fbm" as ModelId,
			modelTimeoutFailoverTimeoutMs: 10000,
		},
		messages: [
			{ role: "user" as const, content: options.message ?? "Find it" },
		],
		tools: {
			lookup: lookup(
				"primary",
				{ fact: "SETTLED-EVIDENCE" },
				options.primaryTool,
			),
		},
		abortSignal: abort.signal,
		fetch: network.fetch,
		completionPolicy: {
			turnId: "t",
			segmentId: "s",
			deadlineAt: Date.now() + 300000,
			totalTimeoutMs: 300000,
			onOutputEvent: (event: NormalChatOutputEvent) => {
				output.push(event);
				hooks.event?.(event);
			},
			onSnapshot: (next: NormalChatContinuationSnapshot) => {
				snapshot = next;
				hooks.snapshot?.(next);
			},
			forAttempt: async (context: {
				provider: { id: string };
				toolsAllowed: boolean;
			}) => {
				await hooks.attempt?.(context.provider.id);
				const base = { classifyExecution: () => "succeeded" as const };
				if (context.provider.id === source.id) return base;
				return {
					...base,
					tools: context.toolsAllowed
						? { lookup: lookup("fallback", { fact: "FALLBACK-EVIDENCE" }) }
						: undefined,
					projectContext: options.refuseFallbackProjection
						? () => null
						: ({
								system,
								messages,
							}: {
								system?: string;
								messages: Parameters<typeof JSON.stringify>[0];
							}) => ({ system, messages }),
				};
			},
		},
	};
	const run = async () => {
		if (transport === "plain")
			await runPlainNormalChatModelRun(
				args as unknown as Parameters<typeof runPlainNormalChatModelRun>[0],
			);
		else
			for await (const _event of runStreamingNormalChatModelRun(
				args as unknown as Parameters<typeof runStreamingNormalChatModelRun>[0],
			)) {
			}
	};
	return {
		network,
		ran,
		output,
		abort,
		hooks,
		run,
		get snapshot() {
			return snapshot;
		},
		get completion() {
			return output.findLast((event) => event.type === "completion")
				?.completion;
		},
		/** One row per attempt: who, in which phase, how it ended, and what it is charged. */
		get attempts() {
			return (snapshot?.usage ?? []).map((u) => ({
				provider: u.providerId,
				phase: u.phase,
				outcome: u.outcome,
				stop: u.safeStopCause,
				input: u.inputTokens,
				known: u.complete,
			}));
		},
		get answer() {
			return projectNormalChatOutput(output).answer;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	records.providers.clear();
	records.models.clear();
	records.gate = null;
	records.waiting = 0;
	records.brokenKey = false;
});

describe.each(
	TRANSPORTS,
)("provider failover before any tool ran (%s)", (transport) => {
	it("first output never arrives within the timeout: the fallback runs the turn with its own tools", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const h = setup(transport);
		h.network.script(PRIMARY, hang);
		h.network.script(
			FALLBACK,
			(c) => respond(c.transport, { call: "fb-1" }),
			(c) => respond(c.transport, { text: "fallback answer" }),
		);
		const done = h.run();
		await vi.waitFor(() => expect(h.network.to(PRIMARY)).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		await done;
		expect(h.network.to(PRIMARY)).toHaveLength(1);
		expect(h.network.to(FALLBACK)).toHaveLength(2);
		const first = h.network.to(FALLBACK)[0].body;
		expect(messagesOf(first)).toEqual([{ role: "user", content: "Find it" }]);
		expect(first.tools).toBeDefined();
		expect(h.ran).toEqual({ primary: 0, fallback: 1 });
		expect(h.network.to(FALLBACK)[1].text).toContain("FALLBACK-EVIDENCE");
		expect(h.completion).toMatchObject({
			phase: "working",
			outcome: "answered",
			stopCause: "natural_stop",
			closingAttempted: false,
		});
		expect(h.answer).toBe("fallback answer");
		expect(h.attempts).toEqual([
			{
				provider: "p",
				phase: "working",
				outcome: "failed",
				stop: "transport_error",
				input: null,
				known: false,
			},
			{
				provider: "fb",
				phase: "working",
				outcome: "answered",
				stop: "natural_stop",
				input: 20,
				known: true,
			},
		]);
	});

	it.each([
		503, 429,
	])("a provider error (%s) before any output moves the turn to the fallback", async (status) => {
		const h = setup(transport);
		h.network.script(PRIMARY, () => httpFailure(status));
		h.network.script(
			FALLBACK,
			(c) => respond(c.transport, { call: "fb-1" }),
			(c) => respond(c.transport, { text: "fallback answer" }),
		);
		await h.run();
		expect(h.network.to(PRIMARY)).toHaveLength(1);
		expect(h.network.to(FALLBACK)).toHaveLength(2);
		const first = h.network.to(FALLBACK)[0].body;
		expect(messagesOf(first)).toEqual([{ role: "user", content: "Find it" }]);
		expect(first.tools).toBeDefined();
		expect(h.ran).toEqual({ primary: 0, fallback: 1 });
		expect(h.completion).toMatchObject({
			outcome: "answered",
			stopCause: "natural_stop",
			closingAttempted: false,
		});
		expect(h.attempts.map((a) => [a.provider, a.outcome, a.stop])).toEqual([
			["p", "failed", "transport_error"],
			["fb", "answered", "natural_stop"],
		]);
		expect(h.attempts[0]).toMatchObject({ input: null, known: false });
	});

	it("an authentication failure is not failed over", async () => {
		const h = setup(transport);
		h.network.script(
			PRIMARY,
			() => httpFailure(401),
			() => httpFailure(401),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.completion).toMatchObject({ outcome: "failed" });
	});
});

describe("provider failover after partial output, before any tool ran (streaming)", () => {
	it("does not carry the failed attempt's partial text or reasoning to the fallback", async () => {
		const h = setup("streaming");
		const wire = dyingWire({
			reasoning: "REASONING-OF-PROVIDER-A",
			text: "PARTIAL-A",
		});
		h.hooks.event = (event) => {
			if (event.type === "block_delta" && event.text.includes("PARTIAL-A"))
				setTimeout(wire.die);
		};
		h.network.script(PRIMARY, () => wire.response);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "fallback answer" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(1);
		const request = h.network.to(FALLBACK)[0];
		expect(messagesOf(request.body)).toEqual([
			{ role: "user", content: "Find it" },
		]);
		expect(request.text).not.toContain("PARTIAL-A");
		expect(request.text).not.toContain("REASONING-OF-PROVIDER-A");
		expect(request.body.tools).toBeDefined();
		expect(h.answer).toBe("fallback answer");
		expect(h.attempts.map((a) => [a.provider, a.outcome])).toEqual([
			["p", "failed"],
			["fb", "answered"],
		]);
	});
});

describe.each(
	TRANSPORTS,
)("provider failover after a tool settled (%s)", (transport) => {
	it("closes once on the fallback with tools off, on the original request and the settled evidence", async () => {
		const h = setup(transport);
		h.network.script(
			PRIMARY,
			(c) => respond(c.transport, { text: "Looking it up.", call: "lookup-1" }),
			failWith(timeoutError),
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "Answer from settled evidence." }),
		);
		await h.run();
		expect(h.network.to(PRIMARY)).toHaveLength(2);
		expect(h.network.to(FALLBACK)).toHaveLength(1);
		expect(h.ran).toEqual({ primary: 1, fallback: 0 });
		const closing = h.network.to(FALLBACK)[0];
		expect(closing.body.tools).toBeUndefined();
		expect(closing.text).toContain("SETTLED-EVIDENCE");
		expect(closing.text).toContain("Looking it up.");
		const messages = messagesOf(closing.body);
		expect(messages[0]).toEqual({ role: "user", content: "Find it" });
		expect(messages.at(-1)).toMatchObject({ role: "user" });
		expect(JSON.stringify(messages.at(-1))).toContain("Tools are unavailable");
		const called = messages.flatMap(
			(m) => m.tool_calls?.map((c) => c.id) ?? [],
		);
		const answered = messages
			.filter((m) => m.role === "tool")
			.map((m) => m.tool_call_id);
		expect(called).toEqual(["lookup-1"]);
		expect(answered).toEqual(["lookup-1"]);
		expect(h.answer).toBe("Answer from settled evidence.");
		expect(h.completion).toMatchObject({
			phase: "closing",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "transport_error",
			closingAttempted: true,
		});
		expect(
			h.attempts.map((a) => [a.provider, a.phase, a.outcome, a.stop]),
		).toEqual([
			["p", "working", "failed", "transport_error"],
			["fb", "closing", "answered", "natural_stop"],
		]);
	});
});

describe("no failover while a tool is running or after an uncertain execution", () => {
	it("streaming: the wire dies while the tool is still running; no fallback, no second run", async () => {
		let release: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = setup("streaming", {
			primaryTool: async () => {
				await running;
				return { fact: "LATE" };
			},
		});
		const wire = dyingWire({ call: "lookup-1" });
		h.hooks.snapshot = (next) => {
			if (
				next.executions.some(
					(e) => e.callId === "lookup-1" && e.state === "dispatched",
				)
			)
				setTimeout(wire.die);
		};
		h.network.script(PRIMARY, () => wire.response);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		release();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.network.to(PRIMARY)).toHaveLength(1);
		expect(h.ran).toEqual({ primary: 1, fallback: 0 });
		expect(h.completion).toMatchObject({ stopCause: "uncertain_execution" });
	});

	it.each(
		TRANSPORTS,
	)("an execution that ended uncertain stops the turn: no fallback, no second run (%s)", async (transport) => {
		const h = setup(transport, {
			primaryTool: async () => {
				throw new Error("the tool failed after it was dispatched");
			},
		});
		h.network.script(
			PRIMARY,
			(c) => respond(c.transport, { call: "lookup-1" }),
			failWith(timeoutError),
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.ran).toEqual({ primary: 1, fallback: 0 });
		expect(h.completion).toMatchObject({ stopCause: "uncertain_execution" });
	});
});

describe.each(TRANSPORTS)("the fallback fails too (%s)", (transport) => {
	it("before any tool ran: an explicit failure, bounded, on the configured providers only", async () => {
		const h = setup(transport);
		h.network.script(
			PRIMARY,
			() => httpFailure(503),
			() => httpFailure(503),
			() => httpFailure(503),
		);
		h.network.script(
			FALLBACK,
			() => httpFailure(503),
			() => httpFailure(503),
			() => httpFailure(503),
		);
		h.network.script("third.invalid", () => httpFailure(503));
		await h.run();
		expect([...new Set(h.network.calls.map((c) => c.host))].sort()).toEqual(
			[FALLBACK, PRIMARY].sort(),
		);
		expect(h.network.to(PRIMARY)).toHaveLength(1);
		expect(h.network.to(FALLBACK).length).toBeLessThanOrEqual(2);
		expect(h.network.calls.length).toBeLessThanOrEqual(3);
		expect(h.completion).toMatchObject({
			outcome: "failed",
			stopCause: "transport_error",
		});
		expect(h.answer).toBe("");
	});

	it("after a tool settled: one closing on the fallback, then an explicit failure; the tool does not run again", async () => {
		const h = setup(transport);
		h.network.script(
			PRIMARY,
			(c) => respond(c.transport, { call: "lookup-1" }),
			() => httpFailure(503),
			() => httpFailure(503),
		);
		h.network.script(
			FALLBACK,
			() => httpFailure(503),
			() => httpFailure(503),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(1);
		expect(h.network.calls).toHaveLength(3);
		expect(h.ran).toEqual({ primary: 1, fallback: 0 });
		expect(h.completion).toMatchObject({
			phase: "closing",
			outcome: "failed",
			stopCause: "transport_error",
			closingAttempted: true,
		});
	});

	it("down a two-hop chain of silent providers: the middle one is cut so the chain goes on, the last one is not", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const h = setup(transport, { chain: true });
		h.network.script(PRIMARY, hang);
		h.network.script(SPECIFIC, hang);
		h.network.script(
			FALLBACK,
			answerAfter(25_000, { text: "last provider answer" }),
		);
		const done = h.run();
		await vi.waitFor(() => expect(h.network.to(PRIMARY)).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.waitFor(() => expect(h.network.to(SPECIFIC)).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.waitFor(() => expect(h.network.to(FALLBACK)).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(30_000);
		await done;
		expect(h.network.calls.map((c) => c.host)).toEqual([
			PRIMARY,
			SPECIFIC,
			FALLBACK,
		]);
		expect(h.answer).toBe("last provider answer");
	});

	it("down a two-hop chain: each configured provider is asked in turn, and no other", async () => {
		const h = setup(transport, { chain: true });
		const fail = () => httpFailure(503);
		h.network.script(PRIMARY, fail, fail, fail);
		h.network.script(SPECIFIC, fail, fail, fail);
		h.network.script(FALLBACK, fail, fail, fail);
		await h.run();
		expect(h.network.to(PRIMARY)).toHaveLength(1);
		expect(h.network.to(SPECIFIC)).toHaveLength(1);
		expect(h.network.to(FALLBACK).length).toBeLessThanOrEqual(2);
		expect(h.network.calls.length).toBeLessThanOrEqual(4);
		expect(h.completion).toMatchObject({
			outcome: "failed",
			stopCause: "transport_error",
		});
	});
});

describe.each(
	TRANSPORTS,
)("Stop pressed during a failover (%s)", (transport) => {
	it.each([
		false,
		true,
	])("while the fallback is being resolved: no request goes to it (after a tool: %s)", async (afterTool) => {
		const h = setup(transport);
		let release: () => void = () => {};
		h.network.script(
			PRIMARY,
			...(afterTool
				? [(c: Ctx) => respond(c.transport, { call: "lookup-1" })]
				: []),
			() => {
				records.gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				return httpFailure(503);
			},
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		const done = h.run();
		await vi.waitFor(() => expect(records.waiting).toBeGreaterThan(0));
		h.abort.abort();
		release();
		await done;
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.completion).toMatchObject({
			outcome: "stopped",
			stopCause: "user_stop",
		});
	});

	it("while the fallback attempt is being prepared: nothing is sent to it", async () => {
		const h = setup(transport);
		h.hooks.attempt = (providerId) => {
			if (providerId === "fb") h.abort.abort();
		};
		h.network.script(PRIMARY, () => httpFailure(503));
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.completion).toMatchObject({
			outcome: "stopped",
			stopCause: "user_stop",
		});
	});

	it("while the fallback request is in flight: it is cut, and nothing else is sent", async () => {
		const h = setup(transport);
		h.network.script(PRIMARY, () => httpFailure(503));
		h.network.script(FALLBACK, (c) => {
			h.abort.abort();
			return hang(c);
		});
		await h.run();
		expect(h.network.calls).toHaveLength(2);
		expect(h.completion).toMatchObject({
			outcome: "stopped",
			stopCause: "user_stop",
		});
	});
});

describe.each(
	TRANSPORTS,
)("failover switched off in the configuration (%s)", (transport) => {
	it("a provider error before any output asks no fallback", async () => {
		const h = setup(transport, { failover: false });
		h.network.script(
			PRIMARY,
			() => httpFailure(503),
			() => httpFailure(503),
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.completion).toMatchObject({ outcome: "failed" });
	});

	it("a failure after a tool settled asks no fallback", async () => {
		const h = setup(transport, { failover: false });
		h.network.script(
			PRIMARY,
			(c) => respond(c.transport, { call: "lookup-1" }),
			() => httpFailure(503),
			(c) => respond(c.transport, { text: "closing on the same provider" }),
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.ran).toEqual({ primary: 1, fallback: 0 });
	});

	it("a request that hangs is not cut at the failover timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const h = setup(transport, { failover: false });
		let seen: AbortSignal | undefined;
		h.network.script(PRIMARY, (c) => {
			seen = c.signal;
			return hang(c);
		});
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		const done = h.run();
		await vi.waitFor(() => expect(h.network.to(PRIMARY)).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(seen?.aborted).toBe(false);
		h.abort.abort();
		await done;
		expect(h.network.to(FALLBACK)).toHaveLength(0);
	});
});

describe.each(
	TRANSPORTS,
)("the fallback cannot take the context (%s)", (transport) => {
	const afterToolOrNot = [
		["before any tool ran", false],
		["after a tool settled", true],
	] as const;

	it.each(
		afterToolOrNot,
	)("its window is too small (%s): an explicit refusal, nothing sent, nothing cut", async (_label, afterTool) => {
		const message = `${"word ".repeat(1500)}end`;
		const h = setup(transport, { fallbackWindow: 6100, message });
		h.network.script(
			PRIMARY,
			...(afterTool
				? [(c: Ctx) => respond(c.transport, { call: "lookup-1" })]
				: []),
			() => httpFailure(503),
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "context_capacity",
		});
		expect(h.snapshot?.original.messages).toEqual([
			{ role: "user", content: message },
		]);
		if (afterTool)
			expect(JSON.stringify(h.snapshot?.steps)).toContain("SETTLED-EVIDENCE");
	});

	it.each(
		afterToolOrNot,
	)("its projection refuses the context (%s): an explicit refusal, nothing sent", async (_label, afterTool) => {
		const h = setup(transport, { refuseFallbackProjection: true });
		h.network.script(
			PRIMARY,
			...(afterTool
				? [(c: Ctx) => respond(c.transport, { call: "lookup-1" })]
				: []),
			() => httpFailure(503),
		);
		h.network.script(FALLBACK, (c) =>
			respond(c.transport, { text: "must not be asked" }),
		);
		await h.run();
		expect(h.network.to(FALLBACK)).toHaveLength(0);
		expect(h.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "incompatible_continuation",
		});
	});
});
