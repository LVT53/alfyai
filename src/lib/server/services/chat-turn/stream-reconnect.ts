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

	try {
		enqueueChunk(createSsePreludeComment());
		enqueueChunk(createSseHeartbeatComment());

		const buffer = getStreamBuffer({
			streamId: targetStreamId,
			userId,
			conversationId,
		});
		if (buffer) {
			const timeline = buffer.eventTimeline;
			const hasTimeline = timeline && timeline.length > 0;
			const hasContent =
				hasTimeline ||
				buffer.tokens.length > 0 ||
				buffer.thinking.length > 0 ||
				buffer.toolCalls.length > 0 ||
				buffer.responseActivity.length > 0;
			console.info(
				"[CHAT_STREAM] Replaying buffer for stream",
				targetStreamId,
				{
					hasContent,
					tokens: buffer.tokens.length,
					thinking: buffer.thinking.length,
					hasTimeline,
				},
			);
			if (hasContent) {
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

				if (hasTimeline) {
					// Replay in temporal order using the event timeline
					const sorted = [...timeline].sort((a, b) => a.seq - b.seq);
					let hasTextStart = false;
					let hasReasoningStart = false;

					for (const entry of sorted) {
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
				} else {
					// Fallback to batch replay for backward compatibility
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

				enqueueChunk(streamDataPartEvent("data-replay-end", {}));
			}
		}

		let reconnectHeartbeatId: ReturnType<typeof setInterval> | null = null;
		const clearReconnectHeartbeat = () => {
			if (!reconnectHeartbeatId) return;
			clearInterval(reconnectHeartbeatId);
			reconnectHeartbeatId = null;
		};
		const liveListener = (chunk: string) => {
			enqueueChunk(chunk);
			if (containsTerminalAiSdkUiStreamPayload(chunk)) {
				unsubscribeFromStream(
					{ streamId: targetStreamId, userId, conversationId },
					liveListener,
				);
				clearReconnectHeartbeat();
				closeDownstream();
			}
		};
		const subscribed = subscribeToStream(
			{ streamId: targetStreamId, userId, conversationId },
			liveListener,
		);
		if (subscribed === false) {
			enqueueChunk(streamDataPartEvent("data-waiting", {}));
			closeDownstream();
			return;
		}

		downstreamAbortSignal.addEventListener(
			"abort",
			() => {
				unsubscribeFromStream(
					{ streamId: targetStreamId, userId, conversationId },
					liveListener,
				);
				clearReconnectHeartbeat();
				closeDownstream();
			},
			{ once: true },
		);

		reconnectHeartbeatId = setInterval(() => {
			enqueueChunk(createSseHeartbeatComment());
		}, 10000);
		unrefTimer(reconnectHeartbeatId);

		console.info(
			"[CHAT_STREAM] Reconnect done, subscribed to stream",
			targetStreamId,
		);
	} catch (err) {
		console.error("[CHAT_STREAM] doReconnect threw", { targetStreamId, err });
		closeDownstream();
	}
}
