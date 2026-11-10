import { type ModelMessage, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderHistoryTurn } from "$lib/server/services/chat-turn/conversation-history";
import {
	runPlainNormalChatModelRun,
	runStreamingNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";

import { resolveHistoryToolMessagesMode } from "$lib/server/services/normal-chat-model/provider-compatibility";

const deepseekProvider = {
	id: "deepseek-test",
	name: "deepseek",
	displayName: "DeepSeek",
	baseUrl: "https://api.deepseek.com/v1",
	modelName: "deepseek-v4-pro",
	apiKey: "synthetic",
};

const reasoning = " \nSynthetic reasoning α.\t\n";

describe("DeepSeek native tool continuation HTTP requests", () => {
	for (const history of [
		"fresh",
		"explicit",
		"native-without-reasoning",
	] as const) {
		for (const streaming of [true, false]) {
			it(`${history === "native-without-reasoning" ? "rejects native history missing required reasoning without fabricating it" : "preserves exact reasoning over multiple tool steps"}: ${streaming ? "streaming" : "plain"}, ${history} history`, async () => {
				const prior: ModelMessage[] =
					history === "fresh"
						? []
						: history === "explicit"
							? [
									{
										role: "assistant",
										content: [
											{ type: "reasoning", text: reasoning },
											{ type: "text", text: "Earlier answer." },
										],
									},
								]
							: renderHistoryTurn(
									{
										messages: [
											{ role: "user", content: "Earlier question." },
											{
												id: "stored-answer",
												role: "assistant",
												content: "Earlier answer.",
												thinkingSegments: [
													{ type: "text", content: reasoning },
													{
														type: "tool_call",
														callId: "call_stored",
														name: "fetch_url",
														input: { url: "https://example.test" },
														status: "done",
														outputSummary: "Synthetic page",
													},
												],
											},
										],
									},
									resolveHistoryToolMessagesMode(deepseekProvider),
								);
				const requests: Record<string, unknown>[] = [];
				const fakeFetch: typeof fetch = async (_input, init) => {
					const body = JSON.parse(String(init?.body));
					requests.push(body);
					const assistants = body.messages.filter(
						(message: { role: string }) => message.role === "assistant",
					);
					if (
						assistants.some(
							(message: { reasoning_content?: string }) =>
								message.reasoning_content !== reasoning,
						)
					) {
						return Response.json(
							{
								error: {
									message: "missing historical reasoning_content",
									type: "invalid_request_error",
									code: "missing_reasoning_content",
								},
							},
							{ status: 400 },
						);
					}
					const step = requests.length;
					const calls = [0, 1].map((index) => ({
						id: `call_${step}_${index}`,
						type: "function",
						function: {
							name: "fetch_url",
							arguments: '{"url":"https://example.test"}',
						},
					}));
					const message =
						step < 3
							? {
									content: null,
									reasoning_content: reasoning,
									tool_calls: calls,
								}
							: { content: "Finished." };
					const completion = {
						id: `completion_${step}`,
						object: "chat.completion",
						created: 1,
						model: "deepseek-v4-pro",
						choices: [
							{
								index: 0,
								message: { role: "assistant", ...message },
								finish_reason: step < 3 ? "tool_calls" : "stop",
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 10,
							total_tokens: 20,
						},
					};
					if (!body.stream) return Response.json(completion);
					const deltas =
						step < 3
							? [
									{ reasoning_content: " \nSynthetic " },
									{
										tool_calls: calls.map((call, index) => ({
											...call,
											index,
										})),
									},
									{ reasoning_content: "reasoning α.\t\n" },
								]
							: [{ content: "Finished." }];
					const frames = [
						...deltas.map((delta) => ({
							...completion,
							object: "chat.completion.chunk",
							choices: [{ index: 0, delta, finish_reason: null }],
						})),
						{
							...completion,
							choices: [
								{
									index: 0,
									delta: {},
									finish_reason: step < 3 ? "tool_calls" : "stop",
								},
							],
						},
					];
					const bytes = new TextEncoder().encode(
						`${frames
							.map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
							.join("")}data: [DONE]\n\n`,
					);
					return new Response(
						new ReadableStream({
							start(controller) {
								for (let offset = 0; offset < bytes.length; offset += 17)
									controller.enqueue(bytes.slice(offset, offset + 17));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				};
				const params = {
					provider: deepseekProvider,
					fetch: fakeFetch,
					maxRetries: 0,
					messages: [
						...prior,
						{ role: "user" as const, content: "Fetch the supplied page." },
					],
					tools: {
						fetch_url: tool({
							inputSchema: z.object({ url: z.string() }),
							execute: async () => ({ text: "Synthetic page" }),
						}),
					},
				};
				if (history === "native-without-reasoning") {
					if (streaming) {
						const events = [];
						for await (const event of runStreamingNormalChatModelRun(params))
							events.push(event);
						expect(events).toEqual([
							{ type: "error", error: "missing historical reasoning_content" },
						]);
					} else {
						await expect(runPlainNormalChatModelRun(params)).rejects.toThrow(
							"missing historical reasoning_content",
						);
					}
					expect(requests).toHaveLength(1);
					expect(requests[0].messages).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								role: "assistant",
								tool_calls: expect.arrayContaining([
									expect.objectContaining({ id: "call_stored" }),
								]),
							}),
						]),
					);
					expect(JSON.stringify(requests[0].messages)).not.toContain(
						"reasoning_content",
					);
					return;
				}
				if (streaming) {
					const events = [];
					for await (const event of runStreamingNormalChatModelRun(params))
						events.push(event);
					expect(events).toContainEqual({
						type: "text_delta",
						text: "Finished.",
					});
					expect(events.some((event) => event.type === "error")).toBe(false);
				} else {
					const result = await runPlainNormalChatModelRun(params);
					expect(result.text).toBe("Finished.");
				}
				expect(requests).toHaveLength(3);
				expect(requests[2].messages).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							reasoning_content: reasoning,
							tool_calls: expect.arrayContaining([
								expect.objectContaining({ id: "call_1_0" }),
								expect.objectContaining({ id: "call_1_1" }),
							]),
						}),
						expect.objectContaining({
							role: "assistant",
							reasoning_content: reasoning,
							tool_calls: expect.arrayContaining([
								expect.objectContaining({ id: "call_2_0" }),
								expect.objectContaining({ id: "call_2_1" }),
							]),
						}),
					]),
				);
			});
		}
	}
});
