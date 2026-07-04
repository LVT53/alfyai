import { describe, expect, it } from "vitest";
import {
	type AiSdkUiStreamFixturePayload,
	encodeAiSdkUiFixtureFrame,
} from "../tests/fixtures/ai-sdk-ui-stream-contract";
import {
	type BenchmarkRunResult,
	type BenchmarkSummary,
	compareBenchmarkSummaries,
	formatBenchmarkComparison,
	parseBenchmarkStreamChunks,
	summarizeBenchmarkRuns,
} from "./benchmark-live-chat-stream";

function frame(payload: AiSdkUiStreamFixturePayload): string {
	return encodeAiSdkUiFixtureFrame(payload);
}

function run(overrides: Partial<BenchmarkRunResult>): BenchmarkRunResult {
	return {
		runIndex: 1,
		prompt: "Say hello.",
		modelId: "model-fixed",
		streamId: "stream-1",
		conversationId: "conversation-1",
		startedAt: "2026-06-29T10:00:00.000Z",
		endedAt: "2026-06-29T10:00:01.000Z",
		chunkCount: 3,
		textLength: 12,
		outcome: "ok",
		responseHeadersMs: 20,
		firstByteMs: 30,
		firstActivityMs: 40,
		firstThinkingMs: 50,
		firstToolCallMs: 60,
		firstTokenMs: 70,
		finishPartMs: 90,
		endMs: 100,
		serverTiming: {},
		serverTimeline: {},
		...overrides,
	};
}

describe("live chat stream benchmark stream parser", () => {
	it("extracts client timing marks, stream metadata, and server timings from AI SDK UI chunks", () => {
		const result = parseBenchmarkStreamChunks(
			[
				{
					text: frame({
						type: "data-response-activity",
						data: { id: "context-preparing" },
						transient: true,
					}),
					elapsedMs: 120,
				},
				{
					text: frame({
						type: "reasoning-delta",
						id: "reasoning",
						delta: "Thinking",
					}),
					elapsedMs: 140,
				},
				{
					text: frame({
						type: "data-tool-call",
						data: { name: "memory_context" },
						transient: true,
					}),
					elapsedMs: 160,
				},
				{
					text: frame({
						type: "text-delta",
						id: "answer",
						delta: "Hello",
					}),
					elapsedMs: 180,
				},
				{
					text: frame({
						type: "data-stream-metadata",
						data: {
							streamId: "stream-from-metadata",
							conversationId: "conversation-from-metadata",
							serverTimeline: {
								version: 1,
								server: {
									route_parse: 1,
									first_visible_token: 42,
									end: 70,
								},
							},
						},
						transient: true,
					}),
					elapsedMs: 200,
				},
				{
					text: frame({ type: "finish", finishReason: "stop" }),
					elapsedMs: 220,
				},
				{ text: frame("[DONE]"), elapsedMs: 225 },
			],
			{
				responseHeadersMs: 100,
				serverTimingHeader:
					'route_parse;dur=1.5, ignored;dur=-4, prelude;desc="ok";dur=3.5',
				endMs: 230,
			},
		);

		expect(result).toMatchObject({
			responseHeadersMs: 100,
			firstByteMs: 120,
			firstActivityMs: 120,
			firstThinkingMs: 140,
			firstToolCallMs: 160,
			firstTokenMs: 180,
			finishPartMs: 220,
			endMs: 230,
			chunkCount: 7,
			textLength: 5,
			finishReason: "stop",
			streamId: "stream-from-metadata",
			conversationId: "conversation-from-metadata",
			outcome: "ok",
			serverTiming: {
				route_parse: 1.5,
				prelude: 3.5,
			},
			serverTimeline: {
				route_parse: 1,
				first_visible_token: 42,
				end: 70,
			},
		});
	});

	it("captures answer text for deterministic downstream quality scoring", () => {
		const result = parseBenchmarkStreamChunks(
			[
				{
					text: frame({
						type: "text-delta",
						id: "answer",
						delta: "First sentence. ",
					}),
					elapsedMs: 20,
				},
				{
					text: frame({
						type: "text-delta",
						id: "answer",
						delta: "Second sentence.",
					}),
					elapsedMs: 40,
				},
				{
					text: frame({
						type: "data-tool-call",
						data: { name: "research_web" },
						transient: true,
					}),
					elapsedMs: 50,
				},
				{
					text: frame({
						type: "data-stream-metadata",
						data: {
							depthMetadata: {
								requested: "auto",
								appliedProfile: "maximum",
								fallback: false,
							},
							thinkingTokenCount: 7,
							responseTokenCount: 11,
							totalTokenCount: 18,
							generationDurationMs: 1234,
						},
						transient: true,
					}),
					elapsedMs: 60,
				},
				{
					text: frame({ type: "finish", finishReason: "stop" }),
					elapsedMs: 70,
				},
			],
			{ endMs: 80, maxAnswerTextLength: 20 },
		);

		expect(result).toMatchObject({
			textLength: 32,
			answerText: "First sentence. Seco",
			answerTextTruncated: true,
			toolCallCount: 1,
			toolCallNames: ["research_web"],
			depthMetadata: {
				requested: "auto",
				appliedProfile: "maximum",
				fallback: false,
			},
			tokenCounts: {
				thinking: 7,
				response: 11,
				total: 18,
			},
			generationDurationMs: 1234,
		});
	});
});

describe("live chat stream benchmark summary", () => {
	it("summarizes successful and failed runs with percentile stats for client and server timings", () => {
		const summary = summarizeBenchmarkRuns(
			[
				run({
					runIndex: 1,
					firstTokenMs: 100,
					endMs: 300,
					serverTimeline: { first_visible_token: 80, end: 250 },
				}),
				run({
					runIndex: 2,
					firstTokenMs: 120,
					endMs: 330,
					serverTimeline: { first_visible_token: 90, end: 280 },
				}),
				run({
					runIndex: 3,
					firstTokenMs: 180,
					endMs: 450,
					serverTimeline: { first_visible_token: 140, end: 360 },
				}),
				run({
					runIndex: 4,
					outcome: "error",
					error: "stream HTTP 500",
					firstTokenMs: undefined,
					endMs: 50,
				}),
			],
			{
				baseUrl: "https://ai.example.test",
				modelId: "model-fixed",
				generatedAt: "2026-06-29T10:00:05.000Z",
			},
		);

		expect(summary).toMatchObject({
			generatedAt: "2026-06-29T10:00:05.000Z",
			baseUrl: "https://ai.example.test",
			modelId: "model-fixed",
			runCount: 4,
			okCount: 3,
			errorCount: 1,
			clientTimings: {
				firstTokenMs: { count: 3, min: 100, p50: 120, p95: 180, mean: 133.3 },
				endMs: { count: 4, min: 50, p50: 300, p95: 450, mean: 282.5 },
			},
			serverTimeline: {
				first_visible_token: {
					count: 3,
					min: 80,
					p50: 90,
					p95: 140,
					mean: 103.3,
				},
				end: { count: 3, min: 250, p50: 280, p95: 360, mean: 296.7 },
			},
		});
	});
});

describe("live chat stream benchmark compare mode", () => {
	it("compares p50 timing deltas concisely", () => {
		const oldSummary: BenchmarkSummary = {
			generatedAt: "2026-06-29T09:00:00.000Z",
			baseUrl: "https://ai.example.test",
			modelId: "model-fixed",
			runCount: 5,
			okCount: 5,
			errorCount: 0,
			clientTimings: {
				firstTokenMs: { count: 5, min: 170, p50: 200, p95: 240, mean: 205 },
			},
			serverTiming: {},
			serverTimeline: {
				end: { count: 5, min: 420, p50: 500, p95: 580, mean: 505 },
			},
		};
		const newSummary: BenchmarkSummary = {
			...oldSummary,
			generatedAt: "2026-06-29T10:00:00.000Z",
			clientTimings: {
				firstTokenMs: { count: 5, min: 120, p50: 150, p95: 210, mean: 160 },
			},
			serverTimeline: {
				end: { count: 5, min: 360, p50: 400, p95: 460, mean: 405 },
			},
		};

		const comparison = compareBenchmarkSummaries(oldSummary, newSummary);
		expect(comparison.rows).toEqual([
			{
				metric: "client.firstTokenMs",
				oldP50: 200,
				newP50: 150,
				deltaP50: -50,
				percentChange: -25,
			},
			{
				metric: "serverTimeline.end",
				oldP50: 500,
				newP50: 400,
				deltaP50: -100,
				percentChange: -20,
			},
		]);
		expect(formatBenchmarkComparison(comparison)).toContain(
			"client.firstTokenMs",
		);
		expect(formatBenchmarkComparison(comparison)).toContain("-50.0");
	});
});
