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

import type { CanvasSize } from "./canvas";
import { graphFor } from "./comfyui/templates";
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
	 * whole plan ahead; one that follows a finished prompt begins the next
	 * prompt's load (a plan with a second load); any other (a re-followed
	 * prompt) changes nothing.
	 */
	start(now?: number): number;
	/**
	 * One ComfyUI progress event. The first one after a load is the first
	 * sampler pass; a node reset (a smaller `max` or `value`) is the next pass,
	 * never negative progress.
	 */
	progress(sample: { value: number; max: number }, now?: number): number;
	/** ComfyUI is done with the prompt: what is left is decoding and the app's own work. */
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
 * The plan for a picture take, from the engine's measurements. H3's is planned
 * from the sequence its DiT runs and the graph's step count (`h3Plan`). Qwen's
 * from the canvas (docs/plans/minimax-h3-image/assessment.md: Qwen at 1 MP has a
 * production p50 of 10 s and p90 of 15 s, and 46.2 s at 4 MP): its sampler's
 * share grows a little faster than the canvas, and the finish (ComfyUI's decode,
 * then the app's guard, store and check) grows with it. A warm engine (its
 * models still loaded from a take a moment ago) has next to no model load. The
 * sampler's real rate replaces its planned share once two steps are in.
 */
export function picturePlan(request: TakeRequest, warm: boolean): EtaPlan {
	if (request.model === "h3") return h3Plan(request, warm);
	const megapixels = (request.canvas.width * request.canvas.height) / 1e6;
	return [
		{ kind: "load", seconds: warm ? WARM_LOAD_SECONDS : QWEN_PLAN.coldLoad },
		{
			kind: "sample",
			seconds: QWEN_PLAN.sampleAtOneMp * megapixels ** QWEN_PLAN.sampleGrowth,
		},
		{
			kind: "finish",
			seconds: FINISH_BASE_SECONDS + QWEN_PLAN.finishPerMp * megapixels,
		},
	];
}

/** A warm engine still stages the prompt and its inputs. */
const WARM_LOAD_SECONDS = 1;
/** Fetching the result, the explicit-picture check and settling, whatever the size. */
const FINISH_BASE_SECONDS = 1.5;

// 1 MP: ~6 s of sampling, a warm take ~9 s; 4 MP print: ~41 s.
const QWEN_PLAN = {
	coldLoad: 15,
	sampleAtOneMp: 6,
	sampleGrowth: 1.35,
	finishPerMp: 0.4,
};

/**
 * H3's plan, from what the box measured on 2026-11-18 (warm, the NumPy
 * huge-page stall gone; docs/plans/minimax-h3-image/speed-investigation-2026-11-18.md).
 * The canvas alone does not say how long H3 takes: the DiT runs one packed
 * sequence of the canvas, every picture the edit is given and the text
 * encoder's tokens (the prompt and each picture's vision tokens), and attention
 * grows with its square. Planned from the canvas, an edit on its 3072x2048
 * canvas was given ~10 s and took ~23.
 *
 * - load: the graph's start, VAE-encoding the pictures, Qwen3-VL over the
 *   prompt and the pictures, and the first step's page-in of the 20 GB DiT
 *   after the text encoder; a cold engine reads its files again first. The
 *   first step's own time is in the sample stage, which plans every step: the
 *   load ends with the first progress event, and counting that step twice
 *   would start every countdown one step long.
 * - sample: the graph's steps (`graphFor`, the template the runner builds the
 *   graph from) times one step on the sequence, `a·k + b·k²` seconds for `k`
 *   thousand tokens. Measured steady steps: 2.0 s at 11.8k tokens (a new 12 MP
 *   picture), 2.45 s at 14.4k (a 3072x2048 edit), 1.5 s at 9.7k (a square
 *   2048 one), 3.2 s at 17.2k and 3.9-4.2 s at 19.9k (edits at 12 MP).
 * - finish: ComfyUI's decode and save, then the app's fetch, check and store;
 *   an edit also runs its guard (three decodes and a PNG at the canvas).
 */
const H3_PLAN = {
	stepPerKiloToken: 0.1154,
	stepPerKiloTokenSquared: 0.00443,
	firstStepPageIn: 1,
	coldLoad: 10,
	startSeconds: 0.1,
	encodePerPictureMp: 0.15,
	textEncoderSeconds: 1.15,
	textEncoderPerToken: 0.0011,
	finishSeconds: 1,
	finishPerMp: 0.15,
	guardPerMp: 0.15,
	/** The chat template and `<Picture 1>` around the prompt. */
	promptOverheadTokens: 60,
	/** A further picture the edit is given: the app stores it within 1 MP; planned as a 3:2 one. */
	referenceAssumed: { width: 1254, height: 836 },
	/** What MiniMaxH3ImageConditioning encodes a picture at: its short edge clamped to 1024-2048 px. */
	encodeShortEdgeMin: 1024,
	encodeShortEdgeMax: 2048,
	/** Qwen3-VL sees each picture at a 1024 px short edge, one token per 28 px square. */
	visionShortEdge: 1024,
	visionTokenSide: 28,
} as const;

/** The DiT's tokens for a picture: 16x VAE, then 2x2 patches, so one per 32 px square. */
function ditTokens(size: CanvasSize): number {
	return Math.round(size.width / 32) * Math.round(size.height / 32);
}

/** A picture as the conditioning node VAE-encodes it. */
function encodedSize(size: CanvasSize): CanvasSize {
	const short = Math.min(size.width, size.height);
	const target = Math.min(
		H3_PLAN.encodeShortEdgeMax,
		Math.max(H3_PLAN.encodeShortEdgeMin, short),
	);
	const scale = target / short;
	return {
		width: Math.round((size.width * scale) / 32) * 32,
		height: Math.round((size.height * scale) / 32) * 32,
	};
}

/** The text encoder's tokens for a picture's vision copy. */
function visionTokens(size: CanvasSize): number {
	const scale = H3_PLAN.visionShortEdge / Math.min(size.width, size.height);
	return (
		Math.round((size.width * scale) / H3_PLAN.visionTokenSide) *
		Math.round((size.height * scale) / H3_PLAN.visionTokenSide)
	);
}

function h3Plan(request: TakeRequest, warm: boolean): EtaPlan {
	const canvas = request.canvas;
	const canvasMp = (canvas.width * canvas.height) / 1e6;
	// The base goes up at the canvas size (prepareTakeInputs); a further picture
	// goes up within 1 MP. A marked copy is never sent to H3.
	const pictures: CanvasSize[] = request.inputs.flatMap((input) =>
		input.role === "base"
			? [canvas]
			: input.role === "reference"
				? [H3_PLAN.referenceAssumed]
				: [],
	);
	const encoded = pictures.map(encodedSize);
	const encodedTokens = encoded.reduce((sum, size) => sum + ditTokens(size), 0);
	const encodedMp = encoded.reduce(
		(sum, size) => sum + (size.width * size.height) / 1e6,
		0,
	);
	const textTokens =
		Math.ceil(request.prompt.length / 4) +
		H3_PLAN.promptOverheadTokens +
		pictures.reduce((sum, size) => sum + visionTokens(size), 0);
	const kiloTokens = (ditTokens(canvas) + encodedTokens + textTokens) / 1000;
	const stepSeconds =
		H3_PLAN.stepPerKiloToken * kiloTokens +
		H3_PLAN.stepPerKiloTokenSquared * kiloTokens ** 2;
	// A request with no graph (H3 has no transparent one; the runner refuses
	// it) is planned at an edit's six.
	const steps =
		graphFor(request.model, request.mode, request.transparent)?.template
			.steps ??
		graphFor("h3", "edit", false)?.template.steps ??
		6;
	return [
		{
			kind: "load",
			seconds:
				(warm ? 0 : H3_PLAN.coldLoad) +
				H3_PLAN.startSeconds +
				H3_PLAN.encodePerPictureMp * encodedMp +
				H3_PLAN.textEncoderSeconds +
				H3_PLAN.textEncoderPerToken * textTokens +
				H3_PLAN.firstStepPageIn,
		},
		{ kind: "sample", seconds: steps * stepSeconds },
		{
			kind: "finish",
			seconds:
				H3_PLAN.finishSeconds +
				H3_PLAN.finishPerMp * canvasMp +
				(request.mode === "edit" ? H3_PLAN.guardPerMp * canvasMp : 0),
		},
	];
}
