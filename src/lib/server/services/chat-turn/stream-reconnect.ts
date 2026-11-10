import { containsTerminalAiSdkUiStreamPayload } from "$lib/services/ai-sdk-ui-stream-contract";
import { streamDataPartEvent } from "./stream";

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
	let connectionClosed = false;
	const closeConnection = () => {
		if (connectionClosed) return;
		connectionClosed = true;
		heartbeat.clear();
		closeDownstream();
	};

	try {
		enqueueChunk(createSsePreludeComment());
		enqueueChunk(createSseHeartbeatComment());

		const buffer = getStreamBuffer(streamOwner);
		const replay = buffer?.journal.read();
		if (!replay?.complete) {
			enqueueChunk(streamDataPartEvent("data-waiting", {}));
			closeConnection();
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

		// The listener lives on the stream's record (its buffer). If that goes without
		// this connection having heard how the run ended (a failure that cleared it
		// first, a buffer that outlived its time to live under a long silent tool
		// call), no terminal event can ever reach it: the heartbeats alone would keep
		// the reader's turn spinning. Say it is waiting, the client's own state for
		// "ask the saved conversation how it ended", and end the connection.
		const endIfRecordIsGone = () => {
			if (connectionClosed) return;
			let recordIsThere = false;
			try {
				recordIsThere = Boolean(getStreamBuffer(streamOwner));
			} catch {
				recordIsThere = false;
			}
			if (recordIsThere) return;
			unsubscribeFromStream(streamOwner, liveListener);
			enqueueChunk(streamDataPartEvent("data-waiting", {}));
			closeConnection();
		};
		heartbeat.start(endIfRecordIsGone);

		console.info(
			"[CHAT_STREAM] Reconnect done, subscribed to stream",
			targetStreamId,
		);
	} catch (err) {
		console.error("[CHAT_STREAM] doReconnect threw", { targetStreamId, err });
		closeDownstream();
	}
}
