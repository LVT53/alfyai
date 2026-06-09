import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runStreamingNormalChatModelRun } from "$lib/server/services/normal-chat-model";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_STREAM_REASONING_TEXT,
	AI_SMOKE_TOOL_FINAL_TEXT,
	AI_SMOKE_TOOL_NAME,
} from "../fixtures/ai/openai-compatible-scenarios";

const MIMO_ULTRASPEED_MODEL_ID = "mimo-v2.5-pro-ultraspeed";
const TOOL_CALL_ID = "call_mimo_report_1";
const TOOL_CALL_INPUT = { title: "MiMo replay report" };

describe("MiMo reasoning_content replay", () => {
	it("replays reasoning_content on the follow-up tool-result request", async () => {
		const requests: unknown[] = [];
		const fakeFetch: typeof fetch = async (_input, init) => {
			const body = parseJsonBody(init?.body);
			requests.push(body);

			if (hasToolResultMessage(body)) {
				if (!hasAssistantToolReasoningContent(body)) {
					return jsonResponse(
						400,
						{
							error: {
								message: "missing historical reasoning_content",
								type: "invalid_request_error",
								code: "missing_reasoning_content",
							},
						},
					);
				}

				return sseResponse([
					{
						id: "chatcmpl_mimo_final",
						object: "chat.completion.chunk",
						created: 1_700_000_101,
						model: MIMO_ULTRASPEED_MODEL_ID,
						choices: [
							{
								index: 0,
								delta: { content: AI_SMOKE_TOOL_FINAL_TEXT },
								finish_reason: null,
							},
						],
					},
					{
						id: "chatcmpl_mimo_final",
						object: "chat.completion.chunk",
						created: 1_700_000_102,
						model: MIMO_ULTRASPEED_MODEL_ID,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 22,
							completion_tokens: 4,
							total_tokens: 26,
						},
					},
				]);
			}

			return sseResponse([
				{
					id: "chatcmpl_mimo_tool",
					object: "chat.completion.chunk",
					created: 1_700_000_100,
					model: MIMO_ULTRASPEED_MODEL_ID,
					choices: [
						{
							index: 0,
							delta: { reasoning_content: AI_SMOKE_STREAM_REASONING_TEXT },
							finish_reason: null,
						},
					],
				},
				{
					id: "chatcmpl_mimo_tool",
					object: "chat.completion.chunk",
					created: 1_700_000_100,
					model: MIMO_ULTRASPEED_MODEL_ID,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: TOOL_CALL_ID,
										type: "function",
										function: {
											name: AI_SMOKE_TOOL_NAME,
											arguments: JSON.stringify(TOOL_CALL_INPUT),
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				},
				{
					id: "chatcmpl_mimo_tool",
					object: "chat.completion.chunk",
					created: 1_700_000_100,
					model: MIMO_ULTRASPEED_MODEL_ID,
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					usage: {
						prompt_tokens: 18,
						completion_tokens: 8,
						total_tokens: 26,
					},
				},
			]);
		};
		const toolExecute = vi.fn(async ({ title }: { title: string }) => ({
			jobId: "mimo-job-1",
			title,
		}));

		const events = [];
		for await (const event of runStreamingNormalChatModelRun({
			provider: {
				id: "xiaomi-mimo-provider",
				name: "xiaomi_mimo",
				displayName: "Xiaomi MiMo UltraSpeed",
				baseUrl: "https://api.xiaomimimo.com/v1",
				modelName: MIMO_ULTRASPEED_MODEL_ID,
				apiKey: AI_SMOKE_API_KEY,
			},
			fetch: fakeFetch,
			providerOptions: {
				xiaomi_mimo: { thinking: { type: "enabled" } },
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Create a report." }],
				},
			],
			tools: {
				[AI_SMOKE_TOOL_NAME]: tool({
					description: "Return a deterministic fake job.",
					inputSchema: z.object({ title: z.string() }),
					execute: toolExecute,
				}),
			},
		})) {
			events.push(event);
		}

		expect(events).toContainEqual({
			type: "reasoning_delta",
			text: AI_SMOKE_STREAM_REASONING_TEXT,
		});
		expect(events).toContainEqual({
			type: "text_delta",
			text: AI_SMOKE_TOOL_FINAL_TEXT,
		});
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "error" }),
		);
		expect(toolExecute).toHaveBeenCalledWith(
			TOOL_CALL_INPUT,
			expect.objectContaining({ toolCallId: TOOL_CALL_ID }),
		);
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({
			model: MIMO_ULTRASPEED_MODEL_ID,
			thinking: { type: "enabled" },
		});
		expect(requests[1]).toMatchObject({
			model: MIMO_ULTRASPEED_MODEL_ID,
			thinking: { type: "enabled" },
		});
		expect(findAssistantToolMessage(requests[1])).toMatchObject({
			reasoning_content: AI_SMOKE_STREAM_REASONING_TEXT,
		});
	});
});

function parseJsonBody(body: BodyInit | null | undefined): unknown {
	if (typeof body !== "string") return null;
	return JSON.parse(body);
}

function sseResponse(chunks: unknown[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
	);
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function hasToolResultMessage(body: unknown): boolean {
	const messages = isRecord(body) ? body.messages : undefined;
	return (
		Array.isArray(messages) &&
		messages.some(
			(message) =>
				isRecord(message) &&
				message.role === "tool" &&
				typeof message.tool_call_id === "string",
		)
	);
}

function hasAssistantToolReasoningContent(body: unknown): boolean {
	const assistantMessage = findAssistantToolMessage(body);
	return (
		isRecord(assistantMessage) &&
		typeof assistantMessage.reasoning_content === "string" &&
		assistantMessage.reasoning_content.length > 0
	);
}

function findAssistantToolMessage(body: unknown): unknown {
	const messages = isRecord(body) ? body.messages : undefined;
	if (!Array.isArray(messages)) return null;
	return messages.find(
		(message) =>
			isRecord(message) &&
			message.role === "assistant" &&
			Array.isArray(message.tool_calls),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
