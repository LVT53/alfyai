import { describe, expect, it } from "vitest";
import {
	ARTIFACT_COUNTER_GAP_PX,
	artifactCounterPillBottom,
	JUMP_CONTROL_GAP_PX,
	JUMP_CONTROL_MIN_BOTTOM_PX,
	JUMP_CONTROL_SIZE_PX,
} from "./artifact-counter-placement";

describe("artifactCounterPillBottom", () => {
	it("keeps the floor above a chat that has no measured composer yet", () => {
		expect(artifactCounterPillBottom({ composerHeight: 0 })).toBe(
			JUMP_CONTROL_MIN_BOTTOM_PX +
				JUMP_CONTROL_SIZE_PX +
				ARTIFACT_COUNTER_GAP_PX,
		);
	});

	it("sits above the jump controls once the composer is taller than their floor", () => {
		expect(artifactCounterPillBottom({ composerHeight: 200 })).toBe(
			200 +
				JUMP_CONTROL_GAP_PX +
				JUMP_CONTROL_SIZE_PX +
				ARTIFACT_COUNTER_GAP_PX,
		);
	});

	it("always clears the jump controls, so the two can never overlap", () => {
		for (const composerHeight of [0, 40, 120, 200, 420]) {
			const jumpBottom = Math.max(
				JUMP_CONTROL_MIN_BOTTOM_PX,
				composerHeight + JUMP_CONTROL_GAP_PX,
			);
			const pillBottom = artifactCounterPillBottom({ composerHeight });
			expect(
				pillBottom - (jumpBottom + JUMP_CONTROL_SIZE_PX),
			).toBeGreaterThanOrEqual(ARTIFACT_COUNTER_GAP_PX);
		}
	});

	it("treats a negative measurement as no composer", () => {
		expect(artifactCounterPillBottom({ composerHeight: -40 })).toBe(
			artifactCounterPillBottom({ composerHeight: 0 }),
		);
	});
});
