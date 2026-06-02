import {
	decodeUiMessageStreamParts,
	streamDataPartEvent,
	streamReasoningDeltaEvent,
	streamReasoningStartEvent,
	streamTextDeltaEvent,
	streamTextStartEvent,
	streamToolCallEvent,
} from "./stream";

export interface ReconnectBuffer {
	userMessage: string | null;
	tokens: string[];
	thinking: string[];
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
}

export interface ReconnectDeps {
	enqueueChunk: (chunk: string) => boolean;
	closeDownstream: () => void;
	downstreamAbortSignal: AbortSignal;
	getStreamBuffer: (streamId: string) => ReconnectBuffer | undefined;
	subscribeToStream: (
		streamId: string,
		listener: (chunk: string) => void,
	) => void;
	unsubscribeFromStream: (
		streamId: string,
		listener: (chunk: string) => void,
	) => void;
	createSsePreludeComment: () => string;
	createSseHeartbeatComment: () => string;
}

function unrefTimer(timer: ReturnType<typeof setInterval>) {
	timer.unref?.();
}

function containsTerminalUiMessageStreamPart(chunk: string): boolean {
	return decodeUiMessageStreamParts(chunk).some((part) => {
		if (part === "[DONE]") return true;
		return part.type === "finish" || part.type === "data-stream-error";
	});
}

export function doReconnect(targetStreamId: string, deps: ReconnectDeps): void {
	const {
		enqueueChunk,
		closeDownstream,
		downstreamAbortSignal,
		getStreamBuffer,
		subscribeToStream,
		unsubscribeFromStream,
		createSsePreludeComment,
		createSseHeartbeatComment,
	} = deps;

	try {
		enqueueChunk(createSsePreludeComment());
		enqueueChunk(createSseHeartbeatComment());

		const buffer = getStreamBuffer(targetStreamId);
		if (buffer) {
			const hasContent =
				buffer.tokens.length > 0 ||
				buffer.thinking.length > 0 ||
				buffer.toolCalls.length > 0;
			console.info(
				"[CHAT_STREAM] Replaying buffer for stream",
				targetStreamId,
				{
					hasContent,
					tokens: buffer.tokens.length,
					thinking: buffer.thinking.length,
				},
			);
			if (hasContent) {
				enqueueChunk(
					streamDataPartEvent("data-replay-start", {
						tokenCount: buffer.tokens.length,
						thinkingCount: buffer.thinking.length,
						toolCallCount: buffer.toolCalls.length,
						userMessage: buffer.userMessage,
					}),
				);
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
				enqueueChunk(streamDataPartEvent("data-replay-end", {}));
			}
		}

		let reconnectHeartbeatId: ReturnType<typeof setInterval>;
		const liveListener = (chunk: string) => {
			enqueueChunk(chunk);
			if (containsTerminalUiMessageStreamPart(chunk)) {
				unsubscribeFromStream(targetStreamId, liveListener);
				clearInterval(reconnectHeartbeatId);
				closeDownstream();
			}
		};
		subscribeToStream(targetStreamId, liveListener);

		downstreamAbortSignal.addEventListener(
			"abort",
			() => {
				unsubscribeFromStream(targetStreamId, liveListener);
				clearInterval(reconnectHeartbeatId);
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
