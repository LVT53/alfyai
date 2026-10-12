import { beforeEach, describe, expect, it, vi } from "vitest";
import { containsTerminalAiSdkUiStreamPayload } from "$lib/services/ai-sdk-ui-stream-contract";
import * as registry from "./active-streams";
import { streamErrorEvent } from "./stream";
import { doReconnect } from "./stream-reconnect";
import { createStreamTerminal } from "./stream-terminal";

vi.mock("$lib/server/services/normal-chat-failover", () => ({
	isModelTimeoutError: vi.fn(() => false),
}));

// FG's finding 1: a browser that reloads within a few hundred milliseconds of a
// first turn that fails at once reconnects to the stream while the original run is
// still failing. These tests run the real registry, the real reconnect and the real
// terminal together, the way the orchestrator wires them (its `enqueueChunk`
// broadcasts to the reconnected listeners through `broadcastStreamChunk`), so what
// the reconnected connection hears is what a reader's browser hears.

const OWNER = {
	streamId: "stream-reconnect-failure",
	userId: "user-1",
	conversationId: "conversation-1",
};

function startRun() {
	const controller = new AbortController();
	expect(registry.registerActiveChatStream({ ...OWNER, controller })).toBe(
		true,
	);
	registry.getOrCreateStreamBuffer({
		...OWNER,
		userMessage: "Hello",
	});
}

function reconnect() {
	const chunks: string[] = [];
	const closeDownstream = vi.fn();
	const abort = new AbortController();
	doReconnect(OWNER.streamId, {
		userId: OWNER.userId,
		conversationId: OWNER.conversationId,
		enqueueChunk: (chunk) => {
			chunks.push(chunk);
			return true;
		},
		closeDownstream,
		downstreamAbortSignal: abort.signal,
		getStreamBuffer: (params) => registry.getStreamBuffer(params) ?? undefined,
		subscribeToStream: registry.subscribeToStream,
		unsubscribeFromStream: registry.unsubscribeFromStream,
		createSsePreludeComment: () => ": prelude\n\n",
		createSseHeartbeatComment: () => ": heartbeat\n\n",
	});
	return { chunks, closeDownstream, abort };
}

/** The run's terminal, wired like the orchestrator's: an emitted frame is broadcast to whoever reconnected. */
function runTerminal() {
	let ended = false;
	const closeDownstream = vi.fn();
	const terminal = createStreamTerminal({
		isEnded: () => ended,
		markEnded: () => {
			ended = true;
		},
		logPhaseTiming: vi.fn(),
		streamId: OWNER.streamId,
		clearStreamBuffer: registry.clearStreamBuffer,
		closeDownstream,
		emitError: (code) =>
			registry.broadcastStreamChunk(OWNER.streamId, streamErrorEvent(code)),
		emitRequestError: vi.fn(),
		runCompleteStreamTurn: vi.fn(async () => undefined),
		flushNativeToolCalls: vi.fn(),
		flushBufferedStreamOutput: vi.fn(() => true),
		wasStopRequested: vi.fn(() => false),
		hasVisibleAssistantAnswerOutput: vi.fn(() => false),
		hasCompletedFileProductionToolCall: vi.fn(() => false),
		hasCompletedNonFileToolCall: vi.fn(() => false),
		getAttemptedNonStreamFallback: vi.fn(() => false),
		getFallbackRunner: vi.fn(() => null),
		getLatestUpstreamAttempt: vi.fn(() => 1),
		upstreamEndLog: {
			conversationId: OWNER.conversationId,
			streamId: OWNER.streamId,
			modelId: "m1",
		},
		getUpstreamEndSnapshot: () => ({
			thinkingLength: 0,
			toolCallCount: 0,
			completedToolCallCount: 0,
			hasCompletedNonFileToolCall: false,
		}),
	});
	return { terminal, closeDownstream };
}

describe("a browser that reconnected while the run was still failing", () => {
	beforeEach(() => {
		registry.unregisterActiveChatStream(OWNER.streamId);
		registry.clearStreamBuffer(OWNER.streamId);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("hears the run's error and its connection ends, instead of waiting on heartbeats for ever", () => {
		startRun();
		const connection = reconnect();
		expect(connection.closeDownstream).not.toHaveBeenCalled();

		// The original run's failure lands after the reconnect subscribed.
		const run = runTerminal();
		run.terminal.failStream("backend_failure");

		expect(
			connection.chunks.some((chunk) =>
				containsTerminalAiSdkUiStreamPayload(chunk),
			),
			"the reconnected connection was told how the run ended",
		).toBe(true);
		expect(connection.closeDownstream).toHaveBeenCalledOnce();
		expect(run.closeDownstream).toHaveBeenCalledOnce();
	});

	it("is handed a wait, not silence, when it connects after the failure", () => {
		startRun();
		runTerminal().terminal.failStream("backend_failure");

		const connection = reconnect();
		expect(connection.closeDownstream).toHaveBeenCalledOnce();
		expect(connection.chunks.join("")).toContain("data-waiting");
	});
});
