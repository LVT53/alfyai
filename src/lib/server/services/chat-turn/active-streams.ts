import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import { getConfig } from "$lib/server/config-store";
import type {
	EvidenceSourceType,
	ToolEvidenceCandidate,
} from "$lib/server/services/message-evidence";
import type { ToolCallMapData } from "$lib/server/services/messages-types";
import { decodeAiSdkUiStreamPayloads } from "$lib/services/ai-sdk-ui-stream-contract";
import { toolCallInputKey } from "$lib/utils/tool-calls";
import { StreamReplayJournal } from "./stream-replay-journal";

const STOP_REQUEST_TTL_MS = 30_000;

type ActiveChatStream = {
	userId: string;
	conversationId: string;
	controller: AbortController;
};

const activeStreams = new Map<string, ActiveChatStream>();
const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();

// D2 (draining): process-local flag gating admission of *new* streams ahead
// of a deploy restart. In-flight streams are already registered in
// `activeStreams` and are untouched by this flag — it only affects
// `checkStreamCapacity`, and `/api/chat/retry` turns a regenerate away for it
// too. Never survives a restart (new process starts undrained), so a completed
// deploy needs no explicit un-drain; a deploy that stops before the restart
// undoes it itself (the trap in scripts/deploy.sh).
let draining = false;

export function setDraining(value: boolean): void {
	draining = value;
}

export function isDraining(): boolean {
	return draining;
}

// Track per-user stream counts for limit enforcement
const userStreamCounts = new Map<string, number>();

// Track conversationId → streamId for orphan detection
const conversationStreams = new Map<string, string>();

// Stream token buffer for reconnection replay
export interface StreamTokenBuffer {
	streamId: string;
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
		status: "running" | "done" | "failed";
		outputSummary?: string | null;
		sourceType?: EvidenceSourceType | null;
		candidates?: ToolEvidenceCandidate[];
		metadata?: Record<string, string | number | boolean | null>;
		map?: ToolCallMapData | null;
	}>;
	journal: StreamReplayJournal;
	listeners: Set<(chunk: string) => void>;
}

const streamBuffers = new Map<string, StreamTokenBuffer>();
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
	return (
		!isStreamActive({
			streamId: buffer.streamId,
			userId: buffer.userId,
			conversationId: buffer.conversationId,
		}) && now - buffer.updatedAt >= BUFFER_TTL_MS
	);
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
			streamId: params.streamId,
			userId: params.userId,
			conversationId: params.conversationId,
			createdAt: now,
			updatedAt: now,
			userMessage: params.userMessage,
			...(params.reasoningDepth
				? { reasoningDepth: params.reasoningDepth }
				: {}),
			journal: new StreamReplayJournal(),
			get tokens() {
				return projectBuffer(this).tokens;
			},
			get thinking() {
				return projectBuffer(this).thinking;
			},
			get responseActivity() {
				return projectBuffer(this).responseActivity;
			},
			get toolCalls() {
				return projectBuffer(this).toolCalls;
			},
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
			createdAt: number;
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
		...(buffer.reasoningDepth ? { reasoningDepth: buffer.reasoningDepth } : {}),
		tokenCount: buffer.tokens.length,
		thinkingCount: buffer.thinking.length,
		toolCallCount: buffer.toolCalls.length,
		...(buffer.responseActivity.length > 0
			? { activityCount: buffer.responseActivity.length }
			: {}),
		createdAt: buffer.createdAt,
	};
}

// Legacy status views are derived on read; replay never reconstructs these arrays.
function projectBuffer(buffer: StreamTokenBuffer) {
	const tokens: string[] = [],
		thinking: string[] = [];
	const responseActivity = new Map<string, ResponseActivityEntry>();
	const toolCalls: StreamTokenBuffer["toolCalls"] = [];
	for (const chunk of buffer.journal.read().chunks) {
		for (const part of decodeAiSdkUiStreamPayloads(chunk)) {
			if (part === "[DONE]") continue;
			if (part.type === "text-delta") tokens.push(part.delta ?? "");
			else if (part.type === "reasoning-delta") thinking.push(part.delta ?? "");
			else if (part.type === "data-response-activity") {
				const entry = part.data as ResponseActivityEntry;
				responseActivity.set(entry.id, {
					...responseActivity.get(entry.id),
					...entry,
				});
			} else if (part.type === "data-tool-call") {
				const entry = part.data as StreamTokenBuffer["toolCalls"][number];
				const prior = toolCalls.findLast(
					(e) =>
						e.name === entry.name &&
						(entry.callId
							? e.callId === entry.callId
							: entry.status !== "running" ||
								toolCallInputKey(e.input) ===
									toolCallInputKey(entry.input ?? {})),
				);
				if (prior)
					Object.assign(prior, entry, { input: entry.input ?? prior.input });
				else toolCalls.push({ ...entry, input: entry.input ?? {} });
			}
		}
	}
	return {
		tokens,
		thinking,
		responseActivity: [...responseActivity.values()],
		toolCalls,
	};
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
	const buffer = getLiveStreamBuffer(streamId);
	if (buffer) {
		buffer.updatedAt = Date.now();
		buffer.journal.append(chunk);
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
		params.controller.abort(new UserStopReason());
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

/**
 * The reason on the abort signal when the PERSON stopped the turn (the
 * composer's Stop). Every other abort (stream timeout, idle watchdog,
 * fallback) carries no such reason, so a tool that must tell a Stop from the
 * app giving up (`make_image` cancels a take not yet rendering only on a Stop)
 * checks for it.
 */
export class UserStopReason extends Error {
	constructor() {
		super("The user stopped the turn");
		this.name = "UserStopReason";
	}
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
	activeStream.controller.abort(new UserStopReason());
	return true;
}

export function requestActiveChatStreamsStopForUser(userId: string): {
	stopped: number;
} {
	let stopped = 0;
	for (const [streamId, activeStream] of activeStreams) {
		if (activeStream.userId !== userId) continue;
		markPendingStop({ streamId, userId });
		activeStream.controller.abort(new UserStopReason());
		stopped += 1;
	}
	return { stopped };
}

export function wasActiveChatStreamStopRequested(params: {
	streamId: string | null | undefined;
	userId: string;
}): boolean {
	if (!params.streamId) return false;
	return pendingStops.has(pendingStopKey(params.userId, params.streamId));
}

export interface StreamCapacityCheck {
	allowed: boolean;
	/**
	 * Why a new turn is turned away. `draining` is the server getting ready for a
	 * deploy restart: it ends by itself, and a page waits for the update instead of
	 * treating it as a full server. The 503 it makes keeps the `CAPACITY_EXCEEDED`
	 * code (`refuseTurnWhenOverCapacity`), so a page loaded before this reason
	 * existed still backs off on the code.
	 */
	reason?: "global_limit" | "user_limit" | "draining";
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

	if (draining) {
		return {
			allowed: false,
			reason: "draining",
			retryAfterSeconds: 10,
			currentGlobalCount,
			currentUserCount,
		};
	}

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

/**
 * Whether one of this user's chat turns is running in this process right now.
 * Nothing the app shows on its own (an announcement) opens over a running turn.
 */
export function userHasActiveChatStream(userId: string): boolean {
	return (userStreamCounts.get(userId) ?? 0) > 0;
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

/** Start and observe are distinct intents. Only a new owned lifetime can generate. */
export function acquireChatStream(params: {
	streamId: string;
	userId: string;
	conversationId: string;
	controller: AbortController;
	userMessage: string;
	reasoningDepth?: ReasoningDepth;
	intent: "start" | "observe";
}):
	| { action: "observe"; streamId: string }
	| { action: "close" }
	| { action: "owned"; release(discard?: boolean): void } {
	if (params.intent === "observe")
		return { action: "observe", streamId: params.streamId };
	if (getStreamBuffer(params))
		return { action: "observe", streamId: params.streamId };
	const current = getOrphanedStream(params);
	if (current) return { action: "observe", streamId: current };
	if (!registerActiveChatStream(params)) return { action: "close" };
	try {
		getOrCreateStreamBuffer({
			streamId: params.streamId,
			userId: params.userId,
			conversationId: params.conversationId,
			userMessage: params.userMessage,
			reasoningDepth: params.reasoningDepth,
		});
	} catch (error) {
		unregisterActiveChatStream(params.streamId, params.controller);
		clearStreamBuffer(params.streamId);
		throw error;
	}
	let released = false;
	return {
		action: "owned",
		release(discard = false) {
			if (released) return;
			released = true;
			unregisterActiveChatStream(params.streamId, params.controller);
			if (discard) clearStreamBuffer(params.streamId);
		},
	};
}
