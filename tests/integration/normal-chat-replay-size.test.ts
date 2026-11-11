import { createHash } from "node:crypto";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createOutputEventWriter } from "$lib/server/services/chat-turn/output-event-writer";
import {
	createServerChunkRuntime,
	streamNormalChatOutputEvent,
	streamReasoningDeltaEvent,
	streamTextDeltaEvent,
} from "$lib/server/services/chat-turn/stream";
import { StreamReplayJournal } from "$lib/server/services/chat-turn/stream-replay-journal";
import { runNormalChatCompletion } from "$lib/server/services/normal-chat-model/completion";

// Original review measurement fixture, now asserting useful compact retention.
// The unmodified measurement oracle remains in the review's reproducers folder.

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

async function overflowPoint(
	reasoningTokens: number,
	answerTokens: number,
	compactWire = false,
) {
	const segmentId = createHash("sha256")
		.update(JSON.stringify(["user", "conversation", "stream"]))
		.digest("hex");
	const parts: LanguageModelV3StreamPart[] = [];
	if (reasoningTokens) {
		parts.push({ type: "reasoning-start", id: "reasoning-0" });
		for (let i = 0; i < reasoningTokens; i++)
			parts.push({
				type: "reasoning-delta",
				id: "reasoning-0",
				delta: " word",
			});
		parts.push({ type: "reasoning-end", id: "reasoning-0" });
	}
	parts.push({ type: "text-start", id: "txt-0" });
	for (let i = 0; i < answerTokens; i++)
		parts.push({ type: "text-delta", id: "txt-0", delta: " word" });
	parts.push({ type: "text-end", id: "txt-0" });
	parts.push({
		type: "finish",
		usage,
		finishReason: { unified: "stop", raw: "stop" },
	});
	const journal = new StreamReplayJournal();
	let streamedTokens = 0;
	let wireBytes = 0;
	let overflowAtToken: number | null = null;
	let overflowAtBytes: number | null = null;
	const append = (frame: string) => {
		wireBytes += Buffer.byteLength(frame);
		journal.append(frame);
		if (overflowAtToken === null && !journal.read().complete) {
			overflowAtToken = streamedTokens;
			overflowAtBytes = wireBytes;
		}
	};
	const writer = createOutputEventWriter(
		(frame) => {
			append(frame);
			return true;
		},
		{ compact: compactWire },
	);
	const runtime = createServerChunkRuntime({
		enqueueChunk: (frame) => {
			append(frame);
			return true;
		},
		structuredOutput: true,
		structuralTransport: () => compactWire,
	});
	const run = runNormalChatCompletion(
		{
			provider,
			messages: [{ role: "user" as const, content: "synthetic request" }],
			completionPolicy: {
				turnId: segmentId,
				segmentId,
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
				forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
				onOutputEvent: (event) => {
					if (event.type === "block_delta") streamedTokens++;
					if (compactWire) writer.write(event);
					else append(streamNormalChatOutputEvent(event));
				},
			},
		},
		{
			model: new MockLanguageModelV3({
				doStream: async () => ({
					stream: new ReadableStream<LanguageModelV3StreamPart>({
						start(controller) {
							for (const part of parts) controller.enqueue(part);
							controller.close();
						},
					}),
				}),
			}),
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
		},
		true,
	);
	for (;;) {
		const next = await run.next();
		if (next.done) break;
		if (next.value.type === "reasoning_delta")
			compactWire
				? runtime.emitThinking(next.value.text)
				: append(streamReasoningDeltaEvent(next.value.text));
		if (next.value.type === "text_delta")
			compactWire
				? runtime.emitChunkWithOutputHandling(next.value.text)
				: append(streamTextDeltaEvent(next.value.text));
	}
	writer.flush();
	runtime.flushPendingThinking();
	runtime.flushOutputBuffer();
	return {
		reasoningTokens,
		answerTokens,
		totalStreamedTokens: streamedTokens,
		totalWireBytes: wireBytes,
		replayCompleteAtEnd: journal.read().complete,
		replayBytes: Buffer.byteLength(journal.read().chunks.join("")),
		replayFrames: journal.read().chunks.length,
		overflowAtToken,
		overflowAtBytes,
	};
}

describe("compact complete replay", () => {
	it("retains the reviewed 3,157-token turn within the same byte bound", async () => {
		const row = await overflowPoint(1200, 1957);
		expect(row.replayCompleteAtEnd).toBe(true);
		expect(row.overflowAtToken).toBeNull();
		expect(row.replayBytes).toBeLessThan(40_000);
		expect(row.replayFrames).toBeLessThan(30);
	});
});

it("bounds the reviewed turn on the live wire as well as in retained replay", async () => {
	const row = await overflowPoint(1200, 1957, true);
	process.stdout.write(
		`${JSON.stringify({ measurement: "reviewed-turn-wire", ...row })}\n`,
	);
	expect(row.totalStreamedTokens).toBe(3157);
	expect(row.totalWireBytes).toBeLessThan(40000);
	expect(row.replayCompleteAtEnd).toBe(true);
});
