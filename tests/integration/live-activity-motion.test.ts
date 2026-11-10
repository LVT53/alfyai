import { expect, test } from "vitest";
import {
	type ActivityFrame,
	measureLiveActivity,
} from "../e2e/live-activity-motion";

const frame = (
	t: number,
	y: number | null,
	h = 20,
	answer = false,
	stop = true,
): ActivityFrame => ({
	t,
	tracked: {
		prose: y === null ? null : { y, h },
		user: { y: 0, h: 20 },
		answer: answer ? { y: 0, h: 30 } : null,
		stop: stop ? { y: 0, h: 10 } : null,
	},
});

test("a 10px jump on live activity growth fails the retained 1px bar", () => {
	const frames = [
		frame(0, 0),
		frame(1, 0),
		frame(2, 10, 40),
		frame(3, 10, 40),
		frame(4, null, 0, true, false),
	];
	const metric = measureLiveActivity(frames, 1);
	expect(metric.proseMovedPx).toBe(10);
	expect(metric.proseMovedPx <= 1).toBe(false);
	expect(metric.end).toBe(4);
});

test.each([
	"answer",
	"terminal",
])("intentional fade after independently observed %s is excluded", (cause) => {
	const frames = [
		frame(0, 0),
		frame(1, 0),
		frame(2, 0, 40),
		frame(3, 30, 40, cause === "answer", cause !== "terminal"),
		frame(4, null, 0, true, false),
	];
	expect(measureLiveActivity(frames, 1)).toEqual({ end: 3, proseMovedPx: 0 });
});

test("unexpected disappearance before known terminal fails rather than truncating", () => {
	expect(() =>
		measureLiveActivity(
			[
				frame(0, 0),
				frame(1, 0),
				frame(2, null),
				frame(3, null, 0, true, false),
			],
			1,
		),
	).toThrow("Live activity disappeared before an observed terminal boundary");
});

test("all live frames count when no independent terminal boundary was sampled", () => {
	expect(
		measureLiveActivity([frame(0, 0), frame(1, 0), frame(2, 10, 40)], 1),
	).toEqual({ end: 3, proseMovedPx: 10 });
});

test("an already terminal first card frame cannot pass an empty movement window", () => {
	expect(() =>
		measureLiveActivity([frame(0, 0), frame(1, 0, 20, true, false)], 1),
	).toThrow("No live activity frames before terminal boundary");
});
