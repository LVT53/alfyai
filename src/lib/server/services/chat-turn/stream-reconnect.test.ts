import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	aiSdkUiStreamContractParts,
	encodeAiSdkUiFixtureFrames,
	oldBrowserSseNamedEndEvent,
} from "../../../../../tests/fixtures/ai-sdk-ui-stream-contract";
import {
	decodeUiMessageStreamParts,
	streamDataPartEvent,
	streamErrorEvent,
	streamReasoningDeltaEvent,
	streamReasoningStartEvent,
	streamResponseActivityEvent,
	streamTextDeltaEvent,
	streamTextStartEvent,
	streamToolCallEvent,
} from "./stream";
import { doReconnect } from "./stream-reconnect";

interface ReconnectBuffer {
	userMessage: string | null;
	tokens: string[];
	thinking: string[];
	responseActivity: Array<{
		id: string;
		kind: "depth" | "context" | "tool" | "source" | "drafting" | "fallback" | "file";
		status: "running" | "done" | "error";
		detail?: string;
		count?: number;
	}>;
	toolCalls: Array<{
		name: string;
		input: Record<string, unknown>;
		status: "running" | "done";
		outputSummary?: string | null;
		sourceType?: "web" | "document" | "memory" | "tool" | null;
		candidates?: Array<{
			id: string;
			title: string;
			url?: string | null;
			snippet?: string | null;
			sourceType: "web" | "document" | "memory" | "tool";
		}>;
		metadata?: Record<string, string | number | boolean | null>;
	}>;
}

describe("doReconnect", () => {
	let enqueueChunk: ReturnType<typeof vi.fn>;
	let closeDownstream: ReturnType<typeof vi.fn>;
	let getStreamBuffer: ReturnType<typeof vi.fn>;
	let subscribeToStream: ReturnType<typeof vi.fn>;
	let unsubscribeFromStream: ReturnType<typeof vi.fn>;
	let createSsePreludeComment: ReturnType<typeof vi.fn>;
	let createSseHeartbeatComment: ReturnType<typeof vi.fn>;
	let abortController: AbortController;
	let intervalIds: number[];
	let clearedIntervalIds: number[];

	beforeEach(() => {
		enqueueChunk = vi.fn().mockReturnValue(true);
		closeDownstream = vi.fn();
		getStreamBuffer = vi.fn().mockReturnValue(undefined);
		subscribeToStream = vi.fn();
		unsubscribeFromStream = vi.fn();
		createSsePreludeComment = vi.fn().mockReturnValue(": prelude\n\n");
		createSseHeartbeatComment = vi.fn().mockReturnValue(": heartbeat\n\n");
		abortController = new AbortController();
		intervalIds = [];
		clearedIntervalIds = [];
		vi.spyOn(global, "setInterval").mockImplementation(
			(_cb: () => void, _ms?: number) => {
				const id = intervalIds.length + 1;
				intervalIds.push(id);
				return id as unknown as ReturnType<typeof setInterval>;
			},
		);
		vi.spyOn(global, "clearInterval").mockImplementation((id: unknown) => {
			clearedIntervalIds.push(id as number);
		});
	});

	function callDoReconnect(targetStreamId = "test-stream") {
		doReconnect(targetStreamId, {
			userId: "user-1",
			conversationId: "conversation-1",
			enqueueChunk,
			closeDownstream,
			downstreamAbortSignal: abortController.signal,
			getStreamBuffer,
			subscribeToStream,
			unsubscribeFromStream,
			createSsePreludeComment,
			createSseHeartbeatComment,
		});
	}

	function streamOwnerParams(streamId = "test-stream") {
		return {
			streamId,
			userId: "user-1",
			conversationId: "conversation-1",
		};
	}

	function makeBuffer(
		overrides: Partial<ReconnectBuffer> = {},
	): ReconnectBuffer {
		return {
			tokens: [],
			thinking: [],
			responseActivity: [],
			toolCalls: [],
			userMessage: null,
			...overrides,
		};
	}

	function enqueuedProtocolEvents() {
		return enqueueChunk.mock.calls.flatMap(([chunk]) =>
			decodeUiMessageStreamParts(chunk as string),
		);
	}

	function dataParts(type: string) {
		return enqueuedProtocolEvents()
			.filter((event): event is Record<string, unknown> => event !== "[DONE]")
			.filter((event) => event.type === type)
			.map((event) => event.data);
	}

	it("enqueues SSE prelude and heartbeat comments on start", () => {
		callDoReconnect();

		expect(createSsePreludeComment).toHaveBeenCalledOnce();
		expect(createSseHeartbeatComment).toHaveBeenCalledOnce();
		expect(enqueueChunk).toHaveBeenCalledWith(": prelude\n\n");
		expect(enqueueChunk).toHaveBeenCalledWith(": heartbeat\n\n");
	});

	it("replays buffered tokens, thinking, and tool_calls with replay_start/replay_end framing", () => {
		const buffer = makeBuffer({
			tokens: ["Hello", " world"],
			thinking: ["reasoning"],
			toolCalls: [
				{
					name: "search",
					input: { q: "test" },
					status: "done" as const,
					outputSummary: "found",
				},
			],
		});
		getStreamBuffer.mockReturnValue(buffer);

		callDoReconnect();

		expect(enqueueChunk).toHaveBeenCalledWith(
			streamDataPartEvent("data-replay-start", {
				tokenCount: 2,
				thinkingCount: 1,
				toolCallCount: 1,
				userMessage: null,
			}),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(streamTextStartEvent());
		expect(enqueueChunk).toHaveBeenCalledWith(streamTextDeltaEvent("Hello"));
		expect(enqueueChunk).toHaveBeenCalledWith(streamTextDeltaEvent(" world"));

		expect(enqueueChunk).toHaveBeenCalledWith(streamReasoningStartEvent());
		expect(enqueueChunk).toHaveBeenCalledWith(
			streamReasoningDeltaEvent("reasoning"),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(
			streamToolCallEvent({
				name: "search",
				input: { q: "test" },
				status: "done",
				outputSummary: "found",
			}),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(
			streamDataPartEvent("data-replay-end", {}),
		);
	});

	it("replays buffered response activity rows with replay framing", () => {
		const activity = [
			{
				id: "depth-selected",
				kind: "depth" as const,
				status: "done" as const,
				detail: "maximum",
			},
			{
				id: "context-ready",
				kind: "context" as const,
				status: "done" as const,
				count: 4,
			},
		];
		getStreamBuffer.mockReturnValue(
			makeBuffer({
				responseActivity: activity,
			}),
		);

		callDoReconnect();

		expect(enqueueChunk).toHaveBeenCalledWith(
			streamDataPartEvent("data-replay-start", {
				tokenCount: 0,
				thinkingCount: 0,
				toolCallCount: 0,
				activityCount: 2,
				userMessage: null,
			}),
		);
		expect(enqueueChunk).toHaveBeenCalledWith(
			streamResponseActivityEvent(activity[0]),
		);
		expect(enqueueChunk).toHaveBeenCalledWith(
			streamResponseActivityEvent(activity[1]),
		);
	});

	it("subscribes to live stream events after replay", () => {
		callDoReconnect();

		expect(subscribeToStream).toHaveBeenCalledWith(
			streamOwnerParams(),
			expect.any(Function),
		);
	});

	it("replays buffered tool_call details with live SSE metadata fields", () => {
		getStreamBuffer.mockReturnValue(
			makeBuffer({
				toolCalls: [
					{
						name: "web_search",
						input: { query: "OpenAI news" },
						status: "done",
						outputSummary: "Found current sources",
						sourceType: "web",
						candidates: [
							{
								id: "src-1",
								title: "OpenAI",
								url: "https://openai.com/",
								snippet: "Official source",
								sourceType: "web",
							},
						],
						metadata: { resultCount: 1 },
					},
				],
			}),
		);

		callDoReconnect();

		const toolCallEvent = dataParts("data-tool-call")[0];

		expect(toolCallEvent).toEqual({
			name: "web_search",
			input: { query: "OpenAI news" },
			status: "done",
			outputSummary: "Found current sources",
			sourceType: "web",
			candidates: [
				{
					id: "src-1",
					title: "OpenAI",
					url: "https://openai.com/",
					snippet: "Official source",
					sourceType: "web",
				},
			],
			metadata: { resultCount: 1 },
		});
	});

	it("forwards live stream chunks to enqueueChunk", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		const liveChunk = `${streamTextStartEvent()}${streamTextDeltaEvent("live")}`;
		listener(liveChunk);

		expect(enqueueChunk).toHaveBeenCalledWith(liveChunk);
	});

	it("closes downstream and unsubscribes on an end protocol event", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		listener(
			encodeAiSdkUiFixtureFrames([
				aiSdkUiStreamContractParts.metadata,
				aiSdkUiStreamContractParts.finish,
				"[DONE]",
			]).join(""),
		);

		expect(unsubscribeFromStream).toHaveBeenCalledWith(
			streamOwnerParams(),
			listener,
		);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("does not close downstream on a partial terminal frame without an SSE block delimiter", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		const partialTerminalChunk = encodeAiSdkUiFixtureFrames([
			aiSdkUiStreamContractParts.finish,
		])
			.join("")
			.trimEnd();
		listener(partialTerminalChunk);

		expect(enqueueChunk).toHaveBeenCalledWith(partialTerminalChunk);
		expect(unsubscribeFromStream).not.toHaveBeenCalled();
		expect(clearedIntervalIds).toEqual([]);
		expect(closeDownstream).not.toHaveBeenCalled();
	});

	it("ignores old Browser SSE named end events without closing downstream", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		listener(oldBrowserSseNamedEndEvent);

		expect(enqueueChunk).toHaveBeenCalledWith(oldBrowserSseNamedEndEvent);
		expect(unsubscribeFromStream).not.toHaveBeenCalled();
		expect(closeDownstream).not.toHaveBeenCalled();
	});

	it("closes downstream when a forwarded live chunk contains a terminal protocol event after a comment", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		const liveChunk = `: heartbeat\n\n${encodeAiSdkUiFixtureFrames([
			aiSdkUiStreamContractParts.finish,
			"[DONE]",
		]).join("")}`;
		listener(liveChunk);

		expect(enqueueChunk).toHaveBeenCalledWith(liveChunk);
		expect(unsubscribeFromStream).toHaveBeenCalledWith(
			streamOwnerParams(),
			listener,
		);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("closes downstream and unsubscribes on an error protocol event", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		listener(streamErrorEvent("timeout"));

		expect(unsubscribeFromStream).toHaveBeenCalledWith(
			streamOwnerParams(),
			listener,
		);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("cleans up on abort signal", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		abortController.abort();

		expect(unsubscribeFromStream).toHaveBeenCalledWith(
			streamOwnerParams(),
			listener,
		);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("does not replay buffer when empty", () => {
		getStreamBuffer.mockReturnValue(
			makeBuffer({ tokens: [], thinking: [], toolCalls: [] }),
		);

		callDoReconnect();

		const replayStartEvent = dataParts("data-replay-start")[0];
		const replayEndEvent = dataParts("data-replay-end")[0];
		expect(replayStartEvent).toBeUndefined();
		expect(replayEndEvent).toBeUndefined();
	});

	it("closes downstream when getStreamBuffer throws", () => {
		getStreamBuffer.mockImplementation(() => {
			throw new Error("buffer error");
		});

		callDoReconnect();

		expect(closeDownstream).toHaveBeenCalled();
	});

	it("replays events in timeline order instead of batch order", () => {
		const buffer = makeBuffer({
			tokens: ["Hello", "world"],
			thinking: ["planning", "analyzing"],
			eventTimeline: [
				{ seq: 0, type: "thinking", index: 0 },
				{ seq: 1, type: "token", index: 0 },
				{ seq: 2, type: "token", index: 1 },
				{ seq: 3, type: "thinking", index: 1 },
			],
		});
		getStreamBuffer.mockReturnValue(buffer);

		callDoReconnect();

		const events = enqueuedProtocolEvents();
		const typeSeq = events
			.filter((e) => e !== "[DONE]")
			.map((e) => (e as Record<string, unknown>).type);

		const firstReasoningDelta = typeSeq.indexOf("reasoning-delta");
		const firstTextDelta = typeSeq.indexOf("text-delta");
		expect(firstReasoningDelta).toBeLessThan(firstTextDelta);

		const secondReasoningDelta = typeSeq.indexOf(
			"reasoning-delta",
			firstReasoningDelta + 1,
		);
		const secondTextDelta = typeSeq.indexOf("text-delta", firstTextDelta + 1);
		expect(secondTextDelta).toBeLessThan(secondReasoningDelta);
	});

	it("replays interleaved tokens, thinking, response activities, and tool calls in timeline order", () => {
		const activity = {
			id: "depth-selected",
			kind: "depth" as const,
			status: "done" as const,
			detail: "maximum",
		};
		const buffer = makeBuffer({
			tokens: ["Hello", "world", "!"],
			thinking: ["planning", "analyzing"],
			responseActivity: [activity],
			toolCalls: [
				{
					name: "search",
					input: { q: "test" },
					status: "done" as const,
					outputSummary: "found",
				},
			],
			eventTimeline: [
				{ seq: 0, type: "thinking", index: 0 },
				{ seq: 1, type: "token", index: 0 },
				{ seq: 2, type: "thinking", index: 1 },
				{ seq: 3, type: "response_activity", index: 0 },
				{ seq: 4, type: "token", index: 1 },
				{ seq: 5, type: "tool_call", index: 0 },
				{ seq: 6, type: "token", index: 2 },
			],
		});
		getStreamBuffer.mockReturnValue(buffer);

		callDoReconnect();

		const events = enqueuedProtocolEvents();
		const typeSeq = events
			.filter((e) => e !== "[DONE]")
			.map((e) => (e as Record<string, unknown>).type);

		const reasoningDeltas = typeSeq.reduce<number[]>(
			(acc, t, i) => (t === "reasoning-delta" ? [...acc, i] : acc),
			[] as number[],
		);
		const textDeltas = typeSeq.reduce<number[]>(
			(acc, t, i) => (t === "text-delta" ? [...acc, i] : acc),
			[] as number[],
		);
		const activityIdx = typeSeq.indexOf("data-response-activity");
		const toolCallIdx = typeSeq.indexOf("data-tool-call");

		// First thinking block before first text
		expect(reasoningDeltas[0]).toBeLessThan(textDeltas[0]);
		// Second thinking block after first text but before tool call
		expect(reasoningDeltas[1]).toBeGreaterThan(textDeltas[0]);
		expect(reasoningDeltas[1]).toBeLessThan(toolCallIdx);
		// Activity appears between second thinking and second text
		expect(activityIdx).toBeGreaterThan(reasoningDeltas[1]);
		expect(activityIdx).toBeLessThan(textDeltas[1]);
		// Tool call appears before final text
		expect(toolCallIdx).toBeLessThan(textDeltas[2]);
	});

	it("falls back to batch replay when eventTimeline is empty", () => {
		const buffer = makeBuffer({
			tokens: ["Hello", " world"],
			thinking: ["reasoning"],
			eventTimeline: [],
		});
		getStreamBuffer.mockReturnValue(buffer);

		callDoReconnect();

		// Replay start/end still emitted
		expect(dataParts("data-replay-start")).toHaveLength(1);
		expect(dataParts("data-replay-end")).toHaveLength(1);

		// Tokens should all come before thinking (batch order)
		const events = enqueuedProtocolEvents();
		const typeSeq = events
			.filter((e) => e !== "[DONE]")
			.map((e) => (e as Record<string, unknown>).type);

		const lastTextDelta = typeSeq.lastIndexOf("text-delta");
		const firstReasoningDelta = typeSeq.indexOf("reasoning-delta");
		expect(lastTextDelta).toBeLessThan(firstReasoningDelta);
	});

	it("sets up a 10-second heartbeat interval for reconnect", () => {
		callDoReconnect();

		expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 10000);
	});
});
