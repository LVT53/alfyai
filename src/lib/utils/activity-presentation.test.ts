import { describe, expect, it } from "vitest";
import type {
	ResponseActivityEntry,
	ThoughtStepClassifierActivityClass,
} from "$lib/response-activity-types";
import { THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES } from "$lib/response-activity-types";
import {
	isThoughtStepActivityEntry,
	isToolProgressActivity,
	type ThoughtStepIconType,
	thoughtStepIconTypeForClass,
} from "./activity-presentation";

// Tier B2 (chat-experience-elevation §5) — the extracted core is the test
// surface. These assert the EXACT classification/labelling both ThinkingBlock
// and MessageBubble previously carried as independent copies, so the two can
// no longer drift. No Svelte, no streaming machinery — the interface is the
// test surface, mirroring reasoning-spine.test.ts.

const activityEntry = (
	over: Partial<ResponseActivityEntry> = {},
): ResponseActivityEntry => ({
	id: "thought-step:1",
	kind: "thought_step",
	status: "running",
	...over,
});

describe("isThoughtStepActivityEntry", () => {
	it("is true for a thought_step entry with a non-empty detail", () => {
		expect(
			isThoughtStepActivityEntry(
				activityEntry({
					id: "thought-step:a",
					kind: "thought_step",
					detail: "weighing-options",
				}),
			),
		).toBe(true);
	});

	it("is false for a thought_step entry with no detail", () => {
		expect(
			isThoughtStepActivityEntry(
				activityEntry({ id: "thought-step:a", kind: "thought_step" }),
			),
		).toBe(false);
	});

	it("is false for a non-thought_step kind", () => {
		expect(
			isThoughtStepActivityEntry(activityEntry({ kind: "tool", detail: "x" })),
		).toBe(false);
	});
});

describe("isToolProgressActivity", () => {
	it("is true for a tool-progress:* entry with a non-empty label", () => {
		expect(
			isToolProgressActivity(
				activityEntry({
					id: "tool-progress:1",
					kind: "tool",
					label: "Let me run more targeted searches now.",
				}),
			),
		).toBe(true);
	});

	it("is false when the id is not a tool-progress id", () => {
		expect(
			isToolProgressActivity(
				activityEntry({ id: "tool:1", kind: "tool", label: "x" }),
			),
		).toBe(false);
	});

	it("is false when the label is blank", () => {
		expect(
			isToolProgressActivity(
				activityEntry({ id: "tool-progress:1", kind: "tool", label: "" }),
			),
		).toBe(false);
	});
});

describe("thoughtStepIconTypeForClass", () => {
	const cases: Array<
		[ThoughtStepClassifierActivityClass, ThoughtStepIconType]
	> = [
		["understanding-request", "help-circle"],
		["recalling-context", "history"],
		["weighing-options", "scale"],
		["working-through-logic", "workflow"],
		["checking-details", "list-checks"],
		["drafting-approach", "pen-line"],
	];

	for (const [activityClass, icon] of cases) {
		it(`maps ${activityClass} -> ${icon}`, () => {
			expect(thoughtStepIconTypeForClass(activityClass)).toBe(icon);
		});
	}

	it("is exhaustive over the closed classifier activity-class enum", () => {
		for (const activityClass of THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES) {
			expect(thoughtStepIconTypeForClass(activityClass)).toBeTruthy();
		}
	});
});
