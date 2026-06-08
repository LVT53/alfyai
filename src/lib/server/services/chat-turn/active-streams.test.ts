import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendToStreamBuffer,
	broadcastStreamChunk,
	clearStreamBuffer,
	getOrCreateStreamBuffer,
	getOrphanedStream,
	getStreamBuffer,
	getStreamBufferSnapshot,
	isStreamActive,
	registerActiveChatStream,
	requestActiveChatStreamStop,
	subscribeToStream,
	unregisterActiveChatStream,
	wasActiveChatStreamStopRequested,
} from "./active-streams";

describe("active chat streams registry", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts an active controller when a stop is requested by the same user", () => {
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-1",
			userId: "user-1",
			controller,
			conversationId: "conversation-1",
		});

		const stopped = requestActiveChatStreamStop({
			streamId: "stream-1",
			userId: "user-1",
		});

		expect(stopped).toBe(true);
		expect(controller.signal.aborted).toBe(true);

		unregisterActiveChatStream("stream-1", controller);
	});

	it("aborts a controller that registers after an early stop request", () => {
		const stopped = requestActiveChatStreamStop({
			streamId: "stream-early-stop",
			userId: "user-1",
		});
		expect(stopped).toBe(false);

		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-early-stop",
			userId: "user-1",
			controller,
			conversationId: "conversation-early-stop",
		});

		expect(controller.signal.aborted).toBe(true);

		unregisterActiveChatStream("stream-early-stop", controller);
	});

	it("does not apply another user's early stop request to a later same-id stream", () => {
		const stopped = requestActiveChatStreamStop({
			streamId: "stream-shared-early-stop",
			userId: "user-1",
		});
		expect(stopped).toBe(false);

		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-shared-early-stop",
			userId: "user-2",
			controller,
			conversationId: "conversation-shared-early-stop",
		});

		expect(controller.signal.aborted).toBe(false);

		unregisterActiveChatStream("stream-shared-early-stop", controller);
		const ownerController = new AbortController();
		registerActiveChatStream({
			streamId: "stream-shared-early-stop",
			userId: "user-1",
			controller: ownerController,
			conversationId: "conversation-shared-early-stop-owner-cleanup",
		});
		unregisterActiveChatStream("stream-shared-early-stop", ownerController);
	});

	it("reports pending stop requests only for the requesting owner", async () => {
		const stopped = requestActiveChatStreamStop({
			streamId: "stream-owned-stop-check",
			userId: "user-1",
		});

		expect(stopped).toBe(false);
		expect(
			wasActiveChatStreamStopRequested({
				streamId: "stream-owned-stop-check",
				userId: "user-2",
			}),
		).toBe(false);
		expect(
			wasActiveChatStreamStopRequested({
				streamId: "stream-owned-stop-check",
				userId: "user-1",
			}),
		).toBe(true);

		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-owned-stop-check",
			userId: "user-1",
			controller,
			conversationId: "conversation-owned-stop-check-cleanup",
		});
		unregisterActiveChatStream("stream-owned-stop-check", controller);
	});

	it("keeps a pending stop when unregister is called with a non-owner controller", () => {
		const ownerController = new AbortController();
		const otherController = new AbortController();
		registerActiveChatStream({
			streamId: "stream-stop-controller-owner",
			userId: "user-1",
			controller: ownerController,
			conversationId: "conversation-stop-controller-owner",
		});

		requestActiveChatStreamStop({
			streamId: "stream-stop-controller-owner",
			userId: "user-1",
		});
		unregisterActiveChatStream("stream-stop-controller-owner", otherController);

		expect(
			wasActiveChatStreamStopRequested({
				streamId: "stream-stop-controller-owner",
				userId: "user-1",
			}),
		).toBe(true);

		unregisterActiveChatStream("stream-stop-controller-owner", ownerController);
	});

	it("does not abort a stream owned by another user", () => {
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-2",
			userId: "user-1",
			controller,
			conversationId: "conversation-2",
		});

		const stopped = requestActiveChatStreamStop({
			streamId: "stream-2",
			userId: "user-2",
		});

		expect(stopped).toBe(false);
		expect(controller.signal.aborted).toBe(false);

		unregisterActiveChatStream("stream-2", controller);
	});

	it("rejects a same-id active stream registration from another user", () => {
		const firstController = new AbortController();
		const secondController = new AbortController();

		expect(
			registerActiveChatStream({
				streamId: "stream-colliding-id",
				userId: "user-1",
				controller: firstController,
				conversationId: "conversation-first-owner",
			}),
		).toBe(true);

		expect(
			registerActiveChatStream({
				streamId: "stream-colliding-id",
				userId: "user-2",
				controller: secondController,
				conversationId: "conversation-second-owner",
			}),
		).toBe(false);

		const stopped = requestActiveChatStreamStop({
			streamId: "stream-colliding-id",
			userId: "user-1",
		});

		expect(stopped).toBe(true);
		expect(firstController.signal.aborted).toBe(true);
		expect(secondController.signal.aborted).toBe(false);

		unregisterActiveChatStream("stream-colliding-id", firstController);
	});

	it("returns orphaned streams only for the owning user and conversation", () => {
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-owned-orphan",
			userId: "user-1",
			controller,
			conversationId: "conversation-owned-orphan",
		});

		try {
			expect(
				getOrphanedStream({
					userId: "user-2",
					conversationId: "conversation-owned-orphan",
				}),
			).toBeNull();
			expect(
				getOrphanedStream({
					userId: "user-1",
					conversationId: "conversation-owned-orphan",
				}),
			).toBe("stream-owned-orphan");
		} finally {
			unregisterActiveChatStream("stream-owned-orphan", controller);
		}
	});

	it("clears the stream buffer cleanup timer when the last buffer is removed", () => {
		vi.useFakeTimers();

		getOrCreateStreamBuffer({
			streamId: "stream-buffer",
			userId: "user-1",
			conversationId: "conversation-buffer",
			userMessage: "hello",
		});
		expect(vi.getTimerCount()).toBe(1);

		clearStreamBuffer("stream-buffer");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns stream buffer snapshots only for the owning user", () => {
		getOrCreateStreamBuffer({
			streamId: "stream-owned-buffer",
			userId: "user-1",
			conversationId: "conversation-owned-buffer",
			userMessage: "private question",
		});
		appendToStreamBuffer("stream-owned-buffer", "token", { text: "Hello" });

		try {
			expect(
				getStreamBufferSnapshot({
					streamId: "stream-owned-buffer",
					userId: "user-2",
				}),
			).toEqual({ exists: false });
			expect(
				getStreamBufferSnapshot({
					streamId: "stream-owned-buffer",
					userId: "user-1",
				}),
		).toEqual({
			exists: true,
			userMessage: "private question",
			tokenCount: 1,
			thinkingCount: 0,
			toolCallCount: 0,
			createdAt: expect.any(Number),
		});
	} finally {
		clearStreamBuffer("stream-owned-buffer");
	}
});

it("preserves the original stream Reasoning depth in buffer snapshots", () => {
		getOrCreateStreamBuffer({
			streamId: "stream-depth-buffer",
			userId: "user-1",
			conversationId: "conversation-depth-buffer",
			userMessage: "private question",
			reasoningDepth: "max",
		});

		try {
			expect(
				getStreamBufferSnapshot({
					streamId: "stream-depth-buffer",
					userId: "user-1",
					conversationId: "conversation-depth-buffer",
				}),
		).toEqual({
			exists: true,
			userMessage: "private question",
			reasoningDepth: "max",
			tokenCount: 0,
			thinkingCount: 0,
			toolCallCount: 0,
			createdAt: expect.any(Number),
		});
		} finally {
			clearStreamBuffer("stream-depth-buffer");
		}
	});

	it("returns reconnect buffers only for the owning user", () => {
		getOrCreateStreamBuffer({
			streamId: "stream-owned-reconnect-buffer",
			userId: "user-1",
			conversationId: "conversation-owned-reconnect-buffer",
			userMessage: "private reconnect question",
		});
		appendToStreamBuffer("stream-owned-reconnect-buffer", "token", {
			text: "Hello",
		});

		try {
			expect(
				getStreamBuffer({
					streamId: "stream-owned-reconnect-buffer",
					userId: "user-2",
				}),
			).toBeNull();
			expect(
				getStreamBuffer({
					streamId: "stream-owned-reconnect-buffer",
					userId: "user-1",
				})?.tokens,
			).toEqual(["Hello"]);
		} finally {
			clearStreamBuffer("stream-owned-reconnect-buffer");
		}
	});

	it("subscribes listeners only to the owning user's stream buffer", () => {
		const ownerListener = vi.fn();
		const otherListener = vi.fn();
		getOrCreateStreamBuffer({
			streamId: "stream-owned-subscribe",
			userId: "user-1",
			conversationId: "conversation-owned-subscribe",
			userMessage: "private reconnect question",
		});

		try {
			subscribeToStream(
				{
					streamId: "stream-owned-subscribe",
					userId: "user-2",
					conversationId: "conversation-owned-subscribe",
				},
				otherListener,
			);
			subscribeToStream(
				{
					streamId: "stream-owned-subscribe",
					userId: "user-1",
					conversationId: "conversation-owned-subscribe",
				},
				ownerListener,
			);

			broadcastStreamChunk("stream-owned-subscribe", "private chunk");

			expect(otherListener).not.toHaveBeenCalled();
			expect(ownerListener).toHaveBeenCalledWith("private chunk");
		} finally {
			clearStreamBuffer("stream-owned-subscribe");
		}
	});

	it("reports active stream state only for the owning user and conversation", () => {
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-owned-active-check",
			userId: "user-1",
			controller,
			conversationId: "conversation-owned-active-check",
		});

		try {
			expect(
				isStreamActive({
					streamId: "stream-owned-active-check",
					userId: "user-2",
					conversationId: "conversation-owned-active-check",
				}),
			).toBe(false);
			expect(
				isStreamActive({
					streamId: "stream-owned-active-check",
					userId: "user-1",
					conversationId: "other-conversation",
				}),
			).toBe(false);
			expect(
				isStreamActive({
					streamId: "stream-owned-active-check",
					userId: "user-1",
					conversationId: "conversation-owned-active-check",
				}),
			).toBe(true);
		} finally {
			unregisterActiveChatStream("stream-owned-active-check", controller);
		}
	});

	it("does not reuse a same-id buffer across owners", () => {
		getOrCreateStreamBuffer({
			streamId: "stream-colliding-buffer",
			userId: "user-1",
			conversationId: "conversation-private-buffer",
			userMessage: "private reconnect question",
		});
		appendToStreamBuffer("stream-colliding-buffer", "token", {
			text: "private answer",
		});

		const replacement = getOrCreateStreamBuffer({
			streamId: "stream-colliding-buffer",
			userId: "user-2",
			conversationId: "conversation-new-owner",
			userMessage: "new owner question",
		});

		try {
			expect(replacement.userId).toBe("user-2");
			expect(replacement.conversationId).toBe("conversation-new-owner");
			expect(replacement.userMessage).toBe("new owner question");
			expect(replacement.tokens).toEqual([]);
			expect(
				getStreamBufferSnapshot({
					streamId: "stream-colliding-buffer",
					userId: "user-1",
				}),
			).toEqual({ exists: false });
			expect(
				getStreamBufferSnapshot({
					streamId: "stream-colliding-buffer",
					userId: "user-2",
				}),
		).toEqual({
			exists: true,
			userMessage: "new owner question",
			tokenCount: 0,
			thinkingCount: 0,
			toolCallCount: 0,
			createdAt: expect.any(Number),
		});
		} finally {
			clearStreamBuffer("stream-colliding-buffer");
		}
	});

	it("expires aged stream buffers on the registry cleanup timer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		getOrCreateStreamBuffer({
			streamId: "stream-expiring-buffer",
			userId: "user-1",
			conversationId: "conversation-expiring-buffer",
			userMessage: "expire this",
		});
		expect(
			getStreamBufferSnapshot({
				streamId: "stream-expiring-buffer",
				userId: "user-1",
			}),
		).toEqual(
			expect.objectContaining({
				exists: true,
				userMessage: "expire this",
			}),
		);

		vi.advanceTimersByTime(5 * 60 * 1000);

		expect(
			getStreamBufferSnapshot({
				streamId: "stream-expiring-buffer",
				userId: "user-1",
			}),
		).toEqual({ exists: false });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not append to an expired stream buffer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		getOrCreateStreamBuffer({
			streamId: "stream-expired-append-buffer",
			userId: "user-1",
			conversationId: "conversation-expired-append-buffer",
			userMessage: "expire before append",
		});
		vi.setSystemTime(5 * 60 * 1000);

		appendToStreamBuffer("stream-expired-append-buffer", "token", {
			text: "late token",
		});

		expect(
			getStreamBufferSnapshot({
				streamId: "stream-expired-append-buffer",
				userId: "user-1",
			}),
		).toEqual({ exists: false });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stores completed tool-call source metadata for reconnect replay", () => {
		getOrCreateStreamBuffer({
			streamId: "stream-tool-buffer",
			userId: "user-1",
			conversationId: "conversation-tool-buffer",
			userMessage: "search this",
		});

		appendToStreamBuffer("stream-tool-buffer", "tool_call", {
			callId: "tool-call-1",
			name: "web_search",
			input: { query: "OpenAI news" },
			status: "running",
		});
		appendToStreamBuffer("stream-tool-buffer", "tool_call", {
			callId: "tool-call-1",
			name: "web_search",
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

		expect(
			getStreamBuffer({
				streamId: "stream-tool-buffer",
				userId: "user-1",
			})?.toolCalls,
		).toEqual([
			{
				callId: "tool-call-1",
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
		]);

		clearStreamBuffer("stream-tool-buffer");
	});

	it("does not replay duplicate running tool calls with the same call id", () => {
		getOrCreateStreamBuffer({
			streamId: "stream-tool-buffer-dedupe",
			userId: "user-1",
			conversationId: "conversation-tool-buffer-dedupe",
			userMessage: "search this",
		});

		appendToStreamBuffer("stream-tool-buffer-dedupe", "tool_call", {
			callId: "tool-call-1",
			name: "web_search",
			input: { query: "OpenAI news" },
			status: "running",
		});
		appendToStreamBuffer("stream-tool-buffer-dedupe", "tool_call", {
			callId: "tool-call-1",
			name: "web_search",
			input: { query: "OpenAI news" },
			status: "running",
		});
		appendToStreamBuffer("stream-tool-buffer-dedupe", "tool_call", {
			callId: "tool-call-1",
			name: "web_search",
			status: "done",
			outputSummary: "Found current sources",
		});

		expect(
			getStreamBuffer({
				streamId: "stream-tool-buffer-dedupe",
				userId: "user-1",
			})?.toolCalls,
		).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				name: "web_search",
				status: "done",
			}),
		]);

		clearStreamBuffer("stream-tool-buffer-dedupe");
	});
});
