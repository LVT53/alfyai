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
	it("is one load, two passes and a finish per segment", () => {
		expect(videoPlan(5, false).map((stage) => stage.kind)).toEqual([
			"load",
			"sample",
			"sample",
			"finish",
		]);
		expect(videoPlan(10, false)).toHaveLength(8);
	});

	it("starts a cold 5 s clip near the 40 s a cold take shows, a warm one well under", () => {
		expect(total(videoPlan(5, false))).toBeGreaterThanOrEqual(36);
		expect(total(videoPlan(5, false))).toBeLessThanOrEqual(46);
		expect(total(videoPlan(5, true))).toBeLessThan(total(videoPlan(5, false)));
		expect(total(videoPlan(5, true))).toBeLessThanOrEqual(28);
	});

	it("gives a 10 s clip a second, warm segment and the longer frame check", () => {
		const five = videoPlan(5, false);
		const ten = videoPlan(10, false);
		expect(total(ten)).toBeGreaterThan(total(five) + 15);
		// The second segment restages from memory, so it loads like a warm take.
		expect(ten[4]?.seconds).toBe(videoPlan(5, true)[0]?.seconds);
		expect(ten.at(-1)?.seconds).toBeGreaterThan(five.at(-1)?.seconds ?? 0);
	});

	it("counts a 10 s take down through both segments without a jump up", () => {
		const eta = createTakeEta(videoPlan(10, false));
		const at = (seconds: number) => T0 + seconds * 1000;
		const published = [eta.start(at(0))];
		// Segment one: a slow staging, both passes, then the decode.
		published.push(eta.progress({ value: 1, max: 8 }, at(30)));
		published.push(eta.progress({ value: 8, max: 8 }, at(36)));
		published.push(eta.progress({ value: 1, max: 3 }, at(37)));
		published.push(eta.progress({ value: 3, max: 3 }, at(39)));
		published.push(eta.enter("finish", at(39)));
		// Segment two's prompt starts after the decode and the chain.
		published.push(eta.start(at(45)));
		published.push(eta.progress({ value: 1, max: 8 }, at(51)));
		published.push(eta.progress({ value: 3, max: 3 }, at(60)));
		published.push(eta.enter("finish", at(60)));
		for (let index = 1; index < published.length; index += 1) {
			expect(published[index]).toBeLessThanOrEqual(published[index - 1] ?? 0);
		}
	});
});
