import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import {
	AI_SMOKE_LATE_CARD_HELD_MARKER,
	AI_SMOKE_LATE_CARD_HOLD,
} from "../fixtures/ai/late-card-scenario";
import {
	AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT,
	AI_SMOKE_CHANGE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
} from "../fixtures/ai/late-picture-scenario";
import {
	assistantAnswer,
	expectTerminalActivityGone,
} from "./artifact-live-edit.helpers";
import { sendMessage } from "./helpers";
import {
	BODY_STATE,
	boxes,
	CARD,
	closeFlow,
	DESKTOP,
	type Flow,
	fakeProvider,
	firstSeen,
	isCardShift,
	longFramesAround,
	mark,
	momentOf,
	newChat,
	openFlow,
	PHONE,
	PROSE,
	readCards,
	settle,
	shiftsBetween,
	sizeDrift,
	TRACK,
} from "./images-motion-helpers";
import { measureLiveActivity } from "./live-activity-motion";
import {
	type MotionFrame,
	type MotionRun,
	startRecording,
	stopRecording,
} from "./panel-motion-helpers";
import { holdThinkingCardDelivery } from "./thinking-display-barrier";

/** The card's own pieces, for the transition probe. */
const CARD_PARTS = /^(image-card|image-picture|artifact-card|tool-activity)/;

const rowOnly = (entry: MotionRun["shifts"][number]) =>
	(entry.sources ?? []).length > 0 &&
	(entry.sources ?? []).every((source) => source === "tool-activity-row");

/** Shifts in the window that were not the card's, with what moved: for the report. */
function otherShiftsBetween(run: MotionRun, from: number, to: number) {
	return run.shifts.filter(
		(entry) =>
			entry.t >= from &&
			entry.t < to &&
			(entry.sources ?? []).length > 0 &&
			!isCardShift(entry),
	);
}

function rowWordShifts(run: MotionRun) {
	return run.shifts
		.filter(rowOnly)
		.reduce((sum, entry) => sum + entry.value, 0);
}

function cardTransitions(run: MotionRun) {
	// A 0.01 ms transition is the reduced-motion rule turning one off, not motion.
	const seen = run.transitions.filter(
		(entry) => CARD_PARTS.test(entry.target) && entry.duration >= 1,
	);
	return {
		properties: [...new Set(seen.map((entry) => entry.property))],
		other: seen.filter(
			(entry) => entry.property !== "opacity" && entry.property !== "transform",
		),
	};
}

/**
 * A picture asked for in words: the sentences stream, the card arrives under them
 * while the take waits its turn, the take is made, the picture lands and fades in,
 * and the closing sentence follows.
 */
/**
 * Where the newest card sits against the window and the composer: the reveal
 * (MessageArea's scroll dispatch) must bring the whole card into view above
 * the composer, not leave it behind it (review I1).
 */
async function cardPlacement(page: Page) {
	return page.evaluate((cardSelector) => {
		const cards = document.querySelectorAll(cardSelector);
		const card = cards[cards.length - 1]?.getBoundingClientRect();
		const composer = document
			.querySelector(".composer-shell")
			?.getBoundingClientRect();
		if (!card || !composer) return null;
		return {
			top: card.top,
			bottom: card.bottom,
			composerTop: composer.top,
			fullyAboveComposer: card.top >= 0 && card.bottom <= composer.top + 0.5,
		};
	}, CARD);
}

/**
 * The picture box while a take waits or is made (Task 11, the owner's call): only
 * a calm light sweeping left to right across the whole box, no spinner, no words
 * on screen (they are the sr-only status), and every CSS animation in the card on
 * transform or opacity alone.
 */
async function shimmerState(page: Page, options: { tag?: boolean } = {}) {
	return page.evaluate(
		({ cardSelector, tag }) => {
			const cards = document.querySelectorAll(cardSelector);
			const card = cards[cards.length - 1];
			const stage = card?.querySelector('[data-testid="image-card-stage"]');
			const shimmer = stage?.querySelector<HTMLElement>(
				'[data-testid="image-card-shimmer"]',
			);
			// The node seen at waiting is tagged, so making can say whether it is still
			// the same one (a remount would restart the sweep: Task 11 fix round 1).
			if (shimmer && tag) shimmer.dataset.probeSeenAtWaiting = "1";
			const band = shimmer?.querySelector(".take-shimmer-band") ?? null;
			const propertiesOf = (animation: Animation) => [
				...new Set(
					(
						(animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
					).flatMap((frame) =>
						Object.keys(frame).filter(
							(key) =>
								!["offset", "computedOffset", "easing", "composite"].includes(
									key,
								),
						),
					),
				),
			];
			const cssAnimations = (
				card?.getAnimations({ subtree: true }) ?? []
			).filter(
				(animation) =>
					(animation as Animation & { animationName?: string }).animationName,
			);
			// A CSS animation keeps its timing function on its keyframes.
			const easingOf = (animation: Animation, timing?: ComputedEffectTiming) =>
				String(
					(animation.effect as KeyframeEffect | null)?.getKeyframes()[0]
						?.easing ??
						timing?.easing ??
						"",
				);
			const iterationsOf = (timing?: ComputedEffectTiming) =>
				timing?.iterations === Infinity ? "infinite" : timing?.iterations;
			const nameOf = (animation: Animation) =>
				(animation as Animation & { animationName?: string }).animationName ??
				"";
			const describeSweep = (animation: Animation) => {
				const timing = animation.effect?.getComputedTiming();
				return {
					name: nameOf(animation),
					playState: animation.playState,
					properties: propertiesOf(animation),
					durationMs: Number(timing?.duration ?? 0),
					iterations: iterationsOf(timing),
					easing: easingOf(animation, timing),
				};
			};
			const bandAnimations = (band?.getAnimations() ?? []).map(describeSweep);
			const box = shimmer?.getBoundingClientRect();
			const stageBox = stage?.getBoundingClientRect();
			return {
				shimmer: shimmer != null,
				coversBox:
					box != null &&
					stageBox != null &&
					Math.abs(box.width - stageBox.width) <= 0.5 &&
					Math.abs(box.height - stageBox.height) <= 0.5,
				textOnScreen: stage?.textContent?.trim() ?? null,
				// The time the take still needs is in the card's head, beside the
				// kind (the owner's call of 17 Nov), never in the box.
				headTime:
					card
						?.querySelector('[data-testid="artifact-card-take-time"]')
						?.textContent?.trim() ?? null,
				spinners: card?.querySelectorAll(".image-card-spin").length ?? 0,
				progressBars:
					card?.querySelectorAll('[role="progressbar"]').length ?? 0,
				tint: shimmer ? getComputedStyle(shimmer).backgroundColor : null,
				bandVisibility: band ? getComputedStyle(band).visibility : null,
				bandAnimations,
				cardAnimationProperties: [
					...new Set(
						cssAnimations.flatMap((animation) => propertiesOf(animation)),
					),
				],
				status:
					card
						?.querySelector('[data-testid="image-card-status"]')
						?.textContent?.trim() ?? null,
				sameShimmerAsWaiting: shimmer?.dataset.probeSeenAtWaiting === "1",
			};
		},
		{ cardSelector: CARD, tag: options.tag === true },
	);
}

/**
 * The newest card's shimmer once that same card shows `state` (Task 11 fix
 * round 1): the gate and the read are on one card, and the read is polled
 * until the shimmer is there, so a lazily drawn body is not read half-made.
 */
async function shimmerWhen(
	page: Page,
	state: "waiting" | "making",
	options: { tag?: boolean } = {},
): Promise<ShimmerState> {
	await expect(
		page.locator(CARD).last().locator(BODY_STATE(state)),
	).toBeVisible({ timeout: 30_000 });
	let read: ShimmerState | null = null;
	await expect
		.poll(
			async () => {
				read = await shimmerState(page, options);
				return read.shimmer;
			},
			{ message: `${state}: the box shows the shimmer`, timeout: 10_000 },
		)
		.toBe(true);
	if (!read) throw new Error(`${state}: the shimmer was not read`);
	return read;
}

type ShimmerState = Awaited<ReturnType<typeof shimmerState>>;

/**
 * The head's words while a take waits: its place in the queue (either language).
 */
const WAITING_LINE =
	/^(?:Next up|\d+ ahead of this one|Következik|\d+ van előtte)$/;

/**
 * The head's words while a take is made: the countdown, or once it has run
 * past its time what it is still doing; never a clock counting up, never a
 * number below zero.
 */
const TIME_LINE =
	/^(?:About \d+ (?:s|min) left|Almost done…|Taking a little longer…|Még kb\. \d+ (?:mp|perc)|Mindjárt kész…|Kicsit tovább tart…)$/;

function holdShimmer(
	state: ShimmerState,
	label: "waiting" | "starting" | "making",
	reducedMotion: boolean,
): void {
	expect(state.shimmer, `${label}: the box shows the shimmer`).toBe(true);
	expect(state.coversBox, `${label}: the shimmer covers the whole box`).toBe(
		true,
	);
	// The box carries no words at all: its state is the sr-only status, and
	// the time is the head's, beside the kind.
	expect(state.textOnScreen, `${label}: no words in the box`).toBe("");
	expect(state.headTime, `${label}: the head says where the take is`).toMatch(
		label === "waiting" ? WAITING_LINE : TIME_LINE,
	);
	expect(state.spinners, `${label}: no spinner in the card`).toBe(0);
	expect(state.progressBars, `${label}: no progress bar`).toBe(0);
	expect(state.status, `${label}: the state is still read out`).not.toBe("");
	expect(
		state.cardAnimationProperties.filter(
			(property) => property !== "transform" && property !== "opacity",
		),
		`${label}: a card animation on something other than transform/opacity`,
	).toEqual([]);
	expect(state.tint, `${label}: the box is tinted`).not.toBe(
		"rgba(0, 0, 0, 0)",
	);
	if (reducedMotion) {
		expect(
			state.bandAnimations.filter(
				(animation) => animation.playState === "running",
			),
			`${label}: the shimmer moves under reduced motion`,
		).toEqual([]);
		expect(
			state.bandVisibility,
			`${label}: a band shows under reduced motion`,
		).toBe("hidden");
		return;
	}
	expect(state.bandAnimations, `${label}: one sweep`).toHaveLength(1);
	const [sweep] = state.bandAnimations;
	expect(sweep.properties, `${label}: the sweep animates`).toEqual([
		"transform",
	]);
	expect(sweep.playState).toBe("running");
	expect(sweep.iterations).toBe("infinite");
	expect(
		sweep.durationMs,
		`${label}: a slow, calm loop`,
	).toBeGreaterThanOrEqual(1600);
	expect(sweep.durationMs, `${label}: a slow, calm loop`).toBeLessThanOrEqual(
		2400,
	);
	expect(sweep.easing, `${label}: on the ease-out token`).toBe(
		"cubic-bezier(0.4, 0, 0.2, 1)",
	);
}

/** Lets the sweep run `loops` whole passes (for the video), read from the animation itself. */
async function letShimmerRun(page: Page, loops: number): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate((cardSelector) => {
					const cards = document.querySelectorAll(cardSelector);
					const band =
						cards[cards.length - 1]?.querySelector(".take-shimmer-band");
					const [sweep] = band?.getAnimations() ?? [];
					// Reduced motion: nothing runs, nothing to wait for.
					if (!sweep) return Number.POSITIVE_INFINITY;
					return sweep.effect?.getComputedTiming().currentIteration ?? 0;
				}, CARD),
			{ message: `the shimmer ran ${loops} passes`, timeout: 15_000 },
		)
		.toBeGreaterThanOrEqual(loops);
}

async function runArrival(flow: Flow, options: { loops?: number } = {}) {
	const { page, comfy } = flow;
	comfy.setOptions({ steps: 12, stepDelayMs: 400 });
	comfy.holdQueue(true);
	await newChat(flow);
	await startRecording(page, TRACK);
	mark(flow, "send");
	const delivery = await holdThinkingCardDelivery(page);
	await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
	await delivery.wait();
	await delivery.release();
	await expect(
		page.locator(CARD).last().locator(BODY_STATE("waiting")),
	).toBeVisible({
		timeout: 30_000,
	});
	mark(flow, "waiting");
	await expect
		.poll(async () => (await cardPlacement(page))?.fullyAboveComposer, {
			message: "the waiting card is on screen, whole, above the composer",
			timeout: 5_000,
		})
		.toBe(true);
	const placementAtWaiting = await cardPlacement(page);
	const shimmerAtWaiting = await shimmerWhen(page, "waiting", { tag: true });
	if (options.loops) await letShimmerRun(page, options.loops);
	comfy.holdQueue(false);
	await expect(
		page.locator(CARD).last().locator(BODY_STATE("making")),
	).toBeVisible({
		timeout: 30_000,
	});
	mark(flow, "making");
	const shimmerAtMaking = await shimmerWhen(page, "making");
	await expect(page.locator(TRACK.loaded)).toBeVisible({ timeout: 30_000 });
	mark(flow, "loaded");
	await expect(
		assistantAnswer(page).getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT, {
			exact: false,
		}),
	).toBeVisible({ timeout: 30_000 });
	await expectTerminalActivityGone(page);
	mark(flow, "final-text");
	const run = await stopRecording(page);
	return {
		...measureArrival(run),
		placementAtWaiting,
		shimmerAtWaiting,
		shimmerAtMaking,
	};
}

/**
 * How the thread scrolls while a late card arrives (final review B-I1): the
 * prose's top moves on screen only by scrolling (nothing above it changes in
 * that window), so its frame-to-frame steps are the scroll's. A follow that
 * lands in one frame is one step as large as the whole travel.
 */
function arrivalScroll(frames: MotionFrame[], from: number, to: number) {
	const window = frames.slice(Math.max(0, from), to);
	const tops = window
		.map((frame) => frame.tracked.prose)
		.filter((box): box is NonNullable<typeof box> => box != null);
	let largestStepPx = 0;
	let framesMoving = 0;
	for (let index = 1; index < tops.length; index++) {
		const step = Math.abs(tops[index].y - tops[index - 1].y);
		largestStepPx = Math.max(largestStepPx, step);
		if (step > 1) framesMoving += 1;
	}
	const travelPx =
		tops.length > 1 ? Math.abs((tops.at(-1)?.y ?? 0) - (tops[0]?.y ?? 0)) : 0;
	return {
		travelPx,
		largestStepPx,
		largestStepShare: travelPx > 0 ? largestStepPx / travelPx : 0,
		framesMoving,
		/** The lowest the prose's bottom edge got on screen (0 is the top of the window). */
		proseBottomMinPx: Math.min(...tops.map((box) => box.y + box.h)),
	};
}

function measureArrival(run: MotionRun) {
	const frames = run.frames;
	const arrival = firstSeen(frames, "card");
	expect(arrival, "the card arrived").toBeGreaterThan(0);
	const { end, proseMovedPx: proseMoved } = measureLiveActivity(
		frames,
		arrival,
	);
	const cardFrames = frames.slice(arrival, end);
	const arrivalT = frames[arrival].t;
	// Only independently observed canonical prose or terminal Stop removal ends
	// the live window. Rewrapping/growth and every preceding jump still count.
	const endT =
		end < frames.length ? frames[end - 1].t : Number.POSITIVE_INFINITY;
	const moments = ["waiting", "making", "ready", "loaded"]
		.map((name) => momentOf(run, name))
		.filter((moment): moment is number => moment !== null);
	const transitions = cardTransitions(run);
	return {
		arrivalMs: arrivalT,
		arrivalScroll: arrivalScroll(frames, arrival - 1, end),
		moments: Object.fromEntries(
			["waiting", "making", "ready", "loaded", "failed"].map((name) => [
				name,
				momentOf(run, name),
			]),
		),
		proseMovedPx: proseMoved,
		stageDrift: sizeDrift(cardFrames, "stage"),
		cardHeightDrift: sizeDrift(cardFrames, "card").h,
		clsWhileCardChanges: shiftsBetween(run, arrivalT + 1, endT),
		notTheCardShiftsWhileCardChanges: otherShiftsBetween(
			run,
			arrivalT + 1,
			endT,
		),
		toolRowWordShift: rowWordShifts(run),
		clsAll: run.shifts.reduce((sum, entry) => sum + entry.value, 0),
		shifts: run.shifts,
		longFramesAroundStateChanges: longFramesAround(run, moments),
		longFramesAll: run.longFrames,
		cardTransitionProperties: transitions.properties,
		nonCompositedCardTransitions: transitions.other,
	};
}

function holdArrival(metrics: ReturnType<typeof measureArrival>) {
	expect(
		metrics.proseMovedPx,
		"the live status above the card moved",
	).toBeLessThanOrEqual(1);
	expect(
		metrics.stageDrift.w,
		"the picture box changed width",
	).toBeLessThanOrEqual(0.5);
	expect(
		metrics.stageDrift.h,
		"the picture box changed height",
	).toBeLessThanOrEqual(0.5);
	expect(
		metrics.cardHeightDrift,
		"the card changed height",
	).toBeLessThanOrEqual(0.5);
	expect(
		metrics.clsWhileCardChanges,
		"layout shift while the card changed",
	).toBe(0);
	expect(
		metrics.longFramesAroundStateChanges,
		"a frame over 50 ms around a state change",
	).toEqual([]);
	expect(
		metrics.nonCompositedCardTransitions,
		"a transition other than transform/opacity in the card",
	).toEqual([]);
}

/** A picture the guards see as changed: the input with a block painted in its middle. */
async function changedPicture(
	source: Uint8Array | undefined,
	width: number,
	height: number,
): Promise<Uint8Array> {
	const base = source
		? sharp(source)
		: sharp({
				create: { width, height, channels: 3, background: "#4a7" },
			});
	const meta = await base.metadata();
	const w = meta.width ?? width;
	const h = meta.height ?? height;
	const block = await sharp({
		create: {
			width: Math.floor(w / 4),
			height: Math.floor(h / 4),
			channels: 3,
			background: "#1e3a8a",
		},
	})
		.png()
		.toBuffer();
	return base
		.composite([
			{
				input: block,
				left: Math.floor((w * 3) / 8),
				top: Math.floor((h * 3) / 8),
			},
		])
		.png()
		.toBuffer();
}

test.describe("the picture card moves like the Document's", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	const ARRIVALS = [
		{ name: "arrival-desktop-light", viewport: DESKTOP, colorScheme: "light" },
		{ name: "arrival-desktop-dark", viewport: DESKTOP, colorScheme: "dark" },
		{ name: "arrival-phone-light", viewport: PHONE, colorScheme: "light" },
		{ name: "arrival-phone-dark", viewport: PHONE, colorScheme: "dark" },
		{
			name: "arrival-desktop-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
		},
	] as const;

	for (const variant of ARRIVALS) {
		test(`${variant.name}: arrives under the streaming reply and changes state in place`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(150_000);
			const flow = await openFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{
					viewport: variant.viewport,
					colorScheme: variant.colorScheme,
					reducedMotion:
						"reducedMotion" in variant ? variant.reducedMotion : undefined,
				},
			);
			let metrics: Awaited<ReturnType<typeof runArrival>> | null = null;
			try {
				metrics = await runArrival(flow);
			} finally {
				await closeFlow(flow, variant.name, { metrics });
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			if (!metrics) throw new Error("the arrival was not measured");
			holdArrival(metrics);
			const reduced = "reducedMotion" in variant;
			holdShimmer(metrics.shimmerAtWaiting, "waiting", reduced);
			holdShimmer(metrics.shimmerAtMaking, "making", reduced);
			expect(
				metrics.shimmerAtMaking.sameShimmerAsWaiting,
				"the shimmer seen at waiting is the same node at making (no remount, no restarted sweep)",
			).toBe(true);
			// The follow to the card glides on the emphasis token (B-I1): no frame
			// carries most of the way. Under reduced motion it is one cut.
			const scroll = metrics.arrivalScroll;
			if (!("reducedMotion" in variant) && scroll.travelPx > 96) {
				expect(
					scroll.largestStepShare,
					`one frame moved the thread ${scroll.largestStepPx} of ${scroll.travelPx} px`,
				).toBeLessThanOrEqual(0.3);
				expect(scroll.framesMoving).toBeGreaterThanOrEqual(4);
			}
		});
	}

	// Task 11: the owner's shimmer, recorded for the owner (`t11-shimmer-*`). The
	// take waits two whole passes of the sweep before it is let through, so the
	// video shows the loop, then the picture crossfades in over the same box.
	const SHIMMERS = [
		{ name: "shimmer-desktop-light", viewport: DESKTOP, colorScheme: "light" },
		{ name: "shimmer-desktop-dark", viewport: DESKTOP, colorScheme: "dark" },
		{ name: "shimmer-phone", viewport: PHONE, colorScheme: "light" },
		{
			name: "shimmer-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
		},
	] as const;

	for (const variant of SHIMMERS) {
		test(`${variant.name}: the box shimmers calmly while the take waits and is made, then the picture fades in`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(150_000);
			const flow = await openFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{
					viewport: variant.viewport,
					colorScheme: variant.colorScheme,
					reducedMotion:
						"reducedMotion" in variant ? variant.reducedMotion : undefined,
				},
			);
			let metrics: Awaited<ReturnType<typeof runArrival>> | null = null;
			try {
				metrics = await runArrival(flow, { loops: 2 });
			} finally {
				await closeFlow(flow, variant.name, { metrics }, { prefix: "t11" });
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			if (!metrics) throw new Error("the arrival was not measured");
			holdArrival(metrics);
			const reduced = "reducedMotion" in variant;
			holdShimmer(metrics.shimmerAtWaiting, "waiting", reduced);
			holdShimmer(metrics.shimmerAtMaking, "making", reduced);
			expect(
				metrics.shimmerAtMaking.sameShimmerAsWaiting,
				"the shimmer seen at waiting is the same node at making (no remount, no restarted sweep)",
			).toBe(true);
		});
	}

	test("another-and-use-this: Another shows its tile at once, the take lands in place, Use this moves the tick", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(150_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
		);
		const { page, comfy } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			comfy.setOptions({ steps: 4, stepDelayMs: 200 });
			await newChat(flow);
			await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
			await expect(page.locator(TRACK.loaded)).toBeVisible({ timeout: 45_000 });
			await expect(
				assistantAnswer(page).getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });
			await expectTerminalActivityGone(page);

			comfy.setOptions({ steps: 12, stepDelayMs: 400 });
			await startRecording(page, {
				...TRACK,
				strip: '[data-testid="image-card-strip"]',
				placeholder: '[data-testid="image-card-tile-placeholder"]',
				use: '[data-testid="image-card-use"]',
			});
			mark(flow, "another");
			await page.getByTestId("image-card-another").click();
			await expect(
				page.getByTestId("image-card-tile-placeholder"),
			).toBeVisible();
			await expect(page.locator(BODY_STATE("making"))).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.getByTestId("image-card-use")).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.locator(TRACK.loaded)).toBeVisible();
			mark(flow, "landed");
			const another = await stopRecording(page);

			await startRecording(page, TRACK);
			mark(flow, "use");
			await page.getByTestId("image-card-use").click();
			const tiles = page.getByTestId("image-card-tile");
			await expect(tiles.nth(1).getByTestId("image-card-in-use")).toBeVisible({
				timeout: 15_000,
			});
			await expect(page.getByTestId("image-card-use")).toBeHidden();
			mark(flow, "used");
			const use = await stopRecording(page);

			const landing = [
				momentOf(another, "making"),
				momentOf(another, "use"),
			].filter((moment): moment is number => moment !== null);
			const stripAt = momentOf(another, "strip") ?? 0;
			metrics = {
				another: {
					placeholderAfterInputMs:
						(momentOf(another, "placeholder") ?? 0) - (another.inputAt ?? 0),
					stripAfterInputMs: stripAt - (another.inputAt ?? 0),
					clsNotFromInput: shiftsBetween(another, 0, Number.POSITIVE_INFINITY),
					stageDriftAfterStrip: sizeDrift(
						another.frames.slice(firstSeen(another.frames, "strip")),
						"stage",
					),
					longFramesAroundLanding: longFramesAround(another, landing),
					cardTransitions: cardTransitions(another),
				},
				use: {
					clsNotFromInput: shiftsBetween(use, 0, Number.POSITIVE_INFINITY),
					stageDrift: sizeDrift(use.frames, "stage"),
					longFrames: use.longFrames,
					cardTransitions: cardTransitions(use),
				},
			};
		} finally {
			await closeFlow(flow, "another-and-use-this", metrics);
		}
		expect(flow.errors, "the page logged an error").toEqual([]);
		const another = metrics.another as {
			placeholderAfterInputMs: number;
			clsNotFromInput: number;
			stageDriftAfterStrip: { w: number; h: number };
			longFramesAroundLanding: unknown[];
			cardTransitions: { other: unknown[] };
		};
		const use = metrics.use as {
			clsNotFromInput: number;
			stageDrift: { w: number; h: number };
			cardTransitions: { other: unknown[] };
		};
		// The tile is drawn in the frame after the press (well inside the 500 ms the
		// layout-shift API gives input), not when the server answers.
		expect(another.placeholderAfterInputMs).toBeLessThan(300);
		expect(another.clsNotFromInput).toBe(0);
		expect(another.stageDriftAfterStrip.h).toBeLessThanOrEqual(0.5);
		expect(another.longFramesAroundLanding).toEqual([]);
		expect(another.cardTransitions.other).toEqual([]);
		expect(use.clsNotFromInput).toBe(0);
		expect(metrics.use).toMatchObject({ longFrames: [] });
		expect(use.stageDrift.h).toBeLessThanOrEqual(0.5);
		expect(use.cardTransitions.other).toEqual([]);
	});

	test("before-after: a changed picture flips to its Before and back in place", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(150_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
		);
		const { page, comfy } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			comfy.setOptions({ steps: 4, stepDelayMs: 200 });
			const conversationId = await newChat(flow);
			await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
			await expect(
				assistantAnswer(page).getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
			await expectTerminalActivityGone(page);
			await expect
				.poll(
					async () => (await readCards(page, conversationId))[0]?.artifactId,
					{
						timeout: 20_000,
					},
				)
				.toBeTruthy();
			const [made] = await readCards(page, conversationId);
			await sendMessage(
				page,
				`${AI_SMOKE_CHANGE_PICTURE_MARKER} ${made.artifactId}`,
			);
			await expect(
				assistantAnswer(page).getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
			await expectTerminalActivityGone(page);
			const changed = page.locator(CARD).last();
			const before = changed.getByTestId("image-card-before");
			await expect(before).toBeVisible({ timeout: 20_000 });
			await expect(
				changed.locator('[data-testid="image-picture-after"].is-loaded'),
			).toBeVisible();

			// The recorder follows one element by selector: name the changed card's box.
			await changed
				.getByTestId("image-card-stage")
				.evaluate((stage) =>
					stage.setAttribute("data-motion-target", "changed"),
				);
			await startRecording(page, {
				stage: '[data-motion-target="changed"]',
			});
			// Before is fetched ahead of the first press (B-I3), so the press never
			// waits on a download with an empty box.
			await expect(
				changed.locator('[data-testid="image-picture-before"].is-loaded'),
			).toBeAttached();
			// After's own fade-in (is-loaded starts it) is over before the flips.
			await settle(page);
			// After stays fully shown under Before through both flips (B-I2): an
			// opaque pair never washes through the box's background.
			await page.evaluate(() => {
				const store = window as unknown as {
					__afterOpacity?: { min: number; frames: number; running: boolean };
				};
				const sample = { min: 1, frames: 0, running: true };
				store.__afterOpacity = sample;
				const tick = () => {
					if (!sample.running) return;
					const after = document.querySelector(
						'[data-motion-target="changed"] [data-testid="image-picture-after"]',
					);
					if (after) {
						sample.min = Math.min(
							sample.min,
							Number(getComputedStyle(after).opacity),
						);
						sample.frames += 1;
					}
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			mark(flow, "before");
			await before.click();
			await expect(
				changed.locator('[data-testid="image-picture-before"].is-loaded'),
			).toBeVisible();
			await expect(changed.getByTestId("image-picture")).toHaveAttribute(
				"data-showing",
				"before",
			);
			mark(flow, "after");
			await changed.getByTestId("image-card-after").click();
			await expect(changed.getByTestId("image-picture")).toHaveAttribute(
				"data-showing",
				"after",
			);
			await settle(page);
			const afterOpacity = await page.evaluate(() => {
				const store = window as unknown as {
					__afterOpacity?: { min: number; frames: number; running: boolean };
				};
				const sample = store.__afterOpacity;
				if (sample) sample.running = false;
				return sample ? { min: sample.min, frames: sample.frames } : null;
			});
			const run = await stopRecording(page);
			metrics = {
				afterOpacity,
				cls: shiftsBetween(run, 0, Number.POSITIVE_INFINITY),
				clsWithInput: run.shifts.reduce((sum, entry) => sum + entry.value, 0),
				shifts: run.shifts,
				stageDrift: sizeDrift(run.frames, "stage"),
				longFrames: run.longFrames,
				cardTransitions: cardTransitions(run),
			};
		} finally {
			await closeFlow(flow, "before-after", metrics);
		}
		expect(flow.errors, "the page logged an error").toEqual([]);
		const afterOpacity = metrics.afterOpacity as {
			min: number;
			frames: number;
		} | null;
		expect(afterOpacity?.frames ?? 0).toBeGreaterThan(10);
		expect(
			afterOpacity?.min,
			"After faded under Before: the flip washed through the background",
		).toBe(1);
		expect(metrics.cls).toBe(0);
		expect((metrics.stageDrift as { h: number }).h).toBeLessThanOrEqual(0.5);
		expect(metrics.longFrames).toEqual([]);
		expect((metrics.cardTransitions as { other: unknown[] }).other).toEqual([]);
	});

	test("checking-again: the server's automatic retry shows a quiet note over the take and swaps in place", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(150_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
		);
		const { page, comfy } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			comfy.setOptions({ steps: 4, stepDelayMs: 200 });
			const conversationId = await newChat(flow);
			await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
			await expect(
				assistantAnswer(page).getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
			await expectTerminalActivityGone(page);
			await expect
				.poll(
					async () => (await readCards(page, conversationId))[0]?.artifactId,
					{ timeout: 20_000 },
				)
				.toBeTruthy();
			const [made] = await readCards(page, conversationId);

			// The change's first take changes nothing (a clear miss the guards
			// measure), so the server makes its one automatic retry, which does
			// change the picture and wins.
			let renders = 0;
			comfy.setOptions({
				steps: 4,
				stepDelayMs: 200,
				render: async (input) => {
					renders += 1;
					const source = input.images[0];
					if (renders === 1 && source) return source;
					// The retry takes a while, so the note is on screen across polls.
					await new Promise((resolve) => setTimeout(resolve, 6_000));
					return changedPicture(source, input.width, input.height);
				},
			});
			await startRecording(page, {
				...TRACK,
				checking: '[data-testid="image-card-checking"]',
			});
			mark(flow, "send-change");
			await sendMessage(
				page,
				`${AI_SMOKE_CHANGE_PICTURE_MARKER} ${made.artifactId}`,
			);
			const changed = page.locator(CARD).last();
			await expect(changed.getByTestId("image-card-checking")).toBeVisible({
				timeout: 45_000,
			});
			mark(flow, "checking");
			await expect(changed.getByTestId("image-card-checking")).toBeHidden({
				timeout: 45_000,
			});
			await expect(
				changed.locator('[data-testid="image-picture-after"].is-loaded'),
			).toBeVisible();
			mark(flow, "swapped");
			const run = await stopRecording(page);
			const checkingAt = momentOf(run, "checking") ?? 0;
			const goneAt =
				run.frames.findLast((frame) => frame.tracked.checking != null)?.t ??
				checkingAt;
			metrics = {
				renders,
				checkingShownMs: goneAt - checkingAt,
				cardCls: shiftsBetween(run, checkingAt - 50, goneAt + 400),
				notTheCard: otherShiftsBetween(run, checkingAt - 50, goneAt + 400),
				longFramesAround: longFramesAround(run, [checkingAt, goneAt]),
				cardTransitions: cardTransitions(run),
			};
		} finally {
			comfy.setOptions({ render: undefined });
			await closeFlow(flow, "checking-again", metrics);
		}
		expect(flow.errors, "the page logged an error").toEqual([]);
		expect(metrics.renders).toBe(2);
		expect(metrics.cardCls).toBe(0);
		expect(metrics.longFramesAround).toEqual([]);
		expect((metrics.cardTransitions as { other: unknown[] }).other).toEqual([]);
	});

	test("failure-try-again: a failed take says so and Try again makes it in place", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(150_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
		);
		const { page, comfy } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			comfy.setOptions({ steps: 4, stepDelayMs: 200, fail: "execution" });
			await newChat(flow);
			await startRecording(page, TRACK);
			mark(flow, "send");
			await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
			await expect(page.locator(BODY_STATE("failed"))).toBeVisible({
				timeout: 45_000,
			});
			await expect(page.getByTestId("image-card-retry")).toBeVisible();
			const failing = await stopRecording(page);

			// The options merge: the failure is taken off by name.
			comfy.setOptions({ steps: 12, stepDelayMs: 400, fail: undefined });
			await startRecording(page, TRACK);
			mark(flow, "try-again");
			await page.getByTestId("image-card-retry").click();
			await expect(page.locator(BODY_STATE("making"))).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.locator(TRACK.loaded)).toBeVisible({ timeout: 30_000 });
			mark(flow, "loaded");
			const retry = await stopRecording(page);
			const moments = ["making", "ready", "loaded"]
				.map((name) => momentOf(retry, name))
				.filter((moment): moment is number => moment !== null);
			const failedAt = momentOf(failing, "failed") ?? 0;
			metrics = {
				failing: {
					clsNotFromInput: shiftsBetween(
						failing,
						(momentOf(failing, "card") ?? 0) + 1,
						Number.POSITIVE_INFINITY,
					),
					longFramesAroundFailure: longFramesAround(failing, [failedAt]),
					stageDrift: sizeDrift(
						failing.frames.slice(firstSeen(failing.frames, "card")),
						"stage",
					),
					cardTransitions: cardTransitions(failing),
				},
				retry: {
					clsNotFromInput: shiftsBetween(retry, 0, Number.POSITIVE_INFINITY),
					stageDrift: sizeDrift(retry.frames, "stage"),
					cardHeightDrift: sizeDrift(retry.frames, "card").h,
					longFramesAroundStateChanges: longFramesAround(retry, moments),
					cardTransitions: cardTransitions(retry),
				},
			};
		} finally {
			await closeFlow(flow, "failure-try-again", metrics);
		}
		expect(flow.errors, "the page logged an error").toEqual([]);
		expect(metrics.failing).toMatchObject({
			clsNotFromInput: 0,
			longFramesAroundFailure: [],
			stageDrift: { w: 0, h: 0 },
		});
		const retry = metrics.retry as {
			clsNotFromInput: number;
			stageDrift: { h: number };
			cardHeightDrift: number;
			longFramesAroundStateChanges: unknown[];
			cardTransitions: { other: unknown[] };
		};
		expect(retry.clsNotFromInput).toBe(0);
		expect(retry.stageDrift.h).toBeLessThanOrEqual(0.5);
		expect(retry.cardHeightDrift).toBeLessThanOrEqual(0.5);
		expect(retry.longFramesAroundStateChanges).toEqual([]);
		expect(retry.cardTransitions.other).toEqual([]);
	});

	// The Document's late card on desktop and on a phone: on a phone, what moves
	// outside the card when an item is made (the header's item count row) is
	// recorded the same way as for the picture card (review I5).
	for (const variant of [
		{ name: "document-arrival", viewport: DESKTOP },
		{ name: "document-arrival-phone", viewport: PHONE },
	] as const) {
		test(`${variant.name}: the Document's late card, recorded the same way for the side-by-side`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(150_000);
			const flow = await openFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{ viewport: variant.viewport },
			);
			const { page } = flow;
			let metrics: Record<string, unknown> = {};
			try {
				await newChat(flow);
				await startRecording(page, {
					card: CARD,
					prose: PROSE,
					answer: '[data-testid="assistant-message"] .prose-container p',
					stop: '[data-testid="stop-button"]',
					user: '[data-testid="user-message"]',
				});
				mark(flow, "send");
				const delivery = await holdThinkingCardDelivery(page);
				await sendMessage(page, AI_SMOKE_LATE_CARD_HELD_MARKER);
				await delivery.wait();
				await delivery.release();
				await expect(page.locator(CARD)).toBeVisible({ timeout: 30_000 });
				mark(flow, "card");
				// The browser may consume tool and final frames together after the
				// delivery gate. Hold synthesis until actual live card frames exist.
				await expect
					.poll(
						() =>
							fakeProvider
								.requests()
								.filter((request) => request.path === "/v1/chat/completions")
								.length,
					)
					.toBe(2);
				const heldLiveSamples = await delivery.sampleLiveCard(CARD);
				fakeProvider.release(AI_SMOKE_LATE_CARD_HOLD);
				await expect(
					assistantAnswer(page).getByText("Elkészült a dokumentum"),
				).toBeVisible({
					timeout: 30_000,
				});
				await expectTerminalActivityGone(page);
				mark(flow, "final-text");
				const run = await stopRecording(page);
				const frames = run.frames;
				const arrival = firstSeen(frames, "card");
				expect(
					arrival,
					"the Document card arrived after live status",
				).toBeGreaterThan(0);
				const { end, proseMovedPx } = measureLiveActivity(frames, arrival);
				metrics = {
					heldLiveSamples,
					arrivalMs: frames[arrival]?.t ?? null,
					arrivalScroll: arrivalScroll(frames, arrival - 1, end),
					proseMovedPx,
					cardHeightFirstFrame: frames[arrival]?.tracked.card?.h ?? null,
					cardHeightSettled: boxes(frames, "card").at(-1)?.h ?? null,
					clsAll: run.shifts.reduce((sum, entry) => sum + entry.value, 0),
					notTheCardShiftsAfterArrival: otherShiftsBetween(
						run,
						frames[arrival]?.t ?? 0,
						Number.POSITIVE_INFINITY,
					),
					toolRowWordShift: rowWordShifts(run),
					shifts: run.shifts,
					longFramesAll: run.longFrames,
					cardTransitionProperties: cardTransitions(run).properties,
				};
			} finally {
				fakeProvider.release(AI_SMOKE_LATE_CARD_HOLD);
				await closeFlow(flow, variant.name, metrics);
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			expect(metrics.proseMovedPx).toBeLessThanOrEqual(1);
		});
	}
});
