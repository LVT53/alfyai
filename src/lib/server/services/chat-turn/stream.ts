import {
	createInlineThinkingState,
	createLeakedToolDiagnosticsState,
	FRIENDLY_STREAM_ERRORS,
	flushInlineThinkingState,
	getLeakedToolDiagnosticPrefixLength,
	getSkillControlEnvelopePrefixHoldLength,
	getTextContent,
	looksLikeLeadingThinkingPreamble,
	mayStartLeadingThinkingPreamble,
	processInlineThinkingChunk,
	SKILL_CONTROL_ENVELOPE_CLOSE_TAG,
	SKILL_CONTROL_ENVELOPE_OPEN_TAG,
	type StreamErrorCode,
	splitLeadingThinkingPreamble,
	stripLeadingResponseMarker,
	stripLeakedToolDiagnostics,
} from "$lib/services/stream-protocol";
import type {
	EvidenceSourceType,
	ToolCallEntry,
	ToolEvidenceCandidate,
} from "$lib/types";
import type { ChatTurnRequestError } from "./types";

export type { UpstreamEvent } from "./stream-parser";
export {
	parseEventBlock,
	parseJsonBlock,
	parseMaybeJson,
	// stream-parser
	parseSseBlock,
	parseUpstreamEvents,
} from "./stream-parser";
// Re-export all public symbols from sub-modules for backward compatibility
export {
	getReasoningContent,
	normalizeVisibleAssistantText,
	// thinking-normalizer
	THINKING_BLOCK_RE,
	THINKING_TAG_RE,
} from "./thinking-normalizer";
export type { StreamToolCallDetails } from "./tool-call-markers";
export {
	processToolCallMarkers,
	TOOL_CALL_END_RE,
	// tool-call-markers
	TOOL_CALL_START_RE,
} from "./tool-call-markers";

// ---------------------------------------------------------------------------
// Internal helpers (moved to sub-modules, retained here for local use)
// ---------------------------------------------------------------------------
import { getNestedObject } from "$lib/services/stream-protocol";
import { isFileProductionToolName } from "$lib/utils/tool-calls";
import { parseMaybeJson } from "./stream-parser";
import type { StreamToolCallDetails as ImportedToolDetails } from "./tool-call-markers";

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-store, must-revalidate",
	Pragma: "no-cache",
	Expires: "0",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
};
const SSE_PRELUDE_PADDING_BYTES = 8192;
const SSE_HEARTBEAT_COMMENT = ": keep-alive\n\n";
export type StreamPhaseTimings = Record<string, number>;

export type ServerStreamSegment =
	| { type: "text"; content: string }
	| {
			type: "tool_call";
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done";
			outputSummary?: string | null;
			sourceType?: EvidenceSourceType | null;
			candidates?: ToolEvidenceCandidate[];
			metadata?: Record<string, string | number | boolean | null>;
	  };

export const URL_LIST_TOOL_RECOVERY_APPENDIX = [
	"Important retry guard for URL-processing tools:",
	"- If a tool uses a field named `urls`, it must be a JSON array of strings.",
	"- Even for one link, pass `[]`, never a bare string.",
].join("\n");

export function createStreamJsonErrorResponse(
	error: ChatTurnRequestError,
): Response {
	return new Response(JSON.stringify(stripUndefined(error)), {
		status: error.status,
		headers: JSON_HEADERS,
	});
}

function formatServerTiming(timings: StreamPhaseTimings): string {
	return Object.entries(timings)
		.filter(([, durationMs]) => Number.isFinite(durationMs) && durationMs >= 0)
		.map(([name, durationMs]) => `${name};dur=${durationMs.toFixed(1)}`)
		.join(", ");
}

export function createEventStreamResponse(
	stream: ReadableStream,
	options?: { serverTiming?: StreamPhaseTimings },
): Response {
	const headers: Record<string, string> = { ...SSE_HEADERS };
	const serverTiming = options?.serverTiming
		? formatServerTiming(options.serverTiming)
		: "";
	if (serverTiming) {
		headers["Server-Timing"] = serverTiming;
	}
	return new Response(stream, { headers });
}

export function createSsePreludeComment(): string {
	return `:${" ".repeat(SSE_PRELUDE_PADDING_BYTES)}\n\n`;
}

export function createSseHeartbeatComment(): string {
	return SSE_HEARTBEAT_COMMENT;
}

export function createServerChunkRuntime({
	enqueueChunk,
	onToken,
	onThinking,
	onToolCall,
	thinkingBatchMin = 20,
	skillControlEnabled = true,
}: {
	enqueueChunk: (chunk: string) => boolean;
	onToken?: (text: string) => void;
	onThinking?: (text: string) => void;
	onToolCall?: (
		name: string,
		input: Record<string, unknown>,
		status: "running" | "done",
		outputSummary?: string | null,
		details?: ImportedToolDetails,
	) => void;
	thinkingBatchMin?: number;
	skillControlEnabled?: boolean;
}) {
	let fullResponse = "";
	let thinkingContent = "";
	const inlineThinkingState = createInlineThinkingState();
	const leakedToolDiagnosticsState = createLeakedToolDiagnosticsState();
	const serverSegments: ServerStreamSegment[] = [];
	const toolCallRecords: ToolCallEntry[] = [];
	const skillControlEnvelopePayloads: string[] = [];
	let pendingThinkingBuffer = "";
	let leadingOutputState: "pending" | "thinking" | "done" = "pending";
	let leadingOutputBuffer = "";
	let visibleTokenBuffer = "";
	let skillControlEnvelopeBuffer = "";

	const flushPendingThinking = (): boolean => {
		if (!pendingThinkingBuffer) return true;
		const chunk = pendingThinkingBuffer;
		pendingThinkingBuffer = "";
		thinkingContent += chunk;
		const lastSegment = serverSegments[serverSegments.length - 1];
		if (lastSegment?.type === "text") {
			lastSegment.content += chunk;
		} else {
			serverSegments.push({ type: "text", content: chunk });
		}
		if (onThinking) onThinking(chunk);
		return enqueueChunk(
			`event: thinking\ndata: ${JSON.stringify({ text: chunk })}\n\n`,
		);
	};

	const stripToolCallsFromThinking = (text: string): string => {
		return text.replace(
			/<tool_calls>[\r\n]*[\r\n\ta-zA-Z0-9_./:,'"{}\u4e00-\u9fff-]*?<\/tool_calls>/gi,
			"",
		);
	};

	const emitThinking = (reasoning: string) => {
		if (!reasoning) return true;
		const cleanedReasoning = stripToolCallsFromThinking(reasoning);
		pendingThinkingBuffer += cleanedReasoning;
		if (!thinkingContent) {
			pendingThinkingBuffer = stripLeadingResponseMarker(pendingThinkingBuffer);
		}
		if (pendingThinkingBuffer.length >= thinkingBatchMin) {
			return flushPendingThinking();
		}
		return true;
	};

	const flushVisibleTokenBuffer = (force = false): boolean => {
		if (!visibleTokenBuffer) {
			return true;
		}

		const sanitizedBuffer = stripLeakedToolDiagnostics(
			visibleTokenBuffer,
			leakedToolDiagnosticsState,
		);
		const envelopeFilteredBuffer = filterSkillControlEnvelopeText(
			sanitizedBuffer,
			force,
		);
		const holdLength = force
			? 0
			: getLeakedToolDiagnosticPrefixLength(envelopeFilteredBuffer);
		const visibleChunk = holdLength
			? envelopeFilteredBuffer.slice(0, -holdLength)
			: envelopeFilteredBuffer;
		visibleTokenBuffer = holdLength ? envelopeFilteredBuffer.slice(-holdLength) : "";

		if (!visibleChunk) {
			return true;
		}

		fullResponse += visibleChunk;
		if (onToken) onToken(visibleChunk);
		return enqueueChunk(
			`event: token\ndata: ${JSON.stringify({ text: visibleChunk })}\n\n`,
		);
	};

	const emitVisibleToken = (chunk: string) => {
		if (!chunk) {
			return true;
		}

		visibleTokenBuffer += chunk;
		return flushVisibleTokenBuffer(false);
	};

	const filterSkillControlEnvelopeText = (
		input: string,
		force = false,
	): string => {
		if (!skillControlEnabled) return input;

		let value = skillControlEnvelopeBuffer + input;
		skillControlEnvelopeBuffer = "";
		if (!value) return "";

		let output = "";
		const openTag = SKILL_CONTROL_ENVELOPE_OPEN_TAG;
		const closeTag = SKILL_CONTROL_ENVELOPE_CLOSE_TAG;

		while (value) {
			const lowerValue = value.toLowerCase();
			const openIndex = lowerValue.indexOf(openTag);
			if (openIndex === -1) {
				const holdLength = force
					? 0
					: getSkillControlEnvelopePrefixHoldLength(value);
				output += holdLength ? value.slice(0, -holdLength) : value;
				skillControlEnvelopeBuffer = holdLength ? value.slice(-holdLength) : "";
				break;
			}

			output += value.slice(0, openIndex);
			const payloadStart = openIndex + openTag.length;
			const closeIndex = lowerValue.indexOf(closeTag, payloadStart);
			if (closeIndex === -1) {
				if (force) {
					output += value.slice(openIndex);
				} else {
					skillControlEnvelopeBuffer = value.slice(openIndex);
				}
				break;
			}

			skillControlEnvelopePayloads.push(
				value.slice(payloadStart, closeIndex).trim(),
			);
			value = value.slice(closeIndex + closeTag.length);
		}

		return output;
	};

	const emitToolCallEvent = (
		name: string,
		input: Record<string, unknown>,
		status: "running" | "done",
		details?: ImportedToolDetails,
	) => {
		const shouldStoreThinkingSegment = !isFileProductionToolName(name);

		flushInlineThinkingBuffer();
		flushPendingThinking();
		if (onToolCall) onToolCall(name, input, status, details?.outputSummary, details);
		enqueueChunk(
			`event: tool_call\ndata: ${JSON.stringify({
				name,
				input,
				status,
				outputSummary: details?.outputSummary,
				sourceType: details?.sourceType,
				candidates: details?.candidates,
				metadata: details?.metadata,
			})}\n\n`,
		);

		if (status === "running") {
			if (shouldStoreThinkingSegment) {
				serverSegments.push({
					type: "tool_call",
					name,
					input,
					status: "running",
				});
			}
			toolCallRecords.push({ name, input, status: "running" });
			return;
		}

		if (shouldStoreThinkingSegment) {
			for (let i = serverSegments.length - 1; i >= 0; i--) {
				const segment = serverSegments[i];
				if (
					segment.type === "tool_call" &&
					segment.name === name &&
					segment.status === "running"
				) {
					segment.status = "done";
					segment.outputSummary = details?.outputSummary ?? null;
					segment.sourceType = details?.sourceType ?? null;
					segment.candidates = details?.candidates;
					segment.metadata = details?.metadata;
					break;
				}
			}
		}

		for (let i = toolCallRecords.length - 1; i >= 0; i--) {
			const toolRecord = toolCallRecords[i];
			if (toolRecord.name === name && toolRecord.status === "running") {
				toolCallRecords[i] = {
					...toolRecord,
					status: "done",
					outputSummary: details?.outputSummary ?? null,
					sourceType: details?.sourceType ?? null,
					candidates: details?.candidates,
					metadata: details?.metadata,
				};
				break;
			}
		}
	};

	const emitInlineToken = (chunk: string) => {
		return processInlineThinkingChunk(inlineThinkingState, chunk, {
			onVisible: emitVisibleToken,
			onThinking: emitThinking,
		});
	};

	const flushLeadingOutputBuffer = (allowOpenEndedThinking = true): boolean => {
		if (!leadingOutputBuffer) {
			return true;
		}

		const buffered = leadingOutputBuffer;
		leadingOutputBuffer = "";

		if (
			leadingOutputState === "thinking" ||
			looksLikeLeadingThinkingPreamble(buffered)
		) {
			const split = splitLeadingThinkingPreamble(buffered, {
				allowOpenEnded: allowOpenEndedThinking,
			});
			if (split) {
				leadingOutputState = split.visibleText ? "done" : "thinking";
				if (split.thinkingText && !emitThinking(split.thinkingText)) {
					return false;
				}
				if (!flushPendingThinking()) {
					return false;
				}
				return split.visibleText ? emitInlineToken(split.visibleText) : true;
			}
		}

		leadingOutputState = "done";
		return emitInlineToken(stripLeadingResponseMarker(buffered));
	};

	const emitOutputToken = (chunk: string): boolean => {
		if (!chunk) return true;
		if (leadingOutputState === "done") {
			return emitInlineToken(chunk);
		}

		leadingOutputBuffer += chunk;

		if (leadingOutputState === "pending") {
			if (looksLikeLeadingThinkingPreamble(leadingOutputBuffer)) {
				leadingOutputState = "thinking";
			} else if (
				leadingOutputBuffer.length < 80 &&
				mayStartLeadingThinkingPreamble(leadingOutputBuffer)
			) {
				return true;
			} else {
				return flushLeadingOutputBuffer(false);
			}
		}

		const split = splitLeadingThinkingPreamble(leadingOutputBuffer);
		if (!split) {
			return true;
		}

		leadingOutputBuffer = "";
		leadingOutputState = "done";
		if (split.thinkingText && !emitThinking(split.thinkingText)) {
			return false;
		}
		if (!flushPendingThinking()) {
			return false;
		}
		return split.visibleText ? emitInlineToken(split.visibleText) : true;
	};

	const flushInlineThinkingBuffer = () => {
		if (!flushLeadingOutputBuffer()) {
			return false;
		}
		const flushedInline = flushInlineThinkingState(inlineThinkingState, {
			onVisible: emitVisibleToken,
			onThinking: emitThinking,
		});
		if (!flushedInline) {
			return false;
		}
		if (!flushVisibleTokenBuffer(true)) {
			return false;
		}
		return flushPendingThinking();
	};

	const emitChunkWithOutputHandling = (chunk: string): boolean => {
		if (!chunk) return true;
		return emitOutputToken(chunk);
	};

	const flushOutputBuffer = (): boolean => flushLeadingOutputBuffer();

	return {
		emitChunkWithOutputHandling,
		emitInlineToken,
		emitThinking,
		emitToolCallEvent,
		flushInlineThinkingBuffer,
		flushOutputBuffer,
		flushPendingThinking,
		get fullResponse() {
			return fullResponse;
		},
		get thinkingContent() {
			return thinkingContent;
		},
		get serverSegments() {
			return serverSegments;
		},
		get toolCallRecords() {
			return toolCallRecords;
		},
		get skillControlEnvelopePayloads() {
			return skillControlEnvelopePayloads;
		},
	};
}

export function classifyStreamError(rawMessage: string): StreamErrorCode {
	const message = rawMessage.toLowerCase();

	if (
		message.includes("timeout") ||
		message.includes("timed out") ||
		message.includes("abort")
	) {
		return "timeout";
	}

	if (
		message.includes("network") ||
		message.includes("fetch") ||
		message.includes("econn") ||
		message.includes("enotfound") ||
		message.includes("socket") ||
		message.includes("connection") ||
		message.includes("terminated") ||
		message.includes("apiconnectionerror") ||
		message.includes("connect_tcp") ||
		message.includes("connect tcp")
	) {
		return "network";
	}

	return "backend_failure";
}

export function isAbruptUpstreamTermination(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message.toLowerCase();
	const cause =
		"cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
	const causeCode =
		cause && typeof cause === "object" && "code" in cause
			? (cause as { code?: unknown }).code
			: undefined;

	return (
		message.includes("terminated") ||
		message.includes("socket") ||
		causeCode === "UND_ERR_SOCKET"
	);
}

export function streamErrorEvent(code: StreamErrorCode): string {
	return `event: error\ndata: ${JSON.stringify({ code, message: FRIENDLY_STREAM_ERRORS[code] })}\n\n`;
}

export function extractAssistantChunk(
	eventType: string,
	rawData: unknown,
): string {
	const data = parseMaybeJson(rawData);
	const sender = getSender(data);
	const normalizedSender = sender ? normalizeSender(sender) : null;

	if (normalizedSender && ["user", "human"].includes(normalizedSender)) {
		return "";
	}

	if (
		normalizedSender &&
		![
			"assistant",
			"ai",
			"machine",
			"model",
			"language model",
			"agent",
			"bot",
		].includes(normalizedSender) &&
		eventType !== "token"
	) {
		return "";
	}

	return getTextContent(data);
}

export function toIncrementalChunk(
	eventType: string,
	chunk: string,
	lastSnapshot: string,
	emittedText: string,
): {
	chunk: string;
	lastSnapshot: string;
	emittedText: string;
} {
	if (eventType === "token") {
		return { chunk, lastSnapshot, emittedText: emittedText + chunk };
	}

	if (!chunk) {
		return { chunk: "", lastSnapshot, emittedText };
	}

	if (emittedText) {
		if (chunk === emittedText) {
			return { chunk: "", lastSnapshot: chunk, emittedText };
		}

		if (chunk.startsWith(emittedText)) {
			const delta = chunk.slice(emittedText.length);
			return {
				chunk: delta,
				lastSnapshot: chunk,
				emittedText: emittedText + delta,
			};
		}

		if (emittedText.startsWith(chunk)) {
			return { chunk: "", lastSnapshot: chunk, emittedText };
		}
	}

	if (!lastSnapshot) {
		return { chunk, lastSnapshot: chunk, emittedText: emittedText + chunk };
	}

	if (chunk === lastSnapshot) {
		return { chunk: "", lastSnapshot, emittedText };
	}

	if (chunk.startsWith(lastSnapshot)) {
		const delta = chunk.slice(lastSnapshot.length);
		return {
			chunk: delta,
			lastSnapshot: chunk,
			emittedText: emittedText + delta,
		};
	}

	if (lastSnapshot.startsWith(chunk)) {
		return { chunk: "", lastSnapshot, emittedText };
	}

	return { chunk, lastSnapshot: chunk, emittedText: emittedText + chunk };
}

export function extractErrorMessage(rawData: unknown): string {
	const data = parseMaybeJson(rawData);

	if (typeof data === "string") return data;

	const payload = getNestedObject(data);
	if (!payload) return "Streaming failed";

	const direct = getDirectErrorText(payload);
	if (direct && !isGenericLangflowErrorText(direct)) return direct;

	const nested = collectNestedErrorText(payload);
	if (nested) {
		return direct ? `${direct}\n${nested}` : nested;
	}

	if (direct) return direct;
	if ("data" in payload) return extractErrorMessage(payload.data);

	return "Streaming failed";
}

function getDirectErrorText(payload: Record<string, unknown>): string | null {
	for (const key of ["message", "error", "text", "detail", "reason"]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return null;
}

function isGenericLangflowErrorText(value: string): boolean {
	return /^code:\s*none\s*$/i.test(value.trim());
}

function collectNestedErrorText(value: unknown, depth = 0): string | null {
	if (depth > 8 || !value || typeof value !== "object") return null;

	if (Array.isArray(value)) {
		return (
			value
				.map((item) => collectNestedErrorText(item, depth + 1))
				.filter((item): item is string => Boolean(item))
				.join("\n")
				.trim() || null
		);
	}

	const payload = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["reason", "traceback", "message", "error", "detail"]) {
		const candidate = payload[key];
		if (typeof candidate === "string" && candidate.trim()) {
			parts.push(candidate);
		}
	}

	for (const key of ["data", "content_blocks", "contents", "properties"]) {
		if (key in payload) {
			const nested = collectNestedErrorText(payload[key], depth + 1);
			if (nested) parts.push(nested);
		}
	}

	return Array.from(new Set(parts)).join("\n").trim() || null;
}

export function isUrlListValidationError(rawMessage: string): boolean {
	const message = rawMessage.toLowerCase();
	return (
		message.includes("validation error") &&
		message.includes("urls") &&
		(message.includes("valid list") || message.includes("type=list_type"))
	);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}

function getSender(value: unknown): string | null {
	const payload = getNestedObject(value);
	if (!payload) return null;

	const sender =
		typeof payload.sender === "string"
			? payload.sender
			: typeof payload.sender_name === "string"
				? payload.sender_name
				: null;
	if (sender) {
		return sender.toLowerCase();
	}

	if ("data" in payload) {
		return getSender(payload.data);
	}

	return null;
}

function normalizeSender(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\r\n]+/g, " ")
		.trim();
}
