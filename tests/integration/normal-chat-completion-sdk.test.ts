import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { type ModelMessage, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { PlainNormalChatModelRunResult } from "$lib/server/services/normal-chat-model";
import {
	type NormalChatContinuationSnapshot,
	runNormalChatCompletion,
} from "$lib/server/services/normal-chat-model/completion";
import { createStepImageQueue } from "$lib/server/services/vision/step-images";
import { STRIPPED_IMAGE_NOTE } from "$lib/server/services/vision/turn-images";
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

	const picture = {
		artifactId: "immich:one",
		name: "private.jpg",
		image: {
			base64: "AQID",
			mediaType: "image/jpeg" as const,
			width: 1,
			height: 1,
			estimatedTokens: 1,
		},
	};
	const seeing = createModelCapabilitySet({
		imageMessageParts: {
			state: "manual_override",
			supported: true,
			source: "manual_override",
		},
	});
	const originalPictures: ModelMessage[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "original picture" },
				{ type: "image", image: "BAUG", mediaType: "image/jpeg" },
			],
		},
	];
	function pixelCount(value: unknown): number {
		if (Array.isArray(value))
			return value.reduce((n, item) => n + pixelCount(item), 0);
		if (!value || typeof value !== "object") return 0;
		if (
			("type" in value && value.type === "image") ||
			("type" in value &&
				value.type === "file" &&
				"mediaType" in value &&
				String(value.mediaType).startsWith("image/"))
		)
			return 1;
		return Object.values(value).reduce<number>(
			(n, item) => n + pixelCount(item),
			0,
		);
	}
	async function collect(run: ReturnType<typeof runNormalChatCompletion>) {
		for (;;) {
			const next = await run.next();
			if (next.done) return next.value;
		}
	}
	it("withdraws provisional text when a tool starts, before its result settles", async () => {
		let releaseTool!: () => void;
		let beganTool!: () => void;
		const pendingTool = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			beganTool = resolve;
		});
		const events: NormalChatOutputEvent[] = [];
		let calls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: stream(
					calls++ === 0
						? [
								...textParts("Let me check."),
								{
									type: "tool-call",
									toolCallId: "pending",
									toolName: "lookup",
									input: "{}",
								},
								finish("tool-calls"),
							]
						: [...textParts("The answer is 42."), finish()],
				),
			}),
		});
		const options = params();
		const run = collect(
			runNormalChatCompletion(
				{
					...options,
					completionPolicy: {
						...options.completionPolicy,
						onOutputEvent: (event) => events.push(event),
						forAttempt: () => ({
							classifyExecution: () => "succeeded" as const,
							tools: {
								lookup: tool({
									inputSchema: z.object({}),
									execute: async () => {
										beganTool();
										await pendingTool;
										return { answer: 42 };
									},
								}),
							},
						}),
					},
				},
				dependencies(model),
				true,
			),
		);
		try {
			await toolStarted;
			expect(
				projectNormalChatOutput(events).blocks.find(
					(block) => block.kind === "text",
				)?.role,
			).toBe("activity");
			expect(projectNormalChatOutput(events).answer).toBe("");
		} finally {
			releaseTool();
		}
		const result = await run;
		expect(result.text).toBe("The answer is 42.");
		expect(projectNormalChatOutput(events).answer).toBe(result.text);
		expect(calls).toBe(2);
	});
	it("keeps automatic recovery tools off after a known refusal and lost finish", async () => {
		let calls = 0;
		let dispatches = 0;
		const availability: boolean[] = [];
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				const toolsOn = Boolean(options.tools?.length);
				availability.push(toolsOn);
				if (calls++ === 0)
					return {
						content: [
							{
								type: "tool-call",
								toolCallId: "refused",
								toolName: "produce_file",
								input: "{}",
							},
						],
						finishReason: { unified: "tool-calls", raw: "tool_calls" },
						usage,
						warnings: [],
					};
				if (toolsOn) throw new Error("Synthetic lost finish");
				return {
					content: [{ type: "text", text: "The file was not submitted." }],
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				};
			},
		});
		const fallback = vi.fn(async () => ({
			provider,
			modelId: "model1" as const,
			dependencies: dependencies(model),
		}));
		const p = params();
		const result = await collect(
			runNormalChatCompletion(
				{
					...p,
					tools: {
						produce_file: tool({
							inputSchema: z.object({}),
							execute: async () => {
								dispatches++;
								return { status: "failed" };
							},
						}),
					},
					completionPolicy: {
						...p.completionPolicy,
						forAttempt: () => ({
							classifyExecution: () => "definitely_not_executed",
						}),
					},
				},
				{ ...dependencies(model), fallback },
				false,
			),
		);
		expect(fallback).not.toHaveBeenCalled();
		expect(dispatches).toBe(1);
		expect(availability).toEqual([true, true, false]);
		expect(result.completion).toMatchObject({
			outcome: "answered",
			workingStopCause: "transport_error",
			closingAttempted: true,
		});
		expect(
			result.continuation?.usage.filter((u) => u.phase === "closing"),
		).toHaveLength(1);
	});

	it("keeps a thrown reused-ID invocation uncertain despite stale success classification", async () => {
		let generations = 0,
			executions = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async () => ({
				content: [
					{
						type: "tool-call",
						toolCallId: "same-id",
						toolName: "produce_file",
						input: "{}",
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool_calls" },
				usage,
				warnings: [],
			}),
		});
		const p = params();
		const result = await collect(
			runNormalChatCompletion(
				{
					...p,
					tools: {
						produce_file: tool({
							inputSchema: z.object({}),
							execute: async () => {
								generations++;
								if (executions++ > 0)
									throw new Error("Synthetic failure before recorder");
								return { status: "succeeded" };
							},
						}),
					},
					completionPolicy: {
						...p.completionPolicy,
						forAttempt: () => ({ classifyExecution: () => "succeeded" }),
					},
				},
				dependencies(model),
				false,
			),
		);
		expect(generations).toBe(2);
		expect(result.continuation?.executions.map((e) => e.state)).toEqual([
			"succeeded",
			"uncertain",
		]);
		expect(result.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "uncertain_execution",
			closingAttempted: false,
		});
	});

	it("does not let a known refusal clear another uncertain execution", async () => {
		let generations = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async () => {
				generations++;
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "unknown",
							toolName: "unknown",
							input: "{}",
						},
						{
							type: "tool-call",
							toolCallId: "refused",
							toolName: "produce_file",
							input: "{}",
						},
					],
					finishReason: { unified: "tool-calls", raw: "tool_calls" },
					usage,
					warnings: [],
				};
			},
		});
		const p = params();
		const result = await collect(
			runNormalChatCompletion(
				{
					...p,
					tools: {
						unknown: tool({
							inputSchema: z.object({}),
							execute: async () => ({ status: "failed" }),
						}),
						produce_file: tool({
							inputSchema: z.object({}),
							execute: async () => ({ status: "failed" }),
						}),
					},
					completionPolicy: {
						...p.completionPolicy,
						forAttempt: () => ({
							classifyExecution: (execution) =>
								execution.toolName === "produce_file"
									? "definitely_not_executed"
									: "uncertain",
						}),
					},
				},
				dependencies(model),
				false,
			),
		);
		expect(generations).toBe(1);
		expect(result.continuation?.executions.map((e) => e.state)).toContain(
			"uncertain",
		);
		expect(result.continuation?.executions.map((e) => e.state)).toContain(
			"definitely_not_executed",
		);
		expect(result.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "uncertain_execution",
			closingAttempted: false,
		});
	});

	it.each([
		false,
		true,
	])("combines native context projection with entry vision policy (local-only: %s)", async (localOnly) => {
		const queue = createStepImageQueue();
		queue.push({
			label: "private names",
			labelWithoutNames: "positions: 1, 2, 3",
			localOnly: localOnly ? true : undefined,
			images: [picture, picture, picture],
		});
		const seen: unknown[] = [];
		const model = new MockLanguageModelV3({
			doGenerate: async (input) => {
				seen.push(input.prompt);
				return {
					content: [{ type: "text", text: "Final" }],
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				};
			},
		});
		const args = params();
		const result = await collect(
			runNormalChatCompletion(
				{
					...args,
					provider: {
						...provider,
						capabilities: localOnly ? seeing : undefined,
					},
					stepImages: queue,
					completionPolicy: {
						...args.completionPolicy,
						forAttempt: () => ({
							projectContext: ({ system, messages }) => ({ system, messages }),
						}),
					},
				},
				dependencies(model),
				false,
			),
		);
		expect(result.completion?.outcome).toBe("answered");
		expect(seen).toHaveLength(1);
		expect(pixelCount(seen)).toBe(0);
		const wire = JSON.stringify(seen);
		expect(wire.split(STRIPPED_IMAGE_NOTE)).toHaveLength(2);
		expect(wire).toContain(localOnly ? "positions: 1, 2, 3" : "private names");
		if (localOnly) expect(wire).not.toContain("private names");
		expect(result.continuation?.steps[0].imageEntries[0].images).toHaveLength(
			3,
		);
	});
	it.each([
		false,
		true,
	])("expires completed step thumbnails while retaining original prepared pictures (stream: %s)", async (streaming) => {
		const queue = createStepImageQueue();
		const seen: unknown[] = [];
		let executions = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async (input) => {
				seen.push(input.prompt);
				return {
					content:
						seen.length < 3
							? [
									{
										type: "tool-call",
										toolCallId: `c${seen.length}`,
										toolName: "lookup",
										input: "{}",
									},
								]
							: [{ type: "text", text: "Final" }],
					finishReason: {
						unified: seen.length < 3 ? "tool-calls" : "stop",
						raw: "stop",
					},
					usage,
					warnings: [],
				};
			},
			doStream: async (input) => {
				seen.push(input.prompt);
				return {
					stream: stream(
						seen.length < 3
							? [
									{
										type: "tool-call",
										toolCallId: `c${seen.length}`,
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
		const args = params();
		const result = await collect(
			runNormalChatCompletion(
				{
					...args,
					provider: { ...provider, capabilities: seeing },
					messages: originalPictures,
					stepImages: queue,
					tools: {
						lookup: tool({
							inputSchema: z.object({}),
							execute: async () => {
								if (++executions === 1)
									queue.push({ label: "step picture", images: [picture] });
								return "evidence";
							},
						}),
					},
					completionPolicy: {
						...args.completionPolicy,
						forAttempt: () => ({
							classifyExecution: () => "succeeded",
							projectContext: ({ system, messages }) => ({ system, messages }),
						}),
					},
				},
				dependencies(model),
				streaming,
			),
		);
		expect(result.completion?.outcome).toBe("answered");
		expect(seen.map(pixelCount)).toEqual([1, 2, 1]);
		expect(JSON.stringify(seen[2])).not.toContain("step picture");
		expect(result.continuation?.steps[1].imageEntries[0].images).toHaveLength(
			1,
		);
		expect(pixelCount(result.continuation?.steps[1].inserts)).toBe(1);
		expect(pixelCount(result.continuation?.original.messages)).toBe(1);
	});
	it.each([
		false,
		true,
	])("retains an unfinished look across pre-execution retry (stream: %s)", async (streaming) => {
		const queue = createStepImageQueue();
		queue.push({ label: "retry picture", images: [picture] });
		const seen: unknown[] = [];
		const failed = new MockLanguageModelV3({
			doGenerate: async (input) => {
				seen.push(input.prompt);
				throw new Error("offline before response");
			},
			doStream: async (input) => {
				seen.push(input.prompt);
				throw new Error("offline before response");
			},
		});
		const recovered = new MockLanguageModelV3({
			doGenerate: async (input) => {
				seen.push(input.prompt);
				return {
					content: [{ type: "text", text: "Final" }],
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				};
			},
			doStream: async (input) => {
				seen.push(input.prompt);
				return { stream: stream([...textParts("Final"), finish()]) };
			},
		});
		const result = await collect(
			runNormalChatCompletion(
				{
					...params(),
					provider: { ...provider, capabilities: seeing },
					messages: originalPictures,
					stepImages: queue,
				},
				{
					...dependencies(failed),
					fallback: async () => ({
						provider: { ...provider, capabilities: seeing },
						modelId: "native",
						dependencies: dependencies(recovered),
					}),
				},
				streaming,
			),
		);
		expect(result.completion).toMatchObject({
			outcome: "answered",
			closingAttempted: false,
		});
		expect(seen.map(pixelCount)).toEqual([2, 2]);
		expect(result.continuation?.steps[0].finished).toBe(false);
		expect(pixelCount(result.continuation?.steps[0].inserts)).toBe(1);
	});

	it.each([
		["length", "stop", 2],
		["failed", "stop", 2],
		["stop", "stop", 1],
		["length", "length", 2],
		["failed", "failed", 2],
	] as const)("keeps unfinished step image eligibility through closing (%s → %s)", async (first, closing, wantClosingPixels) => {
		const queue = createStepImageQueue();
		queue.push({ label: "unfinished picture", images: [picture] });
		const seen: unknown[] = [];
		const model = new MockLanguageModelV3({
			doGenerate: async (input) => {
				seen.push(input.prompt);
				const end = seen.length === 1 ? first : closing;
				if (end === "failed") throw new Error("connection failed");
				return {
					content: [{ type: "text", text: seen.length === 1 ? "" : "Final" }],
					finishReason: { unified: end, raw: end },
					usage,
					warnings: [],
				};
			},
		});
		const result = await collect(
			runNormalChatCompletion(
				{
					...params(),
					provider: { ...provider, capabilities: seeing },
					messages: originalPictures,
					stepImages: queue,
				},
				dependencies(model),
				false,
			),
		);
		expect(seen.map(pixelCount)).toEqual([2, wantClosingPixels]);
		expect(result.completion?.closingAttempted).toBe(true);
		expect(result.completion?.outcome).toBe(
			closing === "stop"
				? "answered"
				: closing === "failed"
					? "failed"
					: "incomplete",
		);
		expect(result.continuation?.steps[0].imageEntries[0].images).toHaveLength(
			1,
		);
		expect(pixelCount(result.continuation?.steps[0].inserts)).toBe(1);
		const resumedInputs: unknown[] = [];
		const resumedModel = new MockLanguageModelV3({
			doGenerate: async (input) => {
				resumedInputs.push(input.prompt);
				return {
					content: [{ type: "text", text: "Resumed answer" }],
					finishReason: { unified: "stop", raw: "stop" },
					usage,
					warnings: [],
				};
			},
		});
		const args = params();
		const resumed = await collect(
			runNormalChatCompletion(
				{
					...args,
					provider: { ...provider, capabilities: seeing },
					messages: originalPictures,
					completionPolicy: {
						...args.completionPolicy,
						segmentId: "new",
						continuation: result.continuation,
						continuationKind: "user_resume",
					},
				},
				dependencies(resumedModel),
				false,
			),
		);
		expect(resumed.completion?.outcome).toBe("answered");
		expect(resumedInputs.map(pixelCount)).toEqual([
			closing === "stop" || first === "stop" ? 1 : 2,
		]);
		expect(pixelCount(resumed.continuation?.steps[0].inserts)).toBe(1);
	});

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
