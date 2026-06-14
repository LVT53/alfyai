import type { NormalChatModelRunCompatibilityProvider } from "./provider-compatibility";
import { isMiMoProvider } from "./provider-compatibility";

export type MiMoReasoningReplayState = {
	reasoningByToolCallId: Map<string, string>;
};

type ActiveMiMoResponseState = {
	reasoningByChoice: Map<string, string>;
	toolCallIdsByChoice: Map<string, Set<string>>;
};

type PreparedFetchRequest = {
	input: Parameters<typeof fetch>[0];
	init: Parameters<typeof fetch>[1];
};

const OMIT_JSON_BODY = Symbol("omit-json-body");

export function createMiMoReasoningReplayFetch(params: {
	provider: NormalChatModelRunCompatibilityProvider;
	fetch?: typeof fetch;
}): typeof fetch {
	const baseFetch = params.fetch ?? fetch;
	if (!isMiMoProvider(params.provider)) return baseFetch;

	const replayState: MiMoReasoningReplayState = {
		reasoningByToolCallId: new Map(),
	};

	return async (input, init) => {
		const prepared = prepareMiMoReplayRequest(input, init, replayState);
		const response = await baseFetch(prepared.input, prepared.init);

		if (isEventStreamResponse(response) && response.body) {
			return observeMiMoReasoningEventStream(response, replayState);
		}

		if (isJsonResponse(response) && response.body) {
			return await observeMiMoReasoningJsonResponse(response, replayState);
		}

		return response;
	};
}

function prepareMiMoReplayRequest(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	state: MiMoReasoningReplayState,
): PreparedFetchRequest {
	const parsedBody = parseJsonRequestBody(init?.body);
	if (parsedBody === OMIT_JSON_BODY) return { input, init };

	const replayedBody = replayMiMoReasoningContentInRequestBody(
		parsedBody,
		state,
	);
	if (replayedBody === parsedBody) return { input, init };

	return {
		input,
		init: {
			...init,
			headers: withoutContentLength(init?.headers),
			body: JSON.stringify(replayedBody),
		},
	};
}

function parseJsonRequestBody(body: BodyInit | null | undefined): unknown {
	if (typeof body !== "string") return OMIT_JSON_BODY;
	try {
		return JSON.parse(body);
	} catch {
		return OMIT_JSON_BODY;
	}
}

export function replayMiMoReasoningContentInRequestBody(
	body: unknown,
	state: MiMoReasoningReplayState,
): unknown {
	if (!isRecord(body)) return body;
	const messages = body.messages;
	if (!Array.isArray(messages)) return body;

	let changed = false;
	const replayedMessages = messages.map((message) => {
		if (!isRecord(message) || message.role !== "assistant") return message;
		if (hasNonEmptyString(message.reasoning_content)) return message;

		const reasoning = resolveReasoningContentForToolCalls(
			message.tool_calls,
			state,
		);
		if (!reasoning) return message;

		changed = true;
		return {
			...message,
			reasoning_content: reasoning,
		};
	});

	return changed ? { ...body, messages: replayedMessages } : body;
}

function resolveReasoningContentForToolCalls(
	toolCalls: unknown,
	state: MiMoReasoningReplayState,
): string | null {
	const reasoningValues = extractToolCallIds(toolCalls)
		.map(
			(toolCallId) => state.reasoningByToolCallId.get(toolCallId)?.trim() ?? "",
		)
		.filter(Boolean);

	const uniqueReasoningValues = Array.from(new Set(reasoningValues));
	return uniqueReasoningValues.length > 0
		? uniqueReasoningValues.join("\n")
		: null;
}

function observeMiMoReasoningEventStream(
	response: Response,
	state: MiMoReasoningReplayState,
): Response {
	const decoder = new TextDecoder();
	let buffer = "";
	const activeResponse: ActiveMiMoResponseState = {
		reasoningByChoice: new Map(),
		toolCallIdsByChoice: new Map(),
	};

	const observedBody = response.body?.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				processCompleteServerSentEvents(
					buffer,
					(consumedChars) => {
						buffer = buffer.slice(consumedChars);
					},
					(rawEvent) => {
						observeServerSentEvent(rawEvent, activeResponse, state);
					},
				);
				controller.enqueue(chunk);
			},
			flush() {
				buffer += decoder.decode();
				if (buffer) {
					observeServerSentEvent(buffer, activeResponse, state);
					buffer = "";
				}
			},
		}),
	);

	return new Response(observedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function observeMiMoReasoningJsonResponse(
	response: Response,
	state: MiMoReasoningReplayState,
): Promise<Response> {
	const text = await response.text();
	try {
		captureMiMoReasoningFromCompletion(JSON.parse(text), state);
	} catch {
		// Preserve the upstream response even when it is not parseable JSON.
	}

	return new Response(text, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function processCompleteServerSentEvents(
	value: string,
	consume: (chars: number) => void,
	observe: (rawEvent: string) => void,
): void {
	let cursor = 0;
	for (;;) {
		const boundary = findNextServerSentEventBoundary(value.slice(cursor));
		if (!boundary) break;

		const start = cursor;
		const rawEvent = value.slice(start, start + boundary.eventEnd);
		observe(rawEvent);
		cursor += boundary.nextEventStart;
	}

	if (cursor > 0) consume(cursor);
}

function findNextServerSentEventBoundary(
	value: string,
): { eventEnd: number; nextEventStart: number } | null {
	const lfIndex = value.indexOf("\n\n");
	const crlfIndex = value.indexOf("\r\n\r\n");

	if (lfIndex === -1 && crlfIndex === -1) return null;
	if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
		return {
			eventEnd: crlfIndex,
			nextEventStart: crlfIndex + "\r\n\r\n".length,
		};
	}

	return {
		eventEnd: lfIndex,
		nextEventStart: lfIndex + "\n\n".length,
	};
}

function observeServerSentEvent(
	rawEvent: string,
	activeResponse: ActiveMiMoResponseState,
	state: MiMoReasoningReplayState,
): void {
	const lines = rawEvent.split(/\r?\n/);
	const dataLines = lines.filter((line) => line.startsWith("data:"));
	if (dataLines.length !== 1) return;

	const payload = dataLines[0].slice("data:".length).trimStart();
	if (!payload || payload === "[DONE]") return;

	try {
		captureMiMoReasoningFromChunk(JSON.parse(payload), activeResponse, state);
	} catch {
		// Keep the stream transparent when a provider emits non-JSON SSE data.
	}
}

function captureMiMoReasoningFromCompletion(
	value: unknown,
	state: MiMoReasoningReplayState,
): void {
	if (!isRecord(value) || !Array.isArray(value.choices)) return;

	for (const choice of value.choices) {
		if (!isRecord(choice) || !isRecord(choice.message)) continue;
		const reasoning =
			typeof choice.message.reasoning_content === "string"
				? choice.message.reasoning_content
				: "";
		if (!reasoning.trim()) continue;

		for (const toolCallId of extractToolCallIds(choice.message.tool_calls)) {
			state.reasoningByToolCallId.set(toolCallId, reasoning);
		}
	}
}

function captureMiMoReasoningFromChunk(
	value: unknown,
	activeResponse: ActiveMiMoResponseState,
	state: MiMoReasoningReplayState,
): void {
	if (!isRecord(value) || !Array.isArray(value.choices)) return;

	value.choices.forEach((choice, choicePosition) => {
		if (!isRecord(choice) || !isRecord(choice.delta)) return;

		const choiceKey = choiceIdPart(choice.index, choicePosition);
		const reasoningDelta = choice.delta.reasoning_content;
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			appendReasoningDelta(choiceKey, reasoningDelta, activeResponse, state);
		}

		const toolCalls = choice.delta.tool_calls;
		if (!Array.isArray(toolCalls)) return;

		for (const toolCall of toolCalls) {
			if (!isRecord(toolCall) || typeof toolCall.id !== "string") continue;
			trackToolCallIdForChoice(choiceKey, toolCall.id, activeResponse);
			const reasoning = activeResponse.reasoningByChoice.get(choiceKey)?.trim();
			if (reasoning) {
				state.reasoningByToolCallId.set(toolCall.id, reasoning);
			}
		}
	});
}

function appendReasoningDelta(
	choiceKey: string,
	delta: string,
	activeResponse: ActiveMiMoResponseState,
	state: MiMoReasoningReplayState,
): void {
	const reasoning =
		(activeResponse.reasoningByChoice.get(choiceKey) ?? "") + delta;
	activeResponse.reasoningByChoice.set(choiceKey, reasoning);

	const toolCallIds = activeResponse.toolCallIdsByChoice.get(choiceKey);
	if (!toolCallIds) return;

	for (const toolCallId of toolCallIds) {
		state.reasoningByToolCallId.set(toolCallId, reasoning);
	}
}

function trackToolCallIdForChoice(
	choiceKey: string,
	toolCallId: string,
	activeResponse: ActiveMiMoResponseState,
): void {
	let toolCallIds = activeResponse.toolCallIdsByChoice.get(choiceKey);
	if (!toolCallIds) {
		toolCallIds = new Set();
		activeResponse.toolCallIdsByChoice.set(choiceKey, toolCallIds);
	}
	toolCallIds.add(toolCallId);
}

function extractToolCallIds(toolCalls: unknown): string[] {
	if (!Array.isArray(toolCalls)) return [];

	return toolCalls.flatMap((toolCall) => {
		if (!isRecord(toolCall) || typeof toolCall.id !== "string") return [];
		return [toolCall.id];
	});
}

function choiceIdPart(value: unknown, fallback: number): string {
	return typeof value === "string" || typeof value === "number"
		? String(value)
		: String(fallback);
}

function isEventStreamResponse(response: Response): boolean {
	return (
		response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream") ?? false
	);
}

function isJsonResponse(response: Response): boolean {
	return (
		response.headers.get("content-type")?.toLowerCase().includes("json") ??
		false
	);
}

function withoutContentLength(
	headers: HeadersInit | undefined,
): HeadersInit | undefined {
	if (!headers) return headers;
	const nextHeaders = new Headers(headers);
	nextHeaders.delete("content-length");
	return nextHeaders;
}

function hasNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
