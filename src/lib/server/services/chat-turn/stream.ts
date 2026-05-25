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
import {
	isFileProductionToolName,
	toolCallInputKey,
} from "$lib/utils/tool-calls";
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
			callId?: string;
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done";
			outputSummary?: string | null;
			sourceType?: EvidenceSourceType | null;
			candidates?: ToolEvidenceCandidate[];
			metadata?: Record<string, string | number | boolean | null>;
	  };

type NativeToolCallFragment = {
	key: string;
	callId?: string;
	name?: string;
	argumentsText?: string;
	input?: Record<string, unknown>;
	done?: boolean;
};

type NativeToolCallAccumulator = {
	key: string;
	callId?: string;
	name?: string;
	argumentsText: string;
	input?: Record<string, unknown>;
	runningEmitted: boolean;
	doneEmitted: boolean;
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

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function readToolArgumentsText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readToolInput(value: unknown): Record<string, unknown> | undefined {
	const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as Record<string, unknown>;
}

function parseToolArguments(
	value: string,
): Record<string, unknown> | undefined {
	const parsed = parseMaybeJson(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as Record<string, unknown>;
}

function getFinishReason(payload: Record<string, unknown>): string | undefined {
	return (
		readNonEmptyString(payload.finish_reason) ??
		readNonEmptyString(payload.finishReason)
	);
}

function collectNativeToolCallFragments(
	value: unknown,
	path = "root",
	seen = new Set<unknown>(),
): { fragments: NativeToolCallFragment[]; shouldFlush: boolean } {
	const data = parseMaybeJson(value);
	const payload = getNestedObject(data);
	if (!payload || seen.has(payload)) {
		return { fragments: [], shouldFlush: false };
	}
	seen.add(payload);

	const fragments: NativeToolCallFragment[] = [];
	let shouldFlush = getFinishReason(payload) === "tool_calls";

	const collectCall = (
		call: unknown,
		key: string,
		options: { done?: boolean } = {},
	) => {
		const callRecord = getNestedObject(call);
		if (!callRecord) return;
		const functionRecord = getNestedObject(callRecord.function);
		const callId =
			readNonEmptyString(callRecord.id) ??
			readNonEmptyString(callRecord.callId) ??
			readNonEmptyString(callRecord.tool_call_id);
		const name =
			readNonEmptyString(functionRecord?.name) ??
			readNonEmptyString(callRecord.name);
		const argumentsText =
			readToolArgumentsText(functionRecord?.arguments) ??
			readToolArgumentsText(callRecord.arguments) ??
			readToolArgumentsText(callRecord.args);
		const input =
			readToolInput(callRecord.input) ?? readToolInput(callRecord.args);

		fragments.push({
			key,
			...(callId ? { callId } : {}),
			...(name ? { name } : {}),
			...(argumentsText !== undefined ? { argumentsText } : {}),
			...(input ? { input } : {}),
			...(options.done ? { done: true } : {}),
		});
	};

	const collectCallArray = (
		value: unknown,
		basePath: string,
		options: { done?: boolean } = {},
	) => {
		if (!Array.isArray(value)) return;
		value.forEach((call, index) => {
			const callRecord = getNestedObject(call);
			const nativeIndex =
				typeof callRecord?.index === "number" ||
				typeof callRecord?.index === "string"
					? String(callRecord.index)
					: String(index);
			collectCall(call, `${basePath}:${nativeIndex}`, options);
		});
	};

	if (Array.isArray(payload.choices)) {
		payload.choices.forEach((choice, choiceArrayIndex) => {
			const choiceRecord = getNestedObject(choice);
			if (!choiceRecord) return;
			const choiceIndex =
				typeof choiceRecord.index === "number" ||
				typeof choiceRecord.index === "string"
					? String(choiceRecord.index)
					: String(choiceArrayIndex);
			if (getFinishReason(choiceRecord) === "tool_calls") {
				shouldFlush = true;
			}

			const delta = getNestedObject(choiceRecord.delta);
			if (delta) {
				collectCallArray(
					delta.tool_calls,
					`${path}:choice:${choiceIndex}:delta`,
				);
			}

			const message = getNestedObject(choiceRecord.message);
			if (message) {
				collectCallArray(
					message.tool_calls,
					`${path}:choice:${choiceIndex}:message`,
					{ done: true },
				);
			}
		});
	}

	collectCallArray(payload.tool_calls, `${path}:tool_calls`, { done: true });
	collectCallArray(payload.tool_call_chunks, `${path}:tool_call_chunks`);

	for (const key of [
		"additional_kwargs",
		"chunk",
		"data",
		"kwargs",
		"message",
		"response_metadata",
	]) {
		if (!(key in payload)) continue;
		const nested = collectNativeToolCallFragments(
			payload[key],
			`${path}:${key}`,
			seen,
		);
		fragments.push(...nested.fragments);
		shouldFlush ||= nested.shouldFlush;
	}

	return { fragments, shouldFlush };
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
	const toolCallAliases = new Map<string, string>();
	const nativeToolCallAccumulators = new Map<
		string,
		NativeToolCallAccumulator
	>();
	const nativeToolCallKeysById = new Map<string, string>();
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
		visibleTokenBuffer = holdLength
			? envelopeFilteredBuffer.slice(-holdLength)
			: "";

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
		const rawCallId = details?.callId;
		const callId = rawCallId
			? (toolCallAliases.get(rawCallId) ?? rawCallId)
			: undefined;
		const inputKey = toolCallInputKey(input);
		const runningRecordMatchesInput = (record: ToolCallEntry) =>
			record.status === "running" &&
			record.name === name &&
			toolCallInputKey(record.input) === inputKey;
		const completedRecordMatchesInput = (record: ToolCallEntry) =>
			record.status === "done" &&
			record.name === name &&
			toolCallInputKey(record.input) === inputKey;
		const runningRecordMatchesCallId = (record: ToolCallEntry) =>
			Boolean(callId) &&
			record.status === "running" &&
			record.name === name &&
			record.callId === callId;
		const findLastToolCallRecordIndex = (
			predicate: (record: ToolCallEntry) => boolean,
		) => {
			for (let i = toolCallRecords.length - 1; i >= 0; i -= 1) {
				if (predicate(toolCallRecords[i])) return i;
			}
			return -1;
		};
		const findRunningRecordIndex = (options: { matchInput: boolean }) => {
			if (callId) {
				const exactIndex = findLastToolCallRecordIndex(
					runningRecordMatchesCallId,
				);
				if (exactIndex !== -1) return exactIndex;
			}
			if (options.matchInput) {
				const inputIndex = findLastToolCallRecordIndex(
					runningRecordMatchesInput,
				);
				if (inputIndex !== -1) return inputIndex;
			}
			return findLastToolCallRecordIndex((record) => {
				if (record.status !== "running" || record.name !== name) return false;
				return true;
			});
		};
		const findCompletedRecordIndexByInput = () =>
			findLastToolCallRecordIndex(completedRecordMatchesInput);
		const rememberAlias = (record: ToolCallEntry | undefined) => {
			if (!rawCallId || !record?.callId || rawCallId === record.callId) return;
			toolCallAliases.set(rawCallId, record.callId);
		};
		const matchesCompletedRecord = (record: ToolCallEntry) =>
			Boolean(callId) && record.status === "done" && record.callId === callId;

		if (status === "running") {
			const duplicateRunningIndex = findRunningRecordIndex({
				matchInput: true,
			});
			if (duplicateRunningIndex !== -1) {
				rememberAlias(toolCallRecords[duplicateRunningIndex]);
				return;
			}
			const completedDuplicateIndex = findCompletedRecordIndexByInput();
			if (completedDuplicateIndex !== -1) {
				rememberAlias(toolCallRecords[completedDuplicateIndex]);
				return;
			}
		} else if (toolCallRecords.some(matchesCompletedRecord)) {
			return;
		} else if (
			callId &&
			findRunningRecordIndex({ matchInput: false }) === -1 &&
			toolCallRecords.some(
				(record) => record.status === "done" && record.name === name,
			)
		) {
			return;
		}

		flushInlineThinkingBuffer();
		flushPendingThinking();
		if (onToolCall)
			onToolCall(name, input, status, details?.outputSummary, details);
		enqueueChunk(
			`event: tool_call\ndata: ${JSON.stringify({
				callId,
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
					...(callId ? { callId } : {}),
					name,
					input,
					status: "running",
				});
			}
			toolCallRecords.push({
				...(callId ? { callId } : {}),
				name,
				input,
				status: "running",
			});
			return;
		}

		if (shouldStoreThinkingSegment) {
			for (let i = serverSegments.length - 1; i >= 0; i--) {
				const segment = serverSegments[i];
				if (
					segment.type === "tool_call" &&
					segment.name === name &&
					segment.status === "running" &&
					(callId ? segment.callId === callId : true)
				) {
					segment.status = "done";
					if (Object.keys(input).length > 0) {
						segment.input = input;
					}
					segment.outputSummary = details?.outputSummary ?? null;
					segment.sourceType = details?.sourceType ?? null;
					segment.candidates = details?.candidates;
					segment.metadata = details?.metadata;
					break;
				}
			}
		}

		const runningRecordIndex = findRunningRecordIndex({ matchInput: false });
		for (let i = toolCallRecords.length - 1; i >= 0; i--) {
			const toolRecord = toolCallRecords[i];
			if (i === runningRecordIndex) {
				toolCallRecords[i] = {
					...toolRecord,
					...(callId ? { callId } : {}),
					input: Object.keys(input).length > 0 ? input : toolRecord.input,
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

	const getNativeToolCallInput = (
		accumulator: NativeToolCallAccumulator,
	): Record<string, unknown> => {
		if (accumulator.input) {
			return accumulator.input;
		}
		if (accumulator.argumentsText.trim()) {
			return parseToolArguments(accumulator.argumentsText) ?? {};
		}
		return {};
	};

	const getNativeAccumulator = (
		fragment: NativeToolCallFragment,
	): NativeToolCallAccumulator => {
		const keyFromId = fragment.callId
			? nativeToolCallKeysById.get(fragment.callId)
			: undefined;
		const key = keyFromId ?? fragment.key;
		let accumulator = nativeToolCallAccumulators.get(key);
		if (!accumulator) {
			accumulator = {
				key,
				argumentsText: "",
				runningEmitted: false,
				doneEmitted: false,
			};
			nativeToolCallAccumulators.set(key, accumulator);
		}
		if (fragment.callId) {
			accumulator.callId = fragment.callId;
			nativeToolCallKeysById.set(fragment.callId, key);
		}
		if (fragment.name) {
			accumulator.name = fragment.name;
		}
		if (fragment.argumentsText !== undefined) {
			accumulator.argumentsText += fragment.argumentsText;
		}
		if (fragment.input) {
			accumulator.input = fragment.input;
		}
		return accumulator;
	};

	const emitNativeToolCallRunning = (
		accumulator: NativeToolCallAccumulator,
	) => {
		if (!accumulator.name || accumulator.runningEmitted) {
			return;
		}
		emitToolCallEvent(
			accumulator.name,
			getNativeToolCallInput(accumulator),
			"running",
			accumulator.callId ? { callId: accumulator.callId } : undefined,
		);
		accumulator.runningEmitted = true;
	};

	const emitNativeToolCallDone = (accumulator: NativeToolCallAccumulator) => {
		if (!accumulator.name || accumulator.doneEmitted) {
			return;
		}
		emitNativeToolCallRunning(accumulator);
		emitToolCallEvent(
			accumulator.name,
			getNativeToolCallInput(accumulator),
			"done",
			accumulator.callId ? { callId: accumulator.callId } : undefined,
		);
		accumulator.doneEmitted = true;
	};

	const flushNativeToolCalls = () => {
		for (const accumulator of nativeToolCallAccumulators.values()) {
			emitNativeToolCallDone(accumulator);
		}
	};

	const processNativeToolCalls = (value: unknown) => {
		const { fragments, shouldFlush } = collectNativeToolCallFragments(value);
		for (const fragment of fragments) {
			const accumulator = getNativeAccumulator(fragment);
			if (fragment.done) {
				emitNativeToolCallDone(accumulator);
			} else {
				emitNativeToolCallRunning(accumulator);
			}
		}
		if (shouldFlush) {
			flushNativeToolCalls();
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
		processNativeToolCalls,
		flushNativeToolCalls,
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

export function formatUpstreamErrorAsAssistantMessage(
	rawMessage: string,
): string {
	const validationSummary = summarizeValidationError(rawMessage);
	if (validationSummary) {
		return `I couldn't complete that request because a tool input failed validation: ${validationSummary}.`;
	}

	return "I couldn't complete that request because the upstream tool returned an error. Please retry or adjust the request.";
}

function summarizeValidationError(rawMessage: string): string | null {
	const lines = rawMessage
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const validationLineIndex = lines.findIndex((line) =>
		/\bvalidation error\b/i.test(line),
	);
	if (validationLineIndex === -1) {
		return null;
	}

	const field = lines
		.slice(validationLineIndex + 1)
		.find((line) => /^[A-Za-z_][\w.:-]*$/.test(line));
	const expectedType = lines
		.map((line) => line.match(/\bInput should be (?:a |an )?valid ([^[.]+)/i))
		.find((match): match is RegExpMatchArray => Boolean(match))?.[1]
		.trim()
		.toLowerCase();

	if (field && expectedType) {
		return `${field} should be a valid ${expectedType}`;
	}
	if (field) {
		return `${field} has an invalid value`;
	}

	return "invalid tool input";
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
	if (isToolLikeStreamPayload(eventType, data)) {
		return "";
	}
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
		].includes(normalizedSender)
	) {
		return "";
	}

	return getTextContent(data);
}

function isToolLikeStreamPayload(eventType: string, value: unknown): boolean {
	const normalizedEventType = eventType.toLowerCase().trim();
	if (
		/\b(?:tool|retriever|retrieval)\b/.test(normalizedEventType) &&
		normalizedEventType !== "tool_call"
	) {
		return true;
	}

	const payload = getNestedObject(value);
	if (!payload) return false;

	const role = readNonEmptyString(payload.role)?.toLowerCase();
	if (role === "tool") {
		return true;
	}

	const type = readNonEmptyString(payload.type)?.toLowerCase();
	if (
		type &&
		/^(?:tool|tool_message|tool_result|tool_output|retriever|retrieval_result)$/.test(
			type,
		)
	) {
		return true;
	}

	const name = readNonEmptyString(payload.name)?.toLowerCase();
	if (name && /^(?:produce_file|file_production)$/.test(name)) {
		return true;
	}
	if (
		name &&
		/^(?:research_web|search|web_search|exa_search|get_contents|fetch_content|fetch|memory_context)$/.test(
			name,
		)
	) {
		return true;
	}

	if ("data" in payload) {
		return isToolLikeStreamPayload(eventType, payload.data);
	}

	return false;
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
