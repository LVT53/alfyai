// The chip's time for a video take: a plausible baseline from the first
// moment, a number that never rises, and a floor for the phases ComfyUI does
// not report (model staging, VAE decode).
//
// What the measurement says (docs/plans/ltx-video/feasibility.md): a 5 s take
// is ~30-45 s cold (53.1 s for the first staging, 27.1 s warm on the card) and
// 16-24 s warm; a 10 s take is two segments, roughly double. The baseline is a
// cold-ish cold-start figure, because a cold take is where an ETA matters; a
// warm take simply reaches the floor and then the sampler quickly.
//
// Most of a video take is invisible to ComfyUI's progress events (it stages a
// 14.6 GB encoder and a 17.8 GB transformer, then decodes 121 or 242 frames),
// and LTX runs two sampler passes whose `max` resets between nodes. So:
//   - a baseline is written before any event, and counts down with the clock
//     while `submitted`/`starting` have nothing to report;
//   - a node reset (a smaller `max` or `value`) starts a new segment, never a
//     negative one, and the written ETA and percent only ever move one way;
//   - the sampler's own rate is only half the story: half of what is left of
//     the baseline is a floor, so a fast early sampler cannot promise a finish
//     the decoder will not meet.
//
// The numbers here are the chip's; they are not a promise, and a take that
// finishes early is the good direction.

import type { VideoDurationSeconds } from "./request";

/**
 * The baseline the chip reads before any progress:
 * 5 s: the measured cold start is 53.1 s and a warm one 16-24 s, so 40 s is
 * the middle of the 30-45 s window a real take shows; 10 s: two segments,
 * roughly double, 80 s.
 */
export const VIDEO_ETA_BASELINE_SECONDS: Record<VideoDurationSeconds, number> =
	{
		5: 40,
		10: 80,
	};

/**
 * What is left of the baseline, as a share, is the floor under the sampler's
 * estimate: decode, the second pass and storing are real time the progress
 * events never show, so the estimate must not collapse to zero in the first
 * pass.
 */
const BASELINE_FLOOR_SHARE = 0.5;

/** Decoding, the metadata strip, the explicit check's last batch and the store. */
const ETA_FINISH_SECONDS = 6;

/**
 * The sampling percent stops here until the take settles (success writes 100):
 * a first pass reaching 100% would otherwise leave the second pass looking
 * finished for a third of the take.
 */
const SAMPLING_PERCENT_CAP = 95;

export type VideoEtaSample = { value: number; max: number };

export type VideoEtaTracker = {
	/** The chip's first value, before any progress event. */
	baseline(now?: number): number;
	/** No progress to report: the baseline counts down at one second a second. */
	tick(now?: number): number;
	/** One ComfyUI progress event; the ETA and percent to write. */
	onProgress(
		sample: VideoEtaSample,
		now?: number,
	): { etaSeconds: number; progressPercent: number };
};

export function createVideoEtaTracker(input: {
	durationSeconds: VideoDurationSeconds;
	startedAt: number;
}): VideoEtaTracker {
	const baselineSeconds = VIDEO_ETA_BASELINE_SECONDS[input.durationSeconds];
	let lastEta: number | null = null;
	let lastAt = input.startedAt;
	let lastPercent = 0;
	// The current sampler segment: a node reset starts a new one.
	let segmentStartAt = input.startedAt;
	let segmentStartValue = 0;
	let prevValue = 0;
	let prevMax = 0;
	let seen = false;

	/**
	 * The one write path: candidate, raised to the baseline floor, then clamped
	 * so it can only fall by the time since the last write.
	 */
	const clamp = (candidate: number, now: number): number => {
		const elapsed = Math.max(0, (now - input.startedAt) / 1000);
		const floor = Math.max(0, baselineSeconds - elapsed) * BASELINE_FLOOR_SHARE;
		const ceiling =
			lastEta === null
				? Number.POSITIVE_INFINITY
				: Math.max(0, lastEta - Math.max(0, (now - lastAt) / 1000));
		const eta = Math.min(Math.max(floor, candidate), ceiling);
		lastEta = Math.max(0, eta);
		lastAt = now;
		return Math.round(lastEta);
	};

	return {
		baseline: (now = Date.now()) => {
			lastEta = baselineSeconds;
			lastAt = now;
			return Math.round(baselineSeconds);
		},
		tick: (now = Date.now()) =>
			// An infinite candidate means "no report": the ceiling is the
			// baseline's countdown, so the chip never reads 0:00 while loading.
			clamp(Number.POSITIVE_INFINITY, now),
		onProgress: (sample, now = Date.now()) => {
			const reset = !seen || sample.max < prevMax || sample.value < prevValue;
			if (reset) {
				// A new node/pass starts its own rate; it is not negative progress.
				segmentStartAt = now;
				segmentStartValue = sample.value;
			}
			seen = true;
			prevValue = sample.value;
			prevMax = sample.max;
			const elapsedInSegment = Math.max(0.001, (now - segmentStartAt) / 1000);
			const done = Math.max(1, sample.value - segmentStartValue);
			const left = Math.max(0, sample.max - sample.value);
			const samplerEta = (elapsedInSegment / done) * left + ETA_FINISH_SECONDS;
			const etaSeconds = clamp(samplerEta, now);
			const rawPercent = sample.max > 0 ? (sample.value / sample.max) * 100 : 0;
			lastPercent = Math.min(
				SAMPLING_PERCENT_CAP,
				Math.max(lastPercent, Math.round(rawPercent)),
			);
			return { etaSeconds, progressPercent: lastPercent };
		},
	};
}
