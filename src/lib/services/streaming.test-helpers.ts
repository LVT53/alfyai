import { vi } from "vitest";
import { encodeAiSdkUiFixtureFrame } from "../../../tests/fixtures/ai-sdk-ui-stream-contract";
import type { StreamCallbacks, StreamMetadata } from "./streaming";
import { streamChat } from "./streaming";

type ResponseBody = {
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

export type MockCallbacks = {
	onToken: ReturnType<typeof vi.fn>;
	onThinking: ReturnType<typeof vi.fn>;
	onEnd: ReturnType<typeof vi.fn>;
	onError: ReturnType<typeof vi.fn>;
};

export type StreamHarnessOptions = {
	message?: string;
	conversationId?: string;
	responseChunks?: string[];
	response?: Response;
	responseStatus?: number;
	callbacks?: MockCallbacks | StreamCallbacks;
	options?: Parameters<typeof streamChat>[3];
};

export function uiFrame(
	payload: Parameters<typeof encodeAiSdkUiFixtureFrame>[0],
): string {
	return encodeAiSdkUiFixtureFrame(payload);
}

export function tokenEvent(text: string): string {
	return uiFrame({ type: "text-delta", id: "text-1", delta: text });
}

export function thinkingEvent(text: string): string {
	return uiFrame({ type: "reasoning-delta", id: "reasoning-1", delta: text });
}

export function endEvent(payload: Partial<StreamMetadata> = {}): string {
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

export function errorEvent(payload: {
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

export function buildFetchResponse(
	sseChunks: string[],
	status = 200,
): Response {
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

export function buildControlledFetchResponse(): {
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

export function makeCallbacks(): MockCallbacks {
	return {
		onToken: vi.fn(),
		onThinking: vi.fn(),
		onEnd: vi.fn(),
		onError: vi.fn(),
	};
}

export function makeEventLogCallbacks(events: string[]) {
	return {
		...makeCallbacks(),
		onToken: vi.fn((chunk: string) => events.push(`token:${chunk}`)),
		onThinking: vi.fn((chunk: string) => events.push(`thinking:${chunk}`)),
		onWaiting: vi.fn(() => events.push("waiting")),
		onEnd: vi.fn((fullText: string) => events.push(`end:${fullText}`)),
	};
}

export function runStreamWithMockedResponse({
	message = "test message",
	conversationId = "conv-1",
	responseChunks = [],
	response,
	responseStatus = 200,
	callbacks = makeCallbacks(),
	options,
}: StreamHarnessOptions) {
	const mockFetch = vi.mocked(fetch);
	mockFetch.mockResolvedValue(
		response ?? buildFetchResponse(responseChunks, responseStatus),
	);
	const done = runStreamAndWait(
		message,
		conversationId,
		callbacks as unknown as StreamCallbacks,
		options,
	);
	return { mockFetch, callbacks, done };
}

async function waitForStream(callbacks: MockCallbacks): Promise<void> {
	return new Promise<void>((resolve) => {
		const originalOnEnd = callbacks.onEnd as (...args: unknown[]) => void;
		const originalOnError = callbacks.onError as (...args: unknown[]) => void;
		callbacks.onEnd = vi.fn((...args: unknown[]) => {
			originalOnEnd(...args);
			resolve();
		});
		callbacks.onError = vi.fn((...args: unknown[]) => {
			originalOnError(...args);
			resolve();
		});
	});
}

export function parseLastStreamRequestBody(
	mockFetch: ReturnType<typeof vi.fn>,
): ResponseBody {
	const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
	return JSON.parse(String(requestInit?.body ?? "{}")) as ResponseBody;
}

export function runStreamAndWait(
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

export async function flushMicrotasks(turns = 3): Promise<void> {
	for (let index = 0; index < turns; index += 1) {
		await Promise.resolve();
	}
}
