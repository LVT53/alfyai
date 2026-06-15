import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	aiSdkUiStreamCloseAfterFinishSequence,
	aiSdkUiStreamContractMetadata,
	aiSdkUiStreamContractSequence,
	aiSdkUiStreamContractToolCall,
	aiSdkUiStreamReplaySequence,
	encodeAiSdkUiFixtureFrame,
	encodeAiSdkUiFixtureFrames,
	malformedAiSdkUiStreamFrames,
	oldBrowserSseNamedTokenEvent,
} from "../../../tests/fixtures/ai-sdk-ui-stream-contract";
import type { StreamCallbacks, StreamMetadata } from "./streaming";
import { streamChat } from "./streaming";

function tokenEvent(text: string): string {
	return uiFrame({ type: "text-delta", id: "text-1", delta: text });
}

function thinkingEvent(text: string): string {
	return uiFrame({ type: "reasoning-delta", id: "reasoning-1", delta: text });
}

function endEvent(payload: Partial<StreamMetadata> = {}): string {
	const metadata =
		Object.keys(payload).length > 0
			? uiFrame({
					type: "data-stream-metadata",
					data: payload,
					transient: true,
				})
			: "";
	return `${metadata}${uiFrame({ type: "finish", finishReason: "stop" })}${uiFrame("[DONE]")}`;
}

function errorEvent(payload: {
	message?: string;
	error?: string;
	code?: string;
}): string {
	return `${uiFrame({
		type: "data-stream-error",
		data: payload,
		transient: true,
	})}${uiFrame({ type: "finish", finishReason: "error" })}${uiFrame("[DONE]")}`;
}

function uiFrame(
	payload: Parameters<typeof encodeAiSdkUiFixtureFrame>[0],
): string {
	return encodeAiSdkUiFixtureFrame(payload);
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

type StreamRequestBody = {
	activeDocumentArtifactId?: string;
	conversationId?: string;
	deepResearch?: {
		depth: string;
	};
	reasoningDepth?: string;
	retryAssistantMessageId?: string;
	retryUserMessageId?: string;
	retryUserMessage?: string;
	userMessage?: string;
	assistantMessageId?: string;
	thinkingMode?: unknown;
	confirmForkedSourceHistoryMutation?: boolean;
	forceWebSearch?: boolean;
	[key: string]: unknown;
};

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

function parseLastStreamRequestBody(
	mockFetch: ReturnType<typeof vi.fn>,
): StreamRequestBody {
	const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
	return JSON.parse(String(requestInit?.body ?? "{}")) as StreamRequestBody;
}

function runStreamAndWait(
	message: string,
	conversationId: string,
	callbacks: MockCallbacks | StreamCallbacks,
	options?: Parameters<typeof streamChat>[3],
) {
	const done = waitForStream(callbacks as MockCallbacks);
	streamChat(
		message,
		conversationId,
		callbacks as unknown as StreamCallbacks,
		options,
	);
	return done;
}

async function flushMicrotasks(turns = 3): Promise<void> {
	for (let index = 0; index < turns; index += 1) {
		await Promise.resolve();
	}
}

describe("streamChat", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("decodes the shared AI SDK UI stream contract fixture end-to-end", async () => {
		const mockFetch = vi.mocked(fetch);
		const onToolCall = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse(
				encodeAiSdkUiFixtureFrames(aiSdkUiStreamContractSequence),
			),
		);

		const cb = {
			...makeCallbacks(),
			onToolCall,
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
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
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				oldBrowserSseNamedTokenEvent,
				encodeAiSdkUiFixtureFrame("[DONE]"),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("ignores malformed AI SDK UI stream fixture frames without partial rendering", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				...malformedAiSdkUiStreamFrames,
				encodeAiSdkUiFixtureFrame("[DONE]"),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("finishes successfully when the stream closes after the finish fixture frame", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse(
				encodeAiSdkUiFixtureFrames(aiSdkUiStreamCloseAfterFinishSequence),
			),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("buffers the shared replay fixture until replay-end before waiting", async () => {
		const mockFetch = vi.mocked(fetch);
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		mockFetch.mockResolvedValue(
			buildFetchResponse(
				encodeAiSdkUiFixtureFrames(aiSdkUiStreamReplaySequence),
			),
		);

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
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				uiFrame({ type: "text-delta", id: "text-1", delta: "Hello" }),
				uiFrame({ type: "text-delta", id: "text-1", delta: " world" }),
				uiFrame("[DONE]"),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello world", undefined);
	});

	it("maps AI SDK UI reasoning, metadata, and finish frames onto existing callbacks", async () => {
		const mockFetch = vi.mocked(fetch);
		const metadata = {
			thinkingTokenCount: 4,
			responseTokenCount: 5,
			totalTokenCount: 9,
			assistantMessageId: "assistant-1",
			modelDisplayName: "Model 1",
		};
		mockFetch.mockResolvedValue(
			buildFetchResponse([
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
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason");
		expect(cb.onToken).toHaveBeenCalledWith("Answer");
		expect(cb.onEnd).toHaveBeenCalledWith("Answer", metadata);
	});

	it("calls terminal callbacks once when finish is followed by DONE", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([tokenEvent("Answer"), endEvent()]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("Answer", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("maps AI SDK UI tool-call data parts onto the existing tool callback", async () => {
		const mockFetch = vi.mocked(fetch);
		const onToolCall = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse([
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
		const mockFetch = vi.mocked(fetch);
		const onResponseActivity = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse([
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
			]),
		);

		const cb = {
			...makeCallbacks(),
			onResponseActivity,
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "context-ready",
			kind: "context",
			status: "done",
			count: 3,
			occurredAt: 123,
		});
	});

	it("maps deliberation response-activity events onto the activity callback", async () => {
		const mockFetch = vi.mocked(fetch);
		const onResponseActivity = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "deliberation-pass-1",
						kind: "deliberation",
						status: "running",
						label: "Reviewing context and sources",
						occurredAt: 456,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			]),
		);

		const cb = {
			...makeCallbacks(),
			onResponseActivity,
		};
		const done = waitForStream(cb as unknown as MockCallbacks);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "deliberation-pass-1",
			kind: "deliberation",
			status: "running",
			label: "Reviewing context and sources",
			occurredAt: 456,
		});
	});

	it("maps AI SDK UI stream-error data parts onto onError with code", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				uiFrame({
					type: "data-stream-error",
					data: {
						message: "Upstream failed",
						code: "UPSTREAM_FAILURE",
					},
					transient: true,
				}),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		const error = cb.onError.mock.calls[0]?.[0] as
			| (Error & { code?: string })
			| undefined;
		expect(error?.message).toBe("Upstream failed");
		expect(error?.code).toBe("UPSTREAM_FAILURE");
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("buffers AI SDK UI replayed chunks until replay end before waiting", async () => {
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

	it("handles AI SDK UI frames split across network chunks", async () => {
		const mockFetch = vi.mocked(fetch);
		const tokenFrame = tokenEvent("Hello from split frame");
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				tokenFrame.slice(0, 17),
				tokenFrame.slice(17),
				endEvent(),
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledOnce();
		expect(cb.onToken).toHaveBeenCalledWith("Hello from split frame");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from split frame", undefined);
	});

	it("does not render a trailing AI SDK UI frame that closes before the SSE block delimiter", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([tokenEvent("partial without delimiter").trimEnd()]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
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
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{ forceWebSearch: true },
		);
		await done;

		const requestBody = parseLastStreamRequestBody(mockFetch);
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

	it("calls onThinking for AI SDK UI reasoning chunks", async () => {
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

	it("preserves AI SDK text-field fallback and strips leaked tool calls from reasoning", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
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
			]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onToken).toHaveBeenCalledWith("Hello from text field");
		expect(cb.onThinking).toHaveBeenCalledWith("Internal reasoning");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from text field", undefined);
	});

	it("routes inline <thinking> tags from text deltas into onThinking", async () => {
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

	it("parses AI SDK UI stream metadata from the data part", async () => {
		const mockFetch = vi.mocked(fetch);
		const endMetadata = {
			thinkingTokenCount: 2,
			responseTokenCount: 3,
			totalTokenCount: 5,
			wasStopped: false,
			modelDisplayName: "Model 1",
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model 1",
			},
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
		} as Partial<StreamMetadata>;
		mockFetch.mockResolvedValue(
			buildFetchResponse([tokenEvent("Hello"), endEvent(endMetadata)]),
		);

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", endMetadata);
	});

	it("parses trailing AI SDK UI stream metadata when the stream closes without a final blank line", async () => {
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
		const done = runStreamAndWait(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{ activeDocumentArtifactId: "artifact-focused-1" },
		);
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/stream",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.any(String),
			}),
		);
		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-1");
		expect(parsedBody.conversationId).toBe("conv-1");
	});

	it("threads the selected Deep Research depth into the streaming request body", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"research this",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{ deepResearchDepth: "standard" },
		);
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.deepResearch).toEqual({ depth: "standard" });
	});

	it("threads Reasoning depth into the streaming request body", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{ reasoningDepth: "off" },
		);
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.reasoningDepth).toBe("off");
		expect(parsedBody).not.toHaveProperty("thinkingMode");
	});

	it("threads the active workspace document id into retry requests too", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"ignored",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				activeDocumentArtifactId: "artifact-focused-2",
			},
		);
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/retry",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.any(String),
			}),
		);
		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.assistantMessageId).toBe("assistant-msg-1");
		expect(parsedBody.userMessageId).toBe("user-msg-1");
		expect(parsedBody.userMessage).toBe("historical user text");
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-2");
	});

	it("threads Reasoning depth into retry requests", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"ignored",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				reasoningDepth: "max",
			},
		);
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.reasoningDepth).toBe("max");
		expect(parsedBody).not.toHaveProperty("thinkingMode");
	});

	it("threads confirmed forked source-history mutation into retry requests", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([endEvent()]));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"ignored",
			"conv-1",
			cb as unknown as StreamCallbacks,
			{
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				confirmForkedSourceHistoryMutation: true,
			},
		);
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.confirmForkedSourceHistoryMutation).toBe(true);
	});

	it("parses tool-call details and assistant evidence metadata", async () => {
		const mockFetch = vi.mocked(fetch);
		const onToolCall = vi.fn();
		mockFetch.mockResolvedValue(
			buildFetchResponse([
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

	it("maps native AI SDK UI error parts onto onError", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			buildFetchResponse([
				uiFrame({ type: "error", errorText: "upstream exploded" }),
			]),
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

	it("buffers replayed token and thinking chunks until replay-end before waiting", async () => {
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
		consoleInfo.mockRestore();
	});

	it("calls onError when the stream closes without a terminal event", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(buildFetchResponse([tokenEvent("partial")]));

		const cb = makeCallbacks();
		const done = waitForStream(cb);
		streamChat("test message", "conv-1", cb as unknown as StreamCallbacks);
		await done;

		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError.mock.calls[0]?.[0]).toMatchObject({
			message: "Stream closed before a terminal completion event",
		});
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

		const cb = makeCallbacks();
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
		let streamFetchPromise!: Promise<Response>;
		mockFetch.mockImplementation(() => {
			streamFetchPromise = new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
			return streamFetchPromise;
		});

		const cb = makeCallbacks();
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
	});
});
