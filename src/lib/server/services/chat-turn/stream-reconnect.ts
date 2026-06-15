import { containsTerminalAiSdkUiStreamPayload } from "$lib/services/ai-sdk-ui-stream-contract";
import {
	streamDataPartEvent,
	streamReasoningDeltaEvent,
	streamReasoningStartEvent,
	streamResponseActivityEvent,
	streamTextDeltaEvent,
	streamTextStartEvent,
	streamToolCallEvent,
} from "./stream";

export interface ReconnectBuffer {
	userMessage: string | null;
	createdAt?: number;
	tokens: string[];
	thinking: string[];
	responseActivity: import("$lib/types").ResponseActivityEntry[];
	toolCalls: Array<{
		callId?: string;
		name: string;
		input: Record<string, unknown>;
		status: "running" | "done";
		outputSummary?: string | null;
		sourceType?: import("$lib/types").EvidenceSourceType | null;
		candidates?: import("$lib/types").ToolEvidenceCandidate[];
		metadata?: Record<string, string | number | boolean | null>;
	}>;
	eventTimeline?: Array<{
		seq: number;
		type: "token" | "thinking" | "response_activity" | "tool_call";
		index: number;
	}>;
}

export interface ReconnectDeps {
	userId: string;
	conversationId: string;
	enqueueChunk: (chunk: string) => boolean;
	closeDownstream: () => void;
	downstreamAbortSignal: AbortSignal;
	getStreamBuffer: (params: {
		streamId: string;
		userId: string;
		conversationId: string;
	}) => ReconnectBuffer | undefined;
	subscribeToStream: (
		params: {
			streamId: string;
			userId: string;
			conversationId: string;
		},
		listener: (chunk: string) => void,
	) => boolean;
	unsubscribeFromStream: (
		params: {
			streamId: string;
			userId: string;
			conversationId: string;
		},
		listener: (chunk: string) => void,
	) => void;
	createSsePreludeComment: () => string;
	createSseHeartbeatComment: () => string;
}

function unrefTimer(timer: ReturnType<typeof setInterval>) {
	timer.unref?.();
}

const RECONNECT_HEARTBEAT_MS = 10_000;

interface StreamOwner {
	streamId: string;
	userId: string;
	conversationId: string;
}

function getStreamOwner(
	streamId: string,
	userId: string,
	conversationId: string,
): StreamOwner {
	return { streamId, userId, conversationId };
}

function hasReplayableBufferData(buffer: ReconnectBuffer | undefined): boolean {
	if (!buffer) return false;
	return Boolean(
		(buffer.eventTimeline?.length ?? 0) ||
			buffer.tokens.length ||
			buffer.thinking.length ||
			buffer.toolCalls.length ||
			buffer.responseActivity.length,
	);
}

function sendReplayStart(
	enqueueChunk: ReconnectDeps["enqueueChunk"],
	buffer: ReconnectBuffer,
) {
	enqueueChunk(
		streamDataPartEvent("data-replay-start", {
			tokenCount: buffer.tokens.length,
			thinkingCount: buffer.thinking.length,
			toolCallCount: buffer.toolCalls.length,
			...(buffer.responseActivity.length > 0
				? { activityCount: buffer.responseActivity.length }
				: {}),
			userMessage: buffer.userMessage,
		}),
	);
}

function sendReplayByTimeline(
	enqueueChunk: ReconnectDeps["enqueueChunk"],
	buffer: ReconnectBuffer,
) {
	const sortedTimeline = [...(buffer.eventTimeline ?? [])].sort(
		(a, b) => a.seq - b.seq,
	);
	let hasTextStart = false;
	let hasReasoningStart = false;

	for (const entry of sortedTimeline) {
		const idx = entry.index;
		switch (entry.type) {
			case "token": {
				const token = buffer.tokens[idx];
				if (token !== undefined) {
					if (!hasTextStart) {
						hasTextStart = true;
						enqueueChunk(streamTextStartEvent());
					}
					enqueueChunk(streamTextDeltaEvent(token));
				}
				break;
			}
			case "thinking": {
				const thinking = buffer.thinking[idx];
				if (thinking !== undefined) {
					if (!hasReasoningStart) {
						hasReasoningStart = true;
						enqueueChunk(streamReasoningStartEvent());
					}
					enqueueChunk(streamReasoningDeltaEvent(thinking));
				}
				break;
			}
			case "response_activity": {
				const activity = buffer.responseActivity[idx];
				if (activity !== undefined) {
					enqueueChunk(streamResponseActivityEvent(activity));
				}
				break;
			}
			case "tool_call": {
				const toolCall = buffer.toolCalls[idx];
				if (toolCall !== undefined) {
					enqueueChunk(
						streamToolCallEvent({
							callId: toolCall.callId,
							name: toolCall.name,
							input: toolCall.input,
							status: toolCall.status,
							outputSummary: toolCall.outputSummary,
							sourceType: toolCall.sourceType,
							candidates: toolCall.candidates,
							metadata: toolCall.metadata,
						}),
					);
				}
				break;
			}
		}
	}
}

function sendReplayFallback(
	enqueueChunk: ReconnectDeps["enqueueChunk"],
	buffer: ReconnectBuffer,
) {
	if (buffer.tokens.length > 0) {
		enqueueChunk(streamTextStartEvent());
	}
	for (const token of buffer.tokens) {
		enqueueChunk(streamTextDeltaEvent(token));
	}
	if (buffer.thinking.length > 0) {
		enqueueChunk(streamReasoningStartEvent());
	}
	for (const thinking of buffer.thinking) {
		enqueueChunk(streamReasoningDeltaEvent(thinking));
	}
	for (const activity of buffer.responseActivity) {
		enqueueChunk(streamResponseActivityEvent(activity));
	}
	for (const toolCall of buffer.toolCalls) {
		enqueueChunk(
			streamToolCallEvent({
				callId: toolCall.callId,
				name: toolCall.name,
				input: toolCall.input,
				status: toolCall.status,
				outputSummary: toolCall.outputSummary,
				sourceType: toolCall.sourceType,
				candidates: toolCall.candidates,
				metadata: toolCall.metadata,
			}),
		);
	}
}

function replayBuffer(
	enqueueChunk: ReconnectDeps["enqueueChunk"],
	buffer: ReconnectBuffer | undefined,
) {
	if (!buffer || !hasReplayableBufferData(buffer)) {
		return;
	}

	sendReplayStart(enqueueChunk, buffer);
	if (buffer.eventTimeline?.length) {
		sendReplayByTimeline(enqueueChunk, buffer);
	} else {
		sendReplayFallback(enqueueChunk, buffer);
	}
	enqueueChunk(streamDataPartEvent("data-replay-end", {}));
}

function createHeartbeatController(
	enqueueChunk: ReconnectDeps["enqueueChunk"],
	createHeartbeatComment: () => string,
) {
	let reconnectHeartbeatId: ReturnType<typeof setInterval> | null = null;
	const start = () => {
		reconnectHeartbeatId = setInterval(() => {
			enqueueChunk(createHeartbeatComment());
		}, RECONNECT_HEARTBEAT_MS);
		unrefTimer(reconnectHeartbeatId);
	};
	const clear = () => {
		if (!reconnectHeartbeatId) return;
		clearInterval(reconnectHeartbeatId);
		reconnectHeartbeatId = null;
	};
	return { start, clear };
}

export function doReconnect(targetStreamId: string, deps: ReconnectDeps): void {
	const {
		enqueueChunk,
		closeDownstream,
		downstreamAbortSignal,
		getStreamBuffer,
		userId,
		conversationId,
		subscribeToStream,
		unsubscribeFromStream,
		createSsePreludeComment,
		createSseHeartbeatComment,
	} = deps;
	const streamOwner = getStreamOwner(targetStreamId, userId, conversationId);
	const heartbeat = createHeartbeatController(
		enqueueChunk,
		createSseHeartbeatComment,
	);
	const closeConnection = () => {
		heartbeat.clear();
		closeDownstream();
	};

	try {
		enqueueChunk(createSsePreludeComment());
		enqueueChunk(createSseHeartbeatComment());

		const buffer = getStreamBuffer(streamOwner);
		if (buffer && hasReplayableBufferData(buffer)) {
			console.info(
				"[CHAT_STREAM] Replaying buffer for stream",
				targetStreamId,
				{
					hasContent: true,
					tokens: buffer.tokens.length,
					thinking: buffer.thinking.length,
					hasTimeline: Boolean(buffer.eventTimeline?.length),
				},
			);
		}
		replayBuffer(enqueueChunk, buffer);

		let liveListener: (chunk: string) => void;
		liveListener = (chunk: string) => {
			enqueueChunk(chunk);
			if (containsTerminalAiSdkUiStreamPayload(chunk)) {
				unsubscribeFromStream(streamOwner, liveListener);
				closeConnection();
			}
		};
		const subscribed = subscribeToStream(streamOwner, liveListener);
		if (subscribed === false) {
			enqueueChunk(streamDataPartEvent("data-waiting", {}));
			closeDownstream();
			return;
		}

		downstreamAbortSignal.addEventListener(
			"abort",
			() => {
				unsubscribeFromStream(streamOwner, liveListener);
				closeConnection();
			},
			{ once: true },
		);

		heartbeat.start();

		console.info(
			"[CHAT_STREAM] Reconnect done, subscribed to stream",
			targetStreamId,
		);
	} catch (err) {
		console.error("[CHAT_STREAM] doReconnect threw", { targetStreamId, err });
		closeDownstream();
	}
}
