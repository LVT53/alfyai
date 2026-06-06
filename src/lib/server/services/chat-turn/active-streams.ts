import { getConfig } from "$lib/server/config-store";
import type {
	EvidenceSourceType,
	ReasoningDepth,
	ResponseActivityEntry,
	ToolEvidenceCandidate,
} from "$lib/types";
import { toolCallInputKey } from "$lib/utils/tool-calls";

const STOP_REQUEST_TTL_MS = 30_000;

type ActiveChatStream = {
	userId: string;
	conversationId: string;
	controller: AbortController;
};

const activeStreams = new Map<string, ActiveChatStream>();
const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();

// Track per-user stream counts for limit enforcement
const userStreamCounts = new Map<string, number>();

// Track conversationId → streamId for orphan detection
const conversationStreams = new Map<string, string>();

// Stream token buffer for reconnection replay
export interface StreamTokenBuffer {
	userId: string;
	conversationId: string;
	createdAt: number;
	updatedAt: number;
	userMessage: string;
	reasoningDepth?: ReasoningDepth;
	tokens: string[];
	thinking: string[];
	responseActivity: ResponseActivityEntry[];
	toolCalls: Array<{
		callId?: string;
		name: string;
		input: Record<string, unknown>;
		status: "running" | "done";
		outputSummary?: string | null;
		sourceType?: EvidenceSourceType | null;
		candidates?: ToolEvidenceCandidate[];
		metadata?: Record<string, string | number | boolean | null>;
	}>;
	/** Monotonic sequence counter for event ordering during replay */
	nextSequence: number;
	/** Ordered timeline of events: each entry records the type and array index */
	eventTimeline: Array<{
		seq: number;
		type: "token" | "thinking" | "response_activity" | "tool_call";
		index: number;
	}>;
	listeners: Set<(chunk: string) => void>;
}

const streamBuffers = new Map<string, StreamTokenBuffer>();
const BUFFER_MAX_TOKENS = 100_000;
const BUFFER_CLEANUP_MS = 5 * 60 * 1000;
const BUFFER_TTL_MS = BUFFER_CLEANUP_MS;

let bufferCleanupTimer: ReturnType<typeof setInterval> | null = null;

function unrefTimer(
	timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>,
) {
	timer.unref?.();
}

function stopBufferCleanupTimer() {
	if (!bufferCleanupTimer) return;
	clearInterval(bufferCleanupTimer);
	bufferCleanupTimer = null;
}

function startBufferCleanupTimer() {
	if (bufferCleanupTimer) return;
	bufferCleanupTimer = setInterval(() => {
		if (streamBuffers.size === 0) {
			stopBufferCleanupTimer();
			return;
		}

		const now = Date.now();
		for (const [streamId, buffer] of streamBuffers) {
			if (isStreamBufferExpired(buffer, now)) {
				streamBuffers.delete(streamId);
			}
		}

		if (streamBuffers.size === 0) {
			stopBufferCleanupTimer();
		}
	}, BUFFER_CLEANUP_MS);
	unrefTimer(bufferCleanupTimer);
}

function conversationStreamKey(userId: string, conversationId: string): string {
	return `${userId}:${conversationId}`;
}

function pendingStopKey(userId: string, streamId: string): string {
	return `${userId}:${streamId}`;
}

function isStreamBufferExpired(
	buffer: StreamTokenBuffer,
	now = Date.now(),
): boolean {
	return now - buffer.updatedAt >= BUFFER_TTL_MS;
}

function getLiveStreamBuffer(streamId: string): StreamTokenBuffer | null {
	const buffer = streamBuffers.get(streamId);
	if (!buffer) return null;
	if (isStreamBufferExpired(buffer)) {
		clearStreamBuffer(streamId);
		return null;
	}
	return buffer;
}

export function getStreamBuffer(params: {
	streamId: string;
	userId: string;
	conversationId?: string;
}): StreamTokenBuffer | null {
	const buffer = getLiveStreamBuffer(params.streamId);
	if (!buffer || buffer.userId !== params.userId) return null;
	if (
		params.conversationId !== undefined &&
		buffer.conversationId !== params.conversationId
	) {
		return null;
	}
	return buffer;
}

export function getOrCreateStreamBuffer(params: {
	streamId: string;
	userId: string;
	conversationId: string;
	userMessage: string;
	reasoningDepth?: ReasoningDepth;
}): StreamTokenBuffer {
	let buffer = getLiveStreamBuffer(params.streamId);
	if (
		buffer &&
		(buffer.userId !== params.userId ||
			buffer.conversationId !== params.conversationId)
	) {
		buffer.listeners.clear();
		streamBuffers.delete(params.streamId);
		buffer = null;
	}
	if (!buffer) {
		const now = Date.now();
		buffer = {
			userId: params.userId,
			conversationId: params.conversationId,
			createdAt: now,
			updatedAt: now,
			userMessage: params.userMessage,
			...(params.reasoningDepth
				? { reasoningDepth: params.reasoningDepth }
				: {}),
			tokens: [],
			thinking: [],
			responseActivity: [],
			toolCalls: [],
			nextSequence: 0,
			eventTimeline: [],
			listeners: new Set(),
		};
		streamBuffers.set(params.streamId, buffer);
		startBufferCleanupTimer();
	}
	return buffer;
}

export type StreamBufferSnapshot =
	| { exists: false }
	| {
			exists: true;
			userMessage: string;
			reasoningDepth?: ReasoningDepth;
			tokenCount: number;
			thinkingCount: number;
			toolCallCount: number;
			activityCount?: number;
	  };

export function getStreamBufferSnapshot(params: {
	streamId: string;
	userId: string;
	conversationId?: string;
}): StreamBufferSnapshot {
	const buffer = streamBuffers.get(params.streamId);
	if (!buffer || buffer.userId !== params.userId) {
		return { exists: false };
	}
	if (isStreamBufferExpired(buffer)) {
		clearStreamBuffer(params.streamId);
		return { exists: false };
	}
	if (
		params.conversationId !== undefined &&
		buffer.conversationId !== params.conversationId
	) {
		return { exists: false };
	}

	return {
		exists: true,
		userMessage: buffer.userMessage,
		...(buffer.reasoningDepth
			? { reasoningDepth: buffer.reasoningDepth }
			: {}),
		tokenCount: buffer.tokens.length,
		thinkingCount: buffer.thinking.length,
		toolCallCount: buffer.toolCalls.length,
		...(buffer.responseActivity.length > 0
			? { activityCount: buffer.responseActivity.length }
			: {}),
	};
}

export function appendToStreamBuffer(
	streamId: string,
	event: "token" | "thinking" | "tool_call" | "response_activity",
	data: {
		text?: string;
		activity?: ResponseActivityEntry;
		callId?: string;
		name?: string;
		input?: Record<string, unknown>;
		status?: "running" | "done";
		outputSummary?: string | null;
		sourceType?: EvidenceSourceType | null;
		candidates?: ToolEvidenceCandidate[];
		metadata?: Record<string, string | number | boolean | null>;
	},
) {
	const buffer = getLiveStreamBuffer(streamId);
	if (!buffer) return;
	buffer.updatedAt = Date.now();

	if (event === "token" && data.text) {
		buffer.tokens.push(data.text);
		buffer.eventTimeline.push({
			seq: buffer.nextSequence++,
			type: "token",
			index: buffer.tokens.length - 1,
		});
		// Cap buffer size
		if (buffer.tokens.join("").length > BUFFER_MAX_TOKENS) {
			buffer.tokens = buffer.tokens.slice(-Math.floor(BUFFER_MAX_TOKENS / 10));
			// Invalidate timeline since indices shifted; fall back to batch replay
			buffer.eventTimeline = [];
		}
	} else if (event === "thinking" && data.text) {
		buffer.thinking.push(data.text);
		buffer.eventTimeline.push({
			seq: buffer.nextSequence++,
			type: "thinking",
			index: buffer.thinking.length - 1,
		});
		if (buffer.thinking.join("").length > BUFFER_MAX_TOKENS) {
			buffer.thinking = buffer.thinking.slice(
				-Math.floor(BUFFER_MAX_TOKENS / 10),
			);
			buffer.eventTimeline = [];
		}
	} else if (event === "response_activity" && data.activity) {
		const existingIndex = buffer.responseActivity.findIndex(
			(entry) => entry.id === data.activity?.id,
		);
		if (existingIndex === -1) {
			buffer.responseActivity.push(data.activity);
			buffer.eventTimeline.push({
				seq: buffer.nextSequence++,
				type: "response_activity",
				index: buffer.responseActivity.length - 1,
			});
		} else {
			buffer.responseActivity[existingIndex] = {
				...buffer.responseActivity[existingIndex],
				...data.activity,
			};
		}
	} else if (event === "tool_call" && data.name) {
		if (data.status === "running") {
			const input = data.input ?? {};
			const inputKey = toolCallInputKey(input);
			const duplicateRunning = buffer.toolCalls.some(
				(toolCall) =>
					toolCall.status === "running" &&
					toolCall.name === data.name &&
					(data.callId
						? toolCall.callId === data.callId
						: toolCallInputKey(toolCall.input) === inputKey),
			);
			if (duplicateRunning) return;
			buffer.toolCalls.push({
				...(data.callId ? { callId: data.callId } : {}),
				name: data.name,
				input,
				status: "running",
				sourceType: data.sourceType,
				candidates: data.candidates,
				metadata: data.metadata,
			});
			buffer.eventTimeline.push({
				seq: buffer.nextSequence++,
				type: "tool_call",
				index: buffer.toolCalls.length - 1,
			});
		} else {
			// Mark last matching tool_call as done
			for (let i = buffer.toolCalls.length - 1; i >= 0; i--) {
				if (
					buffer.toolCalls[i].name === data.name &&
					buffer.toolCalls[i].status === "running" &&
					(data.callId ? buffer.toolCalls[i].callId === data.callId : true)
				) {
					buffer.toolCalls[i] = {
						...(buffer.toolCalls[i].callId
							? { callId: buffer.toolCalls[i].callId }
							: {}),
						name: data.name,
						input: buffer.toolCalls[i].input,
						status: "done",
						outputSummary: data.outputSummary ?? null,
						sourceType: data.sourceType ?? buffer.toolCalls[i].sourceType,
						candidates: data.candidates ?? buffer.toolCalls[i].candidates,
						metadata: data.metadata,
					};
					break;
				}
			}
		}
	}
}

export function clearStreamBuffer(streamId: string) {
	streamBuffers.delete(streamId);
	if (streamBuffers.size === 0) {
		stopBufferCleanupTimer();
	}
}

export function subscribeToStream(
	params: {
		streamId: string;
		userId: string;
		conversationId: string;
	},
	listener: (chunk: string) => void,
): boolean {
	const buffer = getStreamBuffer(params);
	if (buffer) {
		buffer.listeners.add(listener);
		return true;
	}
	return false;
}

export function unsubscribeFromStream(
	params: {
		streamId: string;
		userId: string;
		conversationId: string;
	},
	listener: (chunk: string) => void,
) {
	const buffer = getStreamBuffer(params);
	if (buffer) {
		buffer.listeners.delete(listener);
	}
}

export function broadcastStreamChunk(streamId: string, chunk: string) {
	const buffer = streamBuffers.get(streamId);
	if (buffer) {
		for (const listener of buffer.listeners) {
			try {
				listener(chunk);
			} catch {
				buffer.listeners.delete(listener);
			}
		}
	}
}

function markPendingStop(params: { streamId: string; userId: string }) {
	const key = pendingStopKey(params.userId, params.streamId);
	if (pendingStops.has(key)) {
		return;
	}

	const timeoutId = setTimeout(() => {
		pendingStops.delete(key);
	}, STOP_REQUEST_TTL_MS);
	unrefTimer(timeoutId);
	pendingStops.set(key, timeoutId);
}

function clearPendingStop(params: { streamId: string; userId: string }) {
	const key = pendingStopKey(params.userId, params.streamId);
	const timeoutId = pendingStops.get(key);
	if (timeoutId) {
		clearTimeout(timeoutId);
	}
	pendingStops.delete(key);
}

export function registerActiveChatStream(params: {
	streamId: string;
	userId: string;
	controller: AbortController;
	conversationId: string;
}): boolean {
	if (activeStreams.has(params.streamId)) {
		return false;
	}

	const existingStreamId = conversationStreams.get(
		conversationStreamKey(params.userId, params.conversationId),
	);
	if (existingStreamId && existingStreamId !== params.streamId) {
		return false;
	}

	activeStreams.set(params.streamId, {
		userId: params.userId,
		conversationId: params.conversationId,
		controller: params.controller,
	});

	conversationStreams.set(
		conversationStreamKey(params.userId, params.conversationId),
		params.streamId,
	);

	if (pendingStops.has(pendingStopKey(params.userId, params.streamId))) {
		params.controller.abort();
	}

	const currentCount = userStreamCounts.get(params.userId) ?? 0;
	userStreamCounts.set(params.userId, currentCount + 1);

	return true;
}

export function unregisterActiveChatStream(
	streamId: string,
	controller?: AbortController,
) {
	const activeStream = activeStreams.get(streamId);
	if (!activeStream) {
		return;
	}

	if (!controller || activeStream.controller === controller) {
		activeStreams.delete(streamId);
		conversationStreams.delete(
			conversationStreamKey(activeStream.userId, activeStream.conversationId),
		);

		const userId = activeStream.userId;
		const currentCount = userStreamCounts.get(userId) ?? 1;
		if (currentCount <= 1) {
			userStreamCounts.delete(userId);
		} else {
			userStreamCounts.set(userId, currentCount - 1);
		}
		clearPendingStop({ streamId, userId: activeStream.userId });
	}
}

export function getOrphanedStream(params: {
	userId: string;
	conversationId: string;
}): string | null {
	return (
		conversationStreams.get(
			conversationStreamKey(params.userId, params.conversationId),
		) ?? null
	);
}

export type StreamConversationStatus =
	| { hasOrphanedStream: false }
	| { hasOrphanedStream: true; streamId: string };

export function getStreamConversationStatus(params: {
	userId: string;
	conversationId: string;
}): StreamConversationStatus {
	const streamId = getOrphanedStream(params);
	if (!streamId) {
		return { hasOrphanedStream: false };
	}
	return { hasOrphanedStream: true, streamId };
}

export function isStreamActive(params: {
	streamId: string;
	userId: string;
	conversationId?: string;
}): boolean {
	const activeStream = activeStreams.get(params.streamId);
	if (!activeStream || activeStream.userId !== params.userId) return false;
	if (
		params.conversationId !== undefined &&
		activeStream.conversationId !== params.conversationId
	) {
		return false;
	}
	return true;
}

export function requestActiveChatStreamStop(params: {
	streamId: string;
	userId: string;
}): boolean {
	const activeStream = activeStreams.get(params.streamId);

	if (!activeStream) {
		markPendingStop(params);
		return false;
	}

	if (activeStream.userId !== params.userId) {
		return false;
	}

	markPendingStop(params);
	activeStream.controller.abort();
	return true;
}

export function wasActiveChatStreamStopRequested(params: {
	streamId: string | null | undefined;
	userId: string;
}): boolean {
	return (
		Boolean(params.streamId) &&
		pendingStops.has(pendingStopKey(params.userId, params.streamId!))
	);
}

export interface StreamCapacityCheck {
	allowed: boolean;
	reason?: "global_limit" | "user_limit";
	retryAfterSeconds?: number;
	currentGlobalCount?: number;
	currentUserCount?: number;
}

export interface StreamStats {
	globalActiveCount: number;
	perUserCounts: Map<string, number>;
	maxGlobal: number;
	maxPerUser: number;
}

export function checkStreamCapacity(userId: string): StreamCapacityCheck {
	const config = getConfig();
	const maxGlobal = config.concurrentStreamLimit;
	const maxPerUser = config.perUserStreamLimit;

	const currentGlobalCount = activeStreams.size;
	const currentUserCount = userStreamCounts.get(userId) ?? 0;

	if (currentGlobalCount >= maxGlobal) {
		return {
			allowed: false,
			reason: "global_limit",
			retryAfterSeconds: 10,
			currentGlobalCount,
			currentUserCount,
		};
	}

	if (currentUserCount >= maxPerUser) {
		return {
			allowed: false,
			reason: "user_limit",
			retryAfterSeconds: 5,
			currentGlobalCount,
			currentUserCount,
		};
	}

	return {
		allowed: true,
		currentGlobalCount,
		currentUserCount,
	};
}

export function getStreamStats(): StreamStats {
	const config = getConfig();
	return {
		globalActiveCount: activeStreams.size,
		perUserCounts: new Map(userStreamCounts),
		maxGlobal: config.concurrentStreamLimit,
		maxPerUser: config.perUserStreamLimit,
	};
}
