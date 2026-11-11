import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type NormalChatContinuationSnapshot,
	type NormalChatExecution,
	runNormalChatCompletion,
} from "$lib/server/services/normal-chat-model/completion";
import { buildCompletionTools } from "$lib/server/services/normal-chat-model/completion-tools";
import { sanitizeNormalChatAnswer } from "$lib/shared/normal-chat-output";

const provider = {
	id: "native",
	name: "native",
	displayName: "Native",
	baseUrl: "https://native.invalid",
	modelName: "native",
	apiKey: "synthetic",
	maxOutputTokens: 1000,
	maxModelContext: 32000,
};
const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
afterEach(() => vi.useRealTimers());
it.each([
	"working",
	"first-output",
])("actively aborts the stalled provider at the %s timer", async (mode) => {
	vi.useFakeTimers();
	let calls = 0;
	let aborted = false;
	const parent = new AbortController();
	const model = new MockLanguageModelV3({
		doStream: async ({ abortSignal }) => {
			calls++;
			return {
				stream: new ReadableStream<LanguageModelV3StreamPart>({
					start(controller) {
						if (calls > 1) {
							controller.enqueue({ type: "text-start", id: "b" });
							controller.enqueue({
								type: "text-delta",
								id: "b",
								delta: "Closed",
							});
							controller.enqueue({ type: "text-end", id: "b" });
							controller.enqueue({
								type: "finish",
								usage,
								finishReason: { unified: "stop", raw: "stop" },
							});
							controller.close();
							return;
						}
						if (mode === "working") {
							controller.enqueue({ type: "text-start", id: "b" });
							controller.enqueue({
								type: "text-delta",
								id: "b",
								delta: "Partial",
							});
						}
						abortSignal?.addEventListener(
							"abort",
							() => {
								aborted = true;
								controller.error(abortSignal.reason);
							},
							{ once: true },
						);
					},
				}),
			};
		},
	});
	let terminalSnapshot: NormalChatContinuationSnapshot | undefined;
	const run = runNormalChatCompletion(
		{
			provider,
			abortSignal: parent.signal,
			messages: [{ role: "user", content: "test" }],
			completionPolicy: {
				onSnapshot: (snapshot) => {
					terminalSnapshot = structuredClone(snapshot);
				},
				turnId: "t",
				segmentId: "s",
				deadlineAt: Date.now() + 1000,
				totalTimeoutMs: 1000,
				forAttempt: () => ({}),
			},
		},
		{
			model,
			maxModelContext: 32000,
			providerOptions: undefined,
			stopWhen: undefined,
			firstOutputTimeoutMs: async () => (mode === "first-output" ? 50 : null),
			mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
			metadata: (responseModelName) => ({
				modelId: "native",
				providerId: "native",
				providerName: "native",
				displayName: "Native",
				requestedModelName: "native",
				responseModelName,
			}),
		},
		true,
	);
	const result = (async () => {
		for (;;) {
			const next = await run.next();
			if (next.done) return next.value;
		}
	})();
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(1);
		const boundary = mode === "working" ? 750 : 50;
		await vi.advanceTimersByTimeAsync(boundary - 1);
		expect(aborted).toBe(false);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(aborted).toBe(true);
		expect(calls).toBe(2);
		expect((await result).completion).toMatchObject({
			outcome: "answered",
			closingAttempted: mode === "working",
		});
		expect(
			terminalSnapshot?.usage.map((attempt) => ({
				outcome: attempt.outcome,
				safeStopCause: attempt.safeStopCause,
			})),
		).toEqual([
			{
				outcome: mode === "working" ? "incomplete" : "failed",
				safeStopCause: mode === "working" ? "deadline" : "transport_error",
			},
			{ outcome: "answered", safeStopCause: "natural_stop" },
		]);
	} finally {
		parent.abort();
		await result;
	}
});
it.each([
	"dispatched",
	"uncertain",
] as const)("refuses a tool while another step remains %s", async (state) => {
	const entry: NormalChatExecution = {
		executionId: "current",
		turnId: "t",
		segmentId: "s",
		attemptId: "a",
		stepId: "new",
		callId: "new",
		toolName: "lookup",
		input: {},
		state: "proposed",
	};
	const prior: NormalChatExecution = {
		...entry,
		executionId: "prior",
		stepId: "old",
		callId: "prior",
		state,
	};
	const snapshot: NormalChatContinuationSnapshot = {
		version: 1,
		fidelity: "exact",
		turnId: "t",
		segmentId: "s",
		original: {
			providerId: "native",
			providerBaseUrl: "https://native.invalid",
			modelName: "native",
			messages: [],
		},
		steps: [],
		prepared: { maxOutputTokens: 1000 },
		pendingImageEntries: [],
		executions: [prior, entry],
		events: [],
		usage: [],
		sequence: 0,
		nextAttempt: 1,
		workingSteps: 0,
		closingSegments: [],
		deadlineAt: Date.now() + 1000,
		totalTimeoutMs: 1000,
	};
	const execute = vi.fn(async () => "should not run");
	const tools = buildCompletionTools({
		phase: "working",
		policy: { classifyExecution: () => "succeeded" },
		snapshot,
		params: { tools: { lookup: tool({ inputSchema: z.object({}), execute }) } },
		resumed: false,
		priorExecutions: [],
		workingDeadlineAt: Date.now() + 1000,
		stopped: () => false,
		ledger: () => entry,
		recordCall: () => {},
		responseResult: () => {},
		notify: () => {},
		clearFirstOutputTimeout: () => {},
		executionsForStep: () => [entry],
		failure: (cause) => new Error(cause),
	});
	await expect(
		tools?.lookup.execute?.({}, { toolCallId: "new", messages: [] }),
	).rejects.toThrow("uncertain_execution");
	expect(execute).not.toHaveBeenCalled();
	expect(entry.state).toBe("definitely_not_executed");
	expect(prior.state).toBe(state);
});
it("blanks explicit leading tool syntax rather than promoting it as answer", () => {
	expect(
		sanitizeNormalChatAnswer(
			'<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="lookup">',
		),
	).toBe("");
	expect(
		sanitizeNormalChatAnswer('```json\n{"language":"hu","text":"Szia"}\n```'),
	).toBe('```json\n{"language":"hu","text":"Szia"}\n```');
});
