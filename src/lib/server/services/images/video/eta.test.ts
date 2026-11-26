// @vitest-environment node
//
// A video take's plan: what the estimate counts down from before ComfyUI
// reports anything, and what is still ahead while it does.

import { describe, expect, it } from "vitest";
import { createTakeEta, type EtaPlan } from "../take-eta";
import { videoPlan } from "./eta";

const T0 = 1_000_000;
const total = (plan: EtaPlan) =>
	plan.reduce((sum, stage) => sum + stage.seconds, 0);

describe("videoPlan", () => {
	it("is one load, two passes and a finish", () => {
		expect(videoPlan(5, false).map((stage) => stage.kind)).toEqual([
			"load",
			"sample",
			"sample",
			"finish",
		]);
		// A ten second take is ONE render of 241 frames, not two 121-frame
		// segments, so it plans the same four stages as five seconds and the
		// difference lands in the per-stage seconds.
		expect(videoPlan(10, false)).toHaveLength(4);
	});

	it("counts a 5 s clip down from the measured render, cold a little above warm", () => {
		// Measured on the production card with the sharpen pass and the x2
		// upscale both in the graph: ~56 s a render, plus the check and store
		// the plan adds on top.
		expect(total(videoPlan(5, false))).toBeGreaterThanOrEqual(56);
		expect(total(videoPlan(5, false))).toBeLessThanOrEqual(72);
		expect(total(videoPlan(5, true))).toBeLessThan(total(videoPlan(5, false)));
		expect(total(videoPlan(5, true))).toBeLessThanOrEqual(64);
	});

	it("scales a 10 s clip with its measured render", () => {
		const five = videoPlan(5, false);
		const ten = videoPlan(10, false);
		// The load is paid once and does not scale. The render does: measured
		// 56 s at 121 frames and 114 s at 241, so the total roughly doubles.
		expect(ten[0]?.seconds).toBe(five[0]?.seconds);
		expect(total(ten)).toBeGreaterThan(total(five));
		expect(total(ten) / total(five)).toBeGreaterThan(1.8);
		expect(total(ten) / total(five)).toBeLessThan(2.2);
		expect(total(ten)).toBeLessThanOrEqual(140);
	});

	it("counts a 10 s take down through its single render without a jump up", () => {
		const eta = createTakeEta(videoPlan(10, false));
		const at = (seconds: number) => T0 + seconds * 1000;
		const published = [eta.start(at(0))];
		// The render: a slow staging, both passes, then the decode.
		published.push(eta.progress({ value: 1, max: 8 }, at(30)));
		published.push(eta.progress({ value: 8, max: 8 }, at(36)));
		published.push(eta.progress({ value: 1, max: 3 }, at(37)));
		published.push(eta.progress({ value: 3, max: 3 }, at(39)));
		published.push(eta.enter("finish", at(39)));
		// A prompt that starts again after the finish must not raise it.
		published.push(eta.start(at(45)));
		published.push(eta.progress({ value: 1, max: 8 }, at(51)));
		published.push(eta.progress({ value: 3, max: 3 }, at(60)));
		published.push(eta.enter("finish", at(60)));
		for (let index = 1; index < published.length; index += 1) {
			expect(published[index]).toBeLessThanOrEqual(published[index - 1] ?? 0);
		}
	});
});
