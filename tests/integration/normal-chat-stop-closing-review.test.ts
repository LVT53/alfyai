// Reviewer-added probe (review F): Stop pressed while the CLOSING generation is streaming.
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

import { runStreamingNormalChatModelRun } from "$lib/server/services/normal-chat-model";

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
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
	`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

describe("review F probe: Stop during closing", () => {
	it("keeps the streamed closing prefix as an interrupted answer and reports stopped", async () => {
		const output: NormalChatOutputEvent[] = [];
		const controller = new AbortController();
		let requests = 0;
		let executions = 0;
		const events: Array<{ type: string }> = [];
		for await (const e of runStreamingNormalChatModelRun({
			provider,
			messages: [{ role: "user" as const, content: "Find it" }],
			abortSignal: controller.signal,
			maxToolSteps: 1,
			completionPolicy: {
				turnId: "t",
				segmentId: "s",
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
				onOutputEvent: (ev: NormalChatOutputEvent) => output.push(ev),
				forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
			},
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "evidence";
					},
				}),
			},
			fetch: async (_u: unknown, init?: { signal?: AbortSignal | null }) => {
				requests++;
				const signal = init?.signal;
				if (requests === 1)
					return new Response(
						[
							chunk({ content: "working" }),
							chunk({
								tool_calls: [
									{
										index: 0,
										id: "call-1",
										type: "function",
										function: { name: "lookup", arguments: "{}" },
									},
								],
							}),
							chunk({}, "tool_calls"),
							"data: [DONE]\n\n",
						].join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				// closing: one delta, then silence until the request is aborted
				const enc = new TextEncoder();
				return new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(
								enc.encode(chunk({ content: "Partial closing prefix" })),
							);
							signal?.addEventListener("abort", () =>
								c.error(signal.reason ?? new Error("aborted")),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		})) {
			events.push(e as { type: string });
			if (e.type === "text_delta") controller.abort();
		}
		const projected = projectNormalChatOutput(output);
		console.info("[review-F] stop-during-closing", {
			requests,
			executions,
			completion: projected.completion,
			answer: projected.answer,
			activity: projected.activity.map((a) => a.text),
		});
		expect(requests).toBe(2);
		expect(executions).toBe(1);
		expect(projected.answer).toBe("Partial closing prefix");
		expect(projected.completion).toMatchObject({
			phase: "closing",
			outcome: "stopped",
			stopCause: "user_stop",
			closingAttempted: true,
		});
		expect(projected.answer).not.toContain("working");
	}, 15000);
});
