// @vitest-environment node
//
// The take's estimate on the server: one finish time, built from a plan of the
// phases ComfyUI does not report and the sampler's real rate, that only ever
// moves earlier. Synthetic times, so the arithmetic is pinned without a clock.

import { describe, expect, it } from "vitest";
import {
	graphFor,
	H3_EDIT_STEPS,
	H3_GENERATE_STEPS,
} from "./comfyui/templates";
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

describe("passes and later prompts", () => {
	const TWO_PROMPTS: EtaPlan = [
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
		const eta = createTakeEta(TWO_PROMPTS);
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
		const eta = createTakeEta(TWO_PROMPTS);
		const published = [eta.start(at(0))];
		published.push(eta.progress({ value: 8, max: 8 }, at(26)));
		published.push(eta.progress({ value: 1, max: 3 }, at(27)));
		published.push(eta.progress({ value: 2, max: 3 }, at(28)));
		for (let index = 1; index < published.length; index += 1) {
			expect(published[index]).toBeLessThanOrEqual(published[index - 1] ?? 0);
		}
		expect(left(published.at(-1) ?? 0, at(28))).toBeGreaterThan(40);
	});

	it("takes the next prompt's load when ComfyUI starts it", () => {
		const eta = createTakeEta(TWO_PROMPTS);
		eta.start(at(0));
		eta.progress({ value: 8, max: 8 }, at(26));
		eta.progress({ value: 3, max: 3 }, at(30));
		eta.enter("finish", at(30));
		// The second prompt starts: its load, and all after it.
		const second = eta.start(at(36));
		expect(left(second, at(36))).toBe(42);
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

	it("puts a cold 12 MP H3 picture near the 25 seconds it takes at four steps", () => {
		// The warm ~13 s below, plus the model load of a cold engine.
		expect(total(picturePlan(request({}), false))).toBeGreaterThanOrEqual(22);
		expect(total(picturePlan(request({}), false))).toBeLessThanOrEqual(30);
	});

	it("gives a warm engine a short load: the text encoder and the first step's page-in", () => {
		const cold = picturePlan(request({}), false);
		const warm = picturePlan(request({}), true);
		expect(warm[0]?.seconds).toBeLessThan(cold[0]?.seconds ?? 0);
		expect(warm[0]?.seconds).toBeLessThanOrEqual(3.5);
	});

	// Measured on the box on 2026-11-18, warm, with the NumPy huge-page stall gone
	// (docs/plans/minimax-h3-image/speed-investigation-2026-11-18.md): ComfyUI's own
	// time, plus about a second for the app's fetch, check and store (two for an
	// edit, which also runs its guard).
	describe("H3 plans what the box measured", () => {
		const base = { fileId: "base", role: "base" as const, name: "Base" };
		const reference = (n: number) => ({
			fileId: `ref-${n}`,
			role: "reference" as const,
			name: `Reference ${n}`,
		});

		it("plans a warm 12 MP new picture at four steps near its ~13 s", () => {
			const plan = picturePlan(request({}), true);
			expect(total(plan)).toBeGreaterThanOrEqual(11.5);
			expect(total(plan)).toBeLessThanOrEqual(14.5);
		});

		it("plans a warm edit on its 3072x2048 canvas near its ~23 s, not the ~10 s the canvas alone gave", () => {
			const plan = picturePlan(
				request({
					mode: "edit",
					canvas: { width: 3072, height: 2048 },
					inputs: [base],
				}),
				true,
			);
			expect(total(plan)).toBeGreaterThanOrEqual(21);
			expect(total(plan)).toBeLessThanOrEqual(26);
		});

		it("plans a warm square 2048x2048 edit near its ~15 s", () => {
			const plan = picturePlan(
				request({
					mode: "edit",
					canvas: { width: 2048, height: 2048 },
					inputs: [base],
				}),
				true,
			);
			expect(total(plan)).toBeGreaterThanOrEqual(13.5);
			expect(total(plan)).toBeLessThanOrEqual(17.5);
		});

		it("adds time for every further picture an edit is given", () => {
			const one = picturePlan(
				request({
					mode: "edit",
					canvas: { width: 3072, height: 2048 },
					inputs: [base],
				}),
				true,
			);
			const three = picturePlan(
				request({
					mode: "edit",
					canvas: { width: 3072, height: 2048 },
					inputs: [base, reference(1), reference(2)],
				}),
				true,
			);
			for (const kind of ["load", "sample"] as const) {
				const of = (plan: EtaPlan) =>
					plan.find((s) => s.kind === kind)?.seconds ?? 0;
				expect(of(three)).toBeGreaterThan(of(one));
			}
		});

		it("adds the model load to a cold engine, and only to its load", () => {
			const warm = picturePlan(request({}), true);
			const cold = picturePlan(request({}), false);
			expect(
				(cold[0]?.seconds ?? 0) - (warm[0]?.seconds ?? 0),
			).toBeGreaterThanOrEqual(8);
			expect(cold[1]?.seconds).toBe(warm[1]?.seconds);
			expect(cold[2]?.seconds).toBe(warm[2]?.seconds);
		});
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

	describe("the sampler's share follows the step count of the graph the request runs", () => {
		const secondsOf = (plan: EtaPlan, kind: "load" | "sample" | "finish") =>
			plan.find((entry) => entry.kind === kind)?.seconds ?? 0;
		const sampleSeconds = (plan: EtaPlan) => secondsOf(plan, "sample");
		const canvas = { width: 3072, height: 2048 };

		it("plans an H3 new picture's sampling at 4/6 of an edit's with the same sequence", () => {
			// An edit with no pictures packs the same sequence as a new picture, so
			// only the step count differs between the two.
			const generate = picturePlan(request({ mode: "generate", canvas }), true);
			const edit = picturePlan(request({ mode: "edit", canvas }), true);
			expect(sampleSeconds(generate)).toBeLessThan(sampleSeconds(edit));
			expect(sampleSeconds(generate) / sampleSeconds(edit)).toBeCloseTo(
				H3_GENERATE_STEPS / H3_EDIT_STEPS,
				10,
			);
			// Only the sampler knows steps; an edit's finish adds its guard.
			expect(secondsOf(generate, "load")).toBe(secondsOf(edit, "load"));
		});

		it("takes the step count from the graph template, not from a number of its own", () => {
			const generateSteps = graphFor("h3", "generate", false)?.template.steps;
			const editSteps = graphFor("h3", "edit", false)?.template.steps;
			expect([generateSteps, editSteps]).toEqual([4, 6]);
			const generate = picturePlan(request({ mode: "generate", canvas }), true);
			const edit = picturePlan(request({ mode: "edit", canvas }), true);
			expect(sampleSeconds(generate) / (generateSteps ?? 1)).toBeCloseTo(
				sampleSeconds(edit) / (editSteps ?? 1),
				10,
			);
		});

		it("leaves Qwen's sampling exactly as measured", () => {
			const qwen = picturePlan(
				request({
					model: "qwen",
					canvas: { width: 1248, height: 832 },
				}),
				true,
			);
			expect(sampleSeconds(qwen)).toBeCloseTo(
				6 * ((1248 * 832) / 1e6) ** 1.35,
				6,
			);
		});

		it("plans a request with no graph (H3 has no transparent one) at an edit's six steps", () => {
			const plan = picturePlan(request({ canvas, transparent: true }), true);
			const edit = picturePlan(request({ mode: "edit", canvas }), true);
			expect(sampleSeconds(plan)).toBeCloseTo(sampleSeconds(edit), 10);
		});
	});
});
