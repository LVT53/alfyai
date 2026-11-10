import { expect, it, vi } from "vitest";
import type { NormalChatCompletion } from "$lib/shared/normal-chat-completion";
import {
	createStreamTerminal,
	type StreamTerminalDeps,
} from "./stream-terminal";

function setup(outcome?: NormalChatCompletion["outcome"]) {
	let ended = false;
	const completion: NormalChatCompletion | undefined = outcome
		? {
				version: 1,
				turnId: "t",
				segmentId: "s",
				phase: "closing",
				outcome,
				stopCause: "natural_stop",
				workingStopCause: "tool_budget",
				closingAttempted: true,
			}
		: undefined;
	const order: string[] = [];
	const deps: StreamTerminalDeps = {
		isEnded: () => ended,
		markEnded: () => {
			ended = true;
		},
		logPhaseTiming: vi.fn(),
		streamId: "s",
		clearStreamBuffer: () => {
			order.push("clear");
		},
		closeDownstream: vi.fn(),
		emitError: () => {
			order.push("error");
		},
		emitRequestError: vi.fn(),
		runCompleteStreamTurn: vi.fn(async () => {}),
		flushBufferedStreamOutput: () => true,
		wasStopRequested: () => false,
		getCompletion: () => completion,
	};
	return { deps, terminal: createStreamTerminal(deps), order };
}
it.each([
	"answered",
	"delivered",
	"paused",
	"stopped",
	"incomplete",
	"failed",
] as const)("adapts %s without starting generation", async (outcome) => {
	const { deps, terminal } = setup(outcome);
	await terminal.completeAfterUpstreamEnd("end_event");
	expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith({
		wasStopped: outcome === "stopped",
		paused: outcome === "paused",
		noFinalAnswer: outcome === "incomplete" || outcome === "failed",
		streamClosedWithoutFinish: false,
	});
	await terminal.completeAfterUpstreamEnd("end_event");
	expect(deps.runCompleteStreamTurn).toHaveBeenCalledOnce();
});
it("gives explicit stop precedence over pause", async () => {
	const { deps } = setup("paused");
	deps.wasStopRequested = () => true;
	await createStreamTerminal(deps).completeAfterUpstreamEnd("end_event");
	expect(deps.runCompleteStreamTurn).toHaveBeenCalledWith(
		expect.objectContaining({ wasStopped: true, paused: false }),
	);
});
it("fails a missing model receipt without guessing from prose or tool names", async () => {
	const { terminal, order, deps } = setup();
	await terminal.completeAfterUpstreamEnd("stream_closed");
	expect(order).toEqual(["error", "clear"]);
	expect(deps.closeDownstream).toHaveBeenCalledOnce();
});
it("emits failure before clearing the listener journal and ends once", () => {
	const { terminal, order, deps } = setup();
	terminal.failStream("backend_failure");
	terminal.failStream("timeout");
	expect(order).toEqual(["error", "clear"]);
	expect(deps.closeDownstream).toHaveBeenCalledOnce();
});
