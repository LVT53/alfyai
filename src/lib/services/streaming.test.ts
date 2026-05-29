import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_CHAT_SSE_EVENTS,
	type BrowserChatSseEventName,
	type BrowserChatSsePayload,
	encodeBrowserChatSseEvent,
} from "./stream-protocol";
import type { StreamCallbacks } from "./streaming";
import { streamChat } from "./streaming";

function sseEvent<Name extends BrowserChatSseEventName>(
	event: Name,
	payload: BrowserChatSsePayload<Name>,
): string {
	return encodeBrowserChatSseEvent(event, payload);
}

function tokenEvent(text: string): string {
	return sseEvent(BROWSER_CHAT_SSE_EVENTS.token, { text });
}

function thinkingEvent(text: string): string {
	return sseEvent(BROWSER_CHAT_SSE_EVENTS.thinking, { text });
}

function endEvent(
	payload: BrowserChatSsePayload<typeof BROWSER_CHAT_SSE_EVENTS.end> = {},
): string {
	return sseEvent(BROWSER_CHAT_SSE_EVENTS.end, payload);
}

function errorEvent(
	payload: BrowserChatSsePayload<typeof BROWSER_CHAT_SSE_EVENTS.error>,
): string {
	return sseEvent(BROWSER_CHAT_SSE_EVENTS.error, payload);
}

function buildFetchResponse(sseChunks: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of sseChunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function buildControlledFetchResponse(): {
	response: Response;
	enqueue: (...chunks: string[]) => void;
	close: () => void;
} {
	const encoder = new TextEncoder();
	let streamController!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		enqueue(...chunks: string[]) {
			for (const chunk of chunks) {
				streamController.enqueue(encoder.encode(chunk));
			}
		},
		close() {
			streamController.close();
		},
	};
}

interface MockCallbacks {
	onToken: ReturnType<typeof vi.fn>;
	onThinking: ReturnType<typeof vi.fn>;
	onEnd: ReturnType<typeof vi.fn>;
	onError: ReturnType<typeof vi.fn>;
}

function makeCallbacks(): MockCallbacks {
	return {
		onToken: vi.fn(),
		onThinking: vi.fn(),
		onEnd: vi.fn(),
		onError: vi.fn(),
	};
}

async function waitForStream(cb: MockCallbacks): Promise<void> {
	return new Promise<void>((resolve) => {
		const originalOnEnd = cb.onEnd as (...args: unknown[]) => void;
		const originalOnError = cb.onError as (...args: unknown[]) => void;
		cb.onEnd = vi.fn((...args: unknown[]) => {
			originalOnEnd(...args);
			resolve();
		});
		cb.onError = vi.fn((...args: unknown[]) => {
			originalOnError(...args);
			resolve();
		});
	});
}

describe("streamChat", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("calls onToken for each SSE token chunk", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				tokenEvent("Hello"),
				tokenEvent(" world"),
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
	});

	it("handles token payloads split across SSE data lines", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				"event: token\n",
				"data: {\n",
				'data: "text":"Hello from split data"\n',
				"data: }\n",
				"\n",
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledOnce();
		expect(cb.onToken).toHaveBeenCalledWith("Hello from split data");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from split data", undefined);
	});

	it("includes forceWebSearch in the stream request body for the current turn", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks, {
			forceWebSearch: true,
		});
		await done;

		const requestBody = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
		expect(requestBody).toMatchObject({
			message: "test message",
			conversationId: "conv-1",
			forceWebSearch: true,
		});
	});

	it("calls onEnd with full concatenated text", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				tokenEvent("Hello"),
				tokenEvent(" world"),
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("Hello world", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("calls onThinking for thinking SSE chunks", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				thinkingEvent("Need to reason first"),
				tokenEvent("Final answer"),
				endEvent({ thinking: "Need to reason first" }),
			]),
		);

		const cb = {
			...makeCallbacks(),
			onThinking: vi.fn(),
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason first");
		expect(cb.onEnd).toHaveBeenCalledWith("Final answer", {
			thinking: "Need to reason first",
		});
	});

	it("preserves string payload fallback and strips leaked tool calls from thinking", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				"event: token\n",
				'data: "Hello from string payload"\n',
				"\n",
				"event: thinking\n",
				'data: "Internal<tool_calls>{}</tool_calls> reasoning"\n',
				"\n",
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledWith("Hello from string payload");
		expect(cb.onThinking).toHaveBeenCalledWith("Internal reasoning");
		expect(cb.onEnd).toHaveBeenCalledWith(
			"Hello from string payload",
			undefined,
		);
	});

	it("routes inline <thinking> tags from token chunks into onThinking", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				tokenEvent("Before<thinking>Need to reason</thinking>After"),
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Before");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, "After");
		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason");
		expect(cb.onEnd).toHaveBeenCalledWith("BeforeAfter", undefined);
	});

	it("handles inline <thinking> tags split across token events", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				tokenEvent("Start<th"),
				tokenEvent("inking>Need"),
				tokenEvent(" to search</thin"),
				tokenEvent("king>End"),
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Start");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, "End");
		expect(cb.onThinking).toHaveBeenCalledTimes(2);
		expect(cb.onThinking).toHaveBeenNthCalledWith(1, "Need");
		expect(cb.onThinking).toHaveBeenNthCalledWith(2, " to search");
		expect(cb.onEnd).toHaveBeenCalledWith("StartEnd", undefined);
	});

	it("parses end-event metadata from the data line", async () => {
		const mockFetch = vi.mocked(fetch);
		const endMetadata = {
			thinkingTokenCount: 2,
			responseTokenCount: 3,
			totalTokenCount: 5,
			wasStopped: false,
			modelDisplayName: "Model 1",
			contextSources: {
				conversationId: "conv-1",
				userId: "user-1",
				activeCount: 1,
				inferredCount: 0,
				selectedCount: 1,
				pinnedCount: 0,
				excludedCount: 0,
				reduced: false,
				compacted: false,
				groups: [],
				updatedAt: 1777140000000,
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
		};
		mockFetch.mockResolvedValue(
			buildFetchResponse([tokenEvent("Hello"), endEvent(endMetadata)]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", endMetadata);
	});

	it("parses trailing end-event metadata when the stream closes without a final blank line", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				tokenEvent("Hello"),
				endEvent({
					assistantMessageId: "assistant-1",
					wasStopped: false,
				}).trimEnd(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", {
			assistantMessageId: "assistant-1",
			wasStopped: false,
		});
	});

	it("reports opt-in client timing without changing token parsing or logging by default", async () => {
		const mockFetch = vi.mocked(fetch);
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				": prelude\n",
				"\n",
				tokenEvent("Hello"),
				endEvent(),
			]),
		);

		const cb = {
			...makeCallbacks(),
			onTiming: vi.fn(),
		};
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
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

	it("threads the active workspace document id into the streaming request body", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks, {
			activeDocumentArtifactId: "artifact-focused-1",
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/stream",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.any(String),
			}),
		);
		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-1");
		expect(parsedBody.conversationId).toBe("conv-1");
	});

	it("threads the selected Deep Research depth into the streaming request body", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("research this", "conv-1", cb as unknown as StreamCallbacks, {
			deepResearchDepth: "standard",
		});
		await done;

		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.deepResearch).toEqual({ depth: "standard" });
	});

	it("threads the active workspace document id into retry requests too", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("ignored", "conv-1", cb as unknown as StreamCallbacks, {
			retryAssistantMessageId: "assistant-msg-1",
			retryUserMessageId: "user-msg-1",
			retryUserMessage: "historical user text",
			activeDocumentArtifactId: "artifact-focused-2",
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/retry",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.any(String),
			}),
		);
		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.assistantMessageId).toBe("assistant-msg-1");
		expect(parsedBody.userMessageId).toBe("user-msg-1");
		expect(parsedBody.userMessage).toBe("historical user text");
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-2");
	});

	it("threads confirmed forked source-history mutation into retry requests", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("ignored", "conv-1", cb as unknown as StreamCallbacks, {
			retryAssistantMessageId: "assistant-msg-1",
			retryUserMessageId: "user-msg-1",
			retryUserMessage: "historical user text",
			confirmForkedSourceHistoryMutation: true,
		});
		await done;

		const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
		const parsedBody = JSON.parse(String(requestInit?.body));
		expect(parsedBody.confirmForkedSourceHistoryMutation).toBe(true);
	});

	it("parses tool-call details and assistant evidence metadata", async () => {
		const mockFetch = vi.mocked(fetch);
		const onToolCall = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				sseEvent(BROWSER_CHAT_SSE_EVENTS.toolCall, {
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
			]),
		);

		const cb = {
			...makeCallbacks(),
			onToolCall,
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
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
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Network failure" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("calls onError when response is not ok", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unauthorized" }),
		);
	});

	it("calls onError when stream emits error event", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([errorEvent({ message: "Something went wrong" })]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Something went wrong" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("uses stream error fallback fields and preserves the error code", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				errorEvent({ error: "Fallback failure", code: "UPSTREAM_TIMEOUT" }),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		const error = cb.onError.mock.calls[0]?.[0] as
			| (Error & { code?: string })
			| undefined;
		expect(error?.message).toBe("Fallback failure");
		expect(error?.code).toBe("UPSTREAM_TIMEOUT");
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("uses raw stream error data when JSON parsing fails", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse(["event: error\n", "data: upstream exploded\n", "\n"]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "upstream exploded" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("buffers replayed token and thinking chunks until replay_end before waiting", async () => {
		const mockFetch = vi.mocked(fetch);
		const controlled = buildControlledFetchResponse();
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		mockFetch.mockResolvedValue(controlled.response);

		const events: string[] = [];
		const cb = {
			...makeCallbacks(),
			onToken: vi.fn((chunk: string) => events.push(`token:${chunk}`)),
			onThinking: vi.fn((chunk: string) => events.push(`thinking:${chunk}`)),
			onWaiting: vi.fn(() => events.push("waiting")),
			onEnd: vi.fn((fullText: string) => events.push(`end:${fullText}`)),
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);

		await new Promise((resolve) => setTimeout(resolve, 0));
		controlled.enqueue(
			sseEvent(BROWSER_CHAT_SSE_EVENTS.replayStart, {}),
			tokenEvent("Buffered"),
			thinkingEvent("Reasoning"),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();

		controlled.enqueue(
			sseEvent(BROWSER_CHAT_SSE_EVENTS.replayEnd, {}),
			sseEvent(BROWSER_CHAT_SSE_EVENTS.waiting, {}),
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
		consoleInfo.mockRestore();
	});

	it("calls onEnd with accumulated text when stream closes without end event", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([tokenEvent("partial")]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("partial");
	});

	it("stop() requests a server stop and does not call onError", async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		mockFetch.mockImplementation((input) => {
			if (typeof input === "string" && input === "/api/chat/stream/stop") {
				return Promise.resolve(
					new Response(JSON.stringify({ stopped: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}

			return new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
		});

		const cb = makeCallbacks();
		const handle = streamChat(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);

		await new Promise((r) => setTimeout(r, 10));
		handle.stop();

		abortReject(new DOMException("The user aborted a request.", "AbortError"));

		await new Promise((r) => setTimeout(r, 30));

		expect(cb.onError).not.toHaveBeenCalled();
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

	it("detach() aborts the local stream without requesting a server stop or emitting stop metadata", async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		mockFetch.mockImplementation(
			() =>
				new Promise<Response>((_resolve, reject) => {
					abortReject = reject;
				}),
		);

		const cb = makeCallbacks();
		const handle = streamChat(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);

		await new Promise((r) => setTimeout(r, 10));
		handle.detach();

		abortReject(new DOMException("The user aborted a request.", "AbortError"));

		await new Promise((r) => setTimeout(r, 30));

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).not.toHaveBeenCalled();
	});
});
