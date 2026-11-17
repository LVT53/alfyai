// @vitest-environment node
//
// The take's estimate on the server: one finish time, built from a plan of the
// phases ComfyUI does not report and the sampler's real rate, that only ever
// moves earlier. Synthetic times, so the arithmetic is pinned without a clock.

import { describe, expect, it } from "vitest";
import { createTakeEta, type EtaPlan, picturePlan } from "./take-eta";
import type { TakeRequest } from "./take-request";

const T0 = 1_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
/** Seconds left at `now` for a published finish time. */
const left = (etaAt: number, now: number) => (etaAt - now) / 1000;

/** Ten seconds of loading, ten steps of one second, five seconds of finishing. */
const PLAN: EtaPlan = [
	{ kind: "load", seconds: 10 },
	{ kind: "sample", seconds: 10 },
	{ kind: "finish", seconds: 5 },
];

describe("a take that goes as planned", () => {
	it("counts down one second a second from the whole plan", () => {
		const eta = createTakeEta(PLAN);
		const published = [eta.start(at(0))];
		// The load ends at 10 s; each step takes one second.
		for (let step = 1; step <= 10; step += 1) {
			published.push(eta.progress({ value: step, max: 10 }, at(10 + step)));
		}
		published.push(eta.enter("finish", at(20)));
		expect(left(published[0] ?? 0, at(0))).toBe(25);
		// Steady: the finish time does not move at all, so every second takes a
		// second off what is left.
		expect(new Set(published).size).toBe(1);
		expect(left(published.at(-1) ?? 0, at(20))).toBe(5);
	});

	it("ignores a second start, as a re-followed prompt sends one", () => {
		const eta = createTakeEta(PLAN);
		const first = eta.start(at(0));
		expect(eta.start(at(4))).toBe(first);
	});
});

describe("a take that runs over", () => {
	it("never moves its finish later, however slow the sampler is", () => {
		const eta = createTakeEta(PLAN);
		const published = [eta.start(at(0))];
		// Twice as slow as planned: two seconds a step.
		for (let step = 1; step <= 10; step += 1) {
			published.push(eta.progress({ value: step, max: 10 }, at(10 + 2 * step)));
		}
		published.push(eta.enter("finish", at(31)));
		for (let index = 1; index < published.length; index += 1) {
			expect(
				published[index],
				`publish ${index}: ${published.map((value) => left(value, T0)).join(", ")}`,
			).toBeLessThanOrEqual(published[index - 1] ?? 0);
		}
		// It ran past its finish: the time left at the end is gone, and the card
		// says so in words rather than in a number below zero.
		expect(left(published.at(-1) ?? 0, at(31))).toBeLessThan(0);
	});

	it("holds its finish through a load that takes far longer than planned", () => {
		const eta = createTakeEta(PLAN);
		const start = eta.start(at(0));
		// The model took 30 s to load, not 10: the first step arrives at 31 s.
		const afterLoad = eta.progress({ value: 1, max: 10 }, at(31));
		expect(afterLoad).toBe(start);
	});
});

describe("a slow start", () => {
	it("does not read the time to the first step as the whole render", () => {
		const eta = createTakeEta(PLAN);
		eta.start(at(0));
		// The first step lands at 10 s: no rate is known yet, so the plan's
		// sampling is still ahead (the old runner said "3 s left" here).
		const first = eta.progress({ value: 1, max: 10 }, at(10));
		expect(left(first, at(10))).toBeGreaterThanOrEqual(14);
	});

	it("takes the sampler's rate from the steps after the first, not from the start", () => {
		const eta = createTakeEta([
			{ kind: "load", seconds: 2 },
			{ kind: "sample", seconds: 60 },
			{ kind: "finish", seconds: 4 },
		]);
		eta.start(at(0));
		// Steps of half a second, the first one late (warm-up inside it).
		eta.progress({ value: 1, max: 30 }, at(6));
		eta.progress({ value: 2, max: 30 }, at(6.5));
		const third = eta.progress({ value: 3, max: 30 }, at(7));
		// 27 steps of 0.5 s and the 4 s finish: 17.5 s, not the plan's 60.
		expect(left(third, at(7))).toBeCloseTo(17.5, 1);
	});
});

describe("a take that is faster than planned", () => {
	it("moves its finish earlier as soon as the sampler shows it", () => {
		const eta = createTakeEta(PLAN);
		const start = eta.start(at(0));
		// The model was already loaded: the first step at 1 s, then 0.2 s each.
		eta.progress({ value: 1, max: 10 }, at(1));
		eta.progress({ value: 2, max: 10 }, at(1.2));
		const third = eta.progress({ value: 3, max: 10 }, at(1.4));
		expect(third).toBeLessThan(start);
		// Seven steps of 0.2 s and the 5 s finish.
		expect(left(third, at(1.4))).toBeCloseTo(6.4, 1);
	});
});

describe("passes and segments", () => {
	const VIDEO: EtaPlan = [
		{ kind: "load", seconds: 20 },
		{ kind: "sample", seconds: 6 },
		{ kind: "sample", seconds: 4 },
		{ kind: "finish", seconds: 6 },
		{ kind: "load", seconds: 20 },
		{ kind: "sample", seconds: 6 },
		{ kind: "sample", seconds: 4 },
		{ kind: "finish", seconds: 12 },
	];

	it("counts every later stage, and a node reset moves to the next pass", () => {
		const eta = createTakeEta(VIDEO);
		expect(left(eta.start(at(0)), at(0))).toBe(78);
		// The first pass: eight steps of 0.75 s, as planned. The second starts
		// again at 1/3, one planned step (4 s / 3) later.
		eta.progress({ value: 1, max: 8 }, at(20.75));
		eta.progress({ value: 8, max: 8 }, at(26));
		const second = eta.progress({ value: 1, max: 3 }, at(26 + 4 / 3));
		// Two of three steps of the second pass, then the plan's 6 + 20 + 6 + 4 + 12.
		expect(left(second, at(26 + 4 / 3))).toBeCloseTo(4 * (2 / 3) + 48, 1);
	});

	it("does not take a node reset for negative progress", () => {
		const eta = createTakeEta(VIDEO);
		const published = [eta.start(at(0))];
		published.push(eta.progress({ value: 8, max: 8 }, at(26)));
		published.push(eta.progress({ value: 1, max: 3 }, at(27)));
		published.push(eta.progress({ value: 2, max: 3 }, at(28)));
		for (let index = 1; index < published.length; index += 1) {
			expect(published[index]).toBeLessThanOrEqual(published[index - 1] ?? 0);
		}
		expect(left(published.at(-1) ?? 0, at(28))).toBeGreaterThan(40);
	});

	it("takes the next segment's load when ComfyUI starts its prompt", () => {
		const eta = createTakeEta(VIDEO);
		eta.start(at(0));
		eta.progress({ value: 8, max: 8 }, at(26));
		eta.progress({ value: 3, max: 3 }, at(30));
		eta.enter("finish", at(30));
		// The second segment's prompt starts: its load, and all after it.
		const segmentTwo = eta.start(at(36));
		expect(left(segmentTwo, at(36))).toBe(42);
	});
});

describe("picturePlan", () => {
	const request = (overrides: Partial<TakeRequest>): TakeRequest => ({
		v: 1,
		model: "h3",
		mode: "generate",
		prompt: "a lighthouse on a calm sea",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 4224, height: 2816 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Lighthouse",
		summary: null,
		...overrides,
	});
	const total = (plan: EtaPlan) =>
		plan.reduce((sum, stage) => sum + stage.seconds, 0);

	it("loads, samples and finishes, in that order", () => {
		expect(picturePlan(request({}), false).map((stage) => stage.kind)).toEqual([
			"load",
			"sample",
			"finish",
		]);
	});

	it("puts a cold 12 MP H3 take near the half minute it takes", () => {
		expect(total(picturePlan(request({}), false))).toBeGreaterThanOrEqual(26);
		expect(total(picturePlan(request({}), false))).toBeLessThanOrEqual(34);
	});

	it("gives a warm engine almost no load", () => {
		const cold = picturePlan(request({}), false);
		const warm = picturePlan(request({}), true);
		expect(warm[0]?.seconds).toBeLessThan(cold[0]?.seconds ?? 0);
		expect(warm[0]?.seconds).toBeLessThanOrEqual(2);
	});

	it("grows with the canvas", () => {
		const small = picturePlan(
			request({ model: "qwen", canvas: { width: 1248, height: 832 } }),
			true,
		);
		const print = picturePlan(
			request({ model: "qwen", canvas: { width: 2496, height: 1664 } }),
			true,
		);
		expect(total(print)).toBeGreaterThan(total(small));
	});
});
