import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
	type NormalChatContinuationSnapshot,
	runNormalChatCompletion,
} from "$lib/server/services/normal-chat-model/completion";
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
