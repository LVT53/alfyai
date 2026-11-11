// Adversarial review A reproducers. Each test asserts the contract; a failure is a finding.
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import type { NormalChatOutputEvent } from "$lib/shared/normal-chat-output";

vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: async () => null,
	getProviderWithSecrets: async () => null,
	decryptApiKey: () => "synthetic",
}));
vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: async () => [],
	getProviderModel: async () => null,
}));

import { runPlainNormalChatModelRun } from "$lib/server/services/normal-chat-model";

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
function _streamed(parts: Array<Record<string, unknown>>, finish = "stop") {
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
function _fallbackConfig() {
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

describe("review A: terminal outcomes", () => {
	it.each([
		["U+200E LEFT-TO-RIGHT MARK", "‎"],
		["U+2061 FUNCTION APPLICATION", "⁡"],
		["U+00AD SOFT HYPHEN", "­"],
		["U+3164 HANGUL FILLER", "ㅤ"],
		["U+FE0F VARIATION SELECTOR-16", "️"],
		["U+2800 BRAILLE PATTERN BLANK", "⠀"],
	])("does not settle an invisible-only natural stop as answered (%s)", async (_name, invisible) => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			fetch: async () =>
				++requests === 1 ? reply(invisible) : reply("closed"),
		});
		// Natural promotion requires visible sanitized text; otherwise closing runs.
		expect(requests).toBe(2);
		expect(result.text).toBe("closed");
	});

	it("reports only the resumed segment's own usage, not the paused segment's again", async () => {
		const args = setup();
		const tools = {
			lookup: tool({
				inputSchema: z.object({}),
				execute: async () => "recorded result",
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
					{
						id: "ask",
						type: "function",
						function: { name: "ask_user", arguments: "{}" },
					},
				]),
		});
		expect(first.completion?.outcome).toBe("paused");
		expect(first.usage.inputTokens).toBe(10);
		if (!first.continuation) throw new Error("missing capture");
		const resumed = await runPlainNormalChatModelRun({
			...args,
			tools,
			completionPolicy: {
				...args.completionPolicy,
				segmentId: "resume",
				continuation: first.continuation,
				continuationKind: "user_resume",
			},
			fetch: async () => reply("resumed answer"),
		});
		expect(resumed.completion?.outcome).toBe("answered");
		// One request of 10 prompt tokens ran in the resumed segment.
		expect(resumed.usage.inputTokens).toBe(10);
		expect(resumed.usage.outputTokens).toBe(3);
	});
	it("does not report a turn whose file was delivered as failed when only the caption step fails", async () => {
		const args = setup();
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			...args,
			completionPolicy: {
				...args.completionPolicy,
				forAttempt: () => ({
					classifyExecution: () => "succeeded" as const,
					isDelivery: (e) => e.toolName === "make_file",
				}),
			},
			tools: {
				make_file: tool({
					inputSchema: z.object({}),
					execute: async () => ({ ok: true, jobStatus: "succeeded" }),
				}),
			},
			fetch: async () => {
				if (++requests === 1)
					return reply("", "tool_calls", [
						{
							id: "f1",
							type: "function",
							function: { name: "make_file", arguments: "{}" },
						},
					]);
				return new Response("upstream unavailable", { status: 503 });
			},
		});
		console.info(
			"REVIEW-A delivery",
			JSON.stringify({ requests, completion: result.completion }),
		);
		expect(result.continuation?.executions[0]).toMatchObject({
			state: "succeeded",
			delivered: true,
		});
		expect(result.completion?.outcome).not.toBe("failed");
		expect(result.completion?.outcome).toBe("delivered");
		expect(result.continuation?.executions).toHaveLength(1);
	});
});
