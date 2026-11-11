import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import type { NormalChatCompletion } from "$lib/shared/normal-chat-completion";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";
import { estimateTokenCount } from "$lib/utils/tokens";

const records = vi.hoisted(() => ({
	providers: new Map<string, unknown>(),
	models: new Map<string, Array<{ id: string }>>(),
}));
vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: async () => null,
	getProviderWithSecrets: async (id: string) =>
		records.providers.get(id) ?? null,
	decryptApiKey: () => "synthetic",
}));
vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: async (id: string) => records.models.get(id) ?? [],
	getProviderModel: async (id: string) =>
		[...records.models.values()].flat().find((m) => m.id === id) ?? null,
}));

import {
	parseNormalChatContinuation,
	prepareNormalChatCompletionRun,
	runPlainNormalChatModelRun,
	runStreamingNormalChatModelRun,
	serializeNormalChatContinuation,
} from "$lib/server/services/normal-chat-model";

const provider = {
	id: "p",
	name: "openai",
	displayName: "Test",
	baseUrl: "https://completion.invalid/v1",
	modelName: "test",
	apiKey: "synthetic",
	requestTimeoutMs: 300000,
	maxOutputTokens: 1000,
	maxModelContext: 32000,
};
function reply(content: string, finish = "stop", calls?: unknown[]) {
	return new Response(
		JSON.stringify({
			id: "r",
			object: "chat.completion",
			created: 1,
			model: "actual-test",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content,
						...(calls ? { tool_calls: calls } : {}),
					},
					finish_reason: finish,
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
		}),
		{ headers: { "content-type": "application/json" } },
	);
}
function streamed(
	parts: Array<Record<string, unknown>>,
	finish: string | null = "stop",
) {
	return new Response(
		[
			...parts.map(
				(delta) =>
					`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			),
			`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
const call = {
	id: "call-1",
	type: "function",
	function: { name: "lookup", arguments: "{}" },
};
function setup() {
	const output: NormalChatOutputEvent[] = [];
	return {
		provider,
		messages: [{ role: "user" as const, content: "Find it" }],
		completionPolicy: {
			turnId: "t",
			segmentId: "s",
			deadlineAt: Date.now() + 300000,
			totalTimeoutMs: 300000,
			onOutputEvent: (e: NormalChatOutputEvent) => output.push(e),
			forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
		},
		output,
	};
}
describe("opt-in structural completion with real SDK", () => {
	it("preserves the intentional per-model then global pre-work fallback chain", async () => {
		const args = setup();
		const config = getConfig();
		let requests = 0;
		const source = {
			id: "source-model",
			providerId: "source",
			name: "source-model",
			displayName: "Source",
			enabled: true,
			maxModelContext: 32000,
			maxTokens: 1000,
			reasoningEffort: null,
			thinkingType: null,
			capabilitiesJson: "{}",
			fallbackProviderModelId: "specific-model",
		};
		const target = {
			...source,
			id: "specific-model",
			providerId: "specific",
			name: "specific-model",
			fallbackProviderModelId: null,
		};
		records.models.set("source", [source]);
		records.models.set("specific", [target]);
		records.providers.set("source", {
			...provider,
			id: "source",
			name: "source",
			enabled: true,
		});
		records.providers.set("specific", {
			...provider,
			id: "specific",
			name: "specific",
			enabled: true,
		});
		try {
			const result = await runPlainNormalChatModelRun({
				...args,
				provider: { ...provider, id: "source", modelName: "source-model" },
				modelId: "provider:source:source-model",
				runtimeConfig: {
					...config,
					modelTimeoutFailoverEnabled: true,
					modelTimeoutFailoverTargetModel: "model2",
					modelTimeoutFailoverTimeoutMs: 1000,
					model2Enabled: true,
					model2: {
						...config.model2,
						baseUrl: "https://global.invalid/v1",
						modelName: "global-model",
						apiKey: "synthetic",
						maxTokens: 1000,
					},
				},
				completionPolicy: {
					...args.completionPolicy,
					forAttempt: () => ({
						projectContext: ({ system, messages }) => ({ system, messages }),
					}),
				},
				fetch: async () => {
					if (++requests < 3)
						throw Object.assign(new Error("request timed out"), {
							name: "TimeoutError",
						});
					return reply("global answer");
				},
			});
			expect(result.completion?.outcome).toBe("answered");
			expect(result.continuation?.usage.map((u) => u.providerId)).toEqual([
				"source",
				"specific",
				"model2",
			]);
			expect(requests).toBe(3);
		} finally {
			records.models.clear();
			records.providers.clear();
		}
	});
	it("aggregates step, cache and reasoning usage once at the model seam", async () => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async () => {
				if (++requests === 1) return reply("working", "tool_calls", [call]);
				const final = await reply("final").json();
				final.usage.prompt_tokens_details = { cached_tokens: 4 };
				final.usage.completion_tokens_details = { reasoning_tokens: 2 };
				return new Response(JSON.stringify(final), {
					headers: { "content-type": "application/json" },
				});
			},
		});
		expect(result.usage).toMatchObject({
			inputTokens: 20,
			outputTokens: 6,
			totalTokens: 26,
			lastStepInputTokens: 10,
			cachedInputTokens: 4,
		});
		expect(result.continuation?.usage).toHaveLength(1);
		expect(result.continuation?.usage[0]).toMatchObject({
			providerId: "p",
			inputTokens: 20,
			outputTokens: 6,
			reasoningTokens: 2,
		});
	});
	it("gives both transports one prepared-run owner and cannot start it twice", async () => {
		const args = setup();
		let requests = 0;
		const prepared = prepareNormalChatCompletionRun({
			...args,
			fetch: async () => {
				requests++;
				return reply("owned answer");
			},
		});
		const first = prepared.runPlain();
		const again = prepared.runPlain();
		expect(first).toBe(again);
		expect((await first).text).toBe("owned answer");
		expect(prepared.getSnapshot()?.completion?.outcome).toBe("answered");
		expect(() => prepared.stream()).toThrow();
		expect(requests).toBe(1);
	});
	it("binds the fallback model and executable tool policy together", async () => {
		const args = setup();
		const config = getConfig();
		const attempts: string[] = [];
		let requests = 0;
		let originalExecutions = 0;
		let effectiveExecutions = 0;
		const bodies: string[] = [];
		const result = await runPlainNormalChatModelRun({
			...args,
			modelId: "model1",
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						originalExecutions++;
						return "local secret";
					},
				}),
			},
			runtimeConfig: {
				...config,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				modelTimeoutFailoverTimeoutMs: 1000,
				model2Enabled: true,
				model2: {
					...config.model2,
					baseUrl: "https://fallback.invalid/v1",
					modelName: "fallback-test",
					apiKey: "synthetic",
					maxTokens: 1000,
				},
			},
			completionPolicy: {
				...args.completionPolicy,
				forAttempt: ({ provider: actual }) => {
					attempts.push(actual.id);
					return {
						...args.completionPolicy.forAttempt(),
						tools: {
							lookup: tool({
								inputSchema: z.object({}),
								execute: async () => {
									effectiveExecutions++;
									return `destination:${actual.id}`;
								},
							}),
						},
						projectContext: ({ system, messages }) => ({ system, messages }),
					};
				},
			},
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				if (++requests === 1)
					throw Object.assign(new Error("request timed out"), {
						name: "TimeoutError",
					});
				return requests === 2
					? reply("working", "tool_calls", [call])
					: reply("fallback answer");
			},
		});
		expect(result.completion?.outcome).toBe("answered");
		expect(attempts).toEqual(["p", "model2"]);
		expect(originalExecutions).toBe(0);
		expect(effectiveExecutions).toBe(1);
		expect(bodies[2]).toContain("destination:model2");
		expect(bodies.join("")).not.toContain("local secret");
		expect(
			result.continuation?.usage.map((u) => [u.providerId, u.inputTokens]),
		).toEqual([
			["p", null],
			["model2", 20],
		]);
	});
	it("distinguishes an externally owned deadline abort from a person stopping", async () => {
		const args = setup();
		const controller = new AbortController();
		controller.abort();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			abortSignal: controller.signal,
			completionPolicy: {
				...args.completionPolicy,
				abortCause: () => "deadline",
			},
			fetch: async () => {
				requests++;
				return reply("not reached");
			},
		});
		expect(result.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "deadline",
		});
		expect(requests).toBe(0);
	});
	it("closes stagnated work once without restoring tools", async () => {
		const args = setup();
		let requests = 0;
		let executions = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 10,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "same evidence";
					},
				}),
			},
			fetch: async () =>
				++requests <= 5
					? reply("working", "tool_calls", [
							{ ...call, id: `work-${requests}` },
						])
					: reply("closed"),
		});
		expect(result.completion).toMatchObject({
			outcome: "answered",
			workingStopCause: "stagnation",
			closingAttempted: true,
		});
		expect(executions).toBe(5);
		expect(requests).toBe(6);
	});
	it.each([
		false,
		true,
	])("closes blank or reasoning-only work without inventing reasoning (%s)", async (reasoningOnly) => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			fetch: async () => {
				if (++requests > 1) return reply("closed");
				const first = await reply("").json();
				if (reasoningOnly)
					first.choices[0].message.reasoning_content = "real reasoning";
				return new Response(JSON.stringify(first), {
					headers: { "content-type": "application/json" },
				});
			},
		});
		expect(result.text).toBe("closed");
		expect(requests).toBe(2);
		expect(
			projectNormalChatOutput(args.output)
				.blocks.filter((b) => b.kind === "reasoning")
				.map((b) => b.text),
		).toEqual(reasoningOnly ? ["real reasoning"] : []);
	});
	it("cannot execute a newly named tool call inside closing or recurse", async () => {
		const args = setup();
		let requests = 0;
		let executions = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "evidence";
					},
				}),
			},
			fetch: async () => {
				requests++;
				return reply("partial", "tool_calls", [
					{ ...call, id: `fresh-${requests}` },
				]);
			},
		});
		expect(result.completion?.outcome).toBe("incomplete");
		expect(result.text).toBe("partial");
		expect(executions).toBe(1);
		expect(requests).toBe(2);
	});
	it.each([
		true,
		false,
	])("preserves pre-execution fallback and requires whole-context destination projection (%s)", async (allowProjection) => {
		const args = setup();
		let requests = 0;
		const config = getConfig();
		const result = await runPlainNormalChatModelRun({
			...args,
			modelId: "model1",
			runtimeConfig: {
				...config,
				modelTimeoutFailoverEnabled: true,
				modelTimeoutFailoverTargetModel: "model2",
				modelTimeoutFailoverTimeoutMs: 1000,
				model2Enabled: true,
				model2: {
					...config.model2,
					baseUrl: "https://fallback.invalid/v1",
					modelName: "fallback-test",
					apiKey: "synthetic",
					maxTokens: 1000,
				},
			},
			completionPolicy: {
				...args.completionPolicy,
				forAttempt: () => ({
					...args.completionPolicy.forAttempt(),
					...(allowProjection
						? {
								projectContext: ({ system, messages }) => ({
									system,
									messages,
								}),
							}
						: {}),
				}),
			},
			fetch: async () => {
				requests++;
				if (requests === 1)
					throw Object.assign(new Error("request timed out"), {
						name: "TimeoutError",
					});
				return reply("fallback answer");
			},
		});
		expect(requests).toBe(allowProjection ? 2 : 1);
		expect(result.completion?.stopCause).toBe(
			allowProjection ? "natural_stop" : "incompatible_continuation",
		);
		if (allowProjection)
			expect(
				result.continuation?.usage.map((u) => [
					u.providerId,
					u.inputTokens,
					u.complete,
				]),
			).toEqual([
				["p", null, false],
				["model2", 10, true],
			]);
	});
	it("reserves closing time under the parent deadline without treating working expiry as user stop", async () => {
		const args = setup();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		let requests = 0;
		try {
			const result = await runPlainNormalChatModelRun({
				...args,
				tools: {
					lookup: tool({
						inputSchema: z.object({}),
						execute: async () => {
							clock.mockReturnValue(now + 240000);
							return "evidence";
						},
					}),
				},
				fetch: async () =>
					++requests === 1
						? reply("working", "tool_calls", [call])
						: reply("closed"),
			});
			expect(result.completion).toMatchObject({
				outcome: "answered",
				workingStopCause: "deadline",
				closingAttempted: true,
			});
			expect(requests).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		"new",
		"reuse",
		"refuse",
	] as const)("permits explicit resumed work only under retained operation ownership: %s", async (authorization) => {
		const args = setup();
		let executions = 0;
		const tools = {
			lookup: tool({
				inputSchema: z.object({}),
				execute: async () => {
					executions++;
					return "recorded result";
				},
			}),
			ask_user: tool({
				inputSchema: z.object({}),
				execute: async () => ({ status: "waiting_for_user" }),
			}),
		};
		const first = await runPlainNormalChatModelRun({
			...args,
			tools,
			fetch: async () =>
				reply("before ask", "tool_calls", [
					call,
					{
						...call,
						id: "ask",
						function: { name: "ask_user", arguments: "{}" },
					},
				]),
		});
		expect(first.completion?.outcome).toBe("paused");
		if (!first.continuation) throw new Error("Missing capture");
		const capture = first.continuation;
		const priorId = capture.executions.find(
			(e) => e.toolName === "lookup",
		)?.executionId;
		if (!priorId) throw new Error("Missing prior operation");
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			tools,
			maxToolSteps: 3,
			completionPolicy: {
				...args.completionPolicy,
				segmentId: "resume",
				continuation: capture,
				continuationKind: "user_resume",
				forAttempt: () => ({
					...args.completionPolicy.forAttempt(),
					authorizeExecution: () =>
						authorization === "reuse"
							? { kind: "reuse", executionId: priorId }
							: { kind: authorization },
				}),
			},
			fetch: async () =>
				++requests === 1
					? reply("new work", "tool_calls", [{ ...call, id: "fresh-id" }])
					: reply("resumed answer"),
		});
		expect(executions).toBe(authorization === "new" ? 2 : 1);
		expect(result.completion?.outcome).toBe(
			authorization === "refuse" ? "incomplete" : "answered",
		);
		if (authorization === "refuse")
			expect(result.completion?.stopCause).toBe("uncertain_execution");
	});
	it("commits a natural answer after settlement with no extra call", async () => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			fetch: async () => {
				requests++;
				return reply("Let me check.");
			},
		});
		expect(result.completion?.outcome).toBe("answered");
		expect(projectNormalChatOutput(args.output).answer).toBe("Let me check.");
		expect(requests).toBe(1);
	});
	it("closes a spent tool budget without executable tools and retains full result", async () => {
		const args = setup();
		let executions = 0;
		const bodies: Record<string, unknown>[] = [];
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return { exact: "full evidence" };
					},
				}),
			},
			fetch: async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return bodies.length === 1
					? reply("Hello. Let me check.", "tool_calls", [call])
					: reply("## Result");
			},
		});
		expect(result.text).toBe("## Result");
		expect(executions).toBe(1);
		expect(bodies).toHaveLength(2);
		expect(bodies[1].tools).toBeUndefined();
		expect(JSON.stringify(bodies[1].messages)).toContain("full evidence");
		expect(
			projectNormalChatOutput(args.output).activity.map((b) => b.text),
		).toEqual(["Hello. Let me check."]);
		expect(
			result.continuation?.usage.map((u) => [
				u.providerId,
				u.responseModelId,
				u.inputTokens,
			]),
		).toEqual([
			["p", "actual-test", 10],
			["p", "actual-test", 10],
		]);
	});
	it("keeps stream preamble provisional until a later tool-free stop", async () => {
		const args = setup();
		let n = 0;
		const events = [];
		for await (const event of runStreamingNormalChatModelRun({
			...args,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async () =>
				++n === 1
					? streamed(
							[
								{ content: "Hello. Let me check." },
								{ tool_calls: [{ index: 0, ...call }] },
							],
							"tool_calls",
						)
					: streamed([
							{ reasoning_content: "actual native reasoning" },
							{ content: "## Result" },
						]),
		}))
			events.push(event);
		expect(projectNormalChatOutput(args.output).answer).toBe("## Result");
		expect(
			events
				.filter((e) => e.type === "text_delta")
				.map((e) => e.text)
				.join(""),
		).toBe("## Result");
		expect(projectNormalChatOutput(args.output).activity[0].text).toBe(
			"Hello. Let me check.",
		);
	});
	it("retains a dropped stream tool attempt structurally without showing an unoffered tool row", async () => {
		const args = setup();
		let requests = 0;
		const events = [];
		for await (const event of runStreamingNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "unused",
				}),
			},
			fetch: async () =>
				++requests === 1
					? streamed(
							[
								{ content: "working" },
								{
									tool_calls: [
										{
											index: 0,
											...call,
											function: { name: "not_offered", arguments: "{}" },
										},
									],
								},
							],
							"tool_calls",
						)
					: streamed([{ content: "closed" }]),
		}))
			events.push(event);
		expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
		expect(projectNormalChatOutput(args.output).answer).toBe("closed");
		expect(requests).toBe(2);
	});
	it.each([
		"length",
		"",
		"content_filter",
	])("does not call unfinished %s output answered", async (finish) => {
		const args = setup();
		let n = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			fetch: async () => {
				n++;
				return reply("partial", finish);
			},
		});
		expect(result.completion?.outcome).toBe("incomplete");
		expect(n).toBe(finish === "content_filter" ? 1 : 2);
	});
	it("stops promptly during an ignored abort and records late settlement without another call", async () => {
		const args = setup();
		const controller = new AbortController();
		let release!: (value: string) => void;
		let dispatched!: () => void;
		const started = new Promise<void>((resolve) => {
			dispatched = resolve;
		});
		const held = new Promise<string>((resolve) => {
			release = resolve;
		});
		let requests = 0;
		let last: unknown;
		const run = runPlainNormalChatModelRun({
			...args,
			abortSignal: controller.signal,
			completionPolicy: {
				...args.completionPolicy,
				onSnapshot: (s) => {
					last = s;
				},
			},
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						dispatched();
						return held;
					},
				}),
			},
			fetch: async () => {
				requests++;
				return reply("working", "tool_calls", [call]);
			},
		});
		await started;
		controller.abort();
		const result = await run;
		expect(result.completion?.outcome).toBe("stopped");
		expect(result.continuation?.executions[0].state).toBe("uncertain");
		release("late success");
		await vi.waitFor(() =>
			expect(last).toMatchObject({
				executions: [{ state: "succeeded", output: "late success" }],
			}),
		);
		expect(requests).toBe(1);
		expect(args.output.filter((e) => e.type === "completion")).toHaveLength(1);
	}, 1500);
	it("preserves native reasoning and step image inserts at their original boundary", async () => {
		const args = setup();
		const { createStepImageQueue } = await import(
			"$lib/server/services/vision/step-images"
		);
		const queue = createStepImageQueue();
		const bodies: Record<string, unknown>[] = [];
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 2,
			stepImages: queue,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						queue.push({
							label: "canonical local label",
							images: [],
							localOnly: true,
							labelWithoutNames: "private picture",
						});
						return "evidence";
					},
				}),
			},
			fetch: async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				if (bodies.length === 1) return reply("Hello", "tool_calls", [call]);
				if (bodies.length === 2)
					return new Response(
						JSON.stringify({
							id: "r",
							object: "chat.completion",
							created: 1,
							model: "actual-test",
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: "",
										reasoning_content: "reasoning bytes 123",
									},
									finish_reason: "length",
								},
							],
						}),
						{ headers: { "content-type": "application/json" } },
					);
				return reply("final");
			},
		});
		expect(result.completion?.outcome).toBe("answered");
		expect(result.continuation?.steps[1].imageEntries[0].localOnly).toBe(true);
		expect(JSON.stringify(result.continuation?.steps)).toContain(
			"reasoning bytes 123",
		);
		expect(JSON.stringify(bodies[2].messages)).toContain("reasoning bytes 123");
		expect(JSON.stringify(bodies[2].messages)).not.toContain(
			"canonical local label",
		);
		expect(JSON.stringify(bodies[2].messages)).toContain("private picture");
	});
	it("hands pictures queued on the last budgeted tool step to closing without refetching", async () => {
		const args = setup();
		const { createStepImageQueue } = await import(
			"$lib/server/services/vision/step-images"
		);
		const queue = createStepImageQueue();
		let requests = 0;
		let closing = "";
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			stepImages: queue,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						queue.push({ label: "canonical picture from tool", images: [] });
						return "evidence";
					},
				}),
			},
			fetch: async (_url, init) => {
				requests++;
				if (requests === 1) return reply("working", "tool_calls", [call]);
				closing = String(init?.body);
				return reply("closed");
			},
		});
		expect(result.completion?.outcome).toBe("answered");
		expect(closing).toContain("canonical picture from tool");
	});
	it("cannot promote dropped tool attempts into a natural answer", async () => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "unused",
				}),
			},
			fetch: async () =>
				++requests === 1
					? reply("preamble", "stop", [
							{ ...call, function: { name: "not_offered", arguments: "{}" } },
						])
					: reply("answer"),
		});
		expect(requests).toBe(2);
		expect(result.text).toBe("answer");
	});
	it("keeps completed execution when the wire breaks before step finish and closes without repeating", async () => {
		const args = setup();
		let executions = 0;
		let requests = 0;
		let wire!: ReadableStreamDefaultController<Uint8Array>;
		let release!: () => void;
		const outputSettled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const snapshots: unknown[] = [];
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				wire = controller;
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta: { reasoning_content: "native before loss", content: "working bytes", tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })}\n\n`,
					),
				);
			},
		});
		const run = (async () => {
			for await (const _event of runStreamingNormalChatModelRun({
				...args,
				completionPolicy: {
					...args.completionPolicy,
					onSnapshot: (s) => {
						snapshots.push(s);
						if (s.executions.some((e) => e.state === "succeeded")) release();
					},
				},
				tools: {
					lookup: tool({
						inputSchema: z.object({}),
						execute: async () => {
							executions++;
							return "full result before lost finish";
						},
					}),
				},
				fetch: async () => {
					requests++;
					return requests === 1
						? new Response(source, {
								headers: { "content-type": "text/event-stream" },
							})
						: streamed([{ content: "closed" }]);
				},
			})) {
			}
		})();
		await outputSettled;
		wire.error(new Error("lost transport"));
		await run;
		expect(executions).toBe(1);
		expect(requests).toBe(2);
		expect(projectNormalChatOutput(args.output).answer).toBe("closed");
		expect(JSON.stringify(snapshots.at(-1))).toContain(
			"full result before lost finish",
		);
		expect(JSON.stringify(snapshots.at(-1))).toContain("native before loss");
	}, 1500);
	it("does not retry an uncertain envelope even under a fresh provider call id", async () => {
		const args = setup();
		let executions = 0;
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			completionPolicy: {
				...args.completionPolicy,
				forAttempt: () => ({ classifyExecution: () => "uncertain" }),
			},
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return { error: "timeout after dispatch" };
					},
				}),
			},
			fetch: async () => {
				requests++;
				return reply("working", "tool_calls", [
					{ ...call, id: `fresh-${requests}` },
				]);
			},
		});
		expect(result.completion).toMatchObject({
			outcome: "incomplete",
			stopCause: "uncertain_execution",
		});
		expect(executions).toBe(1);
		expect(requests).toBe(1);
	});

	it.each([
		false,
		true,
	])("budgets actual tool schemas before dispatch, streaming=%s", async (streaming) => {
		for (const oversized of [true, false]) {
			const args = setup();
			const bodies: Array<{
				messages: unknown;
				tools: unknown;
				max_completion_tokens: number;
			}> = [];
			const execute = vi.fn(async () => "unused");
			const params = {
				...args,
				provider: { ...provider, maxModelContext: 8192, maxOutputTokens: 820 },
				maxOutputTokens: 820,
				tools: {
					lookup: tool({
						description: "Look up evidence.",
						inputSchema: z.object({
							query: z
								.string()
								.describe(
									oversized ? "schema constraint ".repeat(5000) : "A query.",
								),
						}),
						execute,
					}),
				},
				fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)));
					return streaming
						? streamed([{ content: "Within capacity." }])
						: reply("Within capacity.");
				},
			};
			let completion: NormalChatCompletion | undefined;
			if (streaming) {
				for await (const _event of runStreamingNormalChatModelRun(params)) {
				}
				const terminal = args.output.findLast(
					(event) => event.type === "completion",
				);
				completion =
					terminal?.type === "completion" ? terminal.completion : undefined;
			} else completion = (await runPlainNormalChatModelRun(params)).completion;
			expect(execute).not.toHaveBeenCalled();
			if (oversized) {
				expect(bodies).toHaveLength(0);
				expect(completion).toMatchObject({
					outcome: "incomplete",
					stopCause: "context_capacity",
					closingAttempted: false,
				});
			} else {
				expect(bodies).toHaveLength(1);
				expect(bodies[0].max_completion_tokens).toBe(820);
				expect(completion).toMatchObject({
					outcome: "answered",
					closingAttempted: false,
				});
				expect(
					estimateTokenCount(
						JSON.stringify({
							messages: bodies[0].messages,
							tools: bodies[0].tools,
						}),
					) + bodies[0].max_completion_tokens,
				).toBeLessThanOrEqual(8192);
			}
		}
	});
	it("reports capacity failure without shrinking completed evidence", async () => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			provider: { ...provider, maxModelContext: 6000 },
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "oversized evidence ".repeat(2500),
				}),
			},
			fetch: async () => {
				requests++;
				return reply("working", "tool_calls", [call]);
			},
		});
		expect(requests).toBe(1);
		expect(result.completion?.stopCause).toBe("context_capacity");
		expect(result.continuation?.executions[0].output).toBe(
			"oversized evidence ".repeat(2500),
		);
	});
	it("round trips native picture bytes and URL objects without fetching or losing metadata", async () => {
		const args = setup();
		const result = await runPlainNormalChatModelRun({
			...args,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", image: new Uint8Array([0, 127, 255]) },
						{ type: "image", image: new URL("https://example.test/image") },
					],
				},
			],
			fetch: async () => reply("answer"),
		});
		if (!result.continuation) throw new Error("Missing continuation");
		const parsed = parseNormalChatContinuation(
			serializeNormalChatContinuation(result.continuation),
		);
		expect(parsed.original.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "image", image: new Uint8Array([0, 127, 255]) },
					{ type: "image", image: new URL("https://example.test/image") },
				],
			},
		]);
	});
});

describe("review A: answer projection attacks", () => {
	const jsonAnswer =
		'```json\n{\n  "language": "hu",\n  "text": "Szia!"\n}\n```\n\nThis object holds the greeting and its language code.';
	it("keeps a legitimate answer that opens with a JSON code block", async () => {
		const { sanitizeNormalChatAnswer } = await import(
			"$lib/shared/normal-chat-output"
		);
		const { normalizeAssistantOutputWithSkillControl } = await import(
			"$lib/server/services/chat-turn/normalizer"
		);
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			fetch: async () => {
				requests++;
				return reply(jsonAnswer);
			},
		});
		expect(sanitizeNormalChatAnswer(jsonAnswer)).toBe(jsonAnswer);
		expect(requests).toBe(1);
		expect(result.completion?.outcome).toBe("answered");
		expect(result.text).toBe(jsonAnswer);
		expect(
			normalizeAssistantOutputWithSkillControl(jsonAnswer, {
				structuredOutput: true,
			}).visibleText,
		).toBe(jsonAnswer);
		expect(projectNormalChatOutput(args.output).answer).toBe(jsonAnswer);
	});
});

it.each([
	false,
	true,
])("keeps production tool-call JSON repair (streaming=%s)", async (streaming) => {
	const malformed = [
		{
			id: "c1",
			type: "function",
			function: { name: "lookup", arguments: '{"query":"x"' },
		},
	];
	const run = async (withCompletion: boolean) => {
		const args = setup();
		let executions = 0;
		let requests = 0;
		const params = {
			...args,
			tools: {
				lookup: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async () => {
						executions++;
						return "evidence";
					},
				}),
			},
			fetch: async () => {
				const first = ++requests === 1;
				return streaming
					? first
						? streamed(
								[{ tool_calls: [{ index: 0, ...malformed[0] }] }],
								"tool_calls",
							)
						: streamed([{ content: "answer" }])
					: first
						? reply("", "tool_calls", malformed)
						: reply("answer");
			},
		};
		const execute = async (
			input: typeof params | Omit<typeof params, "completionPolicy">,
		) => {
			if (streaming) {
				for await (const _ of runStreamingNormalChatModelRun(input)) {
					/* drain */
				}
			} else await runPlainNormalChatModelRun(input);
		};
		if (!withCompletion) {
			const { completionPolicy: _omit, ...legacy } = params;
			await execute(legacy);
		} else await execute(params);
		return executions;
	};
	const legacy = await run(false);
	const completion = await run(true);
	expect(legacy).toBe(1);
	expect(completion).toBe(legacy);
});
