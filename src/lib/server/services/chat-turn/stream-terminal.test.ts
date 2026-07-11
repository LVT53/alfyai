import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createStreamTerminal,
	type StreamTerminalDeps,
} from "./stream-terminal";

vi.mock("$lib/server/services/normal-chat-failover", () => ({
	isModelTimeoutError: vi.fn(() => false),
}));

function createDeps(overrides: Partial<StreamTerminalDeps> = {}) {
	let ended = false;
	const deps: StreamTerminalDeps = {
		isEnded: () => ended,
		markEnded: () => {
			ended = true;
		},
		logPhaseTiming: vi.fn(),
		streamId: "s1",
		clearStreamBuffer: vi.fn(),
		closeDownstream: vi.fn(),
		emitError: vi.fn(),
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
		upstreamEndLog: { conversationId: "c1", streamId: "s1", modelId: "m1" },
		getUpstreamEndSnapshot: () => ({
			thinkingLength: 0,
			toolCallCount: 0,
			completedToolCallCount: 0,
			hasCompletedNonFileToolCall: false,
		}),
		...overrides,
	};
	return deps;
}

describe("createStreamTerminal", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	describe("completeSuccess", () => {
		it("logs the success outcome and finalizes once", async () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			await terminal.completeSuccess();
			expect(deps.logPhaseTiming).toHaveBeenCalledWith("success");
			expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith({
				wasStopped: false,
				streamClosedWithoutFinish: false,
			});
		});

		it("logs stopped when stopped", async () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			await terminal.completeSuccess(true);
			expect(deps.logPhaseTiming).toHaveBeenCalledWith("stopped");
			expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith({
				wasStopped: true,
				streamClosedWithoutFinish: false,
			});
		});

		it("logs error and marks closed-without-finish", async () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			await terminal.completeSuccess(false, {
				streamClosedWithoutFinish: true,
			});
			expect(deps.logPhaseTiming).toHaveBeenCalledWith("error");
			expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith({
				wasStopped: false,
				streamClosedWithoutFinish: true,
			});
		});

		it("is idempotent once ended", async () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			await terminal.completeSuccess();
			await terminal.completeSuccess();
			expect(deps.runCompleteStreamTurn).toHaveBeenCalledTimes(1);
		});
	});

	describe("failStream", () => {
		it("clears the buffer, emits the error, and closes", () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			terminal.failStream("timeout");
			expect(deps.logPhaseTiming).toHaveBeenCalledWith("error");
			expect(deps.clearStreamBuffer).toHaveBeenCalledWith("s1");
			expect(deps.emitError).toHaveBeenCalledWith("timeout");
			expect(deps.closeDownstream).toHaveBeenCalled();
		});

		it("does nothing once ended", async () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			await terminal.completeSuccess();
			terminal.failStream("timeout");
			expect(deps.emitError).not.toHaveBeenCalled();
		});

		it("skips buffer clearing when there is no stream id", () => {
			const deps = createDeps({ streamId: null });
			const terminal = createStreamTerminal(deps);
			terminal.failStream("backend_failure");
			expect(deps.clearStreamBuffer).not.toHaveBeenCalled();
			expect(deps.emitError).toHaveBeenCalledWith("backend_failure");
		});
	});

	describe("failPreparedTurnStream", () => {
		it("emits the request error before clearing the buffer, then closes", () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			const order: string[] = [];
			(deps.emitRequestError as ReturnType<typeof vi.fn>).mockImplementation(
				() => order.push("emit"),
			);
			(deps.clearStreamBuffer as ReturnType<typeof vi.fn>).mockImplementation(
				() => order.push("clear"),
			);
			const error = {
				status: 409,
				error: "nope",
				code: "attachments_not_ready",
			};
			terminal.failPreparedTurnStream(error);
			expect(deps.emitRequestError).toHaveBeenCalledWith(error);
			expect(order).toEqual(["emit", "clear"]);
			expect(deps.closeDownstream).toHaveBeenCalled();
		});
	});

	describe("completeOrRecoverAfterUpstreamEnd", () => {
		it("bails out when buffered output could not flush", async () => {
			const deps = createDeps({
				flushBufferedStreamOutput: vi.fn(() => false),
			});
			const terminal = createStreamTerminal(deps);
			await terminal.completeOrRecoverAfterUpstreamEnd("end_event");
			expect(deps.flushNativeToolCalls).toHaveBeenCalled();
			expect(deps.runCompleteStreamTurn).not.toHaveBeenCalled();
			expect(deps.emitError).not.toHaveBeenCalled();
		});

		it("completes as stopped when a stop was requested", async () => {
			const deps = createDeps({ wasStopRequested: vi.fn(() => true) });
			const terminal = createStreamTerminal(deps);
			await terminal.completeOrRecoverAfterUpstreamEnd("end_event");
			expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith({
				wasStopped: true,
				streamClosedWithoutFinish: false,
			});
		});

		it("completes successfully with closed-without-finish for a stream_closed reason", async () => {
			const deps = createDeps({
				hasVisibleAssistantAnswerOutput: vi.fn(() => true),
			});
			const terminal = createStreamTerminal(deps);
			await terminal.completeOrRecoverAfterUpstreamEnd("stream_closed");
			expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith({
				wasStopped: false,
				streamClosedWithoutFinish: true,
			});
		});

		it("recovers via non-stream fallback after a completed non-file tool with no visible answer", async () => {
			const fallbackRunner = vi.fn(async () => null);
			const deps = createDeps({
				hasCompletedNonFileToolCall: vi.fn(() => true),
				getFallbackRunner: vi.fn(() => fallbackRunner),
			});
			const terminal = createStreamTerminal(deps);
			await terminal.completeOrRecoverAfterUpstreamEnd("end_event");
			expect(fallbackRunner).toHaveBeenCalledWith(
				"stream_read_failure",
				1,
				expect.any(Error),
			);
			expect(deps.emitError).not.toHaveBeenCalled();
		});

		it("hard-fails when a completed tool exists but a fallback was already attempted", async () => {
			const deps = createDeps({
				hasCompletedNonFileToolCall: vi.fn(() => true),
				getAttemptedNonStreamFallback: vi.fn(() => true),
				getFallbackRunner: vi.fn(() => vi.fn(async () => null)),
			});
			const terminal = createStreamTerminal(deps);
			await terminal.completeOrRecoverAfterUpstreamEnd("end_event");
			expect(deps.emitError).toHaveBeenCalledWith("backend_failure");
		});

		it("hard-fails when there is nothing to complete or recover", async () => {
			const deps = createDeps();
			const terminal = createStreamTerminal(deps);
			await terminal.completeOrRecoverAfterUpstreamEnd("done_signal");
			expect(deps.emitError).toHaveBeenCalledWith("backend_failure");
			expect(deps.closeDownstream).toHaveBeenCalled();
		});
	});
});
