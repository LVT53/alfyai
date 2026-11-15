// @vitest-environment node
//
// The chip's ETA: a baseline from the first moment, never rising, and a floor
// under the sampler while model staging and decode run blind. Synthetic times,
// so the arithmetic is pinned without a clock.

import { describe, expect, it } from "vitest";
import { createVideoEtaTracker, VIDEO_ETA_BASELINE_SECONDS } from "./eta";

const T0 = 1_000_000;

describe("the video ETA", () => {
	it("starts from a per-length baseline, before any progress", () => {
		expect(VIDEO_ETA_BASELINE_SECONDS[5]).toBe(40);
		expect(VIDEO_ETA_BASELINE_SECONDS[10]).toBe(80);
		const five = createVideoEtaTracker({ durationSeconds: 5, startedAt: T0 });
		const ten = createVideoEtaTracker({ durationSeconds: 10, startedAt: T0 });
		expect(five.baseline(T0)).toBe(40);
		expect(ten.baseline(T0)).toBe(80);
	});

	it("counts the baseline down while nothing reports, never to 0:00 early", () => {
		const eta = createVideoEtaTracker({ durationSeconds: 5, startedAt: T0 });
		expect(eta.baseline(T0)).toBe(40);
		expect(eta.tick(T0 + 3_000)).toBe(37);
		expect(eta.tick(T0 + 10_000)).toBe(30);
		expect(eta.tick(T0 + 11_000)).toBe(29);
	});

	it("never rises across progress, and a node reset is not negative progress", () => {
		const eta = createVideoEtaTracker({ durationSeconds: 5, startedAt: T0 });
		const written = [eta.baseline(T0)];
		const progress = (value: number, max: number, at: number) => {
			written.push(eta.onProgress({ value, max }, T0 + at).etaSeconds);
		};
		progress(1, 8, 1_000);
		progress(2, 8, 2_000);
		// The first pass's node ends and a second node's max starts again at 1/4.
		progress(1, 4, 3_000);
		progress(2, 4, 4_000);
		progress(4, 4, 5_000);
		for (let index = 1; index < written.length; index += 1) {
			expect(
				written[index],
				`sample ${index} (${written.join(", ")})`,
			).toBeLessThanOrEqual(written[index - 1] ?? 0);
		}
	});

	it("keeps a floor under a fast sampler so the first pass cannot promise zero", () => {
		const eta = createVideoEtaTracker({ durationSeconds: 5, startedAt: T0 });
		eta.baseline(T0);
		// Eight of eight steps in one second: the sampler alone would say ~6 s
		// (the finish allowance), but ten seconds of staging are still ahead.
		const sample = eta.onProgress({ value: 8, max: 8 }, T0 + 1_000);
		expect(sample.etaSeconds).toBeGreaterThanOrEqual(15);
	});

	it("keeps the percent monotonic and below 100 while sampling", () => {
		const eta = createVideoEtaTracker({ durationSeconds: 10, startedAt: T0 });
		eta.baseline(T0);
		const percents = [
			eta.onProgress({ value: 1, max: 4 }, T0 + 1_000).progressPercent,
			eta.onProgress({ value: 4, max: 4 }, T0 + 2_000).progressPercent,
			// A new pass resets ComfyUI's own percent; ours stays where it was.
			eta.onProgress({ value: 1, max: 4 }, T0 + 3_000).progressPercent,
			eta.onProgress({ value: 2, max: 4 }, T0 + 4_000).progressPercent,
		];
		for (let index = 1; index < percents.length; index += 1) {
			expect(percents[index]).toBeGreaterThanOrEqual(percents[index - 1] ?? 0);
		}
		expect(percents.every((percent) => percent <= 95)).toBe(true);
	});

	it("gives a 10 s take a longer baseline and the same monotonic rule", () => {
		const eta = createVideoEtaTracker({ durationSeconds: 10, startedAt: T0 });
		expect(eta.baseline(T0)).toBe(80);
		const values = [eta.tick(T0 + 2_000)];
		for (const [index, step] of [
			{ value: 1, max: 8, at: 3_000 },
			{ value: 2, max: 8, at: 4_000 },
			{ value: 1, max: 4, at: 5_000 },
			{ value: 3, max: 4, at: 6_000 },
		].entries()) {
			values.push(
				eta.onProgress(
					{ value: step.value, max: step.max },
					T0 + step.at + index,
				).etaSeconds,
			);
		}
		for (let index = 1; index < values.length; index += 1) {
			expect(values[index]).toBeLessThanOrEqual(values[index - 1] ?? 0);
		}
	});
});
