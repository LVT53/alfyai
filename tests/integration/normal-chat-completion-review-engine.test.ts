// Adversarial review A reproducers. Each test asserts the contract; a failure is a finding.
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";

vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: async () => null,
	getProviderWithSecrets: async () => null,
	decryptApiKey: () => "synthetic",
}));
vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: async () => [],
	getProviderModel: async () => null,
}));

import {
	runPlainNormalChatModelRun,
	runStreamingNormalChatModelRun,
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
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
	`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}) })}\n\n`;
function streamed(parts: Array<Record<string, unknown>>, finish = "stop") {
	return new Response(
		[...parts.map((p) => chunk(p)), chunk({}, finish), "data: [DONE]\n\n"].join(
			"",
		),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
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
function fallbackConfig() {
	const config = getConfig();
	return {
		...config,
		modelTimeoutFailoverEnabled: true,
		modelTimeoutFailoverTargetModel: "model2" as const,
		modelTimeoutFailoverTimeoutMs: 1000,
		model2Enabled: true,
		model2: {
			...config.model2,
			baseUrl: "https://fallback.invalid/v1",
			modelName: "fallback-test",
			apiKey: "synthetic",
			maxTokens: 1000,
		},
	};
}

describe("review A: Model Run completion attacks", () => {
	it.each([
		true,
		false,
	])("settled-tool failover uses one closing only when destination is admissible=%s", async (admissible) => {
		const args = setup();
		const urls: string[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		const execute = vi.fn(async () => ({ fact: "settled evidence" }));
		const result = await runPlainNormalChatModelRun({
			...args,
			modelId: "model1",
			runtimeConfig: fallbackConfig(),
			completionPolicy: {
				...args.completionPolicy,
				forAttempt: () => ({
					classifyExecution: () => "succeeded",
					projectContext: ({ system, messages, provider }) =>
						admissible || provider.baseUrl === args.provider.baseUrl
							? { system, messages }
							: null,
				}),
			},
			tools: { lookup: tool({ inputSchema: z.object({}), execute }) },
			fetch: async (input, init) => {
				urls.push(String(input));
				bodies.push(JSON.parse(String(init?.body)));
				if (urls.length === 1)
					return reply("", "tool_calls", [
						{
							id: "lookup-1",
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					]);
				if (urls.length === 2)
					throw Object.assign(new Error("request timed out"), {
						name: "TimeoutError",
					});
				return reply("Answer from settled evidence.");
			},
		});
		if (!admissible) {
			expect(urls).toHaveLength(2);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(result.text).toBe("");
			expect(result.completion).toMatchObject({
				outcome: "incomplete",
				stopCause: "incompatible_continuation",
				closingAttempted: true,
			});
			return;
		}
		expect(urls).toHaveLength(3);
		expect(urls[2]).toContain("fallback.invalid");
		expect(bodies[2].tools).toBeUndefined();
		expect(JSON.stringify(bodies[2].messages)).toContain("settled evidence");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(result.text).toBe("Answer from settled evidence.");
		expect(result.completion).toMatchObject({
			outcome: "answered",
			closingAttempted: true,
		});
	});
	it("pre-work failover after streamed partial output must not replay the failed attempt's partial assistant text/reasoning to the new provider", async () => {
		const args = setup();
		const bodies: string[] = [];
		let wire!: ReadableStreamDefaultController<Uint8Array>;
		let requests = 0;
		for await (const _event of runStreamingNormalChatModelRun({
			...args,
			modelId: "model1",
			runtimeConfig: fallbackConfig(),
			completionPolicy: {
				...args.completionPolicy,
				onOutputEvent: (e) => {
					args.output.push(e);
					// Break the first wire only after its partial text was consumed.
					if (
						requests === 1 &&
						e.type === "block_delta" &&
						e.text.includes("PARTIAL-A")
					)
						setTimeout(() =>
							wire.error(
								Object.assign(new Error("request timed out"), {
									name: "TimeoutError",
								}),
							),
						);
				},
				forAttempt: () => ({
					classifyExecution: () => "succeeded" as const,
					projectContext: ({ system, messages }) => ({ system, messages }),
				}),
			},
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				if (++requests === 1)
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								wire = controller;
								controller.enqueue(
									new TextEncoder().encode(
										chunk({
											reasoning_content: "REASONING-OF-PROVIDER-A",
											content: "PARTIAL-A",
										}),
									),
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				return streamed([{ content: "fallback answer" }]);
			},
		})) {
		}
		expect(requests).toBe(2);
		expect(bodies[1]).toContain("fallback-test");
		// A pre-work failover restarts from the prepared input; the failed
		// attempt's unfinished assistant message is not prepared input.
		expect(bodies[1]).not.toContain("PARTIAL-A");
		expect(bodies[1]).not.toContain("REASONING-OF-PROVIDER-A");
	});

	it.each([
		["working natural stop", 0],
		["closing after a spent budget", 1],
	])("does not promote raw DSML tool markup after a visible preface to answered (%s)", async (_label, toolStepsBeforeMarkup) => {
		const args = setup();
		let requests = 0;
		const markup =
			'I will verify that.\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="research_web">\n<｜｜DSML｜｜ parameter name="query" string="true">height</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async () => {
				requests++;
				if (requests <= toolStepsBeforeMarkup)
					return reply("working", "tool_calls", [
						{
							id: `c${requests}`,
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					]);
				return reply(markup);
			},
		});
		expect(result.completion?.outcome).not.toBe("answered");
		expect(result.text).not.toContain("DSML");
	});

	// Review 2, finding 2.8: Qwen (the local model) writes a call as a Hermes-style
	// `<tool_call>` block, not as DeepSeek's token. Explicit control syntax is not an
	// answer whoever wrote it, and the engine settles it the same way.
	const hermesCall =
		'<tool_call>\n{"name": "research_web", "arguments": {"query": "height"}}\n</tool_call>';
	it.each([
		["working natural stop", 0],
		["closing after a spent budget", 1],
	])("does not promote Hermes-style <tool_call> markup after a visible preface to answered (%s)", async (_label, toolStepsBeforeMarkup) => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			maxToolSteps: 1,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async () => {
				requests++;
				if (requests <= toolStepsBeforeMarkup)
					return reply("working", "tool_calls", [
						{
							id: `c${requests}`,
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					]);
				return reply(`Let me look that up.\n${hermesCall}`);
			},
		});
		expect(result.completion?.outcome).not.toBe("answered");
		expect(result.text).not.toContain("<tool_call>");
	});

	it.each([
		[
			"DeepSeek's token",
			'I will verify that.\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="research_web">\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
		],
		["a Hermes-style block", `Let me look that up.\n${hermesCall}`],
	])("settles %s after a visible preface the same way on the streaming transport: incomplete, none of it in the answer", async (_label, markup) => {
		const args = setup();
		for await (const _event of runStreamingNormalChatModelRun({
			...args,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async () => streamed([{ content: markup }]),
		})) {
		}
		const projection = projectNormalChatOutput(args.output);
		expect(projection.completion?.outcome).toBe("incomplete");
		expect(projection.answer).toBe("");
	});

	it.each([
		[
			"the tag named in prose",
			"Qwen models wrap each call in a <tool_call> tag and close it with </tool_call>.",
		],
		[
			"a complete block shown in a code fence",
			`Qwen writes a call like this:\n\`\`\`xml\n${hermesCall}\n\`\`\`\nThe server turns it into a structured call.`,
		],
		[
			"DeepSeek's token quoted in a code fence",
			"Its calls start with:\n```\n<｜｜DSML｜｜ calls>\n```\nand end with a closing tag.",
		],
		["a JSON-first answer", '{"name": "Alice", "arguments": {"age": 30}}'],
	])("still answers with %s", async (_label, text) => {
		const args = setup();
		const result = await runPlainNormalChatModelRun({
			...args,
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async () => reply(text),
		});
		expect(result.completion?.outcome).toBe("answered");
		expect(result.text).toBe(text);
	});

	it("never sends closing an assistant tool call without its tool result", async () => {
		const args = setup();
		const bodies: string[] = [];
		let wire!: ReadableStreamDefaultController<Uint8Array>;
		let requests = 0;
		let broken = false;
		let last: unknown;
		const seen: unknown[] = [];
		for await (const _event of runStreamingNormalChatModelRun({
			...args,
			completionPolicy: {
				...args.completionPolicy,
				onSnapshot: (s) => {
					last = s;
					if (
						!broken &&
						s.executions.some(
							(e) =>
								e.toolName === "not_offered" &&
								e.state === "definitely_not_executed",
						)
					) {
						broken = true;
						setTimeout(() => wire.error(new Error("lost transport")));
					}
				},
			},
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "unused",
				}),
			},
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				if (++requests === 1)
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								wire = controller;
								controller.enqueue(
									new TextEncoder().encode(
										chunk({
											content: "Let me check.",
											tool_calls: [
												{
													index: 0,
													id: "dangling",
													type: "function",
													function: { name: "not_offered", arguments: "{}" },
												},
											],
										}),
									),
								);
								setTimeout(() => {
									broken = true;
									controller.error(new Error("lost transport"));
								}, 100);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				return streamed([{ content: "closed" }]);
			},
		})) {
			seen.push(_event);
		}
		console.info(
			"REVIEW-A dangling",
			JSON.stringify({
				completion: (last as { completion?: unknown })?.completion,
				executions: (
					last as { executions?: Array<{ toolName: string; state: string }> }
				)?.executions?.map((e) => [e.toolName, e.state]),
				events: seen.map((e) => (e as { type: string }).type),
			}),
		);
		expect(requests).toBe(2);
		const closing = JSON.parse(bodies[1]) as {
			messages: Array<{
				role: string;
				tool_calls?: Array<{ id: string }>;
				tool_call_id?: string;
			}>;
		};
		const called = closing.messages.flatMap(
			(m) => m.tool_calls?.map((c) => c.id) ?? [],
		);
		const answered = closing.messages
			.filter((m) => m.role === "tool")
			.map((m) => m.tool_call_id);
		console.info("REVIEW-A closing messages", JSON.stringify(closing.messages));
		// OpenAI-compatible APIs reject an assistant tool_calls entry with no tool reply.
		for (const id of called) expect(answered).toContain(id);
	});
});
