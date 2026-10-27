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
	viewingImagesCount,
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

// Alfy looking at the pictures attached to the message (vision/AGENTS.md): the
// entry carries how many were sent and nothing else, and the browser only says
// it when it can say a number it can trust.
describe("viewingImagesCount", () => {
	const viewing = (
		over: Partial<ResponseActivityEntry> = {},
	): ResponseActivityEntry => ({
		id: "viewing-images",
		kind: "viewing_images",
		status: "running",
		count: 2,
		...over,
	});

	it("is the count of a running viewing_images entry", () => {
		expect(viewingImagesCount(viewing({ count: 2 }))).toBe(2);
		expect(viewingImagesCount(viewing({ count: 1 }))).toBe(1);
		expect(viewingImagesCount(viewing({ count: 8 }))).toBe(8);
	});

	it("is null for any other kind, even one that carries a count", () => {
		expect(viewingImagesCount(viewing({ kind: "tool", count: 3 }))).toBeNull();
		expect(
			viewingImagesCount(viewing({ kind: "context", count: 3 })),
		).toBeNull();
	});

	it("is null once the entry is no longer running", () => {
		expect(viewingImagesCount(viewing({ status: "done" }))).toBeNull();
		expect(viewingImagesCount(viewing({ status: "error" }))).toBeNull();
	});

	it("is null for a count that is not a whole number of at least one", () => {
		for (const count of [
			undefined,
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"2" as unknown as number,
		]) {
			expect(viewingImagesCount(viewing({ count })), String(count)).toBeNull();
		}
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
