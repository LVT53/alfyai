import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PlainNormalChatModelRunResult } from "$lib/server/services/normal-chat-model";
import {
	type NormalChatContinuationSnapshot,
	runNormalChatCompletion,
} from "$lib/server/services/normal-chat-model/completion";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function stream(parts: LanguageModelV3StreamPart[]) {
	return new ReadableStream<LanguageModelV3StreamPart>({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}
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
function dependencies(model: MockLanguageModelV3) {
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
describe("installed SDK native shapes", () => {
	function textParts(text: string): LanguageModelV3StreamPart[] {
		return [
			{ type: "text-start", id: "b" },
			{ type: "text-delta", id: "b", delta: text },
			{ type: "text-end", id: "b" },
		];
	}
	function finish(
		reason: "stop" | "length" | "tool-calls" = "stop",
	): LanguageModelV3StreamPart {
		return {
			type: "finish",
			usage,
			finishReason: { unified: reason, raw: reason },
		};
	}
	function params() {
		return {
			provider,
			messages: [{ role: "user" as const, content: "synthetic request" }],
			completionPolicy: {
				turnId: "t",
				segmentId: "s",
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
				forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
			},
		};
	}
	it("binds a buffered tool result to its source step while the consumer waits for the next SDK step", async () => {
		let calls = 0;
		let executions = 0;
		let nextStepPrepared!: () => void;
		const prepared = new Promise<void>((resolve) => {
			nextStepPrepared = resolve;
		});
		const model = new MockLanguageModelV3({
			doStream: async () => {
				if (++calls > 1) nextStepPrepared();
				return {
					stream: stream(
						calls === 1
							? [
									...textParts("Working"),
									{
										type: "tool-call",
										toolCallId: "c",
										toolName: "lookup",
										input: "{}",
									},
									finish("tool-calls"),
								]
							: [...textParts("Final"), finish()],
					),
				};
			},
		});
		const run = runNormalChatCompletion(
			{
				...params(),
				tools: {
					lookup: tool({
						inputSchema: z.object({}),
						execute: async () => {
							executions++;
							return "evidence";
						},
					}),
				},
			},
			dependencies(model),
			true,
		);
		let result: PlainNormalChatModelRunResult;
		for (;;) {
			const next = await run.next();
			if (next.done) {
				result = next.value;
				break;
			}
			if (next.value.type === "tool_call") await prepared;
		}
		expect(result.completion).toMatchObject({
			outcome: "answered",
			closingAttempted: false,
		});
		expect(result.text).toBe("Final");
		expect(calls).toBe(2);
		expect(executions).toBe(1);
		expect(result.continuation?.steps).toHaveLength(2);
		expect(result.continuation?.steps.map((s) => s.toolAttempted)).toEqual([
			true,
			false,
		]);
		expect(result.continuation?.executions).toHaveLength(1);
		expect(result.continuation?.executions[0].stepId).toBe(
			result.continuation?.steps[0].stepId,
		);
		expect(result.continuation?.usage).toHaveLength(1);
		expect(result.continuation?.usage[0].inputTokens).toBe(2);
		expect(
			result.continuation?.steps.map((s) =>
				s.response
					.filter((m) => m.role === "assistant")
					.flatMap((m) =>
						typeof m.content === "string"
							? [m.content]
							: m.content.filter((p) => p.type === "text").map((p) => p.text),
					)
					.join(""),
			),
		).toEqual(["Working", "Final"]);
		expect(
			result.continuation?.events
				.filter((e) => e.type === "step_start" || e.type === "step_end")
				.map((e) => [e.type, e.stepId]),
		).toEqual([
			["step_start", "s:attempt:0:step:0"],
			["step_end", "s:attempt:0:step:0"],
			["step_start", "s:attempt:0:step:1"],
			["step_end", "s:attempt:0:step:1"],
		]);

		expect(
			projectNormalChatOutput(result.continuation?.events ?? []).activity.map(
				(b) => b.text,
			),
		).toEqual(["Working"]);
	});
	it.each([
		"stream",
		"plain",
	] as const)("requires a visible character for working and closing answers (%s)", async (mode) => {
		let calls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				calls++;
				return { stream: stream([...textParts("\u200B"), finish()]) };
			},
			doGenerate: async () => {
				calls++;
				return {
					content: [{ type: "text", text: "\u200B" }],
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				};
			},
		});
		const run = runNormalChatCompletion(
			params(),
			dependencies(model),
			mode === "stream",
		);
		let result: PlainNormalChatModelRunResult;
		for (;;) {
			const next = await run.next();
			if (next.done) {
				result = next.value;
				break;
			}
		}
		expect(result.completion).toMatchObject({
			outcome: "incomplete",
			closingAttempted: true,
		});
		expect(calls).toBe(2);
		expect(result.continuation?.steps.map((s) => s.phase)).toEqual([
			"working",
			"closing",
		]);
		expect(
			projectNormalChatOutput(result.continuation?.events ?? []).activity.map(
				(b) => b.text,
			),
		).toEqual(["\u200B"]);
	});
	it.each([
		["length", "stop", "length", "answered"],
		["length", "length", "length", "incomplete"],
		["missing_finish", "stop", "stream_end", "answered"],
		["error", "stop", "transport_error", "answered"],
	] as const)("does not let earlier delivery mask later %s work or closing %s", async (workingEnd, closingEnd, workingStopCause, outcome) => {
		let calls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: stream(
					++calls === 1
						? [
								{
									type: "tool-call",
									toolCallId: "c",
									toolName: "deliver",
									input: "{}",
								},
								finish("tool-calls"),
							]
						: calls === 2
							? [
									...textParts("Later analysis cut short"),
									...(workingEnd === "length"
										? [finish("length")]
										: workingEnd === "error"
											? [
													{
														type: "error" as const,
														error: new Error("later stream failed"),
													},
												]
											: []),
								]
							: [...textParts("Completed remaining work"), finish(closingEnd)],
				),
			}),
		});
		const base = params();
		const run = runNormalChatCompletion(
			{
				...base,
				tools: {
					deliver: tool({
						inputSchema: z.object({}),
						execute: async () => "real delivery",
					}),
				},
				completionPolicy: {
					...base.completionPolicy,
					forAttempt: () => ({
						...base.completionPolicy.forAttempt(),
						isDelivery: () => true,
					}),
				},
			},
			dependencies(model),
			true,
		);
		let result: PlainNormalChatModelRunResult;
		for (;;) {
			const next = await run.next();
			if (next.done) {
				result = next.value;
				break;
			}
		}
		expect(result.completion).toMatchObject({
			outcome,
			closingAttempted: true,
			workingStopCause,
		});
		expect(result.text).toBe("Completed remaining work");
		expect(calls).toBe(3);
		expect(
			projectNormalChatOutput(result.continuation?.events ?? []).activity.map(
				(b) => b.text,
			),
		).toEqual(["Later analysis cut short"]);
	});
	it.each([
		false,
		true,
	])("retains artifact-only delivery without closing (clean blank follow-up: %s)", async (blankFollowup) => {
		let calls = 0;
		const base = params();
		const model = new MockLanguageModelV3({
			doStream: async () => {
				calls++;
				if (calls > 1) return { stream: stream([finish()]) };
				return {
					stream: stream([
						{
							type: "tool-call",
							toolCallId: "c",
							toolName: "deliver",
							input: "{}",
						},
						finish("tool-calls"),
					]),
				};
			},
		});
		const run = runNormalChatCompletion(
			{
				...base,
				maxToolSteps: blankFollowup ? 2 : 1,
				tools: {
					deliver: tool({
						inputSchema: z.object({}),
						execute: async () => "real delivery",
					}),
				},
				completionPolicy: {
					...base.completionPolicy,
					forAttempt: () => ({
						...base.completionPolicy.forAttempt(),
						isDelivery: () => true,
					}),
				},
			},
			dependencies(model),
			true,
		);
		let result: PlainNormalChatModelRunResult;
		for (;;) {
			const next = await run.next();
			if (next.done) {
				result = next.value;
				break;
			}
		}
		expect(result.completion).toMatchObject({
			outcome: "delivered",
			closingAttempted: false,
		});
		expect(calls).toBe(blankFollowup ? 2 : 1);
	});

	it("preserves multiple native block IDs within a single clean answer", async () => {
		const output: NormalChatOutputEvent[] = [];
		const model = new MockLanguageModelV3({
			doStream: {
				stream: stream([
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "block-a" },
					{ type: "text-delta", id: "block-a", delta: "One\n" },
					{ type: "text-end", id: "block-a" },
					{ type: "text-start", id: "block-b" },
					{ type: "text-delta", id: "block-b", delta: "## Two" },
					{ type: "text-end", id: "block-b" },
					{
						type: "finish",
						usage,
						finishReason: { unified: "stop", raw: "stop" },
					},
				]),
			},
		});
		for await (const _event of runNormalChatCompletion(
			{
				provider,
				messages: [{ role: "user", content: "answer" }],
				completionPolicy: {
					turnId: "t",
					segmentId: "s",
					deadlineAt: Date.now() + 300000,
					totalTimeoutMs: 300000,
					onOutputEvent: (e) => output.push(e),
				},
			},
			dependencies(model),
			true,
		)) {
		}
		expect(projectNormalChatOutput(output).answer).toBe("One\n## Two");
		expect(
			projectNormalChatOutput(output).blocks.map((b) => b.nativeId),
		).toEqual(["block-a", "block-b"]);
	});
	it("retains provider execution and signed reasoning before a lost step finish", async () => {
		let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
		let recorded!: () => void;
		const settled = new Promise<void>((resolve) => {
			recorded = resolve;
		});
		let final: NormalChatContinuationSnapshot | undefined;
		let calls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () =>
				++calls > 1
					? {
							stream: stream([
								{ type: "stream-start", warnings: [] },
								{ type: "text-start", id: "final" },
								{ type: "text-delta", id: "final", delta: "closed" },
								{ type: "text-end", id: "final" },
								{
									type: "finish",
									usage,
									finishReason: { unified: "stop", raw: "stop" },
								},
							]),
						}
					: {
							stream: new ReadableStream<LanguageModelV3StreamPart>({
								start(c) {
									controller = c;
									c.enqueue({ type: "stream-start", warnings: [] });
									c.enqueue({
										type: "reasoning-start",
										id: "r",
										providerMetadata: { native: { signature: "signed" } },
									});
									c.enqueue({
										type: "reasoning-delta",
										id: "r",
										delta: "exact native reasoning",
									});
									c.enqueue({ type: "reasoning-end", id: "r" });
									c.enqueue({
										type: "tool-call",
										toolCallId: "hosted",
										toolName: "search",
										input: "{}",
										providerExecuted: true,
										dynamic: true,
									});
									c.enqueue({
										type: "tool-result",
										toolCallId: "hosted",
										toolName: "search",
										result: { exact: "provider result" },
										dynamic: true,
									});
								},
							}),
						},
		});
		const run = (async () => {
			for await (const _event of runNormalChatCompletion(
				{
					provider,
					messages: [{ role: "user", content: "answer" }],
					completionPolicy: {
						turnId: "t",
						segmentId: "s",
						deadlineAt: Date.now() + 300000,
						totalTimeoutMs: 300000,
						onSnapshot: (s) => {
							final = s;
							if (s.executions.some((e) => e.state === "succeeded")) recorded();
						},
					},
				},
				{ ...dependencies(model), maxModelContext: 32000 },
				true,
			)) {
			}
		})();
		await settled;
		controller.error(new Error("lost callback"));
		await run;
		expect(final?.executions[0]).toMatchObject({
			providerExecuted: true,
			preliminary: false,
			state: "succeeded",
			output: { exact: "provider result" },
		});
		expect(JSON.stringify(final?.steps)).toContain('"signature":"signed"');
		expect(JSON.stringify(final?.steps)).toContain('"type":"tool-result"');
	}, 1500);
});
