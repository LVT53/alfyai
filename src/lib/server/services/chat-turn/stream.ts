import {
	createInlineThinkingState,
	createLeakedToolDiagnosticsState,
	FRIENDLY_STREAM_ERRORS,
	flushInlineThinkingState,
	getLeakedToolDiagnosticPrefixLength,
	getSkillControlEnvelopePrefixHoldLength,
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
import {
	decodeAiSdkUiStreamPayloads,
	encodeAiSdkUiStreamDoneFrame,
	encodeAiSdkUiStreamPart,
	type UiMessageStreamPart,
} from "$lib/services/ai-sdk-ui-stream-contract";
import type {
	EvidenceSourceType,
	ResponseActivityEntry,
	ToolCallEntry,
	ToolEvidenceCandidate,
} from "$lib/types";
import type { ChatTurnRequestError } from "./types";

// Re-export all public symbols from sub-modules for backward compatibility
export {
	getReasoningContent,
	normalizeVisibleAssistantText,
	// thinking-normalizer
	THINKING_BLOCK_RE,
	THINKING_TAG_RE,
} from "./thinking-normalizer";

export type { UiMessageStreamPart } from "$lib/services/ai-sdk-ui-stream-contract";

// ---------------------------------------------------------------------------
// Internal helpers (moved to sub-modules, retained here for local use)
// ---------------------------------------------------------------------------
import { getNestedObject } from "$lib/services/stream-protocol";
import {
	isFileProductionToolName,
	toolCallInputKey,
} from "$lib/utils/tool-calls";

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-store, must-revalidate",
	Pragma: "no-cache",
	Expires: "0",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
	"X-Vercel-AI-UI-Message-Stream": "v1",
};
const SSE_PRELUDE_PADDING_BYTES = 8192;
const SSE_HEARTBEAT_COMMENT = ": keep-alive\n\n";
const UI_STREAM_TEXT_PART_ID = "answer";
const UI_STREAM_REASONING_PART_ID = "reasoning";
export type StreamPhaseTimings = Record<string, number>;

export type ServerStreamSegment =
	| { type: "text"; content: string }
	| {
			type: "status";
			id: string;
			label: string;
			status: ResponseActivityEntry["status"];
			passIndex?: number;
			passTotal?: number;
			passKind?: string;
	  }
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

type StreamToolCallDetails = {
	callId?: string;
	outputSummary?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
	metadata?: Record<string, string | number | boolean | null>;
};

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

export function encodeUiMessageStreamPart(part: UiMessageStreamPart): string {
	// We own this small encoder instead of wrapping createUIMessageStreamResponse so
	// passive browser disconnects can close only this downstream response while the
	// upstream model run continues, persists, and broadcasts exact replay frames.
	return encodeAiSdkUiStreamPart(part);
}

export function createUiMessageStreamDoneFrame(): string {
	return encodeAiSdkUiStreamDoneFrame();
}

export function decodeUiMessageStreamParts(
	chunk: string,
): Array<UiMessageStreamPart | "[DONE]"> {
	return decodeAiSdkUiStreamPayloads(chunk);
}

export function streamTextStartEvent(): string {
	return encodeUiMessageStreamPart({
		type: "text-start",
		id: UI_STREAM_TEXT_PART_ID,
	});
}

export function streamTextDeltaEvent(delta: string): string {
	return encodeUiMessageStreamPart({
		type: "text-delta",
		id: UI_STREAM_TEXT_PART_ID,
		delta,
	});
}

export function streamTextEndEvent(): string {
	return encodeUiMessageStreamPart({
		type: "text-end",
		id: UI_STREAM_TEXT_PART_ID,
	});
}

export function streamReasoningStartEvent(): string {
	return encodeUiMessageStreamPart({
		type: "reasoning-start",
		id: UI_STREAM_REASONING_PART_ID,
	});
}

export function streamReasoningDeltaEvent(delta: string): string {
	return encodeUiMessageStreamPart({
		type: "reasoning-delta",
		id: UI_STREAM_REASONING_PART_ID,
		delta,
	});
}

export function streamReasoningEndEvent(): string {
	return encodeUiMessageStreamPart({
		type: "reasoning-end",
		id: UI_STREAM_REASONING_PART_ID,
	});
}

export function streamDataPartEvent(
	type: `data-${string}`,
	data: unknown,
): string {
	return encodeUiMessageStreamPart({
		type,
		data,
		transient: true,
	});
}

export function streamToolCallEvent(data: {
	callId?: string;
	name: string;
	input: Record<string, unknown>;
	status: "running" | "done";
	outputSummary?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
	metadata?: Record<string, string | number | boolean | null>;
}): string {
	return streamDataPartEvent("data-tool-call", stripUndefined(data));
}

export function streamResponseActivityEvent(
	data: ResponseActivityEntry,
): string {
	return streamDataPartEvent("data-response-activity", stripUndefined(data));
}

export function streamFinishEvent(
	finishReason:
		| "stop"
		| "error"
		| "length"
		| "content-filter"
		| "tool-calls"
		| "other" = "stop",
): string {
	return encodeUiMessageStreamPart({ type: "finish", finishReason });
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function readToolArgumentsText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseJsonIfString(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}

	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function readToolInput(value: unknown): Record<string, unknown> | undefined {
	const parsed = parseJsonIfString(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as Record<string, unknown>;
}

function parseToolArguments(
	value: string,
): Record<string, unknown> | undefined {
	const parsed = parseJsonIfString(value);
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
	const data = parseJsonIfString(value);
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
		details?: StreamToolCallDetails,
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
	let textPartStarted = false;
	let reasoningPartStarted = false;

	const emitUiTextDelta = (chunk: string): boolean => {
		const frames: string[] = [];
		if (!textPartStarted) {
			textPartStarted = true;
			frames.push(streamTextStartEvent());
		}
		frames.push(streamTextDeltaEvent(chunk));
		return enqueueChunk(frames.join(""));
	};

	const emitUiReasoningDelta = (chunk: string): boolean => {
		const frames: string[] = [];
		if (!reasoningPartStarted) {
			reasoningPartStarted = true;
			frames.push(streamReasoningStartEvent());
		}
		frames.push(streamReasoningDeltaEvent(chunk));
		return enqueueChunk(frames.join(""));
	};

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
		return emitUiReasoningDelta(chunk);
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
		if (
			force &&
			envelopeFilteredBuffer.trim() &&
			getLeakedToolDiagnosticPrefixLength(envelopeFilteredBuffer.trim()) ===
				envelopeFilteredBuffer.trim().length
		) {
			visibleTokenBuffer = "";
			return true;
		}
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
		return emitUiTextDelta(visibleChunk);
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
		details?: StreamToolCallDetails,
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
			streamToolCallEvent({
				callId,
				name,
				input,
				status,
				outputSummary: details?.outputSummary,
				sourceType: details?.sourceType,
				candidates: details?.candidates,
				metadata: details?.metadata,
			}),
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
		if (runningRecordIndex === -1) {
			const doneRecord: ToolCallEntry = {
				...(callId ? { callId } : {}),
				name,
				input,
				status: "done",
				outputSummary: details?.outputSummary ?? null,
				sourceType: details?.sourceType ?? null,
				candidates: details?.candidates,
				metadata: details?.metadata,
			};
			toolCallRecords.push(doneRecord);
			if (shouldStoreThinkingSegment) {
				serverSegments.push({
					type: "tool_call",
					...(callId ? { callId } : {}),
					name,
					input,
					status: "done",
					outputSummary: details?.outputSummary ?? null,
					sourceType: details?.sourceType ?? null,
					candidates: details?.candidates,
					metadata: details?.metadata,
				});
			}
			return;
		}
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

	const emitStatusSegment = (segment: {
		id: string;
		label: string;
		status: ResponseActivityEntry["status"];
		passIndex?: number;
		passTotal?: number;
		passKind?: string;
	}) => {
		if (!segment.label.trim()) return;
		flushInlineThinkingBuffer();
		flushPendingThinking();
		const existingIndex = serverSegments.findIndex(
			(entry) => entry.type === "status" && entry.id === segment.id,
		);
		if (existingIndex === -1) {
			serverSegments.push({ type: "status", ...segment });
			return;
		}
		serverSegments[existingIndex] = {
			...serverSegments[existingIndex],
			...segment,
		};
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

		// Prevent indefinite buffering when models don't use clear thinking/visible boundaries
		if (
			leadingOutputState === "thinking" &&
			leadingOutputBuffer.length > 2000
		) {
			leadingOutputState = "done";
			const buffered = leadingOutputBuffer;
			leadingOutputBuffer = "";
			return emitInlineToken(stripLeadingResponseMarker(buffered));
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
		if (!flushLeadingOutputBuffer(false)) {
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

	const flushOutputBuffer = (): boolean => flushLeadingOutputBuffer(false);

	return {
		emitChunkWithOutputHandling,
		emitInlineToken,
		emitThinking,
		emitStatusSegment,
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

function isInternalFileProductionField(field: string): boolean {
	return /^(?:documentSource|document_source|requestedOutputs|sourceMode|documentIntent|templateHint|program|program\.sourceCode|sourceCode|idempotencyKey)$/i.test(
		field,
	);
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
		if (isInternalFileProductionField(field)) {
			return "the file-generation tool rejected its input shape";
		}
		return `${field} should be a valid ${expectedType}`;
	}
	if (field) {
		if (isInternalFileProductionField(field)) {
			return "the file-generation tool rejected its input shape";
		}
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
	return [
		streamDataPartEvent("data-stream-error", {
			code,
			message: FRIENDLY_STREAM_ERRORS[code],
		}),
		streamFinishEvent("error"),
		createUiMessageStreamDoneFrame(),
	].join("");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}
