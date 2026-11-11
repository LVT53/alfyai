import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalChatTurnObservation } from "$lib/services/ai-sdk-ui-stream-contract";
import type {
	NormalChatOutputEvent,
	NormalChatOutputProjection,
} from "$lib/shared/normal-chat-output";
import {
	aiSdkUiStreamCloseAfterFinishSequence,
	aiSdkUiStreamContractMetadata,
	aiSdkUiStreamContractSequence,
	aiSdkUiStreamContractToolCall,
	aiSdkUiStreamReplaySequence,
	encodeAiSdkUiFixtureFrames,
	malformedAiSdkUiStreamFrames,
	oldBrowserSseNamedTokenEvent,
} from "../../../tests/fixtures/ai-sdk-ui-stream-contract";
import type { StreamCallbacks, StreamMetadata } from "./streaming";
import {
	checkForOrphanedStream,
	getStreamBufferInfo,
	isServerUpdateRefusal,
	isStreamTransportFailure,
	streamChat,
} from "./streaming";
import {
	buildControlledFetchResponse,
	endEvent,
	errorEvent,
	flushMicrotasks,
	makeCallbacks,
	makeEventLogCallbacks,
	parseLastStreamRequestBody,
	runStreamAndWait,
	runStreamWithMockedResponse,
	thinkingEvent,
	tokenEvent,
	uiFrame,
} from "./streaming.test-helpers";

describe("streamChat", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("expands compact wire deltas after a replay start without duplicate text", async () => {
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		};
		const start = {
			...scope,
			sequence: 1,
			type: "block_start",
			blockId: "b",
			nativeId: "n",
			kind: "text",
			role: "answer",
		};
		const compact = uiFrame({
			type: "data-normal-chat-delta",
			data: { ref: 1, sequence: 2, text: "Visible" },
		});
		const { callbacks, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "data-replay-start", data: {} }),
				uiFrame({ type: "data-normal-chat-output", data: start }),
				uiFrame({ type: "data-replay-end", data: {} }),
				compact,
				compact,
				endEvent({}),
			],
		});
		await done;
		expect(callbacks.onEnd).toHaveBeenCalledWith("Visible", undefined);
		expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
			"X-Alfy-Output-Transport": "compact-v1",
		});
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("reports unknown compact wire references as transport errors", async () => {
		const { callbacks, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-normal-chat-delta",
					data: { ref: 404, sequence: 2, text: "Wrong" },
				}),
				endEvent({}),
			],
		});
		await done;
		expect(callbacks.onError).toHaveBeenCalledTimes(1);
		expect(callbacks.onEnd).not.toHaveBeenCalled();
	});

	it("preserves the pending model deadline in observation metadata", async () => {
		const observation = {
			version: 1,
			state: "pending",
			streamId: "observer",
			conversationId: "conv-1",
			turnId: "t",
			segmentId: "s",
			deadlineAt: Date.now() + 500_000,
		} as const;
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent({ observation })],
		});
		await done;
		expect(cb.onEnd).toHaveBeenCalledWith(
			"",
			expect.objectContaining({ observation }),
		);
	});

	it.each([
		"Let me check.",
		"Hello. Let me check.",
	])("keeps %s out of the answer across distinct SSE IDs", async (working) => {
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		};
		const events = [
			{
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "b",
				nativeId: "text-1",
				kind: "text",
				role: "provisional",
			},
			{
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "b",
				text: working,
			},
			{
				...scope,
				sequence: 2,
				type: "step_settled",
				role: "activity",
				finishReason: "tool-calls",
			},
			{
				...scope,
				stepId: "c",
				phase: "closing",
				sequence: 3,
				type: "block_start",
				blockId: "c",
				nativeId: "text-2",
				kind: "text",
				role: "answer",
			},
			{
				...scope,
				stepId: "c",
				phase: "closing",
				sequence: 4,
				type: "block_delta",
				blockId: "c",
				text: "## Result",
			},
		];
		const views: { answer: string; activity: string[] }[] = [];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				...events.flatMap((event) => [
					uiFrame({ type: "data-normal-chat-output", data: event }),
					uiFrame({ type: "text-delta", id: "old", delta: "duplicate" }),
				]),
				uiFrame({ type: "data-normal-chat-output", data: events[4] }),
				endEvent({ finalContent: "## Result [repaired]" }),
			],
			callbacks: {
				...makeCallbacks(),
				onNormalChatOutput: (view: NormalChatOutputProjection) => {
					views.push({
						answer: view.answer,
						activity: view.activity.map((b) => b.text),
					});
				},
			},
		});
		await done;
		expect(views[1]).toEqual({ answer: "", activity: [working] });
		expect(views.at(-1)).toEqual({ answer: "## Result", activity: [working] });
		expect(views).toHaveLength(5);
		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith(
			"## Result",
			expect.objectContaining({ finalContent: "## Result [repaired]" }),
		);
	});

	it.each([
		"natural",
		"replay",
		"tool",
		"missing-finish",
		"closing-error",
	])("preserves block order and explicit roles on %s", async (scenario) => {
		const natural = scenario === "natural" || scenario === "replay";
		const replayLog = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "w",
			phase: scenario === "closing-error" ? "closing" : "working",
		} as const;
		let sequence = 0;
		const events: NormalChatOutputEvent[] = [
			{
				...scope,
				sequence: sequence++,
				type: "block_start",
				blockId: "first",
				nativeId: "1",
				kind: "text",
				role: scenario === "closing-error" ? "answer" : "provisional",
			},
			{
				...scope,
				sequence: sequence++,
				type: "block_delta",
				blockId: "first",
				text: "## Heading\n",
			},
			{
				...scope,
				sequence: sequence++,
				type: "block_start",
				blockId: "second",
				nativeId: "2",
				kind: "text",
				role: scenario === "closing-error" ? "answer" : "provisional",
			},
			{
				...scope,
				sequence: sequence++,
				type: "block_delta",
				blockId: "second",
				text: "```ts\ncode\n```",
			},
		];
		if (natural || scenario === "tool")
			events.push({
				...scope,
				sequence: sequence++,
				type: "step_settled",
				role: natural ? "answer" : "activity",
				finishReason: natural ? "stop" : "tool-calls",
			});
		const views: { answer: string; ids: string[] }[] = [];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				...(scenario === "replay"
					? [uiFrame({ type: "data-replay-start" })]
					: []),
				...events.map((event) =>
					uiFrame({ type: "data-normal-chat-output", data: event }),
				),
				...(scenario === "replay"
					? [uiFrame({ type: "data-replay-end" })]
					: []),
				...(scenario === "missing-finish"
					? []
					: scenario === "closing-error"
						? [errorEvent({ message: "failed" })]
						: [endEvent()]),
			],
			callbacks: {
				...makeCallbacks(),
				onNormalChatOutput: (view: NormalChatOutputProjection) => {
					views.push({
						answer: view.answer,
						ids: view.blocks.map((b) => b.nativeId),
					});
				},
			},
		});
		await done;
		replayLog.mockRestore();
		expect(views.at(-1)).toEqual({
			answer:
				natural || scenario === "closing-error"
					? "## Heading\n```ts\ncode\n```"
					: "",
			ids: ["1", "2"],
		});
		if (natural)
			expect(views.slice(0, -1).every((v) => v.answer === "")).toBe(true);
		if (scenario === "missing-finish" || scenario === "closing-error") {
			expect(cb.onError).toHaveBeenCalled();
			expect(cb.onEnd).not.toHaveBeenCalled();
		}
	});

	it("keeps real structural reasoning distinct from commentary and ignores legacy duplicates", async () => {
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		} as const;
		const events: NormalChatOutputEvent[] = [
			{
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "r",
				nativeId: "reason",
				kind: "reasoning",
				role: "activity",
			},
			{
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "r",
				text: "Real reasoning",
			},
			{
				...scope,
				sequence: 2,
				type: "block_start",
				blockId: "b",
				nativeId: "text",
				kind: "text",
				role: "provisional",
			},
			{
				...scope,
				sequence: 3,
				type: "block_delta",
				blockId: "b",
				text: "Ordinary commentary",
			},
		];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				...events.map((event) =>
					uiFrame({ type: "data-normal-chat-output", data: event }),
				),
				thinkingEvent("duplicate reasoning"),
				endEvent(),
			],
		});
		await done;
		expect(cb.onThinking.mock.calls).toEqual([["Real reasoning"]]);
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
	});

	it.each([
		false,
		true,
	])("retains finalization terminal metadata through finish(error/stop), stopped=%s", async (wasStopped) => {
		const modelCompletion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "closing",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "tool_budget",
			closingAttempted: true,
		} as const;
		const normalChatFinalization = {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped,
		} as const;
		const observation = {
			version: 1,
			streamId: "observer",
			conversationId: "conv-1",
			state: "terminal",
			assistantMessageId: "saved",
			modelCompletion,
			normalChatFinalization,
			completion: {
				...modelCompletion,
				outcome: wasStopped ? "stopped" : "failed",
				stopCause: wasStopped ? "user_stop" : "uncertain_execution",
			},
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-stream-metadata",
					data: { observation, normalChatFinalization },
					transient: true,
				}),
				uiFrame({
					type: "finish",
					finishReason: wasStopped ? "stop" : "error",
				}),
				uiFrame("[DONE]"),
			],
		});
		await done;
		expect(cb.onError).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith(
			"",
			expect.objectContaining({ observation, normalChatFinalization }),
		);
	});

	it.each([
		"missing-model",
		"missing-effective",
		"invalid-effective-shape",
		"invalid-assistant-id",
		"wrong-effective",
		"invalid-marker",
		"mirrored-id",
		"mirrored-status",
	] as const)("does not erase malformed or mismatched finalization truth: %s", async (variant) => {
		const modelCompletion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "closing",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "tool_budget",
			closingAttempted: true,
		} as const;
		const normalChatFinalization = {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped: false,
		} as const;
		const observation = {
			version: 1,
			streamId: "observer",
			conversationId: "conv-1",
			state: "terminal",
			assistantMessageId: variant === "invalid-assistant-id" ? 123 : "saved",
			modelCompletion:
				variant === "missing-model" ? undefined : modelCompletion,
			normalChatFinalization:
				variant === "invalid-marker"
					? { ...normalChatFinalization, version: 2 }
					: normalChatFinalization,
			completion:
				variant === "missing-effective"
					? undefined
					: variant === "invalid-effective-shape"
						? { ...modelCompletion, version: 2 }
						: variant === "wrong-effective"
							? modelCompletion
							: {
									...modelCompletion,
									outcome: "failed",
									stopCause: "uncertain_execution",
								},
		};
		const data = {
			observation,
			...(variant === "mirrored-id" ? { assistantMessageId: "wrong-row" } : {}),
			...(variant === "mirrored-status"
				? {
						normalChatFinalization: {
							...normalChatFinalization,
							wasStopped: true,
						},
					}
				: {}),
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "data-stream-metadata", data, transient: true }),
				uiFrame({ type: "finish", finishReason: "error" }),
				uiFrame("[DONE]"),
			],
		});
		await done;
		expect(cb.onError).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith(
			"",
			expect.objectContaining({
				observation: {
					version: 1,
					streamId: "observer",
					conversationId: "conv-1",
					state: "unavailable",
				},
			}),
		);
	});

	it("preserves scoped observer terminal truth in stream metadata", async () => {
		const observation: NormalChatTurnObservation = {
			version: 1,
			streamId: "observer",
			conversationId: "conv-1",
			state: "terminal",
			assistantMessageId: null,
			completion: {
				version: 1,
				turnId: "t",
				segmentId: "s",
				phase: "closing",
				outcome: "incomplete",
				stopCause: "uncertain_execution",
				workingStopCause: "transport_error",
				closingAttempted: true,
			},
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent({ observation })],
		});
		await done;
		expect(cb.onEnd).toHaveBeenCalledWith(
			"",
			expect.objectContaining({ observation }),
		);
	});

	it("decodes the shared AI SDK UI stream contract fixture end-to-end", async () => {
		const onToolCall = vi.fn();
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: encodeAiSdkUiFixtureFrames(aiSdkUiStreamContractSequence),
			callbacks: {
				...makeCallbacks(),
				onToolCall,
			},
		});
		await done;

		expect(cb.onThinking).toHaveBeenCalledWith("Need current evidence.");
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
		expect(onToolCall).toHaveBeenCalledWith(
			aiSdkUiStreamContractToolCall.name,
			aiSdkUiStreamContractToolCall.input,
			aiSdkUiStreamContractToolCall.status,
			{
				callId: aiSdkUiStreamContractToolCall.callId,
				outputSummary: aiSdkUiStreamContractToolCall.outputSummary,
				sourceType: aiSdkUiStreamContractToolCall.sourceType,
				candidates: aiSdkUiStreamContractToolCall.candidates,
				metadata: aiSdkUiStreamContractToolCall.metadata,
			},
		);
		expect(cb.onEnd).toHaveBeenCalledWith(
			"Hello world",
			aiSdkUiStreamContractMetadata,
		);
	});

	it("ignores old Browser SSE named token events without partial rendering", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [oldBrowserSseNamedTokenEvent, uiFrame("[DONE]")],
		});
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("ignores malformed AI SDK UI stream fixture frames without partial rendering", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [...malformedAiSdkUiStreamFrames, uiFrame("[DONE]")],
		});
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("finishes successfully when the stream closes after the finish fixture frame", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: encodeAiSdkUiFixtureFrames(
				aiSdkUiStreamCloseAfterFinishSequence,
			),
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("buffers the shared replay fixture until replay-end before waiting", async () => {
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const events: string[] = [];
		const { done } = runStreamWithMockedResponse({
			responseChunks: encodeAiSdkUiFixtureFrames(aiSdkUiStreamReplaySequence),
			callbacks: makeEventLogCallbacks(events),
		});
		await done;

		expect(events).toEqual([
			"token:Hello",
			"thinking:Need current evidence.",
			"waiting",
			"end:Hello",
		]);
		consoleInfo.mockRestore();
	});

	it("calls onToken for AI SDK UI text-delta frames and ends on [DONE]", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Hello" }),
				uiFrame({ type: "text-delta", id: "text-1", delta: " world" }),
				uiFrame("[DONE]"),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello world", undefined);
	});

	it("maps AI SDK UI reasoning, metadata, and finish frames onto existing callbacks", async () => {
		const metadata = {
			thinkingTokenCount: 4,
			responseTokenCount: 5,
			totalTokenCount: 9,
			assistantMessageId: "assistant-1",
			modelDisplayName: "Model 1",
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "reasoning-delta",
					id: "reasoning-1",
					delta: "Need to reason",
				}),
				uiFrame({ type: "text-delta", id: "text-1", delta: "Answer" }),
				uiFrame({
					type: "data-stream-metadata",
					data: metadata,
					transient: true,
				}),
				uiFrame({ type: "finish" }),
			],
		});
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason");
		expect(cb.onToken).toHaveBeenCalledWith("Answer");
		expect(cb.onEnd).toHaveBeenCalledWith("Answer", metadata);
	});

	// The user's per-turn choices ride the terminal metadata frame (see
	// $lib/message-user-intent.ts) and are validated on the way in.
	it("carries a valid userIntent from the terminal metadata frame", async () => {
		const userIntent = {
			skill: { id: "skill-1", displayName: "Invoice reply" },
			webSearch: true,
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Answer" }),
				uiFrame({
					type: "data-stream-metadata",
					data: { assistantMessageId: "assistant-1", userIntent },
					transient: true,
				}),
				uiFrame({ type: "finish" }),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith(
			"Answer",
			expect.objectContaining({ userIntent }),
		);
	});

	it("carries the turn's skill drafts from the terminal metadata frame", async () => {
		// The Save/Dismiss card is drawn from these: a turn that drafted a
		// skill must hand them to the message in the session that made it.
		const skillDrafts = [
			{
				id: "weekly-status",
				status: "proposed",
				displayName: "Weekly status",
				description: "Writes a short weekly status update.",
				instructions: "Write one short paragraph: done, next, blocked.",
				activationExamples: ["Write my weekly status."],
				durationPolicy: "next_message",
				questionPolicy: "none",
				notesPolicy: "none",
				sourceScope: "current_conversation",
			},
		];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Draft below." }),
				uiFrame({
					type: "data-stream-metadata",
					data: { assistantMessageId: "assistant-1", skillDrafts },
					transient: true,
				}),
				uiFrame({ type: "finish" }),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith(
			"Draft below.",
			expect.objectContaining({ skillDrafts }),
		);
	});

	it("keeps waitingQuestionId from the terminal metadata", async () => {
		// A reply that stopped to ask the person ends like any reply; the terminal
		// metadata names the question that now waits, and the runtime reads it in
		// onEnd to know the turn paused instead of finished.
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Before I go on," }),
				uiFrame({
					type: "data-stream-metadata",
					data: { assistantMessageId: "assistant-1", waitingQuestionId: "q-1" },
					transient: true,
				}),
				uiFrame({ type: "finish", finishReason: "tool-calls" }),
				uiFrame("[DONE]"),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith(
			"Before I go on,",
			expect.objectContaining({
				assistantMessageId: "assistant-1",
				waitingQuestionId: "q-1",
			}),
		);
	});

	it("drops a waitingQuestionId that is not an id", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Answer" }),
				uiFrame({
					type: "data-stream-metadata",
					data: { assistantMessageId: "assistant-1", waitingQuestionId: 7 },
					transient: true,
				}),
				uiFrame({ type: "finish" }),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Answer", {
			assistantMessageId: "assistant-1",
		});
	});

	it("drops a malformed userIntent from the terminal metadata frame", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Answer" }),
				uiFrame({
					type: "data-stream-metadata",
					data: {
						assistantMessageId: "assistant-1",
						userIntent: { skill: "Invoice reply", webSearch: 1 },
					},
					transient: true,
				}),
				uiFrame({ type: "finish" }),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Answer", {
			assistantMessageId: "assistant-1",
		});
	});

	it("calls terminal callbacks once when finish is followed by DONE", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Answer"), endEvent()],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("Answer", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	// The server ends a turn this way when deleting its chat stopped it
	// (chat-turn/stream-completion.ts): the stopped metadata with no message id,
	// then finish and [DONE]. The transport has to read it as a stop. An error, a
	// wait for the original stream or a close without a terminal event would each
	// send the runtime into recovery (a reconnect, a retry bubble) for a chat
	// that is gone.
	it("ends a turn the server stopped because its chat was deleted, with no error, wait or recovery", async () => {
		const events: string[] = [];
		const callbacks = makeEventLogCallbacks(events);
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Partial answer"),
				endEvent({ wasStopped: true }),
			],
			callbacks,
		});
		await done;

		expect(callbacks.onEnd).toHaveBeenCalledOnce();
		expect(callbacks.onEnd).toHaveBeenCalledWith(
			"Partial answer",
			expect.objectContaining({ wasStopped: true }),
		);
		const metadata = callbacks.onEnd.mock.calls[0]?.[1];
		expect(metadata?.assistantMessageId).toBeUndefined();
		expect(metadata?.userMessageId).toBeUndefined();
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(callbacks.onWaiting).not.toHaveBeenCalled();
		expect(events).toEqual(["token:Partial answer", "end:Partial answer"]);
	});

	it("reports the decoded finish part once before DONE while preserving single onEnd completion", async () => {
		const events: string[] = [];
		const callbacks = {
			...makeCallbacks(),
			onFinishPart: vi.fn((part: { finishReason?: string }) => {
				events.push(`finish:${part.finishReason ?? ""}`);
			}),
		};
		callbacks.onEnd.mockImplementation((fullText) => {
			events.push(`end:${fullText}`);
		});

		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Answer"),
				uiFrame({ type: "finish", finishReason: "stop" }),
				uiFrame({ type: "finish", finishReason: "stop" }),
				uiFrame("[DONE]"),
			],
			callbacks,
		});
		await done;

		expect(callbacks.onFinishPart).toHaveBeenCalledOnce();
		expect(callbacks.onFinishPart).toHaveBeenCalledWith({
			type: "finish",
			finishReason: "stop",
		});
		expect(callbacks.onEnd).toHaveBeenCalledOnce();
		expect(callbacks.onEnd).toHaveBeenCalledWith("Answer", undefined);
		expect(events).toEqual(["finish:stop", "end:Answer"]);
	});

	it("maps AI SDK UI tool-call data parts onto the existing tool callback", async () => {
		const onToolCall = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-tool-call",
					data: {
						callId: "call-1",
						name: "web_search",
						input: { query: "OpenAI news" },
						status: "running",
						outputSummary: null,
						sourceType: "web",
						candidates: [
							{
								id: "src-1",
								title: "OpenAI",
								url: "https://openai.com",
								sourceType: "web",
							},
						],
						metadata: { count: 1 },
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onToolCall,
			},
		});
		await done;

		expect(onToolCall).toHaveBeenCalledWith(
			"web_search",
			{ query: "OpenAI news" },
			"running",
			{
				callId: "call-1",
				outputSummary: null,
				sourceType: "web",
				candidates: [
					{
						id: "src-1",
						title: "OpenAI",
						url: "https://openai.com",
						sourceType: "web",
					},
				],
				metadata: { count: 1 },
			},
		);
	});

	it("maps AI SDK UI response-activity data parts onto the activity callback", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "context-ready",
						kind: "context",
						status: "done",
						count: 3,
						occurredAt: 123,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "context-ready",
			kind: "context",
			status: "done",
			count: 3,
			occurredAt: 123,
		});
	});

	it("preserves only known sanitized context preparation classes on response activity", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "context-preparing",
						kind: "context",
						status: "running",
						contextPreparationClass: "context-retrieval",
						stageId: "constructed_context",
						label: "Diagnostic context retrieval",
						detail: "raw_stage=constructed_context",
					},
					transient: true,
				}),
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "context-preparing",
						kind: "context",
						status: "running",
						contextPreparationClass: "prompt_budget",
						stageId: "prompt_budget",
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "context-retrieval",
			}),
		);
		expect(onResponseActivity.mock.calls[0]?.[0]).not.toHaveProperty("stageId");
		expect(onResponseActivity).toHaveBeenNthCalledWith(2, {
			id: "context-preparing",
			kind: "context",
			status: "running",
		});
	});

	// P3c (ADR-0056) — "thought_step" (P3b's classified-step kind) was
	// missing from isResponseActivityKind's allow-list, so every live
	// classified step was silently dropped here before it ever reached
	// message.responseActivity. Asserts the fix directly: this event must
	// now survive the parser intact.
	it("maps classified thought_step response-activity events onto the activity callback", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "thought-step:step-1",
						kind: "thought_step",
						status: "running",
						detail: "weighing-options",
						occurredAt: 789,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "thought-step:step-1",
			kind: "thought_step",
			status: "running",
			detail: "weighing-options",
			occurredAt: 789,
		});
	});

	// Amendment (2026-08-16) to ADR-0056 — buildResponseActivityEntry copies
	// known fields one at a time (not a spread), so a new field added to the
	// wire payload must be explicitly threaded through here too, or it is
	// silently stripped before message.responseActivity ever sees it — the
	// exact same class of bug the "thought_step" kind allow-list gap above
	// was. Asserts the `summary` field survives the parser intact.
	it("carries the entity-grounded summary field on a classified thought_step response-activity event", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "thought-step:step-2",
						kind: "thought_step",
						status: "running",
						detail: "weighing-options",
						label: "option A",
						summary: "Comparing option A against option B",
						occurredAt: 789,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "thought-step:step-2",
			kind: "thought_step",
			status: "running",
			detail: "weighing-options",
			label: "option A",
			summary: "Comparing option A against option B",
			occurredAt: 789,
		});
	});

	// P2's "acknowledgment" kind had the exact same pre-existing gap — fixed
	// alongside "thought_step" since it is the identical one-line allow-list.
	it("maps instant-acknowledgment response-activity events onto the activity callback", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "turn-acknowledged",
						kind: "acknowledgment",
						status: "running",
						detail: "research",
						label: "the weather in Paris",
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "turn-acknowledged",
			kind: "acknowledgment",
			status: "running",
			detail: "research",
			label: "the weather in Paris",
		});
	});

	// The same allow-list gap, for the line that says Alfy is looking at the
	// pictures of the message: a kind the parser does not list is dropped before
	// it reaches message.responseActivity, and the line never shows.
	it("maps viewing_images response-activity events onto the activity callback, with their count", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "viewing-images",
						kind: "viewing_images",
						status: "running",
						count: 2,
						occurredAt: 456,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledTimes(1);
		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "viewing-images",
			kind: "viewing_images",
			status: "running",
			count: 2,
			occurredAt: 456,
		});
	});

	it("maps AI SDK UI stream-error data parts onto onError with code", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-stream-error",
					data: {
						message: "Upstream failed",
						code: "UPSTREAM_FAILURE",
					},
					transient: true,
				}),
			],
		});
		await done;

		const error = cb.onError.mock.calls[0]?.[0] as
			| (Error & { code?: string })
			| undefined;
		expect(error?.message).toBe("Upstream failed");
		expect(error?.code).toBe("UPSTREAM_FAILURE");
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("buffers AI SDK UI replayed chunks until replay end before waiting", async () => {
		const controlled = buildControlledFetchResponse();
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const events: string[] = [];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: controlled.response,
			callbacks: makeEventLogCallbacks(events),
		});

		await flushMicrotasks();
		controlled.enqueue(
			uiFrame({ type: "data-replay-start", data: {}, transient: true }),
			uiFrame({ type: "text-delta", id: "text-1", delta: "Buffered" }),
			uiFrame({
				type: "reasoning-delta",
				id: "reasoning-1",
				delta: "Reasoning",
			}),
		);
		await flushMicrotasks();

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();

		controlled.enqueue(
			uiFrame({ type: "data-replay-end", data: {}, transient: true }),
			uiFrame({ type: "data-waiting", data: {}, transient: true }),
			uiFrame("[DONE]"),
		);
		controlled.close();
		await done;

		expect(events).toEqual([
			"token:Buffered",
			"thinking:Reasoning",
			"waiting",
			"end:Buffered",
		]);
		consoleInfo.mockRestore();
	});

	it("calls onToken for each AI SDK UI text delta chunk", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Hello"), tokenEvent(" world"), endEvent()],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
	});

	it("handles AI SDK UI frames split across network chunks", async () => {
		const tokenFrame = tokenEvent("Hello from split frame");
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenFrame.slice(0, 17),
				tokenFrame.slice(17),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledOnce();
		expect(cb.onToken).toHaveBeenCalledWith("Hello from split frame");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from split frame", undefined);
	});

	it("does not render a trailing AI SDK UI frame that closes before the SSE block delimiter", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("partial without delimiter").trimEnd()],
		});
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError.mock.calls[0]?.[0]).toMatchObject({
			message: "Stream closed before a terminal completion event",
		});
	});

	it("includes forceWebSearch in the stream request body for the current turn", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { forceWebSearch: true },
		});
		await done;

		const requestBody = parseLastStreamRequestBody(mockFetch);
		expect(requestBody).toMatchObject({
			message: "test message",
			conversationId: "conv-1",
			forceWebSearch: true,
		});
	});

	it("includes enabledConnectionCapabilities in the stream request body for the current turn", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { enabledConnectionCapabilities: ["files", "calendar"] },
		});
		await done;

		const requestBody = parseLastStreamRequestBody(mockFetch);
		expect(requestBody).toMatchObject({
			message: "test message",
			conversationId: "conv-1",
			enabledConnectionCapabilities: ["files", "calendar"],
		});
	});

	it("omits enabledConnectionCapabilities from the request body when not provided", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
		});
		await done;

		const requestBody = parseLastStreamRequestBody(mockFetch);
		expect(requestBody).not.toHaveProperty("enabledConnectionCapabilities");
	});

	it("calls onEnd with full concatenated text", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Hello"), tokenEvent(" world"), endEvent()],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("Hello world", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("calls onThinking for AI SDK UI reasoning chunks", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				thinkingEvent("Need to reason first"),
				tokenEvent("Final answer"),
				endEvent({ thinking: "Need to reason first" }),
			],
			callbacks: {
				...makeCallbacks(),
				onThinking: vi.fn(),
			},
		});
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason first");
		expect(cb.onEnd).toHaveBeenCalledWith("Final answer", {
			thinking: "Need to reason first",
		});
	});

	it("preserves AI SDK text-field fallback and strips leaked tool calls from reasoning", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "text-delta",
					id: "text-1",
					text: "Hello from text field",
				}),
				uiFrame({
					type: "reasoning-delta",
					id: "reasoning-1",
					text: "Internal<tool_calls>{}</tool_calls> reasoning",
				}),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledWith("Hello from text field");
		expect(cb.onThinking).toHaveBeenCalledWith("Internal reasoning");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from text field", undefined);
	});

	it("routes inline <thinking> tags from text deltas into onThinking", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Before<thinking>Need to reason</thinking>After"),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Before");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, "After");
		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason");
		expect(cb.onEnd).toHaveBeenCalledWith("BeforeAfter", undefined);
	});

	it("handles inline <thinking> tags split across token events", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Start<th"),
				tokenEvent("inking>Need"),
				tokenEvent(" to search</thin"),
				tokenEvent("king>End"),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Start");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, "End");
		expect(cb.onThinking).toHaveBeenCalledTimes(2);
		expect(cb.onThinking).toHaveBeenNthCalledWith(1, "Need");
		expect(cb.onThinking).toHaveBeenNthCalledWith(2, " to search");
		expect(cb.onEnd).toHaveBeenCalledWith("StartEnd", undefined);
	});

	it("parses AI SDK UI stream metadata from the data part", async () => {
		const endMetadata = {
			thinkingTokenCount: 2,
			responseTokenCount: 3,
			totalTokenCount: 5,
			wasStopped: false,
			modelDisplayName: "Model 1",
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model 1",
			},
			contextCompressionSnapshots: [
				{
					id: "snapshot-1",
					trigger: "automatic",
					status: "valid",
					sourceEndMessageId: "message-3",
					createdAt: 1777140000100,
					updatedAt: 1777140000200,
					estimatedTokens: 120,
					sourceTokenEstimate: 420,
				},
			],
		} as Partial<StreamMetadata>;
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Hello"), endEvent(endMetadata)],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", endMetadata);
	});

	it("parses trailing AI SDK UI stream metadata when the stream closes without a final blank line", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Hello"),
				endEvent({
					assistantMessageId: "assistant-1",
					wasStopped: false,
				}).trimEnd(),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", {
			assistantMessageId: "assistant-1",
			wasStopped: false,
		});
	});

	it("reports opt-in client timing without changing token parsing or logging by default", async () => {
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [": prelude\n", "\n", tokenEvent("Hello"), endEvent()],
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledWith("Hello");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello", undefined);
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "/api/chat/stream",
				streamId: expect.any(String),
				phases: expect.objectContaining({
					fetchStartMs: 0,
					responseHeadersMs: expect.any(Number),
					firstByteMs: expect.any(Number),
					firstTokenMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
		expect(consoleInfo).not.toHaveBeenCalled();
		consoleInfo.mockRestore();
	});

	it("correlates browser timing with Server-Timing and terminal server timeline metadata", async () => {
		const serverTimingHeader =
			'route_parse;dur=1.0, capacity;dur=-2, preflight;desc="ok";dur=3.5';
		const serverTimeline = {
			version: 1,
			server: {
				route_parse: 1,
				prelude: 6,
				first_visible_token: 24,
				end: 40,
			},
		};
		const metadata = {
			generationDurationMs: 40,
			serverTimeline,
		} as Partial<StreamMetadata>;
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(
				[
					uiFrame({
						type: "data-response-activity",
						data: {
							id: "context-preparing",
							kind: "context",
							status: "running",
							occurredAt: 1777140000000,
						},
						transient: true,
					}),
					tokenEvent("Hello"),
					endEvent(metadata),
				].join(""),
				{
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Server-Timing": serverTimingHeader,
					},
				},
			),
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith(
			"Hello",
			expect.objectContaining({
				generationDurationMs: 40,
				serverTimeline,
			}),
		);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				serverTiming: serverTimingHeader,
				parsedServerTiming: {
					route_parse: 1,
					preflight: 3.5,
				},
				serverTimeline,
				phases: expect.objectContaining({
					responseHeadersMs: expect.any(Number),
					firstByteMs: expect.any(Number),
					firstActivityMs: expect.any(Number),
					firstTokenMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
	});

	it("threads the active workspace document id into the streaming request body", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { activeDocumentArtifactId: "artifact-focused-1" },
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/stream",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Alfy-Output-Transport": "compact-v1",
				},
				body: expect.any(String),
			}),
		);
		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-1");
		expect(parsedBody.conversationId).toBe("conv-1");
	});

	it("threads pending skills into the streaming request body", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "use this skill",
			responseChunks: [endEvent()],
			options: {
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Pack",
				},
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.pendingSkill).toEqual({
			id: "skill-1",
			ownership: "user",
			displayName: "Research Pack",
		});
	});

	it("threads Reasoning depth into the streaming request body", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { reasoningDepth: "quick" },
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.reasoningDepth).toBe("quick");
		expect(parsedBody).not.toHaveProperty("thinkingMode");
	});

	it("threads the active workspace document id into retry requests too", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				activeDocumentArtifactId: "artifact-focused-2",
			},
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/retry",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Alfy-Output-Transport": "compact-v1",
				},
				body: expect.any(String),
			}),
		);
		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.assistantMessageId).toBe("assistant-msg-1");
		expect(parsedBody.userMessageId).toBe("user-msg-1");
		expect(parsedBody.userMessage).toBe("historical user text");
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-2");
	});

	it("leaves the card pictures and the marks out of the body when there are none", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { pictureRefs: [], imageMarks: null },
		});
		await done;
		const plain = parseLastStreamRequestBody(mockFetch);
		expect("pictureRefs" in plain).toBe(false);
		expect("imageMarks" in plain).toBe(false);
	});

	it("sends the card pictures and the marks in the stream body", async () => {
		const refs = [{ imageFileId: "file-1", number: 1 }];
		const marks = {
			imageFileId: "file-1",
			marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.4 }],
		};
		const withPictures = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { pictureRefs: refs, imageMarks: marks },
		});
		await withPictures.done;
		const body = parseLastStreamRequestBody(withPictures.mockFetch);
		expect(body.pictureRefs).toEqual(refs);
		expect(body.imageMarks).toEqual(marks);
	});

	it("sends the card pictures and the marks to the retry route too", async () => {
		const refs = [{ imageFileId: "file-1", number: 2 }];
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				pictureRefs: refs,
			},
		});
		await done;
		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/retry",
			expect.anything(),
		);
		expect(parseLastStreamRequestBody(mockFetch).pictureRefs).toEqual(refs);
	});

	it("threads the retry origin into retry requests", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				retryOrigin: "answer_now",
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.retryOrigin).toBe("answer_now");
	});

	it("says the skill and the web search of the turn in a retry request", async () => {
		const intent = {
			skill: { id: "skill-1", displayName: "Planning reviewer" },
			webSearch: true as const,
		};
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				retryUserIntent: intent,
			},
		});
		await done;

		expect(parseLastStreamRequestBody(mockFetch).userIntent).toEqual(intent);
	});

	it("leaves the intent out of a request that is not a retry", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: {
				retryUserIntent: { webSearch: true },
			},
		});
		await done;

		expect(parseLastStreamRequestBody(mockFetch)).not.toHaveProperty(
			"userIntent",
		);
	});

	it("threads Reasoning depth into retry requests", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				reasoningDepth: "thorough",
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.reasoningDepth).toBe("thorough");
		expect(parsedBody).not.toHaveProperty("thinkingMode");
	});

	it("threads confirmed forked source-history mutation into retry requests", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				confirmForkedSourceHistoryMutation: true,
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.confirmForkedSourceHistoryMutation).toBe(true);
	});

	it("posts an answer to its question's route with the turn's choices", async () => {
		const answer = {
			kind: "answered" as const,
			answers: [
				{ picked: [1], ownWords: null },
				{ picked: [], ownWords: "Both, but not on Fridays" },
			],
		};
		const {
			mockFetch,
			callbacks: cb,
			done,
		} = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [tokenEvent("Carrying on."), endEvent()],
			options: {
				questionAnswer: { questionId: "q-1", answer },
				modelId: "model2",
				reasoningDepth: "thorough",
				personalityProfileId: "personality-1",
				enabledConnectionCapabilities: ["files.read"],
				activeDocumentArtifactId: "artifact-9",
			},
		});
		await done;

		// The resume's stream is the stream protocol, read as any stream is.
		expect(cb.onToken).toHaveBeenCalledWith("Carrying on.");
		expect(cb.onEnd).toHaveBeenCalledWith("Carrying on.", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledWith(
			"/api/conversations/conv-1/questions/q-1/answer",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Alfy-Output-Transport": "compact-v1",
				},
				body: expect.any(String),
			}),
		);
		const body = parseLastStreamRequestBody(mockFetch);
		expect(body.answer).toEqual(answer);
		expect(body.streamId).toEqual(expect.any(String));
		expect(body.streamId).not.toBe("");
		expect(body.model).toBe("model2");
		expect(body.reasoningDepth).toBe("thorough");
		expect(body.personalityProfileId).toBe("personality-1");
		expect(body.enabledConnectionCapabilities).toEqual(["files.read"]);
		expect(body.activeDocumentArtifactId).toBe("artifact-9");
		// The person's message is the server's to find on the reply's own rows: the
		// body carries the answer and the turn's choices, nothing of a send's.
		expect(Object.keys(body).sort()).toEqual([
			"activeDocumentArtifactId",
			"answer",
			"enabledConnectionCapabilities",
			"model",
			"personalityProfileId",
			"reasoningDepth",
			"streamId",
		]);
	});

	it("parses tool-call details and assistant evidence metadata", async () => {
		const onToolCall = vi.fn();
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-tool-call",
					transient: true,
					data: {
						name: "web_search",
						input: { query: "OpenAI news" },
						status: "done",
						outputSummary: "Found sources",
						sourceType: "web",
						candidates: [
							{
								id: "src-1",
								title: "OpenAI",
								url: "https://openai.com",
								sourceType: "web",
							},
						],
					},
				}),
				tokenEvent("Hello"),
				endEvent({
					messageEvidence: {
						structuredWebSearch: true,
						groups: [
							{
								sourceType: "web",
								label: "Web Search",
								reranked: true,
								confidence: 88,
								items: [
									{
										id: "src-1",
										title: "OpenAI",
										sourceType: "web",
										status: "selected",
										url: "https://openai.com",
									},
								],
							},
						],
					},
				}),
			],
			callbacks: {
				...makeCallbacks(),
				onToolCall,
			},
		});
		await done;

		expect(onToolCall).toHaveBeenCalledWith(
			"web_search",
			{ query: "OpenAI news" },
			"done",
			{
				outputSummary: "Found sources",
				sourceType: "web",
				candidates: [
					{
						id: "src-1",
						title: "OpenAI",
						url: "https://openai.com",
						sourceType: "web",
					},
				],
			},
		);
		expect(cb.onEnd).toHaveBeenCalledWith("Hello", {
			messageEvidence: {
				structuredWebSearch: true,
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: true,
						confidence: 88,
						items: [
							{
								id: "src-1",
								title: "OpenAI",
								sourceType: "web",
								status: "selected",
								url: "https://openai.com",
							},
						],
					},
				],
			},
		});
	});

	it("calls onError on network failure", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockRejectedValue(new Error("Network failure"));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Network failure" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("raises the session row when the gate refuses the send", async () => {
		const { clearSessionExpiry, isSessionExpired } = await import(
			"$lib/stores/session"
		);
		const { SESSION_EXPIRED_CODE, SESSION_EXPIRED_HEADER } = await import(
			"$lib/session-expiry"
		);
		clearSessionExpiry();

		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(
				JSON.stringify({ error: "expired", code: SESSION_EXPIRED_CODE }),
				{
					status: 401,
					headers: {
						"Content-Type": "application/json",
						[SESSION_EXPIRED_HEADER]: "1",
					},
				},
			),
			callbacks: makeCallbacks(),
		});
		await done;

		// This transport does not go through client/api/http.ts, so it has to
		// report the refusal itself — otherwise a send on an expired session
		// would only ever show up as one failed turn.
		expect(isSessionExpired()).toBe(true);
		expect(cb.onError).toHaveBeenCalledOnce();
		clearSessionExpiry();
	});

	it("calls onError when response is not ok", async () => {
		const serverTimingHeader = "route_parse;dur=2.0, preflight;dur=4.5";
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: {
					"Content-Type": "application/json",
					"Server-Timing": serverTimingHeader,
				},
			}),
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unauthorized" }),
		);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "error",
				serverTiming: serverTimingHeader,
				parsedServerTiming: {
					route_parse: 2,
					preflight: 4.5,
				},
				phases: expect.objectContaining({
					responseHeadersMs: expect.any(Number),
					errorMs: expect.any(Number),
				}),
			}),
		);
	});

	// A request the server turns away before a turn begins carries what it
	// answered, so the runtime can tell an update (wait, send again) from a
	// refusal (back off, or fail): the status, the body's `reason`, and
	// `serverUnavailable` when the reverse proxy answered instead of the app.
	describe("a request refused before the turn began", () => {
		async function refusalOf(response: Response) {
			const { callbacks: cb, done } = runStreamWithMockedResponse({
				response,
				callbacks: makeCallbacks(),
			});
			await done;
			expect(cb.onError).toHaveBeenCalledOnce();
			return vi.mocked(cb.onError).mock.calls[0][0] as Error & {
				status?: number;
				reason?: string;
				code?: string;
				serverUnavailable?: boolean;
			};
		}

		it("names a draining server: the status and the reason, with the code a full server has", async () => {
			const error = await refusalOf(
				new Response(
					JSON.stringify({
						error: "Server at capacity. Please try again later.",
						code: "CAPACITY_EXCEEDED",
						reason: "draining",
						retryAfter: 10,
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				),
			);

			expect(error.status).toBe(503);
			expect(error.reason).toBe("draining");
			expect(error.code).toBe("CAPACITY_EXCEEDED");
			// The app answered, so it is not the proxy's page.
			expect(error.serverUnavailable).toBeUndefined();
			expect(isServerUpdateRefusal(error)).toBe(true);
		});

		// A regenerate, "Answer now" and a Retry go through the retry route, which
		// turns a draining server's request away as the stream route does.
		it("reads the retry route's refusal the same way, so a regenerate pressed during the drain waits too", async () => {
			const {
				mockFetch,
				callbacks: cb,
				done,
			} = runStreamWithMockedResponse({
				response: new Response(
					JSON.stringify({
						error: "Server at capacity. Please try again later.",
						code: "CAPACITY_EXCEEDED",
						reason: "draining",
						retryAfter: 10,
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				),
				options: {
					retryAssistantMessageId: "assistant-1",
					retryUserMessageId: "user-1",
				},
			});
			await done;

			expect(mockFetch).toHaveBeenCalledWith(
				"/api/chat/retry",
				expect.anything(),
			);
			const error = vi.mocked(cb.onError).mock.calls[0][0] as Error & {
				status?: number;
				reason?: string;
			};
			expect(error.status).toBe(503);
			expect(error.reason).toBe("draining");
			expect(isServerUpdateRefusal(error)).toBe(true);
		});

		it("keeps the reasons of a full server and of a second reply as limits, not updates", async () => {
			for (const reason of ["global_limit", "user_limit"]) {
				const error = await refusalOf(
					new Response(
						JSON.stringify({
							error: "Server at capacity. Please try again later.",
							code: "CAPACITY_EXCEEDED",
							reason,
						}),
						{ status: 503, headers: { "Content-Type": "application/json" } },
					),
				);

				expect(error.status).toBe(503);
				expect(error.reason).toBe(reason);
				expect(error.code).toBe("CAPACITY_EXCEEDED");
				expect(isServerUpdateRefusal(error)).toBe(false);
			}
		});

		it("marks the proxy's maintenance page, a 503 with HTML, as the server being away", async () => {
			const error = await refusalOf(
				new Response("<html><body>AlfyAI is being updated</body></html>", {
					status: 503,
					headers: { "Content-Type": "text/html" },
				}),
			);

			expect(error.status).toBe(503);
			expect(error.serverUnavailable).toBe(true);
			expect(error.code).toBeUndefined();
			expect(error.reason).toBeUndefined();
			expect(error.message).toBe("HTTP 503");
			expect(isServerUpdateRefusal(error)).toBe(true);
		});

		it.each([
			502, 504,
		])("takes a %i with no body, or a JSON body with neither error nor code, for the server being away", async (status) => {
			for (const body of [null, "{}", '{"detail":"upstream"}']) {
				const error = await refusalOf(new Response(body, { status }));

				expect(error.status).toBe(status);
				expect(error.serverUnavailable).toBe(true);
				expect(isServerUpdateRefusal(error)).toBe(true);
			}
		});

		it("does not take the app's own 503 JSON, or its SvelteKit error, for the server being away", async () => {
			for (const body of [
				{ error: "Chat model unavailable" },
				{ code: "provider_down" },
				{ message: "Service unavailable" },
			]) {
				const error = await refusalOf(
					new Response(JSON.stringify(body), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					}),
				);

				expect(error.status).toBe(503);
				expect(error.serverUnavailable).toBeUndefined();
				expect(isServerUpdateRefusal(error)).toBe(false);
			}
		});

		it("does not take a status that is not a gateway's for the server being away, whatever the body", async () => {
			for (const status of [400, 401, 404, 409, 429, 500]) {
				const error = await refusalOf(
					new Response("<html>Nope</html>", {
						status,
						headers: { "Content-Type": "text/html" },
					}),
				);

				expect(error.status).toBe(status);
				expect(error.serverUnavailable).toBeUndefined();
				expect(isServerUpdateRefusal(error)).toBe(false);
			}
		});

		// Detaching (the page was left) aborts the body read, and an aborted read of an
		// app's JSON looks like the proxy's page: a refusal that reached the runtime
		// then would start a wait, and a resend, on a page nobody sees.
		it("reports nothing of a refusal whose body was being read when the stream was detached", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(
				async (_input: RequestInfo | URL, init?: RequestInit) =>
					({
						ok: false,
						status: 503,
						headers: new Headers(),
						json: () =>
							new Promise((_resolve, reject) => {
								init?.signal?.addEventListener("abort", () =>
									reject(new DOMException("aborted", "AbortError")),
								);
							}),
					}) as unknown as Response,
			);
			const cb = makeCallbacks();

			const handle = streamChat(
				"m",
				"conv-1",
				cb as unknown as StreamCallbacks,
			);
			await flushMicrotasks();
			handle.detach();
			await flushMicrotasks(10);

			expect(cb.onError).not.toHaveBeenCalled();
			expect(cb.onEnd).not.toHaveBeenCalled();
		});

		it("still reports that refusal while the stream is attached, whose aborted read looks like the proxy's page", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(
				async () =>
					({
						ok: false,
						status: 503,
						headers: new Headers(),
						json: async () => {
							throw new SyntaxError("Unexpected end of JSON input");
						},
					}) as unknown as Response,
			);
			const cb = makeCallbacks();

			streamChat("m", "conv-1", cb as unknown as StreamCallbacks);
			await flushMicrotasks(10);

			expect(cb.onError).toHaveBeenCalledOnce();
			expect(
				isServerUpdateRefusal(vi.mocked(cb.onError).mock.calls[0][0]),
			).toBe(true);
		});

		// An answer goes to a route of its own (the question's) and meets the same
		// turning away: the runtime tells a claim lost to another answer from one
		// given back by the code, and an update from a limit by the reason.
		it("reports a refused answer with its status, code and reason, like any refused request", async () => {
			async function refusedAnswer(
				status: number,
				body: Record<string, unknown>,
			) {
				const {
					mockFetch,
					callbacks: cb,
					done,
				} = runStreamWithMockedResponse({
					response: new Response(JSON.stringify(body), {
						status,
						headers: { "Content-Type": "application/json" },
					}),
					options: {
						questionAnswer: {
							questionId: "q-1",
							answer: { kind: "left_to_alfy" },
						},
					},
				});
				await done;

				expect(mockFetch.mock.lastCall?.[0]).toBe(
					"/api/conversations/conv-1/questions/q-1/answer",
				);
				expect(cb.onError).toHaveBeenCalledOnce();
				expect(cb.onEnd).not.toHaveBeenCalled();
				return vi.mocked(cb.onError).mock.calls[0][0] as Error & {
					status?: number;
					reason?: string;
					code?: string;
					serverUnavailable?: boolean;
				};
			}

			// The claim was lost to another answer: the card folds.
			const lost = await refusedAnswer(409, {
				error: "The question has already been answered",
				code: "QUESTION_ALREADY_ANSWERED",
			});
			expect(lost.status).toBe(409);
			expect(lost.code).toBe("QUESTION_ALREADY_ANSWERED");
			expect(lost.message).toBe("The question has already been answered");
			expect(lost.reason).toBeUndefined();
			expect(isServerUpdateRefusal(lost)).toBe(false);

			// The preparation refused and gave the claim back: the card shows its error line.
			const notWaiting = await refusedAnswer(409, {
				error: "The question is not waiting for an answer",
				code: "QUESTION_NOT_WAITING",
			});
			expect(notWaiting.status).toBe(409);
			expect(notWaiting.code).toBe("QUESTION_NOT_WAITING");
			expect(isServerUpdateRefusal(notWaiting)).toBe(false);

			// The server is getting ready for a restart: wait, and send the answer again.
			const draining = await refusedAnswer(503, {
				error: "Server at capacity. Please try again later.",
				code: "CAPACITY_EXCEEDED",
				reason: "draining",
				retryAfter: 10,
			});
			expect(draining.status).toBe(503);
			expect(draining.code).toBe("CAPACITY_EXCEEDED");
			expect(draining.reason).toBe("draining");
			expect(draining.serverUnavailable).toBeUndefined();
			expect(isServerUpdateRefusal(draining)).toBe(true);

			// A limit is not an update.
			const limited = await refusedAnswer(503, {
				error: "Server at capacity. Please try again later.",
				code: "CAPACITY_EXCEEDED",
				reason: "user_limit",
			});
			expect(limited.status).toBe(503);
			expect(limited.reason).toBe("user_limit");
			expect(isServerUpdateRefusal(limited)).toBe(false);

			// A refusal the preparation forwards, in the stream route's shape with its
			// `status` inside, keeps the lower-case code it was made with.
			const forwarded = await refusedAnswer(422, {
				status: 422,
				error: "Attachments are not ready.",
				code: "attachment_not_ready",
				attachmentIds: ["att-1"],
			});
			expect(forwarded.status).toBe(422);
			expect(forwarded.code).toBe("attachment_not_ready");
			expect(forwarded.message).toBe("Attachments are not ready.");
		});

		it("is the only kind of error that carries a status: a stream that failed after it was accepted has none", async () => {
			const frame = await (async () => {
				const { callbacks: cb, done } = runStreamWithMockedResponse({
					responseChunks: [
						uiFrame({ type: "data-stream-error", data: { message: "Boom" } }),
					],
					callbacks: makeCallbacks(),
				});
				await done;
				return vi.mocked(cb.onError).mock.calls[0][0] as Error & {
					status?: number;
				};
			})();
			expect(frame.status).toBeUndefined();

			const mockFetch = vi.mocked(fetch);
			mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
			const cb = makeCallbacks();
			await runStreamAndWait("m", "conv-1", cb as unknown as StreamCallbacks);
			const thrown = vi.mocked(cb.onError).mock.calls[0][0] as Error & {
				status?: number;
			};
			expect(thrown.status).toBeUndefined();
			expect(isServerUpdateRefusal(thrown)).toBe(false);
		});
	});

	describe("isStreamTransportFailure", () => {
		// The Fetch standard rejects a request or a body that fails on the network
		// with a TypeError, in every browser.
		it("is a fetch or a reader failing on the network, which the transport passes on as it is", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
			const cb = makeCallbacks();
			await runStreamAndWait("m", "conv-1", cb as unknown as StreamCallbacks);

			const error = vi.mocked(cb.onError).mock.calls[0][0];
			expect(isStreamTransportFailure(error)).toBe(true);
		});

		it("is a response that ends without its terminal event: the connection was cut", async () => {
			const { callbacks: cb, done } = runStreamWithMockedResponse({
				responseChunks: [tokenEvent("Half an answ")],
				callbacks: makeCallbacks(),
			});
			await done;

			const error = vi.mocked(cb.onError).mock.calls[0][0];
			expect(error.message).toBe(
				"Stream closed before a terminal completion event",
			);
			expect(isStreamTransportFailure(error)).toBe(true);
		});

		it("is not the server saying something: a refusal's status, the stream's own code, or an error frame with none", async () => {
			expect(
				isStreamTransportFailure(
					Object.assign(new Error("HTTP 503"), { status: 503 }),
				),
			).toBe(false);
			expect(
				isStreamTransportFailure(
					Object.assign(new Error("Stream timeout"), { code: "timeout" }),
				),
			).toBe(false);
			// A TypeError that carries what the server said is the server's.
			expect(
				isStreamTransportFailure(
					Object.assign(new TypeError("x"), { code: "timeout" }),
				),
			).toBe(false);

			const { callbacks: cb, done } = runStreamWithMockedResponse({
				responseChunks: [
					uiFrame({
						type: "data-stream-error",
						data: { message: "The model refused." },
					}),
				],
				callbacks: makeCallbacks(),
			});
			await done;
			expect(
				isStreamTransportFailure(vi.mocked(cb.onError).mock.calls[0][0]),
			).toBe(false);

			expect(isStreamTransportFailure(new Error("Network failed"))).toBe(false);
			expect(isStreamTransportFailure(null)).toBe(false);
			expect(isStreamTransportFailure("Failed to fetch")).toBe(false);
		});
	});

	it("reports error timing when an ok response has no body", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(null, { status: 200 }),
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Response has no body" }),
		);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "error",
				phases: expect.objectContaining({
					responseHeadersMs: expect.any(Number),
					errorMs: expect.any(Number),
				}),
			}),
		);
	});

	it("calls onError when stream emits error event", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [errorEvent({ message: "Something went wrong" })],
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Something went wrong" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "error",
				phases: expect.objectContaining({
					firstByteMs: expect.any(Number),
					errorMs: expect.any(Number),
				}),
			}),
		);
	});

	it("uses stream error fallback fields and preserves the error code", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				errorEvent({ error: "Fallback failure", code: "UPSTREAM_TIMEOUT" }),
			],
		});
		await done;

		const error = cb.onError.mock.calls[0]?.[0] as
			| (Error & { code?: string })
			| undefined;
		expect(error?.message).toBe("Fallback failure");
		expect(error?.code).toBe("UPSTREAM_TIMEOUT");
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("maps native AI SDK UI error parts onto onError", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "error", errorText: "upstream exploded" }),
			],
		});
		await done;

		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "upstream exploded" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("buffers replayed token and thinking chunks until replay-end before waiting", async () => {
		const controlled = buildControlledFetchResponse();
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const events: string[] = [];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: controlled.response,
			callbacks: {
				...makeEventLogCallbacks(events),
				onTiming: vi.fn(),
			},
		});

		await flushMicrotasks();
		controlled.enqueue(
			uiFrame({ type: "data-replay-start", data: {}, transient: true }),
			tokenEvent("Buffered"),
			thinkingEvent("Reasoning"),
		);
		await flushMicrotasks();

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();

		controlled.enqueue(
			uiFrame({ type: "data-replay-end", data: {}, transient: true }),
			uiFrame({ type: "data-waiting", data: {}, transient: true }),
			endEvent(),
		);
		controlled.close();
		await done;

		expect(events).toEqual([
			"token:Buffered",
			"thinking:Reasoning",
			"waiting",
			"end:Buffered",
		]);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				phases: expect.not.objectContaining({
					stopMs: expect.any(Number),
				}),
			}),
		);
		consoleInfo.mockRestore();
	});

	it("calls onError when the stream closes without a terminal event", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("partial")],
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError.mock.calls[0]?.[0]).toMatchObject({
			message: "Stream closed before a terminal completion event",
		});
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "closed",
				phases: expect.objectContaining({
					firstByteMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
	});

	it("stop() requests a server stop and does not call onError", async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		let streamFetchPromise!: Promise<Response>;
		mockFetch.mockImplementation((input) => {
			if (typeof input === "string" && input === "/api/chat/stream/stop") {
				return Promise.resolve(
					new Response(JSON.stringify({ stopped: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}

			streamFetchPromise = new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
			return streamFetchPromise;
		});

		const cb = {
			...makeCallbacks(),
			onTiming: vi.fn(),
		};
		const handle = streamChat(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);

		handle.stop();

		abortReject(new DOMException("The user aborted a request.", "AbortError"));

		await streamFetchPromise.catch(() => undefined);
		await flushMicrotasks();

		expect(cb.onError).not.toHaveBeenCalled();
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "stopped",
				phases: expect.objectContaining({
					stopMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(mockFetch).toHaveBeenNthCalledWith(
			2,
			"/api/chat/stream/stop",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			}),
		);
		const streamRequest = mockFetch.mock.calls[0]?.[1] as
			| RequestInit
			| undefined;
		const stopRequest = mockFetch.mock.calls[1]?.[1] as RequestInit | undefined;
		expect(streamRequest?.body).toEqual(expect.any(String));
		expect(stopRequest?.body).toEqual(expect.any(String));
		expect(JSON.parse(String(stopRequest?.body)).streamId).toBe(
			JSON.parse(String(streamRequest?.body)).streamId,
		);
	});

	it.each([
		false,
		true,
	])("explicit stop after passive detach cancels the exact observed stream once (failure=%s)", async (failure) => {
		let rejectObserver!: (reason: Error) => void;
		const observer = new Promise<Response>((_resolve, reject) => {
			rejectObserver = reject;
		});
		vi.mocked(fetch).mockImplementation((url) =>
			String(url) === "/api/chat/stream/stop"
				? failure
					? Promise.reject(new TypeError("offline"))
					: Promise.resolve(new Response("{}"))
				: observer,
		);
		const callbacks = makeCallbacks();
		const handle = streamChat("A", "conv-1", callbacks, {
			reconnectToStreamId: "exact-observed-stream",
		});
		handle.detach();
		rejectObserver(new DOMException("detached", "AbortError"));
		await observer.catch(() => undefined);
		await flushMicrotasks();
		expect(fetch).toHaveBeenCalledTimes(1);
		handle.stop();
		handle.stop();
		await flushMicrotasks();
		expect(
			vi
				.mocked(fetch)
				.mock.calls.filter(([url]) => String(url) === "/api/chat/stream/stop"),
		).toEqual([
			[
				"/api/chat/stream/stop",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ streamId: "exact-observed-stream" }),
				},
			],
		]);
		expect(callbacks.onEnd).not.toHaveBeenCalled();
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("detach() aborts the local stream without requesting a server stop or emitting stop metadata", async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		let streamFetchPromise!: Promise<Response>;
		mockFetch.mockImplementation(() => {
			streamFetchPromise = new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
			return streamFetchPromise;
		});

		const cb = {
			...makeCallbacks(),
			onTiming: vi.fn(),
		};
		const handle = streamChat(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);

		handle.detach();

		abortReject(new DOMException("The user aborted a request.", "AbortError"));

		await streamFetchPromise.catch(() => undefined);
		await flushMicrotasks();

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).not.toHaveBeenCalled();
		expect(cb.onTiming).not.toHaveBeenCalled();
	});
});

describe("stream transport session response authority", () => {
	it.each([
		"status",
		"buffer",
		"send",
	])("does not heal a newer expiry from an old %s response", async (kind) => {
		const { clearSessionExpiry, markSessionExpired, isSessionExpired } =
			await import("$lib/stores/session");
		clearSessionExpiry();
		let release!: (response: Response) => void;
		const pending = new Promise<Response>((done) => {
			release = done;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(() => pending),
		);
		try {
			const waiting =
				kind === "status"
					? checkForOrphanedStream("conv-1")
					: kind === "buffer"
						? getStreamBufferInfo("stream-1", "conv-1")
						: runStreamAndWait(
								"hello",
								"conv-1",
								makeCallbacks() as unknown as StreamCallbacks,
							);
			markSessionExpired();
			release(
				kind === "send"
					? new Response("data: [DONE]\n\n", {
							headers: { "Content-Type": "text/event-stream" },
						})
					: new Response("{}"),
			);
			await waiting;
			expect(isSessionExpired()).toBe(true);
		} finally {
			clearSessionExpiry();
			vi.unstubAllGlobals();
		}
	});

	it("does not re-expire newer healing when the send's refusal body resolves late", async () => {
		const { clearSessionExpiry, markSessionExpired, isSessionExpired } =
			await import("$lib/stores/session");
		clearSessionExpiry();
		let release!: (body: { error: string }) => void;
		let reading!: () => void;
		const bodyStarted = new Promise<void>((done) => {
			reading = done;
		});
		const response = new Response(null, { status: 401 });
		vi.spyOn(response, "json").mockImplementation(() => {
			reading();
			return new Promise((done) => {
				release = done;
			});
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		try {
			const waiting = runStreamAndWait(
				"hello",
				"conv-1",
				makeCallbacks() as unknown as StreamCallbacks,
			);
			await bodyStarted;
			markSessionExpired();
			clearSessionExpiry();
			release({ error: "Unauthorized" });
			await waiting;
			expect(isSessionExpired()).toBe(false);
		} finally {
			clearSessionExpiry();
			vi.unstubAllGlobals();
		}
	});
});
