// When a take (a picture or a clip) is expected to be done: one finish time,
// written to the take as `eta_at` (milliseconds) and counted down by the card.
//
// Most of a take is invisible to ComfyUI's progress events: the model loads
// before the first step (11.7 s for a cold H3, tens of seconds for LTX), and
// the decode, the store and the explicit-picture check run after the last one.
// So the estimate is a plan of stages, measured per engine (`picturePlan`,
// `video/eta.ts`'s `videoPlan`): a load, the sampler's pass or passes, a
// finish, in order. While a stage runs, what is left of it comes from the plan,
// except a sampler pass once two of its steps are in: then it is the steps'
// own rate. Every later stage adds its planned time.
//
// The finish time only ever moves EARLIER. A take that is faster than its plan
// shows it at once (the card eases the change in); a slower one keeps its time,
// runs past it, and the card says so in words, never with a number that climbs
// back up or goes below zero. The one real reason to start again higher is a
// render that starts over (ComfyUI forgot the prompt): the runner makes a new
// estimate for it.

import type { TakeRequest } from "./take-request";

export type EtaStage = {
	kind: "load" | "sample" | "finish";
	/** The stage's planned length. */
	seconds: number;
};

/** A take's stages, in the order they run. */
export type EtaPlan = readonly EtaStage[];

export type TakeEta = {
	/**
	 * ComfyUI started a prompt: the first one begins the countdown with the
	 * whole plan ahead; one that follows a finished segment begins the next
	 * segment's load; any other (a re-followed prompt) changes nothing.
	 */
	start(now?: number): number;
	/**
	 * One ComfyUI progress event. The first one after a load is the first
	 * sampler pass; a node reset (a smaller `max` or `value`) is the next pass,
	 * never negative progress.
	 */
	progress(sample: { value: number; max: number }, now?: number): number;
	/** ComfyUI is done with the segment: what is left is decoding and the app's own work. */
	enter(kind: "finish", now?: number): number;
};

/** A pass's own rate counts fully from its third step; its second step is weighed with the plan. */
const RATE_TRUSTED_FROM_INTERVALS = 2;

export function createTakeEta(plan: EtaPlan): TakeEta {
	let started = false;
	let index = 0;
	let stageAt = 0;
	let published: number | null = null;
	// The current sampler pass: its first event, its latest event.
	let firstAt = 0;
	let firstValue = 0;
	let lastAt = 0;
	let lastValue = 0;
	let lastMax = 0;
	let events = 0;

	const nextOfKind = (kind: EtaStage["kind"]): number => {
		for (let candidate = index + 1; candidate < plan.length; candidate += 1) {
			if (plan[candidate]?.kind === kind) return candidate;
		}
		return -1;
	};

	const enterStage = (next: number, now: number) => {
		index = next;
		stageAt = now;
		events = 0;
		lastMax = 0;
	};

	const secondsLeft = (now: number): number => {
		const stage = plan[index];
		let current = 0;
		if (stage?.kind === "sample" && lastMax > 0) {
			const stepsLeft = Math.max(0, lastMax - lastValue);
			const planned = stage.seconds * (stepsLeft / lastMax);
			const intervals = events - 1;
			const stepsSeen = lastValue - firstValue;
			if (intervals >= 1 && stepsSeen > 0) {
				const measured =
					((lastAt - firstAt) / 1000 / stepsSeen) * stepsLeft -
					(now - lastAt) / 1000;
				const weight = Math.min(1, intervals / RATE_TRUSTED_FROM_INTERVALS);
				current = weight * measured + (1 - weight) * planned;
			} else {
				current = planned;
			}
		} else if (stage) {
			current = stage.seconds - (now - stageAt) / 1000;
		}
		let later = 0;
		for (let rest = index + 1; rest < plan.length; rest += 1) {
			later += plan[rest]?.seconds ?? 0;
		}
		return Math.max(0, current) + later;
	};

	/** The one write path: the finish time moves earlier or stays. */
	const publish = (now: number): number => {
		const candidate = Math.round(now + secondsLeft(now) * 1000);
		if (published === null || candidate < published) published = candidate;
		return published;
	};

	const begin = (now: number) => {
		if (started) return;
		started = true;
		enterStage(0, now);
	};

	return {
		start: (now = Date.now()) => {
			if (!started) {
				begin(now);
			} else if (plan[index]?.kind === "finish") {
				const load = nextOfKind("load");
				if (load >= 0) enterStage(load, now);
			}
			return publish(now);
		},
		progress: (sample, now = Date.now()) => {
			begin(now);
			const stage = plan[index];
			const reset =
				stage?.kind === "sample" &&
				events > 0 &&
				(sample.max < lastMax || sample.value < lastValue);
			if (stage?.kind !== "sample" || reset) {
				// The first step after a load, or a new pass: the next sampler
				// stage, when the plan has one (an unplanned extra pass is measured
				// in the stage the take is already in).
				const next = nextOfKind("sample");
				if (next >= 0) enterStage(next, now);
				else events = 0;
			}
			if (events === 0) {
				firstAt = now;
				firstValue = sample.value;
			}
			events += 1;
			lastAt = now;
			lastValue = sample.value;
			lastMax = sample.max;
			return publish(now);
		},
		enter: (kind, now = Date.now()) => {
			begin(now);
			const next = nextOfKind(kind);
			if (next >= 0) enterStage(next, now);
			return publish(now);
		},
	};
}

/**
 * What a read model sends the card: the seconds left as of the read, to a
 * tenth (the card anchors them on its own clock, so no clock is shared), 0
 * once the take runs past its time, and null when only a running take with an
 * estimate has one.
 */
export function etaSecondsAt(
	take: { status: string; etaAt: number | null },
	now: number,
): number | null {
	if (take.status !== "running" || take.etaAt === null) return null;
	return Math.max(0, Math.round((take.etaAt - now) / 100) / 10);
}

/**
 * The plan for a picture take, from the engine's measurements
 * (docs/plans/minimax-h3-image/assessment.md: H3 is 3.0 s at 4 MP and 17.9 s at
 * 16 MP warm, after an 11.7 s model load; Qwen at 1 MP has a production p50 of
 * 10 s and p90 of 15 s, and 46.2 s at 4 MP). The sampler's share grows a little
 * faster than the canvas; the finish (ComfyUI's decode, then the app's guard,
 * store and check) grows with it. A warm engine (its models still loaded from
 * a take a moment ago) has next to no load. The sampler's real rate replaces
 * its planned share once two steps are in.
 */
export function picturePlan(request: TakeRequest, warm: boolean): EtaPlan {
	const megapixels = (request.canvas.width * request.canvas.height) / 1e6;
	const engine = PICTURE_ENGINE_PLAN[request.model];
	return [
		{ kind: "load", seconds: warm ? WARM_LOAD_SECONDS : engine.coldLoad },
		{
			kind: "sample",
			seconds: engine.sampleAtOneMp * megapixels ** engine.sampleGrowth,
		},
		{
			kind: "finish",
			seconds: FINISH_BASE_SECONDS + engine.finishPerMp * megapixels,
		},
	];
}

/** A warm engine still stages the prompt and its inputs. */
const WARM_LOAD_SECONDS = 1;
/** Fetching the result, the explicit-picture check and settling, whatever the size. */
const FINISH_BASE_SECONDS = 1.5;

const PICTURE_ENGINE_PLAN: Record<
	TakeRequest["model"],
	{
		coldLoad: number;
		sampleAtOneMp: number;
		sampleGrowth: number;
		finishPerMp: number;
	}
> = {
	// 12 MP: ~13 s cold load, ~9.5 s of sampling, ~6.3 s of decode and store.
	h3: { coldLoad: 13, sampleAtOneMp: 0.8, sampleGrowth: 1, finishPerMp: 0.4 },
	// 1 MP: ~6 s of sampling, a warm take ~9 s; 4 MP print: ~41 s.
	qwen: {
		coldLoad: 15,
		sampleAtOneMp: 6,
		sampleGrowth: 1.35,
		finishPerMp: 0.4,
	},
};
