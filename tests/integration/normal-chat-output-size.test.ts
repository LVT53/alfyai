import { createHash } from "node:crypto";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { streamNormalChatOutputEvent } from "$lib/server/services/chat-turn/stream";
import { runNormalChatCompletion } from "$lib/server/services/normal-chat-model/completion";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";
import { accountingReadFixture } from "./accounting-read-fixture";

// Regression from the independent review: snapshot metadata grows with block
// text, not the number of provider deltas. Live wire events stay incremental.

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

// The same identity shape completion-lifetime.ts produces for a stream turn:
// sha256 hex of [userId, conversationId, requestId]; turnId defaults to it.
const segmentId = createHash("sha256")
	.update(JSON.stringify(["user", "conversation", "stream"]))
	.digest("hex");

async function measure(reasoningTokens: number, answerTokens: number) {
	const parts: LanguageModelV3StreamPart[] = [];
	if (reasoningTokens > 0) {
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
	const model = new MockLanguageModelV3({
		doStream: async () => ({ stream: stream(parts) }),
	});
	const wireEvents: NormalChatOutputEvent[] = [];
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
				onOutputEvent: (event) => wireEvents.push(event),
			},
		},
		dependencies(model),
		true,
	);
	let legacyTextDeltaEvents = 0;
	let legacyTextChars = 0;
	let result: Awaited<ReturnType<typeof run.next>>;
	for (;;) {
		result = await run.next();
		if (result.done) break;
		if (result.value.type === "text_delta") {
			legacyTextDeltaEvents++;
			legacyTextChars += result.value.text.length;
		}
	}
	const snapshot = result.value.continuation;
	if (!snapshot) throw new Error("no continuation");
	// Exactly what finalize.ts:587-592 writes into the assistant message metadata.
	const persisted = JSON.stringify({
		normalChatOutput: {
			version: 1,
			events: snapshot.events.filter((e) => e.segmentId === snapshot.segmentId),
		},
	});
	const wireBytes = wireEvents.reduce(
		(n, event) => n + Buffer.byteLength(streamNormalChatOutputEvent(event)),
		0,
	);
	return {
		outcome: result.value.completion?.outcome,
		answerChars: result.value.text.length,
		events: snapshot.events.length,
		persistedBytes: Buffer.byteLength(persisted),
		structuralWireBytes: wireBytes,
		legacyTextDeltaEvents,
		legacyTextChars,
	};
}

describe("compact persisted structural events", () => {
	it("reports the stored and wire size for realistic replies", async () => {
		const rows = [];
		for (const [reasoning, answer] of [
			[0, 300],
			[1200, 1957],
			[2000, 4000],
		] as const) {
			rows.push({ reasoning, answer, ...(await measure(reasoning, answer)) });
		}
		console.log(JSON.stringify(rows, null, 1));
		// The natural answer is promoted only at settlement: one legacy text delta.
		expect(rows[0].outcome).toBe("answered");
		expect(rows[0].legacyTextDeltaEvents).toBe(1);
		for (const row of rows) {
			expect(row.persistedBytes).toBeLessThan(
				(row.reasoning + row.answer) * 5 + 8000,
			);
			expect(row.events).toBeLessThanOrEqual(12);
		}
	}, 120000);
});

it("serves legacy per-token metadata as compact blocks through both readers", async () => {
	const fixture = await accountingReadFixture();
	try {
		const scope = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "a:0",
			phase: "working" as const,
		};
		const events: NormalChatOutputEvent[] = [
			{
				...scope,
				type: "block_start",
				sequence: 1,
				blockId: "b",
				nativeId: "b",
				kind: "text",
				role: "provisional",
			},
		];
		for (let i = 0; i < 1000; i++)
			events.push({
				...scope,
				type: "block_delta",
				sequence: i + 2,
				blockId: "b",
				text: " word",
			});
		events.push(
			{ ...scope, type: "block_end", sequence: 1002, blockId: "b" },
			{
				...scope,
				type: "step_settled",
				sequence: 1003,
				role: "answer",
				finishReason: "stop",
			},
		);
		fixture.message("legacy", "assistant", {
			normalChatOutput: { version: 1, events },
		});
		for (const rows of [
			(await fixture.readers.listMessageWindow("c", {})).messages,
			await fixture.readers.listMessages("c"),
		]) {
			const metadata = rows[0].normalChatOutput;
			expect(metadata).toBeDefined();
			if (!metadata) throw new Error("Missing structural output metadata");
			expect(JSON.stringify(metadata).length).toBeLessThan(7000);
			expect(metadata.events).toHaveLength(4);
			expect(projectNormalChatOutput(metadata.events).answer).toBe(
				" word".repeat(1000),
			);
		}
	} finally {
		fixture.close();
	}
});
