import type { ReasoningDepth } from "$lib/types";

/**
 * Reconnect / orphan arbiter.
 *
 * When a request arrives carrying a `streamId`, the orchestrator must decide
 * whether this connection should:
 *  - reconnect to an already-running stream (its own, or an active orphan),
 *  - take ownership as the new main stream, or
 *  - close because ownership could not be established.
 *
 * That arbitration used to be an inline ~120-line block mixing registry reads,
 * registry mutations, logging and control flow. This module isolates the pure
 * decision + the registry commit steps (clearing a stale buffer, registering,
 * creating the buffer) and returns a discriminated {@link StreamStartDecision}.
 * The driver keeps ownership of the SSE-level actions the decision implies
 * (scheduling the reconnect replay, closing downstream, flipping `isMainStream`).
 */
export type StreamStartDecision =
	| { action: "reconnect"; targetStreamId: string }
	| { action: "close" }
	| { action: "start-main" };

export interface StreamStartArbiterDeps {
	streamId: string;
	userId: string;
	conversationId: string;
	controller: AbortController;
	userMessage: string;
	reasoningDepth?: ReasoningDepth;
	getOrphanedStream: (params: {
		userId: string;
		conversationId: string;
	}) => string | null;
	isStreamActive: (params: {
		streamId: string;
		userId: string;
		conversationId: string;
	}) => boolean;
	registerActiveChatStream: (params: {
		streamId: string;
		userId: string;
		controller: AbortController;
		conversationId: string;
	}) => boolean;
	clearStreamBuffer: (streamId: string) => void;
	getOrCreateStreamBuffer: (params: {
		streamId: string;
		userId: string;
		conversationId: string;
		userMessage: string;
		reasoningDepth?: ReasoningDepth;
	}) => unknown;
}

export function arbitrateStreamStart(
	deps: StreamStartArbiterDeps,
): StreamStartDecision {
	const {
		streamId,
		userId,
		conversationId,
		controller,
		userMessage,
		reasoningDepth,
		getOrphanedStream,
		isStreamActive,
		registerActiveChatStream,
		clearStreamBuffer,
		getOrCreateStreamBuffer,
	} = deps;

	let existingStreamId: string | null;
	try {
		existingStreamId = getOrphanedStream({ userId, conversationId });
	} catch (err) {
		console.error("[CHAT_STREAM] getOrphanedStream threw", {
			conversationId,
			streamId,
			err,
		});
		return { action: "close" };
	}

	if (existingStreamId === streamId) {
		console.info("[CHAT_STREAM] Reconnect to same stream", streamId);
		return { action: "reconnect", targetStreamId: streamId };
	} else if (existingStreamId) {
		const clientStreamActive = isStreamActive({
			streamId,
			userId,
			conversationId,
		});
		const orphanStreamActive = isStreamActive({
			streamId: existingStreamId,
			userId,
			conversationId,
		});

		if (clientStreamActive) {
			console.info(
				"[CHAT_STREAM] Reconnect to client stream (concurrent active)",
				streamId,
			);
			return { action: "reconnect", targetStreamId: streamId };
		} else if (orphanStreamActive) {
			console.info(
				"[CHAT_STREAM] Reconnect to orphan stream (client streamId stale)",
				{
					clientStreamId: streamId,
					activeOrphanStreamId: existingStreamId,
				},
			);
			return { action: "reconnect", targetStreamId: existingStreamId };
		} else {
			console.info(
				"[CHAT_STREAM] No active streams - cleaning up and starting new",
				{
					clientStreamId: streamId,
					orphanedStreamId: existingStreamId,
				},
			);
			clearStreamBuffer(existingStreamId);
		}
	}

	const registered = registerActiveChatStream({
		streamId,
		userId,
		controller,
		conversationId,
	});
	if (!registered) {
		let currentStreamId: string | null = null;
		try {
			currentStreamId = getOrphanedStream({ userId, conversationId });
		} catch (err) {
			console.error("[CHAT_STREAM] getOrphanedStream threw after conflict", {
				conversationId,
				streamId,
				err,
			});
		}
		if (
			currentStreamId &&
			isStreamActive({ streamId: currentStreamId, userId, conversationId })
		) {
			console.info(
				"[CHAT_STREAM] Reconnect after stream registration conflict",
				{
					streamId,
					activeStreamId: currentStreamId,
					conversationId,
				},
			);
			return { action: "reconnect", targetStreamId: currentStreamId };
		}
		console.warn(
			"[CHAT_STREAM] Stream registration conflict without active owner",
			{
				streamId,
				conversationId,
			},
		);
		return { action: "close" };
	}

	getOrCreateStreamBuffer({
		streamId,
		userId,
		conversationId,
		userMessage,
		reasoningDepth,
	});
	return { action: "start-main" };
}
