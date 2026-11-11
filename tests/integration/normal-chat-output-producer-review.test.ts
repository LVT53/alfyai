import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runNormalChatCompletion } from "$lib/server/services/normal-chat-model/completion";
import { readNormalChatOutputEvent } from "$lib/services/ai-sdk-ui-stream-contract";
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
const finish = (reason: "stop" | "tool-calls" | "length" = "stop") =>
	({
		type: "finish",
		usage,
		finishReason: { unified: reason, raw: reason },
	}) as LanguageModelV3StreamPart;

async function run(
	model: MockLanguageModelV3,
	extra: Record<string, unknown> = {},
	policyExtra: Record<string, unknown> = {},
	segmentId = "s",
) {
	const output: NormalChatOutputEvent[] = [];
	const texts: string[] = [];
	const gen = runNormalChatCompletion(
		{
			provider,
			messages: [{ role: "user", content: "go" }],
			completionPolicy: {
				turnId: "t",
				segmentId,
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
				onOutputEvent: (e: NormalChatOutputEvent) => output.push(e),
				forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
				...policyExtra,
			},
			...extra,
		} as never,
		dependencies(model),
		true,
	);
	let result: Awaited<ReturnType<typeof gen.next>>["value"];
	for (;;) {
		const next = await gen.next();
		if (next.done) {
			result = next.value;
			break;
		}
		if (next.value.type === "text_delta") texts.push(next.value.text);
	}
	return { output, texts, result };
}

describe("review D: server producer", () => {
	it("P1: persisted event volume for an ordinary long answer", async () => {
		const parts: LanguageModelV3StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "reasoning-start", id: "r" },
		];
		for (let i = 0; i < 2000; i++)
			parts.push({ type: "reasoning-delta", id: "r", delta: "think " });
		parts.push({ type: "reasoning-end", id: "r" });
		parts.push({ type: "text-start", id: "t" });
		for (let i = 0; i < 3000; i++)
			parts.push({ type: "text-delta", id: "t", delta: "word " });
		parts.push({ type: "text-end", id: "t" }, finish());
		const model = new MockLanguageModelV3({
			doStream: async () => ({ stream: stream(parts) }),
		});
		// a realistic scope: segment id is a sha256 hex in production
		const sha = "a".repeat(64);
		const { output, result } = await run(model, {}, { turnId: sha }, sha);
		const json = JSON.stringify({
			version: 1,
			events: result.continuation.events,
		});
		const answerBytes = 3000 * 5;
		console.log(
			"P1 events:",
			output.length,
			"json bytes:",
			json.length,
			"answer bytes:",
			answerBytes,
			"ratio:",
			(json.length / answerBytes).toFixed(1),
		);
		expect(json.length).toBeLessThan(answerBytes * 5);
	});

	it("P2: a provider that reuses one text id twice inside a step merges two blocks into one", async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: stream([
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "txt-0" },
					{ type: "text-delta", id: "txt-0", delta: "Summary." },
					{ type: "text-end", id: "txt-0" },
					{ type: "text-start", id: "txt-0" },
					{ type: "text-delta", id: "txt-0", delta: "## Result" },
					{ type: "text-end", id: "txt-0" },
					finish(),
				]),
			}),
		});
		const { output, texts } = await run(model);
		const p = projectNormalChatOutput(output);
		console.log(
			"P2 blocks:",
			p.blocks.map((b) => JSON.stringify(b.text)).join(" | "),
			"answer:",
			JSON.stringify(p.answer),
			"model-run text_delta:",
			JSON.stringify(texts),
		);
		expect(p.blocks.length).toBe(2);
	});

	it("P3: every produced event survives the browser decoder", async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: stream([
					{ type: "stream-start", warnings: [] },
					{ type: "reasoning-start", id: "r" },
					{ type: "reasoning-delta", id: "r", delta: "hmm" },
					{ type: "reasoning-end", id: "r" },
					{ type: "text-start", id: "t" },
					{ type: "text-delta", id: "t", delta: "Done." },
					{ type: "text-end", id: "t" },
					finish(),
				]),
			}),
		});
		const { output } = await run(model);
		const decoded = output.map((e) =>
			readNormalChatOutputEvent(JSON.parse(JSON.stringify(e))),
		);
		console.log(
			"P3 types:",
			output.map((e) => e.type).join(","),
			"rejected:",
			decoded.filter((d) => d === null).length,
		);
		expect(decoded.every((d) => d !== null)).toBe(true);
	});

	it("P4: tool step with prose then clean step; closing never needed; roles by step", async () => {
		let calls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				calls++;
				return {
					stream: stream(
						calls === 1
							? [
									{ type: "stream-start", warnings: [] },
									{ type: "text-start", id: "txt-0" },
									{ type: "text-delta", id: "txt-0", delta: "Let me check." },
									{ type: "text-end", id: "txt-0" },
									{
										type: "tool-call",
										toolCallId: "c1",
										toolName: "lookup",
										input: "{}",
									},
									finish("tool-calls"),
								]
							: [
									{ type: "stream-start", warnings: [] },
									{ type: "text-start", id: "txt-0" },
									{ type: "text-delta", id: "txt-0", delta: "## Result" },
									{ type: "text-end", id: "txt-0" },
									finish(),
								],
					),
				};
			},
		});
		const { output, texts, result } = await run(model, {
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
		});
		const p = projectNormalChatOutput(output);
		console.log(
			"P4 answer:",
			JSON.stringify(p.answer),
			"activity:",
			JSON.stringify(p.activity.map((b) => b.text)),
			"texts:",
			JSON.stringify(texts),
			"completion:",
			JSON.stringify(result.completion?.outcome),
		);
		expect(p.answer).toBe("## Result");
		expect(texts.join("")).toBe(p.answer);
	});
});
