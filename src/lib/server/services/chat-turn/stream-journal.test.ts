vi.mock("./completion-lifetime", () => ({
	observeCompletionTurn: async () => ({
		version: 1,
		streamId: "s",
		conversationId: "c",
		state: "pending",
		turnId: "t",
		segmentId: "segment",
	}),
}));

import { afterEach, expect, it, vi } from "vitest";
import * as registry from "./active-streams";
import {
	streamReasoningDeltaEvent as journalReasoningFrame,
	streamTextDeltaEvent as journalTextFrame,
	streamDataPartEvent,
	streamTextDeltaEvent,
} from "./stream";
import { doReconnect } from "./stream-reconnect";

const scope = {
	streamId: "journal-test",
	userId: "journal-user",
	conversationId: "journal-chat",
};
afterEach(() => {
	registry.unregisterActiveChatStream(scope.streamId);
	registry.clearStreamBuffer(scope.streamId);
	vi.useRealTimers();
});
function buffer() {
	return registry.getOrCreateStreamBuffer({
		...scope,
		userMessage: "synthetic",
	});
}
function reconnect() {
	const chunks: string[] = [];
	const closed = vi.fn();
	const abort = new AbortController();
	const done = doReconnect(scope.streamId, {
		...scope,
		enqueueChunk: (chunk) => {
			chunks.push(chunk);
			return true;
		},
		closeDownstream: closed,
		downstreamAbortSignal: abort.signal,
		getStreamBuffer: (p) => registry.getStreamBuffer(p) ?? undefined,
		subscribeToStream: registry.subscribeToStream,
		unsubscribeFromStream: registry.unsubscribeFromStream,
		createSsePreludeComment: () => ": prelude\n\n",
		createSseHeartbeatComment: () => ": heartbeat\n\n",
	});
	return { chunks, closed, abort, done };
}
it("retains quiet live owners beyond the idle replay TTL", () => {
	vi.useFakeTimers();
	registry.registerActiveChatStream({
		...scope,
		controller: new AbortController(),
	});
	const original = buffer();
	vi.advanceTimersByTime(11 * 60_000);
	expect(registry.getStreamBuffer(scope)).toBe(original);
	registry.unregisterActiveChatStream(scope.streamId);
	vi.advanceTimersByTime(6 * 60_000);
	expect(registry.getStreamBuffer(scope)).toBeNull();
});
it("never replays a suffix after repeated mixed-event cap crossings", async () => {
	buffer();
	for (let n = 0; n < 5; n++) {
		registry.broadcastStreamChunk(
			scope.streamId,
			journalTextFrame("x".repeat(60_000)),
		);
		registry.broadcastStreamChunk(
			scope.streamId,
			journalReasoningFrame("y".repeat(60_000)),
		);
	}
	const connection = reconnect();
	await connection.done;
	expect(connection.chunks.join("")).toContain("data-waiting");
	expect(connection.chunks.join("")).not.toContain("text-delta");
	expect(connection.closed).toHaveBeenCalledOnce();
});
it("replays exactly ordered wire frames including output roles and terminal metadata", () => {
	buffer();
	const frames = [
		streamTextDeltaEvent("synthetic"),
		streamDataPartEvent("data-normal-chat-output", {
			type: "step-settled",
			sequence: 1,
		}),
		streamDataPartEvent("data-stream-metadata", { finalContent: "canonical" }),
		'data: {"type":"finish"}\n\n',
	];
	for (const frame of frames)
		registry.broadcastStreamChunk(scope.streamId, frame);
	const connection = reconnect();
	expect(connection.chunks.filter((chunk) => frames.includes(chunk))).toEqual(
		frames,
	);
	expect(connection.closed).toHaveBeenCalledOnce();
});
