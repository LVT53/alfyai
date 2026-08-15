import { describe, expect, it } from "vitest";
import {
	deriveReasoningSpineState,
	type ReasoningSpineLiveState,
} from "./reasoning-spine";

// P1 (ADR-0056) — pure lifecycle-event -> spine-state tests. No model call,
// no Svelte, no streaming machinery: the deterministic spine's live
// sub-state is asserted purely against its declared inputs.
describe("deriveReasoningSpineState", () => {
	it("defaults to reasoning_active while reasoning growth is fresh and the answer has not started", () => {
		expect(
			deriveReasoningSpineState({ answerStarted: false, deltaStalled: false }),
		).toBe("reasoning_active");
	});

	it("flips to reasoning_stalled when reasoning growth genuinely stops before the answer starts", () => {
		expect(
			deriveReasoningSpineState({ answerStarted: false, deltaStalled: true }),
		).toBe("reasoning_stalled");
	});

	it("reports writing_answer once the visible answer has started, even if reasoning had stalled first", () => {
		expect(
			deriveReasoningSpineState({ answerStarted: true, deltaStalled: true }),
		).toBe("writing_answer");
	});

	it("reports writing_answer once the visible answer has started and reasoning was still fresh", () => {
		expect(
			deriveReasoningSpineState({ answerStarted: true, deltaStalled: false }),
		).toBe("writing_answer");
	});

	it("never returns an empty state for any combination of inputs — the rail has no absent value", () => {
		const seen = new Set<ReasoningSpineLiveState>();
		for (const answerStarted of [true, false]) {
			for (const deltaStalled of [true, false]) {
				const state = deriveReasoningSpineState({
					answerStarted,
					deltaStalled,
				});
				expect(state).toBeTruthy();
				expect(typeof state).toBe("string");
				seen.add(state);
			}
		}
		// All three declared states are actually reachable, not dead branches.
		expect(seen).toEqual(
			new Set<ReasoningSpineLiveState>([
				"reasoning_active",
				"reasoning_stalled",
				"writing_answer",
			]),
		);
	});
});
