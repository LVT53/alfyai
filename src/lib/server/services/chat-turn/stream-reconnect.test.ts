import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_CHAT_SSE_EVENTS,
	decodeBrowserChatSseEvents,
	encodeBrowserChatSseEvent,
} from "$lib/services/stream-protocol";
import { doReconnect } from "./stream-reconnect";

interface ReconnectBuffer {
	userMessage: string | null;
	tokens: string[];
	thinking: string[];
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

	function makeBuffer(
		overrides: Partial<ReconnectBuffer> = {},
	): ReconnectBuffer {
		return {
			tokens: [],
			thinking: [],
			toolCalls: [],
			userMessage: null,
			...overrides,
		};
	}

	function enqueuedProtocolEvents() {
		return enqueueChunk.mock.calls.flatMap(([chunk]) =>
			decodeBrowserChatSseEvents(chunk as string),
		);
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
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.replayStart, {
				tokenCount: 2,
				thinkingCount: 1,
				toolCallCount: 1,
				userMessage: null,
			}),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.token, {
				text: "Hello",
			}),
		);
		expect(enqueueChunk).toHaveBeenCalledWith(
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.token, {
				text: " world",
			}),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.thinking, {
				text: "reasoning",
			}),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.toolCall, {
				name: "search",
				input: { q: "test" },
				status: "done",
				outputSummary: "found",
			}),
		);

		expect(enqueueChunk).toHaveBeenCalledWith(
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.replayEnd, {}),
		);
	});

	it("subscribes to live stream events after replay", () => {
		callDoReconnect();

		expect(subscribeToStream).toHaveBeenCalledWith(
			"test-stream",
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

		const toolCallEvent = enqueuedProtocolEvents().find(
			(event) => event.event === BROWSER_CHAT_SSE_EVENTS.toolCall,
		);

		expect(toolCallEvent?.data).toEqual({
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
		const liveChunk = encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.token, {
			text: "live",
		});
		listener(liveChunk);

		expect(enqueueChunk).toHaveBeenCalledWith(liveChunk);
	});

	it("closes downstream and unsubscribes on an end protocol event", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		listener(encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.end, {}));

		expect(unsubscribeFromStream).toHaveBeenCalledWith("test-stream", listener);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("closes downstream when a forwarded live chunk contains a terminal protocol event after a comment", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		const liveChunk = `: heartbeat\n\n${encodeBrowserChatSseEvent(
			BROWSER_CHAT_SSE_EVENTS.end,
			{},
		)}`;
		listener(liveChunk);

		expect(enqueueChunk).toHaveBeenCalledWith(liveChunk);
		expect(unsubscribeFromStream).toHaveBeenCalledWith("test-stream", listener);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("closes downstream and unsubscribes on an error protocol event", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		listener(
			encodeBrowserChatSseEvent(BROWSER_CHAT_SSE_EVENTS.error, {
				code: "timeout",
			}),
		);

		expect(unsubscribeFromStream).toHaveBeenCalledWith("test-stream", listener);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("cleans up on abort signal", () => {
		callDoReconnect();

		const listener = subscribeToStream.mock.calls[0][1] as (
			chunk: string,
		) => void;
		abortController.abort();

		expect(unsubscribeFromStream).toHaveBeenCalledWith("test-stream", listener);
		expect(clearInterval).toHaveBeenCalled();
		expect(closeDownstream).toHaveBeenCalled();
	});

	it("does not replay buffer when empty", () => {
		getStreamBuffer.mockReturnValue(
			makeBuffer({ tokens: [], thinking: [], toolCalls: [] }),
		);

		callDoReconnect();

		const replayStartEvent = enqueuedProtocolEvents().find(
			(event) => event.event === BROWSER_CHAT_SSE_EVENTS.replayStart,
		);
		const replayEndEvent = enqueuedProtocolEvents().find(
			(event) => event.event === BROWSER_CHAT_SSE_EVENTS.replayEnd,
		);
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

	it("sets up a 10-second heartbeat interval for reconnect", () => {
		callDoReconnect();

		expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 10000);
	});
});
