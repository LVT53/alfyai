import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStreamWithMockedResponse, uiFrame } from "./streaming.test-helpers";

describe("review C: a terminal observation the reader cannot decode", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		["completion with an unknown outcome", { outcome: "exploded" }],
		["completion missing stopCause", { stopCause: undefined }],
		["numeric assistant id", null],
	] as const)("%s (no finalization marker) is not handed over as a clean end", async (_label, change) => {
		const completion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "closing",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "natural_stop",
			closingAttempted: false,
			...(change ?? {}),
		};
		const observation = {
			version: 1,
			streamId: "observer",
			conversationId: "conv-1",
			state: "terminal",
			assistantMessageId: change === null ? 42 : "saved",
			completion,
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-stream-metadata",
					data: { observation },
					transient: true,
				}),
				uiFrame({ type: "finish", finishReason: "stop" }),
				uiFrame("[DONE]"),
			],
		});
		await done;
		const [, metadata] = vi.mocked(cb.onEnd).mock.calls[0] ?? [];
		console.log(
			_label,
			"-> onEnd metadata.observation =",
			JSON.stringify(metadata?.observation),
			"onError calls:",
			vi.mocked(cb.onError).mock.calls.length,
		);
		// Expected: an explicit unavailable observation (as for the marked case), never "no observation".
		expect(metadata?.observation?.state).toBe("unavailable");
	});
});
