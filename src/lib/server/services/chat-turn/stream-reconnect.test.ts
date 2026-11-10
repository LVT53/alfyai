vi.mock("./completion-lifetime", () => ({
	observeCompletionTurn: async () => null,
}));

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	streamDataPartEvent,
	streamErrorEvent,
	streamTextDeltaEvent,
} from "./stream";
import { doReconnect } from "./stream-reconnect";
import { StreamReplayJournal } from "./stream-replay-journal";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function connect(chunks: string[] = [], alreadyAborted = false) {
	const journal = new StreamReplayJournal();
	for (const chunk of chunks) journal.append(chunk);
	const buffer = { journal, userMessage: "synthetic" };
	const getStreamBuffer = vi.fn(() => buffer as typeof buffer | undefined);
	const enqueueChunk = vi.fn((_chunk: string) => true),
		closeDownstream = vi.fn();
	const subscribeToStream = vi.fn(
			(
				_owner: { streamId: string; userId: string; conversationId: string },
				_listener: (chunk: string) => void,
			) => true,
		),
		unsubscribeFromStream = vi.fn(
			(
				_owner: { streamId: string; userId: string; conversationId: string },
				_listener: (chunk: string) => void,
			) => {},
		);
	const abort = new AbortController();
	if (alreadyAborted) abort.abort();
	doReconnect("s", {
		userId: "u",
		conversationId: "c",
		enqueueChunk,
		closeDownstream,
		getStreamBuffer,
		subscribeToStream,
		unsubscribeFromStream,
		downstreamAbortSignal: abort.signal,
		createSsePreludeComment: () => ": prelude\n\n",
		createSseHeartbeatComment: () => ": heartbeat\n\n",
	});
	return {
		enqueueChunk,
		closeDownstream,
		getStreamBuffer,
		subscribeToStream,
		unsubscribeFromStream,
		abort,
	};
}
it("replays original frames in order and subscribes with authenticated scope", () => {
	const chunks = [
		streamDataPartEvent("data-response-activity", { id: "a" }),
		streamTextDeltaEvent("## Result"),
	];
	const c = connect(chunks);
	expect(
		c.enqueueChunk.mock.calls
			.map((call) => call[0])
			.filter((chunk) => chunks.includes(chunk)),
	).toEqual(chunks);
	expect(c.subscribeToStream).toHaveBeenCalledWith(
		{ streamId: "s", userId: "u", conversationId: "c" },
		expect.any(Function),
	);
	c.abort.abort();
});
it("terminates on live terminal but not an incomplete terminal frame", () => {
	const c = connect();
	const listener = c.subscribeToStream.mock.calls[0][1] as (
		chunk: string,
	) => void;
	listener('data: {"type":"finish"}');
	expect(c.closeDownstream).not.toHaveBeenCalled();
	listener(streamErrorEvent("backend_failure"));
	expect(c.closeDownstream).toHaveBeenCalledOnce();
	expect(c.unsubscribeFromStream).toHaveBeenCalledOnce();
	vi.advanceTimersByTime(20_000);
	expect(c.closeDownstream).toHaveBeenCalledOnce();
});
it("ends a vanished record explicitly instead of waiting on heartbeats", () => {
	const c = connect();
	c.getStreamBuffer.mockReturnValue(undefined);
	vi.advanceTimersByTime(2000);
	expect(c.enqueueChunk).toHaveBeenCalledWith(
		streamDataPartEvent("data-waiting", {}),
	);
	expect(c.closeDownstream).toHaveBeenCalledOnce();
});
it("releases subscription and timers on downstream abort", () => {
	const c = connect();
	c.abort.abort();
	expect(c.unsubscribeFromStream).toHaveBeenCalledOnce();
	expect(c.closeDownstream).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
it("replays terminal once without opening another subscription", () => {
	const c = connect([streamErrorEvent("backend_failure")]);
	expect(c.subscribeToStream).not.toHaveBeenCalled();
	expect(c.closeDownstream).toHaveBeenCalledOnce();
});

it("does not retain a subscription for an already-cancelled observer", () => {
	const c = connect([], true);
	expect(c.subscribeToStream).not.toHaveBeenCalled();
	expect(c.closeDownstream).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
