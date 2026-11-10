import { expect, it } from "vitest";
import type { NormalChatContinuationSnapshot } from "../normal-chat-model";
import { buildAskResumeCapture, buildAskResumeSnapshot } from "./ask-capture";
import { normalizeAssistantOutputWithSkillControl } from "./normalizer";
import {
	createServerChunkRuntime,
	decodeUiMessageStreamParts,
	streamNormalChatOutputEvent,
} from "./stream";

it("never classifies an explicit answer's narration as activity", () => {
	const text = "Let me check.\n\n## Result\n42";
	expect(
		normalizeAssistantOutputWithSkillControl(text, { structuredOutput: true })
			.visibleText,
	).toBe(text);
	const frames: string[] = [];
	const runtime = createServerChunkRuntime({
		enqueueChunk: (chunk) => {
			frames.push(chunk);
			return true;
		},
		structuredOutput: true,
	});
	runtime.emitChunkWithOutputHandling(text);
	runtime.flushInlineThinkingBuffer();
	expect(runtime.fullResponse).toBe(text);
});
it("adapts the frozen output event directly to the existing data grammar", () => {
	const event = {
		version: 1 as const,
		turnId: "t",
		segmentId: "s",
		attemptId: "a",
		stepId: "step",
		phase: "working" as const,
		sequence: 0,
		type: "step_start" as const,
	};
	expect(
		decodeUiMessageStreamParts(streamNormalChatOutputEvent(event)),
	).toEqual([
		expect.objectContaining({ type: "data-normal-chat-output", data: event }),
	]);
});
it("captures full original inline context and replaces only the answered ask in exact resume", () => {
	const snapshot: NormalChatContinuationSnapshot = {
		version: 1,
		fidelity: "exact",
		turnId: "t",
		segmentId: "s",
		original: {
			providerId: "p",
			providerBaseUrl: "http://local",
			modelName: "m",
			system: "original instructions",
			messages: [{ role: "user", content: "original INLINE evidence" }],
		},
		steps: [
			{
				segmentId: "s",
				attemptId: "a",
				stepId: "step",
				phase: "working",
				finished: true,
				toolAttempted: true,
				finishReason: "tool-calls",
				inserts: [],
				imageEntries: [],
				response: [
					{
						role: "assistant",
						content: [
							{ type: "reasoning", text: "real signed thought" },
							{
								type: "tool-call",
								toolName: "ask_user",
								toolCallId: "ask",
								input: {},
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								type: "tool-result",
								toolName: "ask_user",
								toolCallId: "ask",
								output: { type: "json", value: { paused: true } },
							},
						],
					},
				],
			},
		],
		prepared: { maxOutputTokens: 1024 },
		pendingImageEntries: [],
		executions: [],
		events: [],
		usage: [],
		sequence: 0,
		nextAttempt: 0,
		workingSteps: 1,
		closingSegments: [],
		deadlineAt: Date.now() + 10000,
		totalTimeoutMs: 10000,
	};
	const capture = buildAskResumeCapture({
		continuationGiven: [],
		responseMessages: snapshot.steps[0].response,
		toolCalls: [],
		priorResults: [],
		snapshot,
	});
	expect(capture.v).toBe(2);
	const answer = { status: "answered", answers: [] } as Parameters<
		typeof buildAskResumeSnapshot
	>[2];
	const resumed = buildAskResumeSnapshot(capture, "ask", answer);
	expect(resumed?.original).toEqual(snapshot.original);
	expect(resumed?.steps[0].response[0]).toEqual(snapshot.steps[0].response[0]);
	expect(resumed?.steps[0].response[1]).not.toEqual(
		snapshot.steps[0].response[1],
	);
	expect(snapshot.steps[0].response[1]).toMatchObject({
		content: [{ output: { value: { paused: true } } }],
	});
});
