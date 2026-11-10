import {
	containsTerminalAiSdkUiStreamPayload,
	encodeAiSdkUiStreamDoneFrame,
} from "$lib/services/ai-sdk-ui-stream-contract";
import { observeCompletionTurn } from "./completion-lifetime";
import {
	streamDataPartEvent,
	streamErrorEvent,
	streamFinishEvent,
} from "./stream";

export interface ReconnectBuffer {
	userMessage: string | null;
	journal: import("./stream-replay-journal").StreamReplayJournal;
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
/** How often a reconnected connection checks that the stream's record, which holds its listener, is still there. */
const RECONNECT_LIVENESS_MS = 2_000;

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

function createHeartbeatController(
	enqueueChunk: ReconnectDeps["enqueueChunk"],
	createHeartbeatComment: () => string,
) {
	let reconnectHeartbeatId: ReturnType<typeof setInterval> | null = null;
	let livenessId: ReturnType<typeof setInterval> | null = null;
	const start = (checkLiveness: () => void) => {
		reconnectHeartbeatId = setInterval(() => {
			enqueueChunk(createHeartbeatComment());
		}, RECONNECT_HEARTBEAT_MS);
		unrefTimer(reconnectHeartbeatId);
		livenessId = setInterval(checkLiveness, RECONNECT_LIVENESS_MS);
		unrefTimer(livenessId);
	};
	const clear = () => {
		if (reconnectHeartbeatId) {
			clearInterval(reconnectHeartbeatId);
			reconnectHeartbeatId = null;
		}
		if (livenessId) {
			clearInterval(livenessId);
			livenessId = null;
		}
	};
	return { start, clear };
}

export async function doReconnect(
	targetStreamId: string,
	deps: ReconnectDeps,
): Promise<void> {
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
	let connectionClosed = false;
	let unsubscribe = () => {};
	const closeConnection = () => {
		if (connectionClosed) return;
		connectionClosed = true;
		heartbeat.clear();
		unsubscribe();
		downstreamAbortSignal.removeEventListener("abort", closeConnection);
		closeDownstream();
	};

	let observing: Promise<void> | undefined;
	const observeWithoutReplay = () => {
		observing ??= (async () => {
			const observation = await observeCompletionTurn({
				userId,
				conversationId,
				requestId: targetStreamId,
			});
			if (connectionClosed) return;
			enqueueChunk(
				streamDataPartEvent("data-stream-metadata", { observation }),
			);
			if (observation.state === "pending")
				enqueueChunk(streamDataPartEvent("data-waiting", {}));
			else {
				enqueueChunk(streamFinishEvent("other"));
				enqueueChunk(encodeAiSdkUiStreamDoneFrame());
			}
			closeConnection();
		})();
		return observing;
	};

	try {
		if (downstreamAbortSignal.aborted) {
			closeConnection();
			return;
		}
		downstreamAbortSignal.addEventListener("abort", closeConnection, {
			once: true,
		});
		enqueueChunk(createSsePreludeComment());
		enqueueChunk(createSseHeartbeatComment());

		const buffer = getStreamBuffer(streamOwner);
		const replay = buffer?.journal.read();
		if (!replay?.complete) {
			await observeWithoutReplay();
			return;
		}
		if (replay.chunks.length)
			enqueueChunk(
				streamDataPartEvent("data-replay-start", {
					userMessage: buffer?.userMessage,
					tokenCount: 0,
					thinkingCount: 0,
					toolCallCount: 0,
				}),
			);
		for (const chunk of replay.chunks) {
			if (containsTerminalAiSdkUiStreamPayload(chunk))
				enqueueChunk(streamDataPartEvent("data-replay-end", {}));
			enqueueChunk(chunk);
			if (containsTerminalAiSdkUiStreamPayload(chunk)) {
				closeConnection();
				return;
			}
		}

		if (replay.chunks.length)
			enqueueChunk(streamDataPartEvent("data-replay-end", {}));

		let liveListener: (chunk: string) => void;
		liveListener = (chunk: string) => {
			enqueueChunk(chunk);
			if (containsTerminalAiSdkUiStreamPayload(chunk)) {
				closeConnection();
			}
		};
		unsubscribe = () => unsubscribeFromStream(streamOwner, liveListener);
		const subscribed = subscribeToStream(streamOwner, liveListener);
		if (subscribed === false) {
			await observeWithoutReplay();
			return;
		}
		if (downstreamAbortSignal.aborted) {
			closeConnection();
			return;
		}

		// A vanished live record is resolved by the same durable observer as a
		// missing replay prefix, never by promising that a saved row will appear.
		const endIfRecordIsGone = () => {
			if (connectionClosed) return;
			let recordIsThere = false;
			try {
				recordIsThere = Boolean(getStreamBuffer(streamOwner));
			} catch {
				recordIsThere = false;
			}
			if (recordIsThere) return;
			void observeWithoutReplay().catch((error) => {
				console.error("[CHAT_STREAM] Observation failed", error);
				if (!connectionClosed) {
					enqueueChunk(streamErrorEvent("backend_failure"));
					closeConnection();
				}
			});
		};
		heartbeat.start(endIfRecordIsGone);

		console.info(
			"[CHAT_STREAM] Reconnect done, subscribed to stream",
			targetStreamId,
		);
	} catch (err) {
		console.error("[CHAT_STREAM] doReconnect threw", { targetStreamId, err });
		if (!connectionClosed) {
			enqueueChunk(streamErrorEvent("backend_failure"));
			closeConnection();
		}
	}
}
