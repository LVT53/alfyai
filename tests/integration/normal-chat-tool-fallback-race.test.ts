// Review A: does a transport error racing a just-parsed tool call let a pre-work
// fallback run while the failed attempt's tool still executes?
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runNormalChatCompletion } from "$lib/server/services/normal-chat-model/completion";

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
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
function deps(model: MockLanguageModelV3) {
	return {
		model,
		maxModelContext: 32000,
		providerOptions: undefined,
		stopWhen: undefined,
		metadata: (responseModelName: string) => ({
			modelId: "native",
			providerId: "native",
			providerName: "native",
			displayName: "Native",
			requestedModelName: "native",
			responseModelName,
		}),
		mapUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
	};
}
const delays = [
	["sync", (f: () => void) => f()],
	["microtask", (f: () => void) => queueMicrotask(f)],
	["2 microtasks", (f: () => void) => queueMicrotask(() => queueMicrotask(f))],
	[
		"5 microtasks",
		(f: () => void) => {
			let n = 0;
			const hop = () => (++n >= 5 ? f() : queueMicrotask(hop));
			queueMicrotask(hop);
		},
	],
	["setTimeout0", (f: () => void) => setTimeout(f, 0)],
	...Array.from(
		{ length: 40 },
		(_, i) =>
			[
				`${i + 6} microtasks`,
				(f: () => void) => {
					let n = 0;
					const hop = () => (++n >= i + 6 ? f() : queueMicrotask(hop));
					queueMicrotask(hop);
				},
			] as const,
	),
] as const;
describe("review A: tool-call / transport-error race", () => {
	it.each(
		delays,
	)("never runs a pre-work fallback while the failed attempt's tool executes (%s)", async (_name, later) => {
		let streams = 0;
		let executions = 0;
		let fallbackCalls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				const n = streams++;
				if (n > 0)
					return {
						stream: new ReadableStream<LanguageModelV3StreamPart>({
							start(c) {
								c.enqueue({ type: "text-start", id: "t" });
								c.enqueue({
									type: "text-delta",
									id: "t",
									delta: "fallback answer",
								});
								c.enqueue({ type: "text-end", id: "t" });
								c.enqueue({
									type: "finish",
									usage,
									finishReason: { unified: "stop", raw: "stop" },
								});
								c.close();
							},
						}),
					};
				return {
					stream: new ReadableStream<LanguageModelV3StreamPart>({
						start(c) {
							c.enqueue({
								type: "tool-call",
								toolCallId: "side-effect",
								toolName: "send_email",
								input: "{}",
							});
							later(() =>
								c.error(
									Object.assign(new Error("request timed out"), {
										name: "TimeoutError",
									}),
								),
							);
						},
					}),
				};
			},
		});
		const run = runNormalChatCompletion(
			{
				provider,
				messages: [{ role: "user", content: "send it" }],
				tools: {
					send_email: tool({
						inputSchema: z.object({}),
						execute: async () => {
							executions++;
							await new Promise((r) => setTimeout(r, 20));
							return { sent: true };
						},
					}),
				},
				completionPolicy: {
					turnId: "t",
					segmentId: "s",
					deadlineAt: Date.now() + 300000,
					totalTimeoutMs: 300000,
					forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
				},
			},
			{
				...deps(model),
				fallback: async () => {
					fallbackCalls++;
					return {
						provider,
						modelId: "model2" as const,
						dependencies: deps(model),
					};
				},
			},
			true,
		);
		let result: Awaited<ReturnType<typeof run.next>>["value"];
		for (;;) {
			const next = await run.next();
			if (next.done) {
				result = next.value;
				break;
			}
		}
		await new Promise((r) => setTimeout(r, 50));
		process.stderr.write(
			`REVIEW-A race ${_name} ` +
				JSON.stringify({
					streams,
					executions,
					fallbackCalls,
					completion: result.completion,
					states: result.continuation?.executions.map((e) => [
						e.attemptId,
						e.state,
					]),
				}) +
				"\n",
		);
		// If the tool ran, no fallback attempt may have started beside it.
		if (executions > 0) expect(fallbackCalls).toBe(0);
	});
});
