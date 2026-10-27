import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import sharp from "sharp";
import {
	AI_SMOKE_LATE_CARD_FINAL_TEXT,
	AI_SMOKE_LATE_CARD_MARKER,
} from "../fixtures/ai/late-card-scenario";
import {
	AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT,
	AI_SMOKE_CHANGE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
} from "../fixtures/ai/late-picture-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
	createEmptyConversation,
	login,
	sendMessage,
	waitForMotionToSettle,
} from "./helpers";
import {
	type FakeComfyUi,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
} from "./images-helpers";
import {
	installMotionRecorder,
	type MotionFrame,
	type MotionRun,
	profile,
	shiftSum,
	startRecording,
	stopRecording,
	type TrackedBox,
} from "./panel-motion-helpers";

/**
 * The picture card's motion check (plan 2b T2, MOTION-PARITY "By measurement").
 *
 * Each flow runs the way a reader does it (type, press Send, press the card's
 * buttons) against the fake chat model and the fake ComfyUI, in a context that
 * records a video. While it runs, the shared recorder (panel-motion-helpers.ts)
 * samples the card every frame and collects layout shifts, long animation frames
 * and the CSS transitions that ran. What is held:
 *
 * - the prose above a card never moves when the card arrives (F16);
 * - the picture box keeps the size it was reserved at, from the card's first
 *   frame through waiting, making, the picture loading and its fade-in;
 * - no layout shift that was not caused by input while the card changes state;
 * - no frame longer than 50 ms around a state change;
 * - only transform and opacity transition in the card.
 *
 * Videos, their numbers and a contact sheet per video go to the handoff folder:
 * the controller and the owner look at them. Nothing here waits on a clock: every
 * wait is on a state the page shows.
 */

const OUT_DIR = "/home/lvt53/alfyai-handoff/checks/videos";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';
const STAGE = '[data-testid="image-card-stage"]';
const PROSE = '[data-testid="assistant-message"] .prose-container';
const BODY_STATE = (state: string) =>
	`[data-testid="image-card-body"][data-state="${state}"]`;

/** The card's own pieces, for the transition probe. */
const CARD_PARTS = /^(image-card|image-picture|artifact-card|tool-activity)/;

const fakeProvider = createOpenAICompatibleProviderHarness();

type Flow = {
	context: BrowserContext;
	page: Page;
	startedAt: number;
	marks: Record<string, number>;
	/** What the page logged as an error: saved with the numbers. */
	errors: string[];
	providerId: string;
	previousModel: string | null;
	comfy: FakeComfyUi;
};

async function openFlow(
	browser: Browser,
	baseURL: string,
	options: {
		viewport: { width: number; height: number };
		colorScheme?: "light" | "dark";
		reducedMotion?: "reduce" | "no-preference";
	},
): Promise<Flow> {
	const context = await browser.newContext({
		baseURL,
		viewport: options.viewport,
		colorScheme: options.colorScheme ?? "light",
		reducedMotion: options.reducedMotion ?? "no-preference",
		hasTouch: options.viewport.width < 500,
		isMobile: options.viewport.width < 500,
		recordVideo: { dir: join(OUT_DIR, ".raw"), size: options.viewport },
	});
	const page = await context.newPage();
	const startedAt = Date.now();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await installMotionRecorder(page);
	await login(page);
	const previousModel = await snapshotUserModelPreference(page);
	const provider = await createTemporaryFakeProviderModel(
		page,
		fakeProvider.baseURL,
	);
	await updateUserModelPreference(page, provider.selectedModel);
	const comfy = await startFakeComfyUiForSpec(page);
	return {
		context,
		page,
		startedAt,
		marks: {},
		errors,
		providerId: provider.providerId,
		previousModel,
		comfy,
	};
}

/** Saves the video, its numbers and its contact sheets, and puts the settings back. */
async function closeFlow(
	flow: Flow,
	name: string,
	metrics: Record<string, unknown>,
	options: {
		/** The task the files are named for: `t2-<name>.webm`, `t3-<name>.webm`. */
		prefix?: string;
		/** Marks (from `flow.marks`) that each get sheets of their own, 4 s from the mark. */
		segments?: string[];
	} = {},
): Promise<void> {
	const prefix = options.prefix ?? "t2";
	const { page, context } = flow;
	await updateUserModelPreference(page, flow.previousModel);
	await deleteTemporaryProvider(page, flow.providerId);
	await stopFakeComfyUiForSpec(page, flow.comfy);
	const video = page.video();
	await context.close();
	mkdirSync(OUT_DIR, { recursive: true });
	const videoPath = join(OUT_DIR, `${prefix}-${name}.webm`);
	if (video) await video.saveAs(videoPath);
	writeFileSync(
		join(OUT_DIR, `${prefix}-${name}.json`),
		`${JSON.stringify({ name, marks: flow.marks, pageErrors: flow.errors, ...metrics }, null, 2)}\n`,
	);
	if (!video) return;
	if (options.segments) {
		for (const segment of options.segments) {
			const at = flow.marks[segment];
			if (at === undefined) continue;
			execFileSync(
				"ffmpeg",
				[
					"-y",
					"-loglevel",
					"error",
					"-ss",
					Math.max(0, at / 1000 - 0.3).toFixed(2),
					"-t",
					"4",
					"-i",
					videoPath,
					"-vf",
					"fps=12,scale=480:-1,tile=6x4",
					join(OUT_DIR, `${prefix}-${name}-${segment}-sheet-%02d.png`),
				],
				{ stdio: "inherit" },
			);
		}
		return;
	}
	// The brief's sheet (fps 12, 6x4 tiles: two seconds a sheet), from the
	// interaction's first mark, so the sheets show the motion and not the login.
	const marks = Object.values(flow.marks);
	const from = marks.length > 0 ? Math.min(...marks) / 1000 : 0;
	execFileSync(
		"ffmpeg",
		[
			"-y",
			"-loglevel",
			"error",
			"-ss",
			Math.max(0, from - 0.3).toFixed(2),
			"-i",
			videoPath,
			"-vf",
			"fps=12,scale=480:-1,tile=6x4",
			join(OUT_DIR, `${prefix}-${name}-sheet-%02d.png`),
		],
		{ stdio: "inherit" },
	);
}

function mark(flow: Flow, label: string): void {
	flow.marks[label] = Date.now() - flow.startedAt;
}

async function newChat(flow: Flow): Promise<string> {
	const conversationId = await createEmptyConversation(flow.page);
	await flow.page.goto(`/chat/${conversationId}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(flow.page.getByTestId("message-input")).toBeVisible();
	return conversationId;
}

/** The first frame (index) a tracked element is on screen, or -1. */
function firstSeen(frames: MotionFrame[], name: string): number {
	return frames.findIndex((frame) => frame.tracked[name] != null);
}

function boxes(frames: MotionFrame[], name: string): TrackedBox[] {
	return frames
		.map((frame) => frame.tracked[name])
		.filter((box): box is TrackedBox => box != null);
}

/** How far a tracked box's size wandered from its first frame, in px. */
function sizeDrift(frames: MotionFrame[], name: string) {
	const seen = boxes(frames, name);
	if (seen.length === 0) return { w: 0, h: 0, frames: 0 };
	const [first] = seen;
	return {
		w: Math.max(...seen.map((box) => Math.abs(box.w - first.w))),
		h: Math.max(...seen.map((box) => Math.abs(box.h - first.h))),
		frames: seen.length,
	};
}

/**
 * A layout shift is the card's when what moved is the card or a piece of it. What
 * else moves while a card works is reported, not held: the tool row's own words
 * when its call ends ("Making a picture X" -> "Made X", as a Document's "Creating"
 * -> "Created"), and on a phone the whole thread when the header's item count
 * appears for the new Image (the family's header, the same for a Document).
 */
const CARD_SOURCES =
	/^(image-card|image-picture|artifact-card|tool-activity-standalone-card)/;
const isCardShift = (entry: MotionRun["shifts"][number]) =>
	(entry.sources ?? []).some((source) => CARD_SOURCES.test(source));
const rowOnly = (entry: MotionRun["shifts"][number]) =>
	(entry.sources ?? []).length > 0 &&
	(entry.sources ?? []).every((source) => source === "tool-activity-row");

/** The card's own layout shifts in [from, to) ms, without the ones input caused (500 ms window). */
function shiftsBetween(run: MotionRun, from: number, to: number) {
	return run.shifts
		.filter(
			(entry) =>
				entry.t >= from &&
				entry.t < to &&
				!entry.hadRecentInput &&
				(isCardShift(entry) || (entry.sources ?? []).length === 0),
		)
		.reduce((sum, entry) => sum + entry.value, 0);
}

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

/** Long animation frames within `margin` ms of any of the given moments. */
function longFramesAround(run: MotionRun, moments: number[], margin = 400) {
	return run.longFrames.filter((frame) =>
		moments.some(
			(moment) =>
				frame.t + frame.duration >= moment - margin &&
				frame.t <= moment + margin,
		),
	);
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

/** The time (ms since recording) of the first frame a state is on screen. */
function momentOf(run: MotionRun, name: string): number | null {
	const index = firstSeen(run.frames, name);
	return index < 0 ? null : run.frames[index].t;
}

const TRACK = {
	card: CARD,
	stage: STAGE,
	prose: PROSE,
	waiting: BODY_STATE("waiting"),
	making: BODY_STATE("making"),
	ready: BODY_STATE("ready"),
	failed: BODY_STATE("failed"),
	loaded: `${STAGE} [data-testid="image-picture-after"].is-loaded`,
	deliverables: '[data-testid="message-deliverables"]',
	row: '[data-testid="message-deliverables"] [data-testid="tool-activity-row"]',
	bubble: '[data-testid="assistant-message"]',
	user: '[data-testid="user-message"]',
};

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

async function runArrival(flow: Flow) {
	const { page, comfy } = flow;
	comfy.setOptions({ steps: 12, stepDelayMs: 400 });
	comfy.holdQueue(true);
	await newChat(flow);
	await startRecording(page, TRACK);
	mark(flow, "send");
	await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
	await expect(page.locator(BODY_STATE("waiting"))).toBeVisible({
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
	comfy.holdQueue(false);
	await expect(page.locator(BODY_STATE("making"))).toBeVisible({
		timeout: 30_000,
	});
	mark(flow, "making");
	await expect(page.locator(TRACK.loaded)).toBeVisible({ timeout: 30_000 });
	mark(flow, "loaded");
	await expect(
		page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT, { exact: false }),
	).toBeVisible({ timeout: 30_000 });
	mark(flow, "final-text");
	const run = await stopRecording(page);
	return { ...measureArrival(run), placementAtWaiting };
}

function measureArrival(run: MotionRun) {
	const frames = run.frames;
	const arrival = firstSeen(frames, "card");
	expect(arrival, "the card arrived").toBeGreaterThan(0);
	const before = frames[arrival - 1].tracked.prose;
	const proseHeight = before?.h ?? 0;
	// The closing sentence is the first thing that grows the prose after the card.
	const grew = frames.findIndex(
		(frame, index) =>
			index > arrival &&
			frame.tracked.prose != null &&
			frame.tracked.prose.h > proseHeight + 1,
	);
	const end = grew < 0 ? frames.length : grew;
	const cardFrames = frames.slice(arrival, end);
	// Where the prose sits in the thread: against the reader's own message above
	// it, which scrolls with it. A phone's thread follows the bottom while a reply
	// streams, so a position on screen would count that scroll as a move.
	const offset = (frame: MotionFrame) =>
		frame.tracked.prose && frame.tracked.user
			? frame.tracked.prose.y - frame.tracked.user.y
			: null;
	const startOffset = offset(frames[arrival - 1]) ?? 0;
	const proseMoved = Math.max(
		0,
		...frames.slice(arrival).map((frame) => {
			const now = offset(frame);
			return now === null ? 0 : Math.abs(now - startOffset);
		}),
	);
	const arrivalT = frames[arrival].t;
	// A layout-shift entry is stamped a little before the frame that shows it: the
	// closing sentence's shift belongs to the frame the prose grew in, so the card's
	// window ends at the last frame before it.
	const endT =
		end < frames.length ? frames[end - 1].t : Number.POSITIVE_INFINITY;
	const moments = ["waiting", "making", "ready", "loaded"]
		.map((name) => momentOf(run, name))
		.filter((moment): moment is number => moment !== null);
	const transitions = cardTransitions(run);
	return {
		arrivalMs: arrivalT,
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
		"the prose above the card moved",
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

/** What `GET /api/conversations/[id]` says about its picture cards. */
async function readCards(page: Page, conversationId: string) {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	expect(response.ok()).toBe(true);
	return (
		(await response.json()) as {
			imageCards: Array<{ id: string; artifactId: string | null }>;
		}
	).imageCards;
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
			let metrics: ReturnType<typeof measureArrival> | null = null;
			try {
				metrics = await runArrival(flow);
			} finally {
				await closeFlow(flow, variant.name, { metrics });
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			if (!metrics) throw new Error("the arrival was not measured");
			holdArrival(metrics);
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
				page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });

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
				page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
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
				page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
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
			const run = await stopRecording(page);
			metrics = {
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
				page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
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
					user: '[data-testid="user-message"]',
				});
				mark(flow, "send");
				await sendMessage(page, AI_SMOKE_LATE_CARD_MARKER);
				await expect(page.locator(CARD)).toBeVisible({ timeout: 30_000 });
				mark(flow, "card");
				await expect(page.getByText("Elkészült a dokumentum")).toBeVisible({
					timeout: 30_000,
				});
				mark(flow, "final-text");
				const run = await stopRecording(page);
				const frames = run.frames;
				const arrival = firstSeen(frames, "card");
				const offsetOf = (frame: MotionFrame | undefined) =>
					frame?.tracked.prose && frame.tracked.user
						? frame.tracked.prose.y - frame.tracked.user.y
						: null;
				const proseTop = offsetOf(frames[arrival - 1]) ?? 0;
				metrics = {
					arrivalMs: frames[arrival]?.t ?? null,
					proseMovedPx: Math.max(
						0,
						...frames.slice(arrival).map((frame) => {
							const now = offsetOf(frame);
							return now === null ? 0 : Math.abs(now - proseTop);
						}),
					),
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
				await closeFlow(flow, variant.name, metrics);
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			expect(metrics.proseMovedPx).toBeLessThanOrEqual(1);
		});
	}
});

// ---------------------------------------------------------------------------
// Plan 2b T3: the picture in the panel (MOTION-PARITY, F19, F23, F24).
//
// The Image opens in the family's panel, `DocumentWorkspace`, as a body; the
// open, dock, expand and phone sheet are the shell's. What is held here: the
// chat and the panel move on the same curve as for the Document (measured in
// the same run, side by side), the picture's box never re-flows while the dock
// opens (F24), Before / After and a strip frame move nothing, pinch-zoom moves
// only `transform` on a phone and keeps the sheet open, and a version that lands
// while the panel is open swaps the picture in place (F23).
// ---------------------------------------------------------------------------

const PANEL_FRAME = '[data-testid="image-body-frame"]';
const PANEL_LOADED =
	'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded';
const DOC_BODY = ".workspace-stage .ProseMirror";
const MOBILE_SHELL = '[data-testid="document-workspace-mobile-shell"]';
const PANEL_TRACK = {
	frame: PANEL_FRAME,
	loaded: PANEL_LOADED,
	docBody: DOC_BODY,
	mobileShell: MOBILE_SHELL,
	strip: '[data-testid="image-version-strip"]',
	toolbar: ".image-body-toolbar",
};

/** What the panel's motion is made of, one kind's run: the chat, the panel, the curve, what else moved. */
function measurePanel(run: MotionRun) {
	const chat = profile(run.frames, "chatW");
	const panel = profile(run.frames, "panelW");
	const shell = boxes(run.frames, "mobileShell");
	const shellFirst = firstSeen(run.frames, "mobileShell");
	const frameFrom = firstSeen(run.frames, "frame");
	const end = Math.max(chat.settledAt, panel.settledAt, run.inputAt ?? 0) + 120;
	const real = run.transitions.filter((entry) => entry.duration >= 1);
	return {
		chat: {
			travel: chat.total,
			maxStepFraction: chat.maxStepFraction,
			between: chat.between,
			movedAt: chat.movedAt,
			settledAt: chat.settledAt,
			durationMs: chat.movedAt < 0 ? 0 : chat.settledAt - chat.movedAt,
		},
		panel: {
			travel: panel.total,
			maxStepFraction: panel.maxStepFraction,
			between: panel.between,
			durationMs: panel.movedAt < 0 ? 0 : panel.settledAt - panel.movedAt,
		},
		phoneSheet:
			shellFirst < 0
				? null
				: {
						firstSeenMs: run.frames[shellFirst].t - (run.inputAt ?? 0),
						opacityFrames: shell.map((box) => Number(box.opacity.toFixed(3))),
						transforms: [...new Set(shell.map((box) => box.transform))],
					},
		frameDrift:
			frameFrom < 0 ? null : sizeDrift(run.frames.slice(frameFrom), "frame"),
		frameFirstSeenMs:
			frameFrom < 0 ? null : run.frames[frameFrom].t - (run.inputAt ?? 0),
		pictureLoadedMs: (() => {
			const at = momentOf(run, "loaded");
			return at === null ? null : at - (run.inputAt ?? 0);
		})(),
		cls: shiftSum(run),
		clsNoInput: shiftSum(run, { ignoreRecentInput: true }),
		shifts: run.shifts,
		longFramesInMotion: run.longFrames.filter(
			(frame) =>
				frame.t + frame.duration >= (run.inputAt ?? 0) && frame.t <= end,
		),
		longFramesAll: run.longFrames,
		transitions: [
			...new Map(
				real.map((entry) => [
					`${entry.property}|${entry.target}`,
					{
						property: entry.property,
						target: entry.target,
						duration: entry.duration,
						easing: entry.easing,
					},
				]),
			).values(),
		],
		animations: run.animations.map((entry) => ({
			target: entry.target,
			properties: entry.properties,
			duration: entry.duration,
			easing: entry.easing,
		})),
	};
}

type PanelMetrics = ReturnType<typeof measurePanel>;

/**
 * What belongs to the picture, by the recorder's target names. The shell's own
 * motion (the column's width, the content's fade) is compared with the
 * Document's instead; the chat's hover and focus colours (a card, the composer,
 * the count button) are the chat's, the same for both kinds.
 */
const PICTURE_PART = /^(image-body|image-picture|image-version)/;

/** A picture piece that animates anything but transform and opacity (MOTION-PARITY 3). */
function unsafePictureTransitions(metrics: PanelMetrics) {
	return metrics.transitions.filter(
		(entry) =>
			PICTURE_PART.test(entry.target) &&
			entry.property !== "opacity" &&
			entry.property !== "transform",
	);
}

/** The Image's numbers against the Document's, the same interaction: same curve, same timing. */
function compareKinds(image: PanelMetrics, document: PanelMetrics) {
	// The shell's own motion: what moves the column and what fades its content in.
	const curves = (metrics: PanelMetrics) =>
		[
			...metrics.transitions
				.filter((entry) => /^workspace/.test(entry.target))
				.map(
					(entry) =>
						`${entry.target} ${entry.property} ${Math.round(entry.duration)}ms ${entry.easing}`,
				),
			...metrics.animations
				.filter((entry) => /^workspace/.test(entry.target))
				.map(
					(entry) =>
						`${entry.target} ${entry.properties.join("+")} ${Math.round(entry.duration)}ms ${entry.easing}`,
				),
		].sort();
	return {
		chatDurationDeltaMs: image.chat.durationMs - document.chat.durationMs,
		panelDurationDeltaMs: image.panel.durationMs - document.panel.durationMs,
		imageCurves: [...new Set(curves(image))],
		documentCurves: [...new Set(curves(document))],
	};
}

/** Makes a picture through the chat (fake model, fake ComfyUI's gradient) and returns its item. */
async function makePicture(flow: Flow) {
	const { page, comfy } = flow;
	comfy.setOptions({ steps: 3, stepDelayMs: 150 });
	const conversationId = await newChat(flow);
	await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
	await expect(page.locator(TRACK.loaded).last()).toBeVisible({
		timeout: 45_000,
	});
	await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
	await expect
		.poll(async () => (await readCards(page, conversationId))[0]?.artifactId, {
			timeout: 20_000,
		})
		.toBeTruthy();
	const [card] = await readCards(page, conversationId);
	return { conversationId, artifactId: card.artifactId as string };
}

/** Asks Alfy to change the picture, and waits for the change's card to show its picture. */
async function changePicture(flow: Flow, artifactId: string) {
	const { page } = flow;
	const before = await page
		.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT)
		.count();
	await sendMessage(page, `${AI_SMOKE_CHANGE_PICTURE_MARKER} ${artifactId}`);
	await expect(page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT)).toHaveCount(
		before + 1,
		{ timeout: 45_000 },
	);
}

/** Makes a Document through the chat's late card, the side-by-side's other kind. */
async function makeDocument(flow: Flow) {
	await newChat(flow);
	await sendMessage(flow.page, AI_SMOKE_LATE_CARD_MARKER);
	await expect(flow.page.locator(CARD)).toBeVisible({ timeout: 30_000 });
	await expect(
		flow.page.getByText(AI_SMOKE_LATE_CARD_FINAL_TEXT, { exact: false }),
	).toBeVisible({ timeout: 30_000 });
}

async function settle(page: Page) {
	await page.waitForTimeout(150);
	await waitForMotionToSettle(page);
	await page.waitForTimeout(200);
}

const isPhoneFlow = (flow: Flow) =>
	(flow.page.viewportSize()?.width ?? 1440) < 768;

/** The open panel, whichever surface shows it. */
function shellOf(flow: Flow) {
	return isPhoneFlow(flow)
		? flow.page.locator(MOBILE_SHELL)
		: flow.page.locator("aside.workspace-shell-desktop");
}

/** Opens the newest card's item from its head, recording, and waits for its body to be drawn. */
async function openFromCard(flow: Flow, kind: "image" | "document") {
	const { page } = flow;
	await settle(page);
	await startRecording(page, PANEL_TRACK);
	mark(flow, `open-${kind}`);
	await page.locator(CARD).last().getByTestId("artifact-card-head").click();
	await expect(shellOf(flow)).toBeVisible();
	await expect(
		page
			.locator(kind === "image" ? PANEL_LOADED : `${DOC_BODY}:visible`)
			.first(),
	).toBeVisible({ timeout: 20_000 });
	await settle(page);
	return measurePanel(await stopRecording(page));
}

async function closePanel(flow: Flow, kind: "image" | "document") {
	const { page } = flow;
	await startRecording(page, PANEL_TRACK);
	mark(flow, `close-${kind}`);
	await page.locator(".workspace-close-button:visible").first().click();
	await expect(shellOf(flow)).toHaveCount(0);
	await settle(page);
	return measurePanel(await stopRecording(page));
}

/** The bars the Document's own panel spec holds, held for whichever kind opened. */
function holdOpen(metrics: PanelMetrics, phone: boolean, reduced: boolean) {
	expect(
		metrics.longFramesInMotion,
		"a frame over 50 ms while the panel moved",
	).toEqual([]);
	expect(
		unsafePictureTransitions(metrics),
		"the picture animated something other than transform/opacity",
	).toEqual([]);
	if (phone || reduced) return;
	expect(metrics.chat.travel, "the chat did not make room").toBeGreaterThan(
		300,
	);
	expect(
		metrics.chat.maxStepFraction,
		"the chat went to its width in one frame",
	).toBeLessThan(0.5);
	expect(
		metrics.chat.between,
		"the chat was never seen on its way",
	).toBeGreaterThanOrEqual(4);
}

function holdClose(metrics: PanelMetrics, phone: boolean, reduced: boolean) {
	expect(
		metrics.longFramesInMotion,
		"a frame over 50 ms while the panel moved",
	).toEqual([]);
	expect(unsafePictureTransitions(metrics)).toEqual([]);
	if (phone || reduced) return;
	expect(metrics.chat.travel).toBeGreaterThan(300);
	expect(metrics.chat.maxStepFraction).toBeLessThan(0.5);
	expect(metrics.chat.between).toBeGreaterThanOrEqual(3);
}

/**
 * The Image against the Document, the same open and close: the Document holds its
 * own bars, the Image adds no shift it does not have, takes the same time (one
 * sampler frame either way, where the column moves) and runs the shell on the
 * same curves, on every surface.
 */
function holdSideBySide(
	image: { open: PanelMetrics; close: PanelMetrics },
	document: { open: PanelMetrics; close: PanelMetrics },
	noColumn: boolean,
) {
	holdOpen(document.open, noColumn, noColumn);
	holdClose(document.close, noColumn, noColumn);
	expect(image.open.clsNoInput).toBeLessThanOrEqual(
		Math.max(0.01, document.open.clsNoInput + 0.005),
	);
	for (const step of ["open", "close"] as const) {
		if (!noColumn) {
			expect(
				Math.abs(image[step].chat.durationMs - document[step].chat.durationMs),
				`${step}: the picture's panel took another time`,
			).toBeLessThanOrEqual(34);
		}
		// The shell's own curves (the column's width, the content's fade).
		const side = compareKinds(image[step], document[step]);
		expect(
			side.imageCurves,
			`${step}: the panel ran on another curve for the picture`,
		).toEqual(side.documentCurves);
	}
}

test.describe("the picture in the panel moves like the Document's (T3)", () => {
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

	const OPENS = [
		{
			name: "open-close-desktop-light",
			viewport: DESKTOP,
			colorScheme: "light",
			document: true,
		},
		{
			name: "open-close-desktop-dark",
			viewport: DESKTOP,
			colorScheme: "dark",
			document: false,
		},
		{
			name: "open-close-phone-light",
			viewport: PHONE,
			colorScheme: "light",
			document: true,
		},
		{
			name: "open-close-phone-dark",
			viewport: PHONE,
			colorScheme: "dark",
			document: false,
		},
		{
			name: "open-close-desktop-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
			document: true,
		},
	] as const;

	for (const variant of OPENS) {
		test(`${variant.name}: the picture opens from its card into the panel and closes on the Document's curve`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const reduced = "reducedMotion" in variant;
			const options = {
				viewport: variant.viewport,
				colorScheme: variant.colorScheme,
				reducedMotion: reduced ? ("reduce" as const) : undefined,
			};
			const phone = variant.viewport.width < 768;
			const results: Record<string, PanelMetrics> = {};

			// The Document first, recorded the same way: the side-by-side's reference.
			if (variant.document) {
				const docFlow = await openFlow(
					browser,
					testInfo.project.use.baseURL as string,
					options,
				);
				try {
					await makeDocument(docFlow);
					results.documentOpen = await openFromCard(docFlow, "document");
					await docFlow.page.waitForTimeout(300);
					results.documentClose = await closePanel(docFlow, "document");
				} finally {
					await closeFlow(docFlow, `document-${variant.name}`, results, {
						prefix: "t3",
						segments: ["open-document", "close-document"],
					});
				}
				expect(docFlow.errors, "the page logged an error").toEqual([]);
			}

			const flow = await openFlow(
				browser,
				testInfo.project.use.baseURL as string,
				options,
			);
			let metrics: Record<string, unknown> = {};
			try {
				await makePicture(flow);
				results.imageOpen = await openFromCard(flow, "image");
				await flow.page.waitForTimeout(300);
				results.imageClose = await closePanel(flow, "image");
				metrics = {
					imageOpen: results.imageOpen,
					imageClose: results.imageClose,
					...(results.documentOpen
						? {
								openSideBySide: compareKinds(
									results.imageOpen,
									results.documentOpen,
								),
								closeSideBySide: compareKinds(
									results.imageClose,
									results.documentClose,
								),
							}
						: {}),
				};
			} finally {
				await closeFlow(flow, variant.name, metrics, {
					prefix: "t3",
					segments: ["open-image", "close-image"],
				});
			}
			expect(flow.errors, "the page logged an error").toEqual([]);

			const { imageOpen, imageClose } = results;
			holdOpen(imageOpen, phone, reduced);
			holdClose(imageClose, phone, reduced);
			// F24: the picture's box is laid out once; the dock's motion never re-flows it.
			expect(
				imageOpen.frameDrift?.w ?? 0,
				"the picture re-flowed while the panel opened",
			).toBeLessThanOrEqual(0.5);
			expect(imageOpen.frameDrift?.h ?? 0).toBeLessThanOrEqual(0.5);
			if (reduced) {
				expect(
					imageOpen.chat.between,
					"the chat was seen part-way under reduced motion",
				).toBeLessThanOrEqual(1);
				expect(
					imageOpen.transitions,
					"a transition ran under reduced motion",
				).toEqual([]);
			}
			if (results.documentOpen) {
				holdSideBySide(
					{ open: imageOpen, close: imageClose },
					{ open: results.documentOpen, close: results.documentClose },
					phone || reduced,
				);
			}
		});
	}
});

/** A tracked box's width, frame by frame: smooth, or a cut. */
function boxProfile(frames: MotionFrame[], name: string) {
	const seen = boxes(frames, name).map((box) => box.w);
	// (`widths` below: every frame's, for the report.)
	const first = seen[0] ?? 0;
	const last = seen.at(-1) ?? 0;
	let maxStep = 0;
	for (let index = 1; index < seen.length; index++) {
		maxStep = Math.max(maxStep, Math.abs(seen[index] - seen[index - 1]));
	}
	const total = Math.abs(last - first);
	return {
		first,
		last,
		maxStep,
		maxStepFraction: total > 0 ? maxStep / total : 0,
		widths: seen.map((width) => Math.round(width * 10) / 10),
	};
}

/** How far a tracked box's top moved from its first frame, in px. */
function topDrift(frames: MotionFrame[], name: string): number {
	const seen = boxes(frames, name);
	if (seen.length === 0) return 0;
	return Math.max(...seen.map((box) => Math.abs(box.y - seen[0].y)));
}

/** Layout shifts of the panel's own pieces (the chat beside it streams and scrolls on its own). */
const PANEL_SOURCES =
	/^(image-body|image-picture|image-version|workspace|page-scroll-container|artifact-panel)/;
function panelShifts(run: MotionRun) {
	return run.shifts
		.filter((entry) =>
			(entry.sources ?? []).some((source) => PANEL_SOURCES.test(source)),
		)
		.reduce((sum, entry) => sum + entry.value, 0);
}

function pictureTransitions(run: MotionRun) {
	const seen = run.transitions.filter(
		(entry) => PICTURE_PART.test(entry.target) && entry.duration >= 1,
	);
	return {
		properties: [...new Set(seen.map((entry) => entry.property))],
		other: seen.filter(
			(entry) => entry.property !== "opacity" && entry.property !== "transform",
		),
	};
}

/** The src of the picture the panel shows. */
async function panelPictureSrc(page: Page) {
	return page
		.locator(
			'[data-testid="image-body-picture"] [data-testid="image-picture-after"]',
		)
		.last()
		.getAttribute("src");
}

test.describe("the picture in the panel: dock, versions, phone (T3)", () => {
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

	test("dock-expand: the picture's panel expands and docks on the Document's curve", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(180_000);
		const runs: Record<string, Record<string, unknown>> = {};
		const measureDock = async (flow: Flow, kind: "image" | "document") => {
			const { page } = flow;
			await openFromCard(flow, kind);
			await settle(page);
			await startRecording(page, PANEL_TRACK);
			mark(flow, `expand-${kind}`);
			await page.locator(".workspace-expand-button:visible").first().click();
			await expect(
				page.locator(".workspace-shell-expanded:visible"),
			).toHaveCount(1);
			await settle(page);
			const expand = await stopRecording(page);
			await startRecording(page, PANEL_TRACK);
			mark(flow, `dock-${kind}`);
			await page
				.locator(".workspace-shell-expanded:visible")
				.getByRole("button", { name: /to the docked workspace/ })
				.click();
			await expect(page.locator(".workspace-shell-expanded")).toHaveCount(0);
			await settle(page);
			const dock = await stopRecording(page);
			return {
				expand: {
					...measurePanel(expand),
					frameWidth: boxProfile(expand.frames, "frame"),
				},
				dock: {
					...measurePanel(dock),
					frameWidth: boxProfile(dock.frames, "frame"),
				},
			};
		};

		const docFlow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{
				viewport: DESKTOP,
			},
		);
		try {
			await makeDocument(docFlow);
			runs.document = await measureDock(docFlow, "document");
		} finally {
			await closeFlow(docFlow, "document-dock-expand", runs, {
				prefix: "t3",
				segments: ["expand-document", "dock-document"],
			});
		}
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{
				viewport: DESKTOP,
			},
		);
		try {
			await makePicture(flow);
			runs.image = await measureDock(flow, "image");
			const image = runs.image as unknown as Record<
				"expand" | "dock",
				PanelMetrics
			>;
			const document = runs.document as unknown as Record<
				"expand" | "dock",
				PanelMetrics
			>;
			runs.sideBySide = {
				expand: compareKinds(image.expand, document.expand),
				dock: compareKinds(image.dock, document.dock),
			};
		} finally {
			await closeFlow(flow, "dock-expand", runs, {
				prefix: "t3",
				segments: ["expand-image", "dock-image"],
			});
		}
		expect(docFlow.errors).toEqual([]);
		expect(flow.errors).toEqual([]);
		const image = runs.image as unknown as Record<
			"expand" | "dock",
			PanelMetrics & { frameWidth: ReturnType<typeof boxProfile> }
		>;
		const document = runs.document as unknown as Record<
			"expand" | "dock",
			PanelMetrics
		>;
		for (const step of ["expand", "dock"] as const) {
			const side = compareKinds(image[step], document[step]);
			expect(
				side.imageCurves,
				`${step}: another curve for the picture`,
			).toEqual(side.documentCurves);
			expect(image[step].longFramesInMotion, `${step}: a long frame`).toEqual(
				[],
			);
			expect(unsafePictureTransitions(image[step])).toEqual([]);
			expect(
				image[step].panel.travel,
				`${step}: the panel did not change size`,
			).toBeGreaterThan(300);
			expect(
				image[step].panel.maxStepFraction,
				`${step}: the panel cut`,
			).toBeLessThan(0.5);
			expect(
				Math.abs(
					image[step].panel.durationMs - document[step].panel.durationMs,
				),
				`${step}: the picture's panel took another time`,
			).toBeLessThanOrEqual(34);
			// The picture follows its box as the panel's insets move (the shell re-lays
			// the content each frame, as it re-wraps the Document's text), never by a
			// bigger step than the panel's own.
			expect(
				image[step].frameWidth.maxStep,
				`${step}: the picture moved more in one frame than the panel did`,
			).toBeLessThanOrEqual(
				image[step].panel.maxStepFraction * image[step].panel.travel + 1,
			);
			expect(image[step].clsNoInput).toBeLessThanOrEqual(
				Math.max(0.01, document[step].clsNoInput + 0.005),
			);
		}
	});

	test("before-after-and-strip: Before / After and a strip frame in the panel move nothing", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(200_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{
				viewport: DESKTOP,
			},
		);
		const { page } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			const { artifactId } = await makePicture(flow);
			await changePicture(flow, artifactId);
			await openFromCard(flow, "image");
			await expect(page.getByTestId("image-version-frame")).toHaveCount(2, {
				timeout: 15_000,
			});
			await settle(page);

			await startRecording(page, PANEL_TRACK);
			mark(flow, "before");
			await page.getByTestId("image-body-before").click();
			await expect(
				page.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-before"].is-loaded',
				),
			).toBeVisible();
			await expect(
				page.getByTestId("image-body-picture").getByTestId("image-picture"),
			).toHaveAttribute("data-showing", "before");
			await page.waitForTimeout(300);
			mark(flow, "after");
			await page.getByTestId("image-body-after").click();
			await expect(
				page.getByTestId("image-body-picture").getByTestId("image-picture"),
			).toHaveAttribute("data-showing", "after");
			await settle(page);
			const flip = await stopRecording(page);

			await startRecording(page, PANEL_TRACK);
			mark(flow, "strip");
			await page.getByTestId("image-version-frame").first().click();
			await page.waitForTimeout(600);
			const strip = await stopRecording(page);
			metrics = {
				flip: {
					cls: shiftSum(flip),
					shifts: flip.shifts,
					frameDrift: sizeDrift(flip.frames, "frame"),
					frameTopDrift: topDrift(flip.frames, "frame"),
					longFrames: flip.longFrames,
					transitions: pictureTransitions(flip),
				},
				strip: {
					cls: shiftSum(strip),
					frameDrift: sizeDrift(strip.frames, "frame"),
					stripTopDrift: topDrift(strip.frames, "strip"),
					longFrames: strip.longFrames,
					transitions: pictureTransitions(strip),
					// History for an Image is T4 (HISTORY_PREVIEWS.image): until then the
					// frame's press asks for History and the panel, with no History for
					// the kind, stays as it is.
					historyOpened: await page.getByTestId("artifact-history").count(),
				},
			};
		} finally {
			await closeFlow(flow, "before-after-and-strip", metrics, {
				prefix: "t3",
				segments: ["before", "after", "strip"],
			});
		}
		expect(flow.errors).toEqual([]);
		const flip = metrics.flip as {
			cls: number;
			frameDrift: { w: number; h: number };
			frameTopDrift: number;
			longFrames: unknown[];
			transitions: { other: unknown[]; properties: string[] };
		};
		expect(flip.cls).toBe(0);
		expect(flip.frameDrift.w).toBeLessThanOrEqual(0.5);
		expect(flip.frameDrift.h).toBeLessThanOrEqual(0.5);
		expect(flip.frameTopDrift).toBeLessThanOrEqual(0.5);
		expect(flip.longFrames).toEqual([]);
		expect(flip.transitions.other).toEqual([]);
		const strip = metrics.strip as typeof flip & { stripTopDrift: number };
		expect(strip.cls).toBe(0);
		expect(strip.frameDrift.h).toBeLessThanOrEqual(0.5);
		expect(strip.stripTopDrift).toBeLessThanOrEqual(0.5);
		expect(strip.longFrames).toEqual([]);
		expect(strip.transitions.other).toEqual([]);
	});

	test("new-version-while-open: a version landing while the panel is open swaps the picture in place (F23)", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(200_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{
				viewport: DESKTOP,
			},
		);
		const { page } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			const { artifactId } = await makePicture(flow);
			await openFromCard(flow, "image");
			const first = await panelPictureSrc(page);
			await settle(page);
			await startRecording(page, PANEL_TRACK);
			mark(flow, "send-change");
			await changePicture(flow, artifactId);
			await expect
				.poll(() => panelPictureSrc(page), {
					message: "the panel shows the new version",
					timeout: 20_000,
				})
				.not.toBe(first);
			mark(flow, "swapped");
			await expect(page.locator(PANEL_LOADED).last()).toBeVisible();
			await expect(page.getByTestId("image-version-frame")).toHaveCount(2);
			await expect(page.getByTestId("image-body-before")).toBeVisible();
			await settle(page);
			const run = await stopRecording(page);
			metrics = {
				panelCls: panelShifts(run),
				shifts: run.shifts,
				frameDrift: sizeDrift(run.frames, "frame"),
				frameTopDrift: topDrift(run.frames, "frame"),
				stripTopDrift: topDrift(run.frames, "strip"),
				stripHeightDrift: sizeDrift(run.frames, "strip").h,
				transitions: pictureTransitions(run),
				longFramesAll: run.longFrames,
			};
		} finally {
			await closeFlow(flow, "new-version-while-open", metrics, {
				prefix: "t3",
				segments: ["send-change", "swapped"],
			});
		}
		expect(flow.errors).toEqual([]);
		expect(metrics.panelCls).toBe(0);
		expect(
			(metrics.frameDrift as { w: number; h: number }).h,
		).toBeLessThanOrEqual(0.5);
		expect(metrics.frameTopDrift).toBeLessThanOrEqual(0.5);
		expect(metrics.stripTopDrift).toBeLessThanOrEqual(0.5);
		expect(metrics.stripHeightDrift).toBeLessThanOrEqual(0.5);
		const swap = metrics.transitions as {
			other: unknown[];
			properties: string[];
		};
		expect(swap.other).toEqual([]);
		// The new picture crosses over the old one (a fade), never a cut.
		expect(swap.properties).toContain("opacity");
	});

	test("phone-pinch: on a phone the panel is the full-screen sheet, and two fingers zoom the picture", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(180_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{
				viewport: PHONE,
			},
		);
		const { page } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			await makePicture(flow);
			metrics.open = await openFromCard(flow, "image");
			const stage = await page.getByTestId("image-body-stage").boundingBox();
			if (!stage) throw new Error("no stage on screen");
			const shellBefore = await page.locator(MOBILE_SHELL).boundingBox();
			const cx = stage.x + stage.width / 2;
			const cy = stage.y + stage.height / 2;
			const client = await page.context().newCDPSession(page);
			const touch = (type: string, points: Array<{ x: number; y: number }>) =>
				client.send("Input.dispatchTouchEvent", {
					type,
					touchPoints: points.map((point, id) => ({ ...point, id })),
				});
			const scaleOf = async () =>
				page.getByTestId("image-body-frame").evaluate((frame) => {
					const transform = getComputedStyle(frame).transform;
					return transform === "none" ? 1 : new DOMMatrix(transform).a;
				});

			await startRecording(page, PANEL_TRACK);
			mark(flow, "pinch");
			await touch("touchStart", [
				{ x: cx - 40, y: cy },
				{ x: cx + 40, y: cy },
			]);
			for (let step = 1; step <= 10; step++) {
				const spread = 40 + step * 4;
				await touch("touchMove", [
					{ x: cx - spread, y: cy },
					{ x: cx + spread, y: cy },
				]);
				await page.waitForTimeout(16);
			}
			await touch("touchEnd", []);
			await page.waitForTimeout(200);
			const zoomed = await scaleOf();
			const shellAfter = await page.locator(MOBILE_SHELL).boundingBox();
			mark(flow, "double-tap");
			for (let tap = 0; tap < 2; tap++) {
				await touch("touchStart", [{ x: cx, y: cy }]);
				await touch("touchEnd", []);
				await page.waitForTimeout(80);
			}
			await page.waitForTimeout(400);
			await waitForMotionToSettle(page);
			const reset = await scaleOf();
			const run = await stopRecording(page);
			metrics = {
				...metrics,
				zoomed,
				reset,
				sheetStillOpen: await page.locator(MOBILE_SHELL).isVisible(),
				shellMoved:
					shellBefore && shellAfter
						? Math.abs(shellAfter.y - shellBefore.y)
						: null,
				cls: shiftSum(run),
				longFrames: run.longFrames,
				transitions: pictureTransitions(run),
				frameTransitions: run.transitions.filter(
					(entry) => entry.target === "image-body-frame",
				),
			};
		} finally {
			await closeFlow(flow, "phone-pinch", metrics, {
				prefix: "t3",
				segments: ["pinch", "double-tap"],
			});
		}
		expect(flow.errors).toEqual([]);
		// The fingers spread from 80 px to 160 px: twice the size.
		expect(metrics.zoomed as number).toBeGreaterThan(1.8);
		expect(metrics.zoomed as number).toBeLessThanOrEqual(2.05);
		expect(metrics.reset).toBe(1);
		expect(metrics.sheetStillOpen).toBe(true);
		expect(metrics.shellMoved).toBe(0);
		expect(metrics.cls).toBe(0);
		expect(metrics.longFrames).toEqual([]);
		expect((metrics.transitions as { other: unknown[] }).other).toEqual([]);
	});
});
