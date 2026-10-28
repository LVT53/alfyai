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
import { updateArtifactBody } from "../../src/lib/server/services/artifacts";
import {
	AI_SMOKE_LATE_CARD_FINAL_TEXT,
	AI_SMOKE_LATE_CARD_MARKER,
} from "../fixtures/ai/late-card-scenario";
import {
	AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT,
	AI_SMOKE_CHANGE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_TITLE,
} from "../fixtures/ai/late-picture-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
	backToList,
	createTourUser,
	IMAGE_ITEM_TITLE,
	markToursSeen,
	openItem,
	reopenChat,
	seedImageItem,
	seedItem,
	startChatAs,
	type TourUser,
} from "./artifact-tours-helpers";
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
	const { page } = flow;
	await updateUserModelPreference(page, flow.previousModel);
	await deleteTemporaryProvider(page, flow.providerId);
	await stopFakeComfyUiForSpec(page, flow.comfy);
	await saveRecording(flow, name, metrics, options);
}

/** Closes a recorded context and saves its video, its numbers and its contact sheets. */
async function saveRecording(
	flow: Pick<Flow, "context" | "page" | "marks" | "errors">,
	name: string,
	metrics: Record<string, unknown>,
	options: { prefix?: string; segments?: string[] } = {},
): Promise<void> {
	const prefix = options.prefix ?? "t2";
	const { page, context } = flow;
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

function mark(
	flow: { marks: Record<string, number>; startedAt: number },
	label: string,
): void {
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
	/** The shell's own content box, whatever kind it holds: what a re-flow would move. */
	content: "aside.workspace-shell-desktop > .workspace-content",
};

/** The shell's content box at rest, after a step has settled. */
async function settledContent(page: Page) {
	const box = await page.locator(PANEL_TRACK.content).first().boundingBox();
	return box ? { width: box.width, height: box.height } : null;
}

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
	// MOTION-PARITY holds long frames during transitions; under reduced motion none
	// runs (asserted on its own), and the Document's editor mounting there once took
	// 50.3 ms with nothing moving.
	if (!reduced) {
		expect(
			metrics.longFramesInMotion,
			"a frame over 50 ms while the panel moved",
		).toEqual([]);
	}
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
	// MOTION-PARITY holds long frames during transitions; under reduced motion none
	// runs (asserted on its own), and the Document's editor mounting there once took
	// 50.3 ms with nothing moving.
	if (!reduced) {
		expect(
			metrics.longFramesInMotion,
			"a frame over 50 ms while the panel moved",
		).toEqual([]);
	}
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

/**
 * How a tracked box's size moves over the frames, per side: every distinct
 * value, how many frames changed it (by more than half a pixel), and whether
 * every change went the same way.
 */
function contentChanges(frames: MotionFrame[], name: string) {
	const seen = boxes(frames, name);
	const side = (pick: (box: TrackedBox) => number) => {
		const values = seen.map((box) => Math.round(pick(box) * 10) / 10);
		const steps = values
			.slice(1)
			.map((value, index) => value - values[index])
			.filter((step) => Math.abs(step) > 0.5);
		return {
			changes: steps.length,
			monotonic:
				steps.every((step) => step > 0) || steps.every((step) => step < 0),
			first: values[0] ?? 0,
			last: values.at(-1) ?? 0,
			values: values.filter(
				(value, index) => index === 0 || value !== values[index - 1],
			),
		};
	};
	return {
		frames: seen.length,
		width: side((box) => box.w),
		height: side((box) => box.h),
		x: side((box) => box.x),
		y: side((box) => box.y),
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
			const expandSettled = await settledContent(page);
			await startRecording(page, PANEL_TRACK);
			mark(flow, `dock-${kind}`);
			await page
				.locator(".workspace-shell-expanded:visible")
				.getByRole("button", { name: /to the docked workspace/ })
				.click();
			await expect(page.locator(".workspace-shell-expanded")).toHaveCount(0);
			await settle(page);
			const dock = await stopRecording(page);
			const dockSettled = await settledContent(page);
			// What the panel holds: the picture's own box, or the Document's text block.
			const content = kind === "image" ? "frame" : "docBody";
			return {
				expand: {
					...measurePanel(expand),
					content: contentChanges(expand.frames, content),
					shellContent: contentChanges(expand.frames, "content"),
					settled: expandSettled,
				},
				dock: {
					...measurePanel(dock),
					content: contentChanges(dock.frames, content),
					shellContent: contentChanges(dock.frames, "content"),
					settled: dockSettled,
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
		type DockRun = Record<
			"expand" | "dock",
			PanelMetrics & {
				content: ReturnType<typeof contentChanges>;
				shellContent: ReturnType<typeof contentChanges>;
				settled: { width: number; height: number } | null;
			}
		>;
		const image = runs.image as unknown as DockRun;
		const document = runs.document as unknown as DockRun;
		// The shell holds what the panel shows at its final size while its edges move:
		// for both kinds the content box changes size at most once (when the hold
		// starts), or moves one way only; never a re-flow through every frame.
		for (const [kind, run] of [
			["image", image],
			["document", document],
		] as const) {
			for (const step of ["expand", "dock"] as const) {
				// The shell's content box itself, for every kind: its size changes once
				// per step at most (when the hold starts), its place moves one way, and
				// where it ends is where it rests (no hold left behind).
				const shell = run[step].shellContent;
				expect(
					shell.frames,
					`${kind} ${step}: no shell content box`,
				).toBeGreaterThan(0);
				for (const side of ["width", "height"] as const) {
					expect(
						shell[side].changes,
						`${kind} ${step}: the panel's content ${side} re-flowed (${shell[side].values.join(", ")})`,
					).toBeLessThanOrEqual(1);
				}
				for (const axis of ["x", "y"] as const) {
					expect(
						shell[axis].monotonic,
						`${kind} ${step}: the panel's content went back and forth in ${axis} (${shell[axis].values.join(", ")})`,
					).toBe(true);
				}
				expect(
					run[step].settled,
					`${kind} ${step}: no content at rest`,
				).not.toBeNull();
				expect(
					Math.abs(shell.width.last - (run[step].settled?.width ?? 0)),
					`${kind} ${step}: the last width is not the resting width`,
				).toBeLessThanOrEqual(0.5);
				expect(
					Math.abs(shell.height.last - (run[step].settled?.height ?? 0)),
					`${kind} ${step}: the last height is not the resting height`,
				).toBeLessThanOrEqual(0.5);
				const box = run[step].content;
				expect(box.frames, `${kind} ${step}: no content box`).toBeGreaterThan(
					0,
				);
				for (const side of ["width", "height"] as const) {
					expect(
						box[side].changes <= 1 || box[side].monotonic,
						`${kind} ${step}: the content's ${side} re-flowed (${box[side].values.join(", ")})`,
					).toBe(true);
				}
			}
		}
		// Expanding gives the picture more room, never less (the panel is wider and
		// nothing of the body's sits above the picture).
		expect(
			image.expand.content.width.last,
			"the expanded picture is smaller than the docked one",
		).toBeGreaterThan(image.expand.content.width.first);
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
			// T4: the frame opens History on its version; the body stays where it is under it.
			await expectHistoryShown(page, "image");
			await settle(page);
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
					// T4: the frame's press opens History (HISTORY_PREVIEWS.image).
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
		const strip = metrics.strip as typeof flip & {
			stripTopDrift: number;
			historyOpened: number;
		};
		expect(strip.historyOpened, "the frame did not open History").toBe(1);
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

test.describe("the picture panel's foot row on a narrow phone (T3b)", () => {
	test("phone-foot-360-hu: the versions strip and Before / After share one row at 360 px in Hungarian, with 44 px targets", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(120_000);
		const viewport = { width: 360, height: 780 };
		const context = await browser.newContext({
			baseURL: testInfo.project.use.baseURL as string,
			viewport,
			hasTouch: true,
			isMobile: true,
			recordVideo: { dir: join(OUT_DIR, ".raw"), size: viewport },
		});
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let metrics: Record<string, unknown> = {};
		try {
			const user = await createTourUser("hu");
			await markToursSeen(user);
			const chatId = await startChatAs(page, user);
			// Two versions, the newest made from the first: a Before, and a strip.
			await seedImageItem(user, chatId, { versions: 2 });
			await reopenChat(page, chatId);
			await openItem(page, IMAGE_ITEM_TITLE);
			await expect(page.locator(PANEL_LOADED).last()).toBeVisible({
				timeout: 20_000,
			});
			await expect(page.getByTestId("image-version-frame")).toHaveCount(2);
			const foot = page.getByTestId("image-body-foot").last();
			await expect(foot.getByRole("button", { name: "Előtte" })).toBeVisible();
			await waitForMotionToSettle(page);
			await page.waitForTimeout(400);
			metrics = await foot.evaluate((row) => {
				const rect = (element: Element | null) =>
					element ? element.getBoundingClientRect() : null;
				const strip = row.querySelector(".image-body-strip");
				const tools = row.querySelector(".image-body-toolbar");
				// A button that is not drawn (the strip's Attach dot, hidden on touch) is no target.
				const drawn = [...row.querySelectorAll("button")].filter(
					(button) => button.getClientRects().length > 0,
				);
				const buttons = drawn.map((button) => {
					const box = button.getBoundingClientRect();
					return {
						label:
							button.getAttribute("aria-label") ?? button.textContent?.trim(),
						width: box.width,
						height: box.height,
						left: box.left,
						right: box.right,
						clipped: button.scrollWidth > button.clientWidth + 0.5,
					};
				});
				const rowBox = row.getBoundingClientRect();
				const stripBox = rect(strip);
				const toolsBox = rect(tools);
				return {
					row: { left: rowBox.left, right: rowBox.right, width: rowBox.width },
					rowOverflows: row.scrollWidth > row.clientWidth + 0.5,
					pageOverflows:
						document.documentElement.scrollWidth > window.innerWidth + 0.5,
					stripBox: stripBox && { left: stripBox.left, right: stripBox.right },
					toolsBox: toolsBox && { left: toolsBox.left, right: toolsBox.right },
					gap: stripBox && toolsBox ? toolsBox.left - stripBox.right : null,
					buttons,
				};
			});
			await page.waitForTimeout(600);
		} finally {
			const video = page.video();
			await context.close();
			mkdirSync(OUT_DIR, { recursive: true });
			const videoPath = join(OUT_DIR, "t3-phone-foot-360-hu.webm");
			if (video) await video.saveAs(videoPath);
			writeFileSync(
				join(OUT_DIR, "t3-phone-foot-360-hu.json"),
				`${JSON.stringify({ name: "phone-foot-360-hu", pageErrors: errors, ...metrics }, null, 2)}\n`,
			);
			// The panel at rest: the last second of the video, one sheet.
			execFileSync(
				"ffmpeg",
				[
					"-y",
					"-loglevel",
					"error",
					"-sseof",
					"-2",
					"-i",
					videoPath,
					"-vf",
					"fps=12,scale=480:-1,tile=6x4",
					join(OUT_DIR, "t3-phone-foot-360-hu-sheet-%02d.png"),
				],
				{ stdio: "inherit" },
			);
		}
		expect(errors).toEqual([]);
		type Box = { left: number; right: number };
		const m = metrics as {
			row: Box & { width: number };
			rowOverflows: boolean;
			pageOverflows: boolean;
			stripBox: Box;
			toolsBox: Box;
			gap: number;
			buttons: Array<{
				label: string;
				width: number;
				height: number;
				left: number;
				right: number;
				clipped: boolean;
			}>;
		};
		expect(m.rowOverflows, "the foot row scrolls sideways").toBe(false);
		expect(m.pageOverflows, "the page scrolls sideways").toBe(false);
		// The strip and the tools do not run into each other.
		expect(m.gap, "the strip runs into Before / After").toBeGreaterThanOrEqual(
			8,
		);
		expect(m.toolsBox.right).toBeLessThanOrEqual(m.row.right + 0.5);
		for (const button of m.buttons) {
			expect(button.clipped, `${button.label} is cut off`).toBe(false);
			expect(
				button.height,
				`${button.label} is under 44 px tall`,
			).toBeGreaterThanOrEqual(44);
			expect(
				button.width,
				`${button.label} is under 44 px wide`,
			).toBeGreaterThanOrEqual(44);
		}
		// The two words and at least two whole frames fit; the strip scrolls inside itself for more.
		const frames = m.buttons.filter(
			(button) =>
				button.right <= m.stripBox.right + 0.5 &&
				button.left >= m.stripBox.left - 0.5,
		);
		expect(
			frames.length,
			"fewer than two whole frames show",
		).toBeGreaterThanOrEqual(2);
	});
});

// ---- Plan 2b T4: History for pictures ------------------------------------------

/**
 * History for pictures (plan 2b T4, MOTION-PARITY "By measurement", F19): History
 * opening and closing, the rail's thumbnails loading and scrolling, the compare
 * wipe dragged by a pointer, by the keyboard and by a finger, Restore, and the
 * phone's flow from a strip frame. The Document's History open and Restore are
 * recorded the same way beside it.
 *
 * Items are seeded straight into the reader's chat (gradients made with sharp,
 * the fake ComfyUI's kind, never a photo), so every flow starts from the same
 * history and nothing waits on a model.
 */

type SeededFlow = {
	context: BrowserContext;
	page: Page;
	startedAt: number;
	marks: Record<string, number>;
	errors: string[];
	user: TourUser;
	chatId: string;
};

const DOCUMENT_TITLE = "Trip notes";

async function openSeededFlow(
	browser: Browser,
	baseURL: string,
	options: {
		viewport: { width: number; height: number };
		colorScheme?: "light" | "dark";
		reducedMotion?: "reduce" | "no-preference";
		/** The reader's language (T6's 360 px Hungarian row). */
		language?: "en" | "hu";
	},
	seed: (user: TourUser, chatId: string) => Promise<unknown>,
): Promise<SeededFlow> {
	const phone = options.viewport.width < 500;
	const context = await browser.newContext({
		baseURL,
		viewport: options.viewport,
		colorScheme: options.colorScheme ?? "light",
		reducedMotion: options.reducedMotion ?? "no-preference",
		hasTouch: phone,
		isMobile: phone,
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
	const user = await createTourUser(options.language ?? "en");
	await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	await seed(user, chatId);
	await reopenChat(page, chatId);
	return { context, page, startedAt, marks: {}, errors, user, chatId };
}

/** An Image of three versions: Alfy's picture, a marked change of Alfy's with its prompt, a picked take. */
async function seedPictureHistory(
	user: TourUser,
	chatId: string,
	versions = 3,
	size: { width: number; height: number } = { width: 1248, height: 832 },
) {
	return seedImageItem(user, chatId, {
		versions,
		...size,
		// Each later version a take the reader picked: one History moment each.
		authorOf: (index) => (index === 1 ? "alfy" : "picked"),
		decorate: (index) =>
			index === 1
				? {
						prompt: "Make the sky warmer and the hills softer",
						marks: [{ letter: "A", x: 0.1, y: 0.2, w: 0.3, h: 0.3 }],
					}
				: {},
	});
}

/** A Document of two versions, the second Alfy's change: the side-by-side's other kind. */
async function seedDocumentHistory(user: TourUser, chatId: string) {
	const documentId = await seedItem(user, chatId, "document");
	const written = await updateArtifactBody({
		userId: user.id,
		artifactId: documentId,
		conversationId: chatId,
		body: "## Plan\n\nFriday: Naschmarkt, Secession.\n\nSaturday: Belvedere.\n",
		author: "alfy",
		summary: "Added Saturday",
	});
	if (!written.ok) throw new Error(`seedDocumentHistory: ${written.reason}`);
	return documentId;
}

const HISTORY_SHEET = '[role="dialog"]:has([data-testid="artifact-history"])';
const HISTORY_TRACK = {
	/** The desktop's History slot over the body; the phone's is a sheet of its own. */
	slot: ".workspace-history-slot",
	sheet: HISTORY_SHEET,
	rail: '[data-testid="artifact-history-rail"]',
	preview: '[data-testid="image-version-preview"]',
	thumb: '[data-testid="history-thumb"]',
	thumbImg: '[data-testid="history-thumb"] [data-testid="image-picture-after"]',
	wipe: '[data-testid="compare-wipe"]',
	wipeTop: '[data-testid="compare-wipe-after"]',
	line: '[data-testid="compare-wipe-line"]',
	toast: '[data-testid="history-toast"]',
	content: "aside.workspace-shell-desktop > .workspace-content",
};

/** History's own pieces and the picture's, by the recorder's target names. */
const HISTORY_PICTURE_PART =
	/^(image-version|image-picture|compare-wipe|history-thumb)/;

async function nextFrame(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

/** Opens the seeded item and waits for its body to be drawn. */
async function openSeededItem(flow: SeededFlow, kind: "image" | "document") {
	await openItem(
		flow.page,
		kind === "image" ? IMAGE_ITEM_TITLE : DOCUMENT_TITLE,
	);
	await expect(
		flow.page
			.locator(kind === "image" ? PANEL_LOADED : `${DOC_BODY}:visible`)
			.first(),
	).toBeVisible({ timeout: 20_000 });
	await settle(flow.page);
}

function historyButton(page: Page) {
	return page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first();
}

/** History's preview has drawn what it shows: the wipe's pictures (or the one picture) loaded, or the Document's text. */
async function expectHistoryShown(page: Page, kind: "image" | "document") {
	const history = page.getByTestId("artifact-history");
	await expect(history).toBeVisible({ timeout: 20_000 });
	await expect(history.getByTestId("history-loading")).toHaveCount(0);
	const listOnly =
		(await history.getAttribute("data-layout")) === "phone" &&
		(await history.getByTestId("history-option").count()) > 0;
	if (listOnly) {
		// A phone's History opened from the header shows its list: the rail's
		// thumbnails are what it draws.
		if (kind === "image") {
			await expect(
				history.locator('[data-testid="history-thumb"] img:not(.is-loaded)'),
			).toHaveCount(0, { timeout: 15_000 });
		}
		return;
	}
	if (kind === "image") {
		await expect(history.getByTestId("image-version-preview")).toHaveAttribute(
			"data-status",
			"ready",
		);
		await expect(
			history.locator(
				'[data-testid="compare-wipe-after"].is-loaded, [data-testid="image-version-picture"] img.is-loaded',
			),
		).toHaveCount(1, { timeout: 15_000 });
	} else {
		await expect(
			history.locator('[data-testid="history-option"]').first(),
		).toBeVisible();
	}
	await expect(history.getByTestId("history-loading")).toHaveCount(0);
}

/** What History's motion is made of: the shell's own animations, what moved, what shifted, what ran long. */
function measureHistory(run: MotionRun) {
	const real = run.transitions.filter((entry) => entry.duration >= 1);
	const start = run.inputAt ?? 0;
	const opacityOf = (name: string) =>
		run.frames
			.filter((frame) => frame.tracked[name] != null)
			.map((frame) => ({
				t: frame.t - start,
				opacity: frame.tracked[name]?.opacity ?? 0,
			}));
	/** ms after the press when what shows History reached full opacity. */
	const shownAt = (name: string) =>
		opacityOf(name).find((frame) => frame.opacity >= 0.999)?.t ?? null;
	return {
		cls: shiftSum(run),
		clsNoInput: shiftSum(run, { ignoreRecentInput: true }),
		shifts: run.shifts,
		longFrames: run.longFrames,
		slotShownMs: shownAt("slot"),
		sheetShownMs: shownAt("sheet"),
		slotOpacity: opacityOf("slot").map((frame) =>
			Number(frame.opacity.toFixed(3)),
		),
		contentDrift: sizeDrift(run.frames, "content"),
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
			duration: Math.round(entry.duration),
			easing: entry.easing,
		})),
	};
}
type HistoryMetrics = ReturnType<typeof measureHistory>;

/** The picture's own pieces animate only transform and opacity (MOTION-PARITY 3). */
function unsafeHistoryTransitions(metrics: HistoryMetrics) {
	return metrics.transitions.filter(
		(entry) =>
			HISTORY_PICTURE_PART.test(entry.target) &&
			entry.property !== "opacity" &&
			entry.property !== "transform",
	);
}

/** The shell's motion when History opens or closes: what animated, how long, on which curve; the same list for both kinds. */
function historyCurves(metrics: HistoryMetrics) {
	return [
		...new Set(
			metrics.animations
				.filter((entry) => !HISTORY_PICTURE_PART.test(entry.target))
				.map(
					(entry) =>
						`${entry.target} ${entry.properties.join("+")} ${entry.duration}ms ${entry.easing}`,
				),
		),
	].sort();
}

function holdHistoryMotion(metrics: HistoryMetrics, reduced: boolean) {
	expect(
		metrics.clsNoInput,
		"History moved something the reader did not",
	).toBeLessThanOrEqual(0.01);
	if (!reduced) {
		expect(
			metrics.longFrames,
			"a frame over 50 ms in History's motion",
		).toEqual([]);
	}
	expect(
		unsafeHistoryTransitions(metrics),
		"a picture piece animated something other than transform/opacity",
	).toEqual([]);
	// History is a slot over the body: the panel's own content is never re-laid out.
	expect(metrics.contentDrift.w).toBeLessThanOrEqual(0.5);
	expect(metrics.contentDrift.h).toBeLessThanOrEqual(0.5);
	if (reduced) {
		expect(
			metrics.transitions.filter((entry) => entry.duration >= 1),
			"a transition ran under reduced motion",
		).toEqual([]);
		expect(
			metrics.animations.filter((entry) => entry.duration >= 1),
			"an animation ran under reduced motion",
		).toEqual([]);
	}
}

/** Opens History from the header (recorded), and leaves it the reader's way (recorded). */
async function historyOpenClose(flow: SeededFlow, kind: "image" | "document") {
	const { page } = flow;
	const phone = (page.viewportSize()?.width ?? 1440) < 768;
	await startRecording(page, HISTORY_TRACK);
	mark(flow, `history-open-${kind}`);
	await historyButton(page).click();
	await expectHistoryShown(page, kind);
	await settle(page);
	const open = measureHistory(await stopRecording(page));

	await startRecording(page, HISTORY_TRACK);
	mark(flow, `history-close-${kind}`);
	if (phone) await page.keyboard.press("Escape");
	else await historyButton(page).click();
	await expect(page.getByTestId("artifact-history")).toHaveCount(0);
	await settle(page);
	const close = measureHistory(await stopRecording(page));
	return { open, close };
}

test.describe("History for pictures moves like the Document's (T4)", () => {
	test.describe.configure({ mode: "serial" });

	const VARIANTS = [
		{
			name: "history-desktop-light",
			viewport: DESKTOP,
			colorScheme: "light",
			document: true,
		},
		{
			name: "history-desktop-dark",
			viewport: DESKTOP,
			colorScheme: "dark",
			document: false,
		},
		{
			name: "history-phone-light",
			viewport: PHONE,
			colorScheme: "light",
			document: true,
		},
		{
			name: "history-phone-dark",
			viewport: PHONE,
			colorScheme: "dark",
			document: false,
		},
		{
			name: "history-desktop-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
			document: true,
		},
	] as const;

	for (const variant of VARIANTS) {
		test(`${variant.name}: History opens and closes over the picture on the Document's curve`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const reduced = "reducedMotion" in variant;
			const options = {
				viewport: variant.viewport,
				colorScheme: variant.colorScheme,
				reducedMotion: reduced ? ("reduce" as const) : undefined,
			};
			const baseURL = testInfo.project.use.baseURL as string;
			const results: Record<string, HistoryMetrics> = {};

			if (variant.document) {
				const docFlow = await openSeededFlow(
					browser,
					baseURL,
					options,
					(user, chatId) => seedDocumentHistory(user, chatId),
				);
				try {
					await openSeededItem(docFlow, "document");
					const doc = await historyOpenClose(docFlow, "document");
					results.documentOpen = doc.open;
					results.documentClose = doc.close;
				} finally {
					await saveRecording(docFlow, `document-${variant.name}`, results, {
						prefix: "t4",
						segments: ["history-open-document", "history-close-document"],
					});
				}
				expect(docFlow.errors, "the page logged an error").toEqual([]);
			}

			const flow = await openSeededFlow(
				browser,
				baseURL,
				options,
				(user, chatId) => seedPictureHistory(user, chatId),
			);
			let metrics: Record<string, unknown> = {};
			try {
				await openSeededItem(flow, "image");
				const image = await historyOpenClose(flow, "image");
				results.imageOpen = image.open;
				results.imageClose = image.close;
				metrics = {
					imageOpen: image.open,
					imageClose: image.close,
					...(results.documentOpen
						? {
								sideBySide: {
									open: {
										image: historyCurves(image.open),
										document: historyCurves(results.documentOpen),
										imageShownMs:
											image.open.slotShownMs ?? image.open.sheetShownMs,
										documentShownMs:
											results.documentOpen.slotShownMs ??
											results.documentOpen.sheetShownMs,
									},
									close: {
										image: historyCurves(image.close),
										document: historyCurves(results.documentClose),
									},
								},
							}
						: {}),
				};
			} finally {
				await saveRecording(flow, variant.name, metrics, {
					prefix: "t4",
					segments: ["history-open-image", "history-close-image"],
				});
			}
			expect(flow.errors, "the page logged an error").toEqual([]);

			holdHistoryMotion(results.imageOpen, reduced);
			holdHistoryMotion(results.imageClose, reduced);
			if (results.documentOpen) {
				holdHistoryMotion(results.documentOpen, reduced);
				holdHistoryMotion(results.documentClose, reduced);
				for (const step of ["Open", "Close"] as const) {
					expect(
						historyCurves(results[`image${step}`]),
						`${step}: History ran on another curve for the picture`,
					).toEqual(historyCurves(results[`document${step}`]));
				}
				const imageShown =
					results.imageOpen.slotShownMs ?? results.imageOpen.sheetShownMs;
				const documentShown =
					results.documentOpen.slotShownMs ?? results.documentOpen.sheetShownMs;
				if (imageShown !== null && documentShown !== null && !reduced) {
					expect(
						Math.abs(imageShown - documentShown),
						"History took another time to show for the picture",
					).toBeLessThanOrEqual(50);
				}
			}
		});
	}

	test("history-rail-thumbs: the rail's thumbnails are reserved at 40 px, fade in and scroll with nothing moving", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(240_000);
		const flow = await openSeededFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
			// Sixteen versions, each a moment of its own: more than the rail shows.
			(user, chatId) =>
				seedPictureHistory(user, chatId, 16, { width: 624, height: 416 }),
		);
		const { page } = flow;
		let metrics: Record<string, unknown> = {};
		try {
			await openSeededItem(flow, "image");
			await startRecording(page, HISTORY_TRACK);
			mark(flow, "rail-open");
			await historyButton(page).click();
			await expectHistoryShown(page, "image");
			await expect(
				page.locator('[data-testid="history-thumb"] img.is-loaded'),
			).toHaveCount(16, { timeout: 20_000 });
			await settle(page);
			const open = await stopRecording(page);
			const thumbSizes = boxes(open.frames, "thumb").map(
				(box) => `${Math.round(box.w)}x${Math.round(box.h)}`,
			);
			const thumbOpacity = boxes(open.frames, "thumbImg").map((box) =>
				Number(box.opacity.toFixed(2)),
			);

			const rail = page.getByTestId("artifact-history-rail");
			const railBox = await rail.boundingBox();
			if (!railBox) throw new Error("no rail on screen");
			const scrollable = await rail.evaluate(
				(element) => element.scrollHeight - element.clientHeight,
			);
			await startRecording(page, HISTORY_TRACK);
			mark(flow, "rail-scroll");
			await page.mouse.move(
				railBox.x + railBox.width / 2,
				railBox.y + railBox.height / 2,
			);
			for (let step = 0; step < 12; step++) {
				await page.mouse.wheel(0, 80);
				await nextFrame(page);
			}
			await settle(page);
			const scroll = await stopRecording(page);
			const scrolled = await rail.evaluate((element) => element.scrollTop);
			const allThumbs = await page
				.getByTestId("history-thumb")
				.evaluateAll((elements) =>
					elements.map((element) => {
						const box = element.getBoundingClientRect();
						return `${Math.round(box.width)}x${Math.round(box.height)}`;
					}),
				);
			const imgTransition = await page
				.locator('[data-testid="history-thumb"] img')
				.first()
				.evaluate((element) => getComputedStyle(element).transitionProperty);
			metrics = {
				open: measureHistory(open),
				thumbSizes: [...new Set(thumbSizes)],
				thumbOpacity,
				scroll: {
					scrollable,
					scrolled,
					cls: shiftSum(scroll),
					longFrames: scroll.longFrames,
					transitions: scroll.transitions.filter((entry) =>
						HISTORY_PICTURE_PART.test(entry.target),
					),
				},
				allThumbs: [...new Set(allThumbs)],
				imgTransition,
			};
		} finally {
			await saveRecording(flow, "history-rail-thumbs", metrics, {
				prefix: "t4",
				segments: ["rail-open", "rail-scroll"],
			});
		}
		expect(flow.errors).toEqual([]);
		const open = metrics.open as HistoryMetrics;
		holdHistoryMotion(open, false);
		// Reserved: every frame a thumbnail was on screen it was 40 x 40.
		expect(metrics.thumbSizes).toEqual(["40x40"]);
		expect(metrics.allThumbs).toEqual(["40x40"]);
		// It fades in: seen part-way, and ends shown.
		const opacity = metrics.thumbOpacity as number[];
		expect(opacity.at(-1)).toBe(1);
		expect(metrics.imgTransition).toBe("opacity");
		const scroll = metrics.scroll as {
			scrollable: number;
			scrolled: number;
			cls: number;
			longFrames: unknown[];
			transitions: unknown[];
		};
		expect(scroll.scrollable, "the rail did not overflow").toBeGreaterThan(200);
		expect(scroll.scrolled).toBeGreaterThan(200);
		expect(scroll.cls).toBe(0);
		expect(scroll.longFrames).toEqual([]);
	});
});

/**
 * A probe of the wipe's own writes: every `input` the range fires and every
 * write to the top picture's `clip-path`, each stamped with the animation frame
 * it happened in. "Applied in the same rAF" is: the write for an input lands in
 * the frame the input was counted in (lag 0), and carries the input's position.
 */
async function installWipeProbe(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as Record<string, unknown>;
		let frame = 0;
		const tick = () => {
			frame += 1;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		const inputs: Array<{ frame: number; value: number; t: number }> = [];
		const writes: Array<{ frame: number; at: number; t: number }> = [];
		const range = document.querySelector<HTMLInputElement>(
			'[data-testid="compare-wipe-range"]',
		);
		const top = document.querySelector<HTMLElement>(
			'[data-testid="compare-wipe-after"]',
		);
		range?.addEventListener("input", () =>
			inputs.push({ frame, value: Number(range.value), t: performance.now() }),
		);
		range?.addEventListener("keydown", () =>
			queueMicrotask(() =>
				inputs.push({
					frame,
					value: Number(range.value),
					t: performance.now(),
				}),
			),
		);
		const observer = new MutationObserver(() => {
			const match = /inset\(0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)%\)/.exec(
				top?.style.clipPath ?? "",
			);
			if (match)
				writes.push({ frame, at: Number(match[1]), t: performance.now() });
		});
		if (top)
			observer.observe(top, { attributes: true, attributeFilter: ["style"] });
		w.__wipeProbe = {
			read: () => ({ inputs: inputs.slice(), writes: writes.slice() }),
			reset: () => {
				inputs.length = 0;
				writes.length = 0;
			},
		};
	});
}

type WipeProbe = {
	inputs: Array<{ frame: number; value: number; t: number }>;
	writes: Array<{ frame: number; at: number; t: number }>;
};

async function readWipeProbe(page: Page): Promise<WipeProbe> {
	return page.evaluate(() =>
		(
			window as unknown as { __wipeProbe: { read(): unknown } }
		).__wipeProbe.read(),
	) as Promise<WipeProbe>;
}

async function resetWipeProbe(page: Page) {
	await page.evaluate(() =>
		(
			window as unknown as { __wipeProbe: { reset(): void } }
		).__wipeProbe.reset(),
	);
}

/** For each input, how many frames passed before the cut showed its position (or a later one). */
function wipeLag(probe: WipeProbe) {
	return probe.inputs.map((input) => {
		const write = probe.writes.find(
			(candidate) =>
				candidate.t >= input.t && Math.abs(candidate.at - input.value) < 0.01,
		);
		const later = probe.writes.find((candidate) => candidate.t >= input.t);
		const landed = write ?? later;
		return landed ? landed.frame - input.frame : Number.POSITIVE_INFINITY;
	});
}

/** Where the wipe's line stands, in px from the page's left, and the cut's position in %. */
async function wipeLine(page: Page) {
	return page.evaluate(() => {
		const line = document.querySelector<HTMLElement>(
			'[data-testid="compare-wipe-line"]',
		);
		const top = document.querySelector<HTMLElement>(
			'[data-testid="compare-wipe-after"]',
		);
		const box = line?.getBoundingClientRect();
		const match = /([\d.]+)%\)/.exec(top?.style.clipPath ?? "");
		return {
			x: box ? box.x + box.width / 2 : null,
			at: match ? Number(match[1]) : null,
			transition: top ? getComputedStyle(top).transitionProperty : null,
		};
	});
}

test.describe("the compare wipe follows the hand (T4)", () => {
	test.describe.configure({ mode: "serial" });

	for (const variant of [
		{ name: "history-wipe-desktop", viewport: DESKTOP },
		{ name: "history-wipe-phone", viewport: PHONE },
	] as const) {
		test(`${variant.name}: the wipe is dragged by ${variant.viewport === PHONE ? "a finger" : "a pointer and the keyboard"}, its cut written in the same frame as each move`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const phone = variant.viewport === PHONE;
			const flow = await openSeededFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{ viewport: variant.viewport },
				(user, chatId) => seedPictureHistory(user, chatId, 2),
			);
			const { page } = flow;
			const metrics: Record<string, unknown> = {};
			try {
				await openSeededItem(flow, "image");
				// The newest version is selected: it is wiped against the one before it.
				await historyButton(page).click();
				if (phone) {
					// The phone's History opens on its list: the newest row pushes its preview.
					await page.getByTestId("history-option").first().tap();
				}
				await expectHistoryShown(page, "image");
				await settle(page);
				await installWipeProbe(page);
				const wipe = await page.getByTestId("compare-wipe").boundingBox();
				if (!wipe) throw new Error("no wipe on screen");
				const y = wipe.y + wipe.height / 2;
				const xAt = (percent: number) => wipe.x + (wipe.width * percent) / 100;

				if (!phone) {
					await startRecording(page, HISTORY_TRACK);
					mark(flow, "wipe-pointer");
					await page.mouse.move(xAt(50), y);
					await page.mouse.down();
					for (let step = 1; step <= 30; step++) {
						await page.mouse.move(xAt(50 - step), y);
						await nextFrame(page);
					}
					const held = await wipeLine(page);
					await page.mouse.up();
					await settle(page);
					const run = await stopRecording(page);
					const probe = await readWipeProbe(page);
					metrics.pointer = {
						inputs: probe.inputs.length,
						lagFrames: [...new Set(wipeLag(probe))],
						lineVsPointerPx:
							held.x === null ? null : Math.abs(held.x - xAt(20)),
						cutAt: held.at,
						topTransitionProperty: held.transition,
						cls: shiftSum(run),
						longFrames: run.longFrames,
						transitions: run.transitions.filter((entry) =>
							HISTORY_PICTURE_PART.test(entry.target),
						),
					};

					await resetWipeProbe(page);
					await startRecording(page, HISTORY_TRACK);
					mark(flow, "wipe-keyboard");
					await page.getByTestId("compare-wipe-range").focus();
					const keys: Array<{ key: string; at: number | null }> = [];
					for (const key of [
						"ArrowRight",
						"ArrowRight",
						"ArrowRight",
						"Shift+ArrowRight",
						"End",
						"Home",
						"PageUp",
					]) {
						await page.keyboard.press(key);
						await nextFrame(page);
						await nextFrame(page);
						keys.push({ key, at: (await wipeLine(page)).at });
					}
					await settle(page);
					const keyRun = await stopRecording(page);
					const keyProbe = await readWipeProbe(page);
					metrics.keyboard = {
						keys,
						lagFrames: [...new Set(wipeLag(keyProbe))],
						cls: shiftSum(keyRun),
						longFrames: keyRun.longFrames,
					};
				} else {
					const client = await page.context().newCDPSession(page);
					const touch = (
						type: string,
						points: Array<{ x: number; y: number }>,
					) =>
						client.send("Input.dispatchTouchEvent", {
							type,
							touchPoints: points.map((point, id) => ({ ...point, id })),
						});
					await startRecording(page, HISTORY_TRACK);
					mark(flow, "wipe-touch");
					await touch("touchStart", [{ x: xAt(50), y }]);
					for (let step = 1; step <= 30; step++) {
						await touch("touchMove", [{ x: xAt(50 + step), y }]);
						await nextFrame(page);
					}
					const held = await wipeLine(page);
					await touch("touchEnd", []);
					await settle(page);
					const run = await stopRecording(page);
					const probe = await readWipeProbe(page);
					metrics.touch = {
						inputs: probe.inputs.length,
						lagFrames: [...new Set(wipeLag(probe))],
						lineVsFingerPx: held.x === null ? null : Math.abs(held.x - xAt(80)),
						cutAt: held.at,
						topTransitionProperty: held.transition,
						sheetStillOpen: await page.locator(HISTORY_SHEET).isVisible(),
						cls: shiftSum(run),
						longFrames: run.longFrames,
						transitions: run.transitions.filter((entry) =>
							HISTORY_PICTURE_PART.test(entry.target),
						),
					};
				}
			} finally {
				await saveRecording(flow, variant.name, metrics, {
					prefix: "t4",
					segments: phone ? ["wipe-touch"] : ["wipe-pointer", "wipe-keyboard"],
				});
			}
			expect(flow.errors).toEqual([]);
			type Drag = {
				inputs: number;
				lagFrames: number[];
				cutAt: number | null;
				topTransitionProperty: string | null;
				cls: number;
				longFrames: unknown[];
				transitions: SeenTransitionLike[];
			};
			type SeenTransitionLike = { property: string };
			const holdDrag = (drag: Drag, endsAt: number, offPx: number | null) => {
				expect(drag.inputs, "the range never moved").toBeGreaterThan(10);
				// The owner's bar, "the same frame": every move's cut is written in the
				// frame its input was dispatched in (Chrome dispatches pointer and touch
				// moves with the frame, before its animation callbacks), lag 0.
				expect(drag.lagFrames).toEqual([0]);
				expect(drag.cutAt ?? -1).toBeCloseTo(endsAt, 0);
				// The line stands under the hand.
				expect(offPx ?? 99).toBeLessThanOrEqual(2);
				// Nothing eases the cut: the picture's only transition is its fade-in.
				expect(drag.topTransitionProperty).toBe("opacity");
				expect(
					drag.transitions.filter((entry) => entry.property !== "opacity"),
				).toEqual([]);
				expect(drag.cls).toBe(0);
				expect(drag.longFrames).toEqual([]);
			};
			if (phone) {
				const drag = metrics.touch as Drag & {
					lineVsFingerPx: number | null;
					sheetStillOpen: boolean;
				};
				holdDrag(drag, 80, drag.lineVsFingerPx);
				expect(drag.sheetStillOpen).toBe(true);
			} else {
				const drag = metrics.pointer as Drag & {
					lineVsPointerPx: number | null;
				};
				holdDrag(drag, 20, drag.lineVsPointerPx);
				const keyboard = metrics.keyboard as {
					keys: Array<{ key: string; at: number | null }>;
					lagFrames: number[];
					cls: number;
					longFrames: unknown[];
				};
				// From where the drag left it (20 %): +2, +2, +2, +10, the ends, +10.
				expect(
					keyboard.keys.map((entry) => Math.round(entry.at ?? -1)),
				).toEqual([22, 24, 26, 36, 100, 0, 10]);
				expect(keyboard.lagFrames).toEqual([0]);
				expect(keyboard.cls).toBe(0);
				expect(keyboard.longFrames).toEqual([]);
			}
		});
	}
});

/** Restores the oldest version from History (recorded from the confirming press). */
async function restoreOldest(flow: SeededFlow, kind: "image" | "document") {
	const { page } = flow;
	const phone = (page.viewportSize()?.width ?? 1440) < 768;
	await historyButton(page).click();
	await expectHistoryShown(page, kind);
	const options = page.getByTestId("history-option");
	if (phone) await options.last().tap();
	else await options.last().click();
	await expect(
		page.locator('[data-testid="history-restore"]:visible').first(),
	).toBeEnabled();
	await settle(page);
	await page.locator('[data-testid="history-restore"]:visible').first().click();
	await settle(page);
	await startRecording(page, HISTORY_TRACK);
	mark(flow, `restore-${kind}`);
	await page
		.locator('[data-testid="history-restore-confirm"]:visible')
		.first()
		.click();
	await expect(page.getByTestId("history-toast")).toContainText("Restored");
	await expect(
		page.locator('[data-testid="history-option"][aria-selected="true"]'),
	).toHaveCount(phone ? 0 : 1);
	await settle(page);
	const run = await stopRecording(page);
	const toastAt = (() => {
		const start = run.inputAt ?? 0;
		const frames = run.frames.filter((frame) => frame.tracked.toast != null);
		const first = frames[0];
		const shown = frames.find(
			(frame) => (frame.tracked.toast?.opacity ?? 0) >= 0.999,
		);
		return {
			firstSeenMs: first ? first.t - start : null,
			shownMs: shown ? shown.t - start : null,
			transforms: [
				...new Set(frames.map((frame) => frame.tracked.toast?.transform)),
			],
		};
	})();
	return { ...measureHistory(run), toast: toastAt };
}

test.describe("Restore of a picture moves like the Document's (T4)", () => {
	test.describe.configure({ mode: "serial" });

	for (const variant of [
		{ name: "history-restore-desktop", viewport: DESKTOP, document: true },
		{ name: "history-restore-phone", viewport: PHONE, document: false },
	] as const) {
		test(`${variant.name}: Restore lands the older picture with the Document's toast and no shift`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const baseURL = testInfo.project.use.baseURL as string;
			const results: Record<string, unknown> = {};
			if (variant.document) {
				const docFlow = await openSeededFlow(
					browser,
					baseURL,
					{ viewport: variant.viewport },
					(user, chatId) => seedDocumentHistory(user, chatId),
				);
				try {
					await openSeededItem(docFlow, "document");
					results.document = await restoreOldest(docFlow, "document");
				} finally {
					await saveRecording(docFlow, `document-${variant.name}`, results, {
						prefix: "t4",
						segments: ["restore-document"],
					});
				}
				expect(docFlow.errors).toEqual([]);
			}
			let fileIds: string[] = [];
			const flow = await openSeededFlow(
				browser,
				baseURL,
				{ viewport: variant.viewport },
				async (user, chatId) => {
					fileIds = (await seedPictureHistory(user, chatId)).fileIds;
				},
			);
			try {
				await openSeededItem(flow, "image");
				results.image = await restoreOldest(flow, "image");
				// Leaving History shows the restored picture in the panel.
				if (variant.viewport === PHONE) {
					await flow.page.keyboard.press("Escape");
					await flow.page.keyboard.press("Escape");
				} else {
					await historyButton(flow.page).click();
				}
				await expect(flow.page.getByTestId("artifact-history")).toHaveCount(0);
				await expect(
					flow.page
						.locator(
							'[data-testid="image-body-picture"] [data-testid="image-picture-after"]',
						)
						.last(),
				).toHaveAttribute("src", new RegExp(fileIds[0]));
				results.panelShowsRestored = true;
			} finally {
				await saveRecording(flow, variant.name, results, {
					prefix: "t4",
					segments: ["restore-image"],
				});
			}
			expect(flow.errors).toEqual([]);
			type Restore = HistoryMetrics & {
				toast: { firstSeenMs: number | null; shownMs: number | null };
			};
			const image = results.image as Restore;
			holdHistoryMotion(image, false);
			expect(image.toast.shownMs).not.toBeNull();
			if (results.document) {
				const document = results.document as Restore;
				holdHistoryMotion(document, false);
				expect(historyCurves(image)).toEqual(historyCurves(document));
				expect(
					Math.abs((image.toast.shownMs ?? 0) - (document.toast.shownMs ?? 0)),
					"the restore's toast took another time for the picture",
				).toBeLessThanOrEqual(80);
			}
		});
	}
});

test.describe("History for pictures on a phone (T4)", () => {
	test("history-phone-flow: a strip frame opens the sheet on its version, the wipe moves under a finger, Back and the sheet peel", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(180_000);
		const flow = await openSeededFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: PHONE },
			(user, chatId) => seedPictureHistory(user, chatId),
		);
		const { page } = flow;
		const metrics: Record<string, unknown> = {};
		try {
			await openSeededItem(flow, "image");
			const frames = page.locator(
				'[data-testid="image-version-frame"]:visible',
			);
			await expect(frames).toHaveCount(3);
			const versionId = await frames.nth(1).getAttribute("data-version-id");
			await startRecording(page, HISTORY_TRACK);
			mark(flow, "phone-frame");
			await frames.nth(1).tap();
			await expectHistoryShown(page, "image");
			await settle(page);
			metrics.open = measureHistory(await stopRecording(page));

			const wipe = await page.getByTestId("compare-wipe").boundingBox();
			if (!wipe) throw new Error("no wipe on screen");
			const client = await page.context().newCDPSession(page);
			const touch = (type: string, points: Array<{ x: number; y: number }>) =>
				client.send("Input.dispatchTouchEvent", {
					type,
					touchPoints: points.map((point, id) => ({ ...point, id })),
				});
			const y = wipe.y + wipe.height / 2;
			await startRecording(page, HISTORY_TRACK);
			mark(flow, "phone-wipe");
			await touch("touchStart", [{ x: wipe.x + wipe.width / 2, y }]);
			for (let step = 1; step <= 20; step++) {
				await touch("touchMove", [
					{ x: wipe.x + wipe.width / 2 - (step * wipe.width) / 50, y },
				]);
				await nextFrame(page);
			}
			await touch("touchEnd", []);
			await settle(page);
			const wipeRun = await stopRecording(page);
			metrics.wipe = {
				cutAt: (await wipeLine(page)).at,
				cls: shiftSum(wipeRun),
				longFrames: wipeRun.longFrames,
			};

			await startRecording(page, HISTORY_TRACK);
			mark(flow, "phone-back");
			await page
				.getByTestId("artifact-history")
				.getByRole("button", { name: "History" })
				.tap();
			const selected = page.locator(
				'[data-testid="history-option"][aria-selected="true"]',
			);
			await expect(selected).toHaveAttribute(
				"data-version-id",
				versionId ?? "",
			);
			await settle(page);
			mark(flow, "phone-close");
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("artifact-history")).toHaveCount(0);
			await settle(page);
			metrics.backAndClose = measureHistory(await stopRecording(page));
		} finally {
			await saveRecording(flow, "history-phone-flow", metrics, {
				prefix: "t4",
				segments: ["phone-frame", "phone-wipe", "phone-back"],
			});
		}
		expect(flow.errors).toEqual([]);
		holdHistoryMotion(metrics.open as HistoryMetrics, false);
		holdHistoryMotion(metrics.backAndClose as HistoryMetrics, false);
		const wipe = metrics.wipe as {
			cutAt: number;
			cls: number;
			longFrames: unknown[];
		};
		expect(wipe.cutAt).toBeCloseTo(10, 0);
		expect(wipe.cls).toBe(0);
		expect(wipe.longFrames).toEqual([]);
	});
});

/** One pixel of the page, as [r, g, b]. */
async function pixelAt(page: Page, x: number, y: number) {
	const png = await page.screenshot({
		clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 },
	});
	const raw = await sharp(png).removeAlpha().raw().toBuffer();
	return [raw[0], raw[1], raw[2]];
}

/** How far a colour is from grey: the checkerboard's cells are near-grey in both themes, the gradients are not. */
const chroma = ([r, g, b]: number[]) => Math.max(r, g, b) - Math.min(r, g, b);

test.describe("a see-through picture in the wipe (T4 fix round 1)", () => {
	test.describe.configure({ mode: "serial" });

	for (const colorScheme of ["light", "dark"] as const) {
		test(`history-wipe-transparent-${colorScheme}: the selected picture's see-through part shows the checkerboard, never the picture compared with`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const flow = await openSeededFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{ viewport: DESKTOP, colorScheme },
				// An opaque first picture, then one see-through right of 55 %.
				(user, chatId) =>
					seedImageItem(user, chatId, {
						versions: 2,
						seeThroughOf: (index) => index === 1,
					}),
			);
			const { page } = flow;
			const metrics: Record<string, unknown> = {};
			try {
				await openSeededItem(flow, "image");
				await historyButton(page).click();
				await expectHistoryShown(page, "image");
				await settle(page);
				const wipe = page.getByTestId("compare-wipe");
				const box = await wipe.boundingBox();
				if (!box) throw new Error("no wipe on screen");
				const y = box.y + box.height * 0.5;
				const at = (fraction: number) => box.x + box.width * fraction;
				metrics.checkerboard = await wipe.evaluate((element) =>
					element.classList.contains("image-checkerboard"),
				);

				await startRecording(page, HISTORY_TRACK);
				mark(flow, "transparent-wipe");
				const range = page.getByTestId("compare-wipe-range");
				await range.focus();
				// The cut at the middle: right of it is the selected picture, see-through at 80 %.
				metrics.middle = {
					seeThrough: await pixelAt(page, at(0.8), y),
					opaque: await pixelAt(page, at(0.3), y),
				};
				// All of the picture compared with: at 80 % it is its own opaque gradient.
				await page.keyboard.press("End");
				await nextFrame(page);
				await nextFrame(page);
				metrics.allLeft = { at80: await pixelAt(page, at(0.8), y) };
				// All of the selected picture: at 80 % its see-through part, on the checkerboard.
				await page.keyboard.press("Home");
				await nextFrame(page);
				await nextFrame(page);
				metrics.allRight = { at80: await pixelAt(page, at(0.8), y) };
				metrics.clips = await page.evaluate(() => ({
					under: document.querySelector<HTMLElement>(
						'[data-testid="compare-wipe-under"]',
					)?.style.clipPath,
					top: document.querySelector<HTMLElement>(
						'[data-testid="compare-wipe-after"]',
					)?.style.clipPath,
					underTransition: getComputedStyle(
						document.querySelector<HTMLElement>(
							'[data-testid="compare-wipe-under"]',
						) as HTMLElement,
					).transitionDuration,
				}));
				await page.keyboard.press("PageUp");
				await page.keyboard.press("PageUp");
				await page.keyboard.press("PageUp");
				await page.keyboard.press("PageUp");
				await page.keyboard.press("PageUp");
				await settle(page);
				const run = await stopRecording(page);
				metrics.cls = shiftSum(run);
				metrics.longFrames = run.longFrames;
			} finally {
				await saveRecording(
					flow,
					`history-wipe-transparent-${colorScheme}`,
					metrics,
					{ prefix: "t4", segments: ["transparent-wipe"] },
				);
			}
			expect(flow.errors).toEqual([]);
			expect(metrics.checkerboard).toBe(true);
			const middle = metrics.middle as {
				seeThrough: number[];
				opaque: number[];
			};
			// Right of the cut, where the selected picture is see-through: the
			// checkerboard, not the opaque gradient of the picture compared with.
			expect(
				chroma(middle.seeThrough),
				"the other picture showed through",
			).toBeLessThan(30);
			expect(chroma(middle.opaque)).toBeGreaterThan(60);
			expect(
				chroma((metrics.allLeft as { at80: number[] }).at80),
				"the picture compared with is not shown left of the cut",
			).toBeGreaterThan(60);
			expect(
				chroma((metrics.allRight as { at80: number[] }).at80),
			).toBeLessThan(30);
			const clips = metrics.clips as {
				under: string;
				top: string;
				underTransition: string;
			};
			expect(clips.under).toBe("inset(0px 100% 0px 0px)");
			expect(clips.top).toBe("inset(0px 0px 0px 0%)");
			// No transition on the left side's cut either.
			expect(clips.underTransition).toBe("0s");
			expect(metrics.cls).toBe(0);
			expect(metrics.longFrames).toEqual([]);
		});
	}
});

// ---- Plan 2b T5: pictures in the composer ---------------------------------------

/**
 * Pictures in the composer (plan 2b T5, MOTION-PARITY "By measurement", F19): a
 * picture attached from a card, a strip frame or History becomes a numbered chip;
 * removing one renumbers the rest in the same frame; the send carries the chips and
 * the sent bubble draws its numbered thumbnails from its first paint (F13), so
 * nothing appears above a streaming reply later. What is held:
 *
 * - a chip's box is its final size from its first frame (28 px tall), its numeral
 *   is there with it, and its thumbnail loads into a reserved 18 px square;
 * - a sent bubble's thumbnails exist in the very DOM insertion of the bubble, with
 *   their numbers, and the server's record (after a reload) says the same;
 * - no layout shift the card or the chips did not ask for, no frame over 50 ms
 *   around an attach or a send;
 * - only transform and opacity move in what this task added (the chip's own hover
 *   tint is the existing chip's, reported not held);
 * - on a phone the panel gives way (the full-screen sheet closes) so the chip is
 *   seen; at 360 px in Hungarian the chips do not make the page scroll sideways.
 */

const CHIP = '[data-testid="composer-chip-picture"]';
const CHIP_NUMBER = `${CHIP} [data-testid="composer-chip-number"]`;
const T5_PARTS =
	/^(composer-chip-number|message-picture-chip|image-version-attach|image-version-preview-attach)/;

const T5_TRACK = {
	composer: ".composer-shell",
	chip: CHIP,
	chipNumber: CHIP_NUMBER,
	secondChip: `.composer-chip-item:nth-child(2) ${CHIP}`,
	userChip: '[data-testid="user-message"] [data-testid="message-picture-chip"]',
};

function t5Transitions(run: MotionRun) {
	const seen = run.transitions.filter(
		(entry) => T5_PARTS.test(entry.target) && entry.duration >= 1,
	);
	return {
		properties: [...new Set(seen.map((entry) => entry.property))],
		other: seen.filter(
			(entry) => entry.property !== "opacity" && entry.property !== "transform",
		),
		// The chip's own hover tint: the existing chip's, as on any attachment.
		chipHover: [
			...new Set(
				run.transitions
					.filter(
						(entry) =>
							entry.target === "composer-chip-picture" && entry.duration >= 1,
					)
					.map((entry) => entry.property),
			),
		],
	};
}

/** The chips on screen, in order, as the reader reads them. */
async function composerChips(page: Page) {
	return page.evaluate(() =>
		[...document.querySelectorAll('[data-testid="composer-chip-picture"]')].map(
			(chip) => {
				const box = chip.getBoundingClientRect();
				return {
					number:
						chip.querySelector('[data-testid="composer-chip-number"]')
							?.textContent ?? null,
					name: chip.getAttribute("aria-label"),
					w: box.width,
					h: box.height,
					x: box.x,
					thumbLoaded:
						(chip.querySelector("img") as HTMLImageElement | null)?.complete ===
							true &&
						((chip.querySelector("img") as HTMLImageElement | null)
							?.naturalWidth ?? 0) > 0,
				};
			},
		),
	);
}

function holdChipRun(
	label: string,
	run: MotionRun,
	moments: number[],
	reduced: boolean,
) {
	const cls = shiftsBetween(run, 0, Number.POSITIVE_INFINITY);
	expect(cls, `${label}: layout shift`).toBeLessThanOrEqual(0.01);
	expect(
		longFramesAround(run, moments),
		`${label}: a frame over 50 ms`,
	).toEqual([]);
	expect(
		t5Transitions(run).other,
		`${label}: a transition other than transform/opacity`,
	).toEqual([]);
	const chip = sizeDrift(run.frames, "chip");
	expect(chip.h, `${label}: the chip changed height`).toBeLessThanOrEqual(0.5);
	if (reduced) {
		expect(
			run.transitions.filter(
				(entry) => T5_PARTS.test(entry.target) && entry.duration >= 1,
			),
			`${label}: motion under reduced motion`,
		).toEqual([]);
	}
}

test.describe("pictures in the composer: a card's picture, numbered, sent (T5)", () => {
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

	const VARIANTS = [
		{
			name: "card-send-desktop-light",
			viewport: DESKTOP,
			colorScheme: "light",
		},
		{ name: "card-send-desktop-dark", viewport: DESKTOP, colorScheme: "dark" },
		{ name: "card-send-phone-light", viewport: PHONE, colorScheme: "light" },
		{ name: "card-send-phone-dark", viewport: PHONE, colorScheme: "dark" },
		{
			name: "card-send-desktop-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
		},
	] as const;

	for (const variant of VARIANTS) {
		test(`${variant.name}: Attach from a card adds a numbered chip, and the send shows its thumbnail from the bubble's first paint`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const reduced = "reducedMotion" in variant;
			const flow = await openFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{
					viewport: variant.viewport,
					colorScheme: variant.colorScheme,
					reducedMotion: reduced ? "reduce" : undefined,
				},
			);
			const { page, comfy } = flow;
			const phone = variant.viewport.width < 500;
			let metrics: Record<string, unknown> = {};
			let attachRun: MotionRun | null = null;
			let sendRun: MotionRun | null = null;
			let sentBubbles: Array<{
				chips: number;
				number: string | null;
				thumb: boolean;
			}> = [];
			let afterReload: { number: string | null; name: string | null } | null =
				null;
			try {
				comfy.setOptions({ steps: 4, stepDelayMs: 200 });
				const conversationId = await newChat(flow);
				await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
				await expect(
					page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
				).toBeVisible({ timeout: 45_000 });
				await expect(page.locator(TRACK.loaded)).toBeVisible({
					timeout: 30_000,
				});
				await expect
					.poll(
						async () => (await readCards(page, conversationId))[0]?.artifactId,
						{ timeout: 20_000 },
					)
					.toBeTruthy();
				const [made] = await readCards(page, conversationId);
				await waitForMotionToSettle(page);

				// The sent bubble, the moment it is put in the page.
				await page.evaluate(() => {
					const seen: unknown[] = [];
					(window as unknown as { __sentBubbles: unknown[] }).__sentBubbles =
						seen;
					new MutationObserver((records) => {
						for (const record of records) {
							for (const node of record.addedNodes) {
								if (!(node instanceof Element)) continue;
								const bubbles = node.matches('[data-testid="user-message"]')
									? [node]
									: [...node.querySelectorAll('[data-testid="user-message"]')];
								for (const bubble of bubbles) {
									seen.push({
										chips: bubble.querySelectorAll(
											'[data-testid="message-picture-chip"]',
										).length,
										number:
											bubble.querySelector(
												'[data-testid="composer-chip-number"]',
											)?.textContent ?? null,
										thumb: Boolean(
											bubble.querySelector(
												'[data-testid="message-picture-chip"] img',
											),
										),
									});
								}
							}
						}
					}).observe(document.body, { childList: true, subtree: true });
				});

				const card = page.locator(CARD).last();
				await startRecording(page, T5_TRACK);
				mark(flow, "attach");
				await card.getByRole("button", { name: "More" }).click();
				await page.getByTestId("image-card-attach").click();
				const chip = page.locator(CHIP);
				await expect(chip).toHaveCount(1);
				await expect(chip.getByTestId("composer-chip-number")).toHaveText("1");
				await expect(chip).toHaveAttribute(
					"aria-label",
					`Picture 1: ${AI_SMOKE_LATE_PICTURE_TITLE}`,
				);
				await expect
					.poll(async () => (await composerChips(page))[0]?.thumbLoaded)
					.toBe(true);
				if (!phone) {
					await expect(page.getByTestId("message-input")).toBeFocused();
				}
				await settle(page);
				attachRun = await stopRecording(page);
				const chipsAfterAttach = await composerChips(page);

				await startRecording(page, T5_TRACK);
				mark(flow, "send");
				await sendMessage(
					page,
					`${AI_SMOKE_CHANGE_PICTURE_MARKER} ${made.artifactId}`,
				);
				await expect(
					page.locator('[data-testid="user-message"]').last(),
				).toContainText(AI_SMOKE_CHANGE_PICTURE_MARKER);
				await expect(page.locator(CHIP)).toHaveCount(0);
				await expect(
					page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
				).toBeVisible({ timeout: 45_000 });
				await settle(page);
				sendRun = await stopRecording(page);
				sentBubbles = await page.evaluate(
					() => (window as unknown as { __sentBubbles: never[] }).__sentBubbles,
				);

				// The server's own record says the same.
				await page.reload({ waitUntil: "domcontentloaded" });
				const sent = page
					.locator('[data-testid="user-message"]')
					.filter({ hasText: AI_SMOKE_CHANGE_PICTURE_MARKER })
					.getByTestId("message-picture-chip");
				await expect(sent).toHaveCount(1, { timeout: 20_000 });
				afterReload = {
					number: await sent.getByTestId("composer-chip-number").textContent(),
					name: await sent.getAttribute("aria-label"),
				};

				metrics = {
					chipsAfterAttach,
					attach: {
						cls: shiftsBetween(attachRun, 0, Number.POSITIVE_INFINITY),
						shifts: attachRun.shifts,
						chipDrift: sizeDrift(attachRun.frames, "chip"),
						longFrames: attachRun.longFrames,
						transitions: t5Transitions(attachRun),
					},
					send: {
						cls: shiftsBetween(sendRun, 0, Number.POSITIVE_INFINITY),
						shifts: sendRun.shifts,
						userChipDrift: sizeDrift(sendRun.frames, "userChip"),
						longFrames: sendRun.longFrames,
						transitions: t5Transitions(sendRun),
					},
					sentBubbles,
					afterReload,
				};
			} finally {
				await closeFlow(flow, variant.name, metrics, {
					prefix: "t5",
					segments: ["attach", "send"],
				});
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			if (!attachRun || !sendRun) throw new Error("not measured");

			const chips = metrics.chipsAfterAttach as Awaited<
				ReturnType<typeof composerChips>
			>;
			expect(chips).toHaveLength(1);
			expect(chips[0].number).toBe("1");
			expect(Math.round(chips[0].h), "the chip is 28 px tall").toBe(28);
			holdChipRun("attach", attachRun, [flow.marks.attach], reduced);
			holdChipRun("send", sendRun, [flow.marks.send], reduced);
			// First paint (F13): every bubble put in the page for the sent message already
			// held its numbered thumbnail, the optimistic one and the server's after it.
			expect(sentBubbles.length, "no sent bubble was seen").toBeGreaterThan(0);
			for (const bubble of sentBubbles) {
				expect(bubble.chips).toBe(1);
				expect(bubble.number).toBe("1");
				expect(bubble.thumb).toBe(true);
			}
			expect(sizeDrift(sendRun.frames, "userChip").h).toBeLessThanOrEqual(0.5);
			expect(afterReload).toEqual({
				number: "1",
				name: `Picture 1: ${AI_SMOKE_LATE_PICTURE_TITLE}`,
			});
		});
	}
});

test.describe("pictures in the composer: a strip frame's and a History version's picture, renumbered (T5)", () => {
	test.describe.configure({ mode: "serial" });

	const VARIANTS = [
		{
			name: "strip-history-desktop-light",
			viewport: DESKTOP,
			colorScheme: "light",
		},
		{
			name: "strip-history-desktop-dark",
			viewport: DESKTOP,
			colorScheme: "dark",
		},
		{
			name: "strip-history-desktop-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
		},
	] as const;

	for (const variant of VARIANTS) {
		test(`${variant.name}: Attach on a strip frame and in History add chips 1 and 2, and removing the first makes the other 1`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const reduced = "reducedMotion" in variant;
			const flow = await openSeededFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{
					viewport: variant.viewport,
					colorScheme: variant.colorScheme,
					reducedMotion: reduced ? "reduce" : undefined,
				},
				(user, chatId) => seedPictureHistory(user, chatId),
			);
			const { page } = flow;
			const runs: Record<string, MotionRun> = {};
			const metrics: Record<string, unknown> = {};
			try {
				await openSeededItem(flow, "image");
				const frames = page.locator(
					'[data-testid="image-version-frame"]:visible',
				);
				await expect(frames).toHaveCount(3);

				await startRecording(page, T5_TRACK);
				mark(flow, "strip-attach");
				await frames.first().hover();
				await page.getByTestId("image-version-attach").first().click();
				await expect(page.locator(CHIP)).toHaveCount(1);
				await expect(page.locator(CHIP_NUMBER)).toHaveText("1");
				await expect(page.getByTestId("message-input")).toBeFocused();
				await expect
					.poll(async () => (await composerChips(page))[0]?.thumbLoaded)
					.toBe(true);
				await settle(page);
				runs.stripAttach = await stopRecording(page);

				await historyButton(page).click();
				await expectHistoryShown(page, "image");
				await settle(page);
				await startRecording(page, T5_TRACK);
				mark(flow, "history-attach");
				await page.getByTestId("image-version-preview-attach").click();
				await expect(page.locator(CHIP)).toHaveCount(2);
				await expect(page.locator(CHIP_NUMBER)).toHaveText(["1", "2"]);
				await expect
					.poll(async () =>
						(await composerChips(page)).every((entry) => entry.thumbLoaded),
					)
					.toBe(true);
				await settle(page);
				runs.historyAttach = await stopRecording(page);
				metrics.twoChips = await composerChips(page);

				await startRecording(page, T5_TRACK);
				mark(flow, "remove");
				await page.locator(`${CHIP} .composer-chip__remove`).first().click();
				await expect(page.locator(CHIP)).toHaveCount(1);
				await expect(page.locator(CHIP_NUMBER)).toHaveText("1");
				await settle(page);
				runs.remove = await stopRecording(page);
				metrics.oneChip = await composerChips(page);
				// Both were the same item: the chips are told apart by number, not by name.
				expect((metrics.twoChips as Array<{ name: string }>)[0].name).toBe(
					`Picture 1: ${IMAGE_ITEM_TITLE}`,
				);
				expect((metrics.twoChips as Array<{ name: string }>)[1].name).toBe(
					`Picture 2: ${IMAGE_ITEM_TITLE}`,
				);
				metrics.runs = Object.fromEntries(
					Object.entries(runs).map(([name, run]) => [
						name,
						{
							cls: shiftsBetween(run, 0, Number.POSITIVE_INFINITY),
							shifts: run.shifts,
							longFrames: run.longFrames,
							chipDrift: sizeDrift(run.frames, "chip"),
							transitions: t5Transitions(run),
						},
					]),
				);
			} finally {
				await saveRecording(flow, variant.name, metrics, {
					prefix: "t5",
					segments: ["strip-attach", "history-attach", "remove"],
				});
			}
			expect(flow.errors, "the page logged an error").toEqual([]);
			holdChipRun(
				"strip attach",
				runs.stripAttach,
				[flow.marks["strip-attach"]],
				reduced,
			);
			holdChipRun(
				"History attach",
				runs.historyAttach,
				[flow.marks["history-attach"]],
				reduced,
			);
			holdChipRun("remove", runs.remove, [flow.marks.remove], reduced);
			// The remaining chip is the same size it was, and the numeral changed in place.
			const [one] = metrics.oneChip as Array<{ w: number; h: number }>;
			const [, second] = metrics.twoChips as Array<{ w: number; h: number }>;
			expect(Math.abs(one.w - second.w)).toBeLessThanOrEqual(0.5);
			expect(Math.round(one.h)).toBe(28);
		});
	}
});

test.describe("pictures in the composer on a phone (T5)", () => {
	test.describe.configure({ mode: "serial" });

	for (const variant of [
		{ name: "phone-history-attach-390", viewport: PHONE, language: "en" },
		{
			name: "phone-history-attach-360-hu",
			viewport: { width: 360, height: 780 },
			language: "hu",
		},
	] as const) {
		test(`${variant.name}: a strip frame opens History, Attach there gives the sheet way and the chip shows; two chips do not make the page scroll sideways`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const context = await browser.newContext({
				baseURL: testInfo.project.use.baseURL as string,
				viewport: variant.viewport,
				hasTouch: true,
				isMobile: true,
				recordVideo: { dir: join(OUT_DIR, ".raw"), size: variant.viewport },
			});
			const page = await context.newPage();
			const startedAt = Date.now();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			await installMotionRecorder(page);
			const flow = {
				context,
				page,
				startedAt,
				marks: {} as Record<string, number>,
				errors,
			};
			const hu = variant.language === "hu";
			const metrics: Record<string, unknown> = {};
			const runs: Record<string, MotionRun> = {};
			try {
				const user = await createTourUser(variant.language);
				await markToursSeen(user);
				const chatId = await startChatAs(page, user);
				await seedPictureHistory(user, chatId);
				await reopenChat(page, chatId);
				const attachFromHistory = async (label: string, frame: number) => {
					if (label === "first") {
						await openItem(page, IMAGE_ITEM_TITLE);
					} else {
						// The panel gave way and remembers its item: the count button brings it back.
						await page.getByTestId("artifact-count-button-compact").click();
					}
					await expect(page.locator(PANEL_LOADED).last()).toBeVisible({
						timeout: 20_000,
					});
					await settle(page);
					const frames = page.locator(
						'[data-testid="image-version-frame"]:visible',
					);
					await expect(frames).toHaveCount(3);
					// A finger cannot hit a dot on a 56 px frame: none is drawn on touch.
					await expect(
						page.locator('[data-testid="image-version-attach"]:visible'),
					).toHaveCount(0);
					await frames.nth(frame).tap();
					await expectHistoryShown(page, "image");
					await settle(page);
					await startRecording(page, T5_TRACK);
					mark(flow, label);
					const attach = page.getByTestId("image-version-preview-attach");
					await expect(attach).toBeEnabled();
					const box = await attach.boundingBox();
					metrics[`${label}Target`] = box && { w: box.width, h: box.height };
					await attach.tap();
					await expect(page.locator(".workspace-stage:visible")).toHaveCount(0);
					await expect(page.locator(CHIP)).toHaveCount(
						label === "first" ? 1 : 2,
					);
					await expect
						.poll(async () =>
							(await composerChips(page)).every((entry) => entry.thumbLoaded),
						)
						.toBe(true);
					await settle(page);
					runs[label] = await stopRecording(page);
				};
				await attachFromHistory("first", 0);
				await attachFromHistory("second", 1);
				const names = (await composerChips(page)).map((entry) => entry.name);
				metrics.chips = await composerChips(page);
				metrics.layout = await page.evaluate(() => {
					const send = document.querySelector('[data-testid="send-button"]');
					const box = send?.getBoundingClientRect();
					const row = document.querySelector(
						".composer-chip-item",
					)?.parentElement;
					return {
						pageOverflows:
							document.documentElement.scrollWidth > window.innerWidth + 0.5,
						sendInViewport: Boolean(
							box && box.right <= window.innerWidth + 0.5 && box.left >= 0,
						),
						rowScrollsInside: row
							? row.scrollWidth > row.clientWidth + 0.5
							: false,
					};
				});
				expect(names).toEqual(
					hu
						? [`1. kép: ${IMAGE_ITEM_TITLE}`, `2. kép: ${IMAGE_ITEM_TITLE}`]
						: [
								`Picture 1: ${IMAGE_ITEM_TITLE}`,
								`Picture 2: ${IMAGE_ITEM_TITLE}`,
							],
				);
				metrics.runs = Object.fromEntries(
					Object.entries(runs).map(([name, run]) => [
						name,
						{
							cls: shiftsBetween(run, 0, Number.POSITIVE_INFINITY),
							shifts: run.shifts,
							longFrames: run.longFrames,
							transitions: t5Transitions(run),
						},
					]),
				);
				await page.waitForTimeout(500);
			} finally {
				await saveRecording(flow, variant.name, metrics, {
					prefix: "t5",
					segments: ["first", "second"],
				});
			}
			expect(errors, "the page logged an error").toEqual([]);
			const layout = metrics.layout as {
				pageOverflows: boolean;
				sendInViewport: boolean;
			};
			expect(layout.pageOverflows, "the page scrolls sideways").toBe(false);
			expect(layout.sendInViewport, "Send is pushed off the screen").toBe(true);
			for (const key of ["firstTarget", "secondTarget"]) {
				const target = metrics[key] as { w: number; h: number };
				expect(target.h, `${key}: under 44 px tall`).toBeGreaterThanOrEqual(44);
			}
			for (const chip of metrics.chips as Array<{ h: number }>) {
				expect(Math.round(chip.h)).toBe(28);
			}
			for (const label of ["first", "second"]) {
				holdChipRun(label, runs[label], [flow.marks[label]], false);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Marks (plan 2b T6): lettered boxes on the open picture, sent as one chip.
// ---------------------------------------------------------------------------

const MARK_TRACK = {
	frame: '[data-testid="image-body-frame"]',
	layer: '[data-testid="mark-layer"]',
	draft: '[data-testid="mark-draft"]',
	boxA: '[data-testid="mark-box"][data-letter="A"]',
	boxB: '[data-testid="mark-box"][data-letter="B"]',
	note: '[data-testid="image-body-mark-note"]',
	toggle: '[data-testid="image-body-mark"]',
	chip: '[data-testid="composer-chip-marks"]',
	composer: ".composer-shell",
};
/** The pieces T6 adds, by the recorder's target names. */
const T6_PARTS = /^(mark-|image-body-mark|composer-chip-marks)/;
const MARK_BOX = '[data-testid="mark-box"]';
const MARKS_CHIP = '[data-testid="composer-chip-marks"]';

/**
 * Records, per animation frame, every pointer move over an active marks layer
 * and every time the box being drawn was written, so "the box follows the hand
 * in the frame it moved" is a number: for each move, the frames until the box's
 * corner stood under the pointer.
 */
async function installMarkProbe(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as Record<string, unknown>;
		let frame = 0;
		const tick = () => {
			frame += 1;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		const inputs: Array<{ frame: number; x: number; y: number; t: number }> =
			[];
		const writes: Array<{
			frame: number;
			right: number;
			bottom: number;
			t: number;
		}> = [];
		const draftTransitions = new Set<string>();
		let down: { x: number; y: number } | null = null;
		const active = () =>
			document.querySelector('[data-testid="mark-layer"].is-active') !== null;
		window.addEventListener(
			"pointerdown",
			(event) => {
				if (active()) down = { x: event.clientX, y: event.clientY };
			},
			true,
		);
		window.addEventListener(
			"pointermove",
			(event) => {
				if (!active() || !down) return;
				// The first moves are inside the tap slop: no box yet, by design.
				if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 10)
					return;
				inputs.push({
					frame,
					x: event.clientX,
					y: event.clientY,
					t: performance.now(),
				});
			},
			true,
		);
		window.addEventListener("pointerup", () => (down = null), true);
		const observer = new MutationObserver(() => {
			const draft = document.querySelector<HTMLElement>(
				'[data-testid="mark-draft"]',
			);
			if (!draft) return;
			const rect = draft.getBoundingClientRect();
			const style = getComputedStyle(draft);
			draftTransitions.add(
				`${style.transitionProperty} ${style.transitionDuration}`,
			);
			writes.push({
				frame,
				right: rect.right,
				bottom: rect.bottom,
				t: performance.now(),
			});
		});
		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["style"],
		});
		// A removed box's fade: Svelte samples the easing into keyframes, so the
		// opacity at each offset says which curve it runs on.
		const fadeFrames: Array<Array<{ offset: number; opacity: number }>> = [];
		const animate = Element.prototype.animate;
		Element.prototype.animate = function (
			this: Element,
			keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
			options?: number | KeyframeAnimationOptions,
		) {
			if (
				this.getAttribute("data-testid") === "mark-box" &&
				Array.isArray(keyframes) &&
				keyframes.length > 2
			) {
				fadeFrames.push(
					keyframes.map((frame, index) => ({
						offset: index / (keyframes.length - 1),
						opacity: Number(frame.opacity),
					})),
				);
			}
			return animate.call(this, keyframes, options);
		};
		w.__markProbe = {
			read: () => ({
				inputs: inputs.slice(),
				writes: writes.slice(),
				draftTransitions: [...draftTransitions],
				fadeFrames: fadeFrames.slice(),
			}),
			reset: () => {
				inputs.length = 0;
				writes.length = 0;
				draftTransitions.clear();
			},
		};
	});
}

type MarkProbe = {
	fadeFrames: Array<Array<{ offset: number; opacity: number }>>;
	inputs: Array<{ frame: number; x: number; y: number; t: number }>;
	writes: Array<{ frame: number; right: number; bottom: number; t: number }>;
	draftTransitions: string[];
};

async function readMarkProbe(page: Page): Promise<MarkProbe> {
	return page.evaluate(() =>
		(
			window as unknown as { __markProbe: { read(): unknown } }
		).__markProbe.read(),
	) as Promise<MarkProbe>;
}

/** For each move, the frames until the box's lower right corner stood under the pointer (1.5 px). */
function markLag(probe: MarkProbe) {
	return probe.inputs.map((input) => {
		const write = probe.writes.find(
			(candidate) =>
				candidate.t >= input.t &&
				Math.abs(candidate.right - input.x) <= 1.5 &&
				Math.abs(candidate.bottom - input.y) <= 1.5,
		);
		return write ? write.frame - input.frame : Number.POSITIVE_INFINITY;
	});
}

/** The picture's own rectangle on screen, and a point in it from fractions. */
async function frameBox(page: Page) {
	const box = await page.getByTestId("image-body-frame").boundingBox();
	if (!box) throw new Error("no picture frame on screen");
	return {
		...box,
		at: (fx: number, fy: number) => ({
			x: box.x + box.width * fx,
			y: box.y + box.height * fy,
		}),
	};
}

type Hand = {
	drag(
		from: { x: number; y: number },
		to: { x: number; y: number },
		steps?: number,
	): Promise<void>;
	tap(at: { x: number; y: number }): Promise<void>;
	press(selector: string): Promise<void>;
};

/** A mouse on a desktop, one finger (CDP touch) on a phone. Each move waits for a frame. */
async function handFor(page: Page, phone: boolean): Promise<Hand> {
	if (!phone) {
		return {
			async drag(from, to, steps = 24) {
				await page.mouse.move(from.x, from.y);
				await page.mouse.down();
				for (let step = 1; step <= steps; step++) {
					await page.mouse.move(
						from.x + ((to.x - from.x) * step) / steps,
						from.y + ((to.y - from.y) * step) / steps,
					);
					await nextFrame(page);
				}
				await page.mouse.up();
			},
			async tap(at) {
				await page.mouse.click(at.x, at.y);
			},
			async press(selector) {
				await page.locator(selector).first().click();
			},
		};
	}
	const client = await page.context().newCDPSession(page);
	const touch = (type: string, points: Array<{ x: number; y: number }>) =>
		client.send("Input.dispatchTouchEvent", {
			type,
			touchPoints: points.map((point, id) => ({ ...point, id })),
		});
	return {
		async drag(from, to, steps = 24) {
			await touch("touchStart", [from]);
			for (let step = 1; step <= steps; step++) {
				await touch("touchMove", [
					{
						x: from.x + ((to.x - from.x) * step) / steps,
						y: from.y + ((to.y - from.y) * step) / steps,
					},
				]);
				await nextFrame(page);
			}
			await touch("touchEnd", []);
		},
		async tap(at) {
			await touch("touchStart", [at]);
			await touch("touchEnd", []);
		},
		async press(selector) {
			await page.locator(selector).first().tap();
		},
	};
}

/** Each box on screen against the picture's rectangle, and the fractions it was drawn at. */
async function readMarkBoxes(page: Page) {
	return page.evaluate(() => {
		const frame = document
			.querySelector('[data-testid="image-body-frame"]')
			?.getBoundingClientRect();
		return [
			...document.querySelectorAll<HTMLElement>('[data-testid="mark-box"]'),
		].map((box) => {
			const rect = box.getBoundingClientRect();
			const pct = (value: string) => Number.parseFloat(value) / 100;
			return {
				letter: box.dataset.letter ?? "",
				colour: getComputedStyle(box).borderTopColor,
				onScreen: frame
					? {
							x: (rect.left - frame.left) / frame.width,
							y: (rect.top - frame.top) / frame.height,
							w: rect.width / frame.width,
							h: rect.height / frame.height,
						}
					: null,
				drawn: {
					x: pct(box.style.left),
					y: pct(box.style.top),
					w: pct(box.style.width),
					h: pct(box.style.height),
				},
				transitionDuration: getComputedStyle(box).transitionDuration,
			};
		});
	});
}

/** The largest gap, in fractions of the picture, between where a box stands and where it was drawn. */
function misalignment(boxes: Awaited<ReturnType<typeof readMarkBoxes>>) {
	let worst = 0;
	for (const box of boxes) {
		if (!box.onScreen) return Number.POSITIVE_INFINITY;
		for (const key of ["x", "y", "w", "h"] as const) {
			worst = Math.max(worst, Math.abs(box.onScreen[key] - box.drawn[key]));
		}
	}
	return worst;
}

/** The --ease-out token, cubic-bezier(0.4, 0, 0.2, 1), at time t (bisection on x). */
function easeOutAt(t: number): number {
	const at = (a: number, b: number, s: number) =>
		3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
	let low = 0;
	let high = 1;
	for (let step = 0; step < 50; step++) {
		const mid = (low + high) / 2;
		if (at(0.4, 0.2, mid) < t) low = mid;
		else high = mid;
	}
	return at(0, 1, (low + high) / 2);
}

/** How far each sampled fade is from 1 - easeOut(offset): the worst gap, and how many fades. */
function easeOutGap(fades: MarkProbe["fadeFrames"]) {
	let worst = 0;
	for (const frames of fades) {
		for (const frame of frames) {
			worst = Math.max(
				worst,
				Math.abs(frame.opacity - (1 - easeOutAt(frame.offset))),
			);
		}
	}
	return { fades: fades.length, worstGap: worst };
}

function t6Transitions(run: MotionRun) {
	const seen = run.transitions.filter(
		(entry) => T6_PARTS.test(entry.target) && entry.duration >= 1,
	);
	return {
		properties: [...new Set(seen.map((entry) => entry.property))],
		other: seen.filter(
			(entry) => entry.property !== "opacity" && entry.property !== "transform",
		),
	};
}

function markFades(run: MotionRun) {
	return run.animations.filter((entry) => entry.target === "mark-box");
}

/** What a T6 interaction measured: its shifts not caused by the hand, long frames and the motion of the added parts. */
function t6Step(run: MotionRun) {
	return {
		cls: shiftSum(run, { ignoreRecentInput: true }),
		allShifts: shiftSum(run),
		longFrames: run.longFrames,
		transitions: t6Transitions(run),
		fades: markFades(run),
	};
}

type T6Step = ReturnType<typeof t6Step>;

function holdT6Step(label: string, step: T6Step, reduced: boolean) {
	expect(step.cls, `${label}: a shift not caused by the hand`).toBe(0);
	expect(step.longFrames, `${label}: a frame over 50 ms`).toEqual([]);
	expect(
		step.transitions.other,
		`${label}: something other than opacity or transform animated`,
	).toEqual([]);
	for (const fade of step.fades) {
		// A removed box fades, on opacity alone, over the standard duration (none under reduced motion).
		expect(fade.properties, `${label}: a box's removal`).toEqual(["opacity"]);
		expect(fade.duration).toBe(reduced ? 0 : 150);
	}
}

test.describe("marks on the open picture (T6)", () => {
	test.describe.configure({ mode: "serial" });

	const VARIANTS = [
		{ name: "draw-desktop-light", viewport: DESKTOP, colorScheme: "light" },
		{ name: "draw-desktop-dark", viewport: DESKTOP, colorScheme: "dark" },
		{
			name: "draw-desktop-reduced-motion",
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
		},
		{ name: "draw-phone-light", viewport: PHONE, colorScheme: "light" },
		{ name: "draw-phone-dark", viewport: PHONE, colorScheme: "dark" },
		{
			name: "draw-phone-360-hu",
			viewport: { width: 360, height: 780 },
			colorScheme: "light",
			language: "hu",
		},
	] as const;

	for (const variant of VARIANTS) {
		test(`${variant.name}: boxes follow the hand, a tap fades one out, the chip shows and its x clears them`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(240_000);
			const phone = variant.viewport.width < 500;
			const reduced = "reducedMotion" in variant;
			const hu = "language" in variant;
			const flow = await openSeededFlow(
				browser,
				testInfo.project.use.baseURL as string,
				{
					viewport: variant.viewport,
					colorScheme: variant.colorScheme,
					reducedMotion: reduced ? "reduce" : undefined,
					language: hu ? "hu" : "en",
				},
				(user, chatId) => seedPictureHistory(user, chatId, 2),
			);
			const { page } = flow;
			const metrics: Record<string, unknown> = {};
			const steps: Record<string, T6Step> = {};
			try {
				await openSeededItem(flow, "image");
				const hand = await handFor(page, phone);
				await installMarkProbe(page);

				// The toggle: Mark on, the hint over the picture.
				await startRecording(page, MARK_TRACK);
				mark(flow, "toggle");
				await hand.press(MARK_TRACK.toggle);
				await expect(page.getByTestId("image-body-mark")).toHaveAttribute(
					"aria-pressed",
					"true",
				);
				await expect(page.getByTestId("image-body-mark-note")).toHaveText(
					hu ? "Húzással rajzolj keretet" : "Drag to draw a box",
				);
				await settle(page);
				steps.toggle = t6Step(await stopRecording(page));
				metrics.toggleTarget = await page
					.getByTestId("image-body-mark")
					.evaluate((node) => {
						const rect = node.getBoundingClientRect();
						return { w: rect.width, h: rect.height };
					});

				// Two boxes, A then B, drawn by the hand.
				let frame = await frameBox(page);
				await startRecording(page, MARK_TRACK);
				mark(flow, "draw");
				await hand.drag(frame.at(0.1, 0.15), frame.at(0.45, 0.6));
				await hand.drag(frame.at(0.55, 0.3), frame.at(0.9, 0.85));
				await expect(page.locator(MARK_BOX)).toHaveCount(2);
				await expect(page.locator(MARKS_CHIP)).toHaveCount(1);
				await settle(page);
				steps.draw = t6Step(await stopRecording(page));
				const probe = await readMarkProbe(page);
				metrics.draw = {
					moves: probe.inputs.length,
					lagFrames: [...new Set(markLag(probe))],
					draftTransitions: probe.draftTransitions,
					boxes: await readMarkBoxes(page),
					chipText: await page.locator(MARKS_CHIP).textContent(),
				};

				// A tap on A removes it, fading.
				frame = await frameBox(page);
				await startRecording(page, MARK_TRACK);
				mark(flow, "remove");
				await hand.tap(frame.at(0.2, 0.3));
				await expect(page.locator(MARK_BOX)).toHaveCount(1);
				await settle(page);
				steps.remove = t6Step(await stopRecording(page));
				metrics.fadeCurve = easeOutGap((await readMarkProbe(page)).fadeFrames);

				if (!phone) {
					// Up to eight: the ninth is refused, and the note says so.
					await startRecording(page, MARK_TRACK);
					mark(flow, "too-many");
					for (let index = 0; index < 8; index++) {
						const left = 0.02 + index * 0.11;
						await hand.drag(
							frame.at(left, 0.03),
							frame.at(left + 0.08, 0.2),
							8,
						);
					}
					await expect(page.locator(MARK_BOX)).toHaveCount(8);
					await expect(page.getByTestId("image-body-mark-note")).toHaveText(
						"Up to 8 marks",
					);
					await settle(page);
					steps.tooMany = t6Step(await stopRecording(page));
					metrics.tooManyNoteOpacity = await page
						.getByTestId("image-body-mark-note")
						.evaluate((node) => getComputedStyle(node).opacity);
				} else {
					// Two fingers are the zoom's, Mark on or off; the boxes zoom with the picture.
					const client = await page.context().newCDPSession(page);
					const touch = (
						type: string,
						points: Array<{ x: number; y: number }>,
					) =>
						client.send("Input.dispatchTouchEvent", {
							type,
							touchPoints: points.map((point, id) => ({ ...point, id })),
						});
					// Fix round 1 (I1): a second finger beside the picture, in the stage's
					// band, drops the box being drawn: nothing is committed.
					const stageBox = await page
						.getByTestId("image-body-stage")
						.boundingBox();
					if (!stageBox) throw new Error("no stage on screen");
					const band = {
						x: frame.x + frame.width / 2,
						y: (frame.y + frame.height + stageBox.y + stageBox.height) / 2,
					};
					mark(flow, "band-finger");
					const before = await page.locator(MARK_BOX).count();
					const start = frame.at(0.1, 0.4);
					await touch("touchStart", [start]);
					for (let step = 1; step <= 8; step++) {
						await touch("touchMove", [
							{ x: start.x + step * 6, y: start.y + step * 4 },
						]);
						await nextFrame(page);
					}
					const drawingBeforeBand = await page
						.getByTestId("mark-draft")
						.count();
					await touch("touchStart", [
						{ x: start.x + 48, y: start.y + 32 },
						band,
					]);
					await nextFrame(page);
					const drawingAfterBand = await page.getByTestId("mark-draft").count();
					await touch("touchMove", [
						{ x: start.x + 70, y: start.y + 50 },
						{ x: band.x, y: band.y + 10 },
					]);
					await touch("touchEnd", []);
					await settle(page);
					metrics.bandFinger = {
						bandBelowPicture: band.y > frame.y + frame.height,
						drawingBeforeBand,
						drawingAfterBand,
						boxesBefore: before,
						boxesAfter: await page.locator(MARK_BOX).count(),
					};
					const centre = frame.at(0.5, 0.5);
					await startRecording(page, MARK_TRACK);
					mark(flow, "zoom");
					await touch("touchStart", [{ x: centre.x - 30, y: centre.y }]);
					await touch("touchStart", [
						{ x: centre.x - 30, y: centre.y },
						{ x: centre.x + 30, y: centre.y },
					]);
					for (let step = 1; step <= 10; step++) {
						await touch("touchMove", [
							{ x: centre.x - 30 - step * 3, y: centre.y },
							{ x: centre.x + 30 + step * 3, y: centre.y },
						]);
						await nextFrame(page);
					}
					await touch("touchEnd", []);
					await settle(page);
					const zoomed = await frameBox(page);
					// A box drawn on the zoomed picture (in its part on screen) lands where the finger drew it.
					await hand.drag(zoomed.at(0.4, 0.4), zoomed.at(0.55, 0.6));
					await expect(page.locator(MARK_BOX)).toHaveCount(2);
					await settle(page);
					// Fix round 1: two quick taps in Mark mode (on no box) keep the zoom.
					mark(flow, "double-tap");
					const empty = zoomed.at(0.3, 0.75);
					for (let tap = 0; tap < 2; tap++) {
						await hand.tap(empty);
						await page.waitForTimeout(80);
					}
					await settle(page);
					const afterDoubleTap = await frameBox(page);
					steps.zoom = t6Step(await stopRecording(page));
					const boxes = await readMarkBoxes(page);
					metrics.zoom = {
						scaleAfterDoubleTap: afterDoubleTap.width / frame.width,
						scale: zoomed.width / frame.width,
						boxes,
						misalignment: misalignment(boxes),
						drawnOnZoomed: boxes.find((box) => box.letter === "A")?.drawn,
						sheetStillOpen: await page.locator(MOBILE_SHELL).isVisible(),
					};
					// The sheet gives way; the marks stay for the message (F14).
					await page.locator(".workspace-close-button:visible").first().tap();
					await expect(page.locator(MOBILE_SHELL)).toHaveCount(0);
					await settle(page);
				}

				// The chip in the composer, then its x.
				const chip = page.locator(MARKS_CHIP);
				await expect(chip).toBeVisible();
				const letters = phone ? "B, A" : "B, A, C, D, E, F, G, H";
				await expect(chip).toContainText(
					hu ? `${letters} jelölés` : `Marks ${letters}`,
				);
				metrics.chip = await chip.evaluate((node) => {
					const rect = node.getBoundingClientRect();
					const img = node.querySelector("img");
					return {
						x: rect.x,
						right: rect.right,
						h: rect.height,
						number:
							node.querySelector('[data-testid="composer-chip-number"]')
								?.textContent ?? null,
						thumb: Boolean(img?.complete && img.naturalWidth > 0),
						label: node.getAttribute("aria-label"),
						viewport: window.innerWidth,
						pageScrollsSideways:
							document.scrollingElement !== null &&
							document.scrollingElement.scrollWidth > window.innerWidth,
					};
				});
				await startRecording(page, MARK_TRACK);
				mark(flow, "chip-clear");
				await hand.press(
					`${MARKS_CHIP} button[aria-label="${hu ? "Jelölések törlése" : "Remove the marks"}"]`,
				);
				await expect(chip).toHaveCount(0);
				if (!phone) await expect(page.locator(MARK_BOX)).toHaveCount(0);
				await settle(page);
				steps.chipClear = t6Step(await stopRecording(page));
			} finally {
				metrics.steps = steps;
				await saveRecording(flow, variant.name, metrics, {
					prefix: "t6",
					segments: [
						"toggle",
						"draw",
						"remove",
						"too-many",
						"zoom",
						"chip-clear",
					],
				});
			}
			expect(flow.errors, "the page logged an error").toEqual([]);

			const draw = metrics.draw as {
				moves: number;
				lagFrames: number[];
				draftTransitions: string[];
				boxes: Awaited<ReturnType<typeof readMarkBoxes>>;
			};
			expect(draw.moves, "the hand never drew").toBeGreaterThan(20);
			// The owner's bar: the box is written in the frame its pointer moved, lag 0.
			expect(draw.lagFrames).toEqual([0]);
			// Nothing eases the box being drawn: no transition on its position.
			for (const entry of draw.draftTransitions) {
				// "none" or a zero duration (the reduced-motion rule writes 0.01 ms on everything).
				expect(
					entry.startsWith("none ") || entry.endsWith(" 0s"),
					`the box being drawn: ${entry}`,
				).toBe(true);
			}
			expect(draw.boxes.map((box) => box.letter)).toEqual(["A", "B"]);
			// MARK_COLOURS: A red, B blue.
			expect(draw.boxes.map((box) => box.colour)).toEqual([
				"rgb(229, 57, 53)",
				"rgb(30, 136, 229)",
			]);
			for (const box of draw.boxes) {
				expect(["0s", "1e-05s"]).toContain(box.transitionDuration);
			}
			expect(misalignment(draw.boxes)).toBeLessThan(0.01);
			const a = draw.boxes[0].drawn;
			expect(a.x).toBeCloseTo(0.1, 1);
			expect(a.y).toBeCloseTo(0.15, 1);
			expect(a.w).toBeCloseTo(0.35, 1);
			expect(a.h).toBeCloseTo(0.45, 1);

			for (const [label, step] of Object.entries(steps)) {
				holdT6Step(label, step, reduced);
			}
			// The removal faded (instantly under reduced motion).
			if (!reduced) {
				// The removal fade runs on the ease-out token.
				const curve = metrics.fadeCurve as { fades: number; worstGap: number };
				expect(curve.fades).toBeGreaterThan(0);
				expect(curve.worstGap).toBeLessThan(0.02);
				expect(steps.remove.fades.length).toBeGreaterThan(0);
				if (!phone) expect(steps.chipClear.fades.length).toBeGreaterThan(0);
			}

			const chip = metrics.chip as {
				x: number;
				right: number;
				h: number;
				number: string | null;
				thumb: boolean;
				label: string | null;
				viewport: number;
				pageScrollsSideways: boolean;
			};
			expect(Math.round(chip.h), "the chip is 28 px tall").toBe(28);
			expect(chip.thumb, "the chip shows the picture's thumbnail").toBe(true);
			expect(chip.number).toBe("1");
			expect(chip.pageScrollsSideways).toBe(false);
			expect(chip.x).toBeGreaterThanOrEqual(0);
			if (phone) {
				const zoom = metrics.zoom as {
					scale: number;
					misalignment: number;
					drawnOnZoomed: { x: number; y: number; w: number; h: number };
					sheetStillOpen: boolean;
				};
				expect(zoom.scale).toBeGreaterThan(1.5);
				expect(
					(zoom as unknown as { scaleAfterDoubleTap: number })
						.scaleAfterDoubleTap,
					"a double tap in Mark mode reset the zoom",
				).toBeCloseTo(zoom.scale, 2);
				expect(metrics.bandFinger).toEqual({
					bandBelowPicture: true,
					drawingBeforeBand: 1,
					drawingAfterBand: 0,
					boxesBefore: 1,
					boxesAfter: 1,
				});
				// The boxes stand where they were drawn on the zoomed picture.
				expect(zoom.misalignment).toBeLessThan(0.01);
				// A box drawn at 40 % to 55 % of the zoomed picture is 40 % to 55 % of the picture.
				expect(zoom.drawnOnZoomed.x).toBeCloseTo(0.4, 1);
				expect(zoom.drawnOnZoomed.w).toBeCloseTo(0.15, 1);
				expect(zoom.drawnOnZoomed.y).toBeCloseTo(0.4, 1);
				expect(zoom.drawnOnZoomed.h).toBeCloseTo(0.2, 1);
				expect(zoom.sheetStillOpen).toBe(true);
				const toggle = metrics.toggleTarget as { w: number; h: number };
				expect(toggle.w).toBeGreaterThanOrEqual(44);
				expect(toggle.h).toBeGreaterThanOrEqual(44);
			} else {
				expect(metrics.tooManyNoteOpacity).toBe("1");
			}
		});
	}

	test("other-item-clears: opening another item lets the marks and their chip go (Review Focus 4)", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(180_000);
		const flow = await openSeededFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
			async (user, chatId) => {
				await seedPictureHistory(user, chatId, 2);
				await seedDocumentHistory(user, chatId);
			},
		);
		const { page } = flow;
		const metrics: Record<string, unknown> = {};
		try {
			await openSeededItem(flow, "image");
			const hand = await handFor(page, false);
			await hand.press(MARK_TRACK.toggle);
			const frame = await frameBox(page);
			await hand.drag(frame.at(0.1, 0.1), frame.at(0.4, 0.5));
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);
			mark(flow, "open-other");
			// The panel's way back to its list, then the other item (the count
			// button would close the panel: a closed panel keeps the marks, F14).
			await backToList(page);
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);
			await openItem(page, DOCUMENT_TITLE);
			await expect(page.locator(`${DOC_BODY}:visible`).first()).toBeVisible({
				timeout: 20_000,
			});
			await expect(page.locator(MARKS_CHIP)).toHaveCount(0);
			metrics.chipAfterOther = await page.locator(MARKS_CHIP).count();
			// Back on the picture: nothing of the old marks is left.
			await backToList(page);
			await openItem(page, IMAGE_ITEM_TITLE);
			await expect(page.locator(PANEL_LOADED).first()).toBeVisible({
				timeout: 20_000,
			});
			metrics.boxesBack = await page.locator(MARK_BOX).count();
		} finally {
			await saveRecording(flow, "other-item-clears", metrics, {
				prefix: "t6",
			});
		}
		expect(flow.errors).toEqual([]);
		expect(metrics.chipAfterOther).toBe(0);
		expect(metrics.boxesBack).toBe(0);
	});
});

test.describe("marks sent with a message, and left from an older picture (T6)", () => {
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

	test("version-clears-and-send: a newer version lets the marks go; marks on a closed panel ride the send with their picture (F14)", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(240_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
		);
		const { page, comfy } = flow;
		const metrics: Record<string, unknown> = {};
		let sentBody: Record<string, unknown> | null = null;
		try {
			const { artifactId } = await makePicture(flow);
			await page.locator(CARD).last().getByTestId("artifact-card-head").click();
			await expect(page.locator(PANEL_LOADED).first()).toBeVisible({
				timeout: 20_000,
			});
			await settle(page);
			const hand = await handFor(page, false);
			await hand.press(MARK_TRACK.toggle);
			let frame = await frameBox(page);
			await hand.drag(frame.at(0.1, 0.1), frame.at(0.4, 0.5));
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);

			// A newer version of the item lands (Another, then Use this): the marks go.
			comfy.setOptions({ steps: 3, stepDelayMs: 150 });
			mark(flow, "new-version");
			await page.locator(CARD).last().getByTestId("image-card-another").click();
			await expect(page.getByTestId("image-card-use")).toBeVisible({
				timeout: 30_000,
			});
			await page.getByTestId("image-card-use").click();
			await expect(page.locator(MARKS_CHIP)).toHaveCount(0, {
				timeout: 15_000,
			});
			await expect(page.locator(MARK_BOX)).toHaveCount(0);
			metrics.clearedOnVersion = true;

			// New marks on the newer picture, then the panel is closed before the send.
			await settle(page);
			await expect(page.getByTestId("image-body-mark")).toBeVisible();
			if (
				(await page
					.getByTestId("image-body-mark")
					.getAttribute("aria-pressed")) !== "true"
			) {
				await hand.press(MARK_TRACK.toggle);
			}
			frame = await frameBox(page);
			await hand.drag(frame.at(0.2, 0.2), frame.at(0.5, 0.6));
			await hand.drag(frame.at(0.6, 0.3), frame.at(0.9, 0.7));
			await expect(page.locator(MARKS_CHIP)).toContainText("Marks A, B");
			const fileId = await page
				.locator(MARKS_CHIP)
				.locator("img")
				.getAttribute("src");
			metrics.chipThumb = fileId;
			await page.locator(".workspace-close-button:visible").first().click();
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);

			mark(flow, "send");
			const request = page.waitForRequest(
				(candidate) =>
					candidate.method() === "POST" &&
					new URL(candidate.url()).pathname === "/api/chat/stream",
			);
			await sendMessage(
				page,
				`${AI_SMOKE_CHANGE_PICTURE_MARKER} ${artifactId}`,
			);
			sentBody = (await request).postDataJSON() as Record<string, unknown>;
			await expect(page.locator(MARKS_CHIP)).toHaveCount(0);
			await expect(
				page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
			metrics.sentBody = {
				imageMarks: sentBody.imageMarks,
				pictureRefs: sentBody.pictureRefs,
				markedPicture: sentBody.markedPicture ?? null,
				pictures: sentBody.pictures ?? null,
			};

			// The server's record: the marked picture rode as picture 1.
			await page.reload({ waitUntil: "domcontentloaded" });
			const sent = page
				.locator('[data-testid="user-message"]')
				.filter({ hasText: AI_SMOKE_CHANGE_PICTURE_MARKER })
				.getByTestId("message-picture-chip");
			await expect(sent).toHaveCount(1, { timeout: 20_000 });
			metrics.afterReload = await sent
				.getByTestId("composer-chip-number")
				.textContent();
		} finally {
			await closeFlow(flow, "version-clears-and-send", metrics, {
				prefix: "t6",
				segments: ["new-version", "send"],
			});
		}
		expect(flow.errors, "the page logged an error").toEqual([]);
		expect(metrics.clearedOnVersion).toBe(true);
		const body = metrics.sentBody as {
			imageMarks: {
				imageFileId: string;
				marks: Array<{
					letter: string;
					x: number;
					y: number;
					w: number;
					h: number;
				}>;
			};
			pictureRefs: Array<{ imageFileId: string; number: number }>;
			markedPicture: unknown;
			pictures: unknown;
		};
		expect(body.imageMarks.marks.map((entry) => entry.letter)).toEqual([
			"A",
			"B",
		]);
		const first = body.imageMarks.marks[0];
		expect(first.x).toBeCloseTo(0.2, 1);
		expect(first.w).toBeCloseTo(0.3, 1);
		// F14: the panel was closed, so the marked picture rides as a ref.
		expect(body.pictureRefs).toEqual([
			{ imageFileId: body.imageMarks.imageFileId, number: 1 },
		]);
		expect(String(metrics.chipThumb)).toContain(body.imageMarks.imageFileId);
		// Client-only fields never go on the wire.
		expect(body.markedPicture).toBeNull();
		expect(body.pictures).toBeNull();
		expect(metrics.afterReload).toBe("1");
	});

	test("queued-older-marks: marks queued while a turn runs go when a newer version lands before the queued message is edited (fix round 1, I2)", async ({
		browser,
	}, testInfo) => {
		test.setTimeout(240_000);
		const flow = await openFlow(
			browser,
			testInfo.project.use.baseURL as string,
			{ viewport: DESKTOP },
		);
		const { page, comfy } = flow;
		const metrics: Record<string, unknown> = {};
		try {
			await makePicture(flow);
			await page.locator(CARD).last().getByTestId("artifact-card-head").click();
			await expect(page.locator(PANEL_LOADED).first()).toBeVisible({
				timeout: 20_000,
			});
			await settle(page);

			// A turn that runs until it is stopped: the stream request is held.
			let held = false;
			await page.route("**/api/chat/stream", async (route) => {
				if (route.request().method() !== "POST" || held) {
					await route.fallback();
					return;
				}
				held = true;
				// Never answered: the page stays in "generating" until Stop.
			});
			await sendMessage(page, "Think about the colours for a while.");
			await expect(page.getByTestId("stop-button")).toBeVisible();

			// Marks on the picture as it is now, queued with "move A to B".
			const hand = await handFor(page, false);
			await hand.press(MARK_TRACK.toggle);
			const frame = await frameBox(page);
			await hand.drag(frame.at(0.1, 0.1), frame.at(0.4, 0.5));
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);
			await page.getByTestId("message-input").fill("Move A to B");
			await page.getByTestId("queue-button").click();
			await expect(page.getByTestId("queued-message-banner")).toBeVisible();
			await expect(page.locator(MARKS_CHIP)).toHaveCount(0);

			// A newer version lands while the turn still runs.
			comfy.setOptions({ steps: 3, stepDelayMs: 150 });
			mark(flow, "new-version");
			await page.locator(CARD).last().getByTestId("image-card-another").click();
			await expect(page.getByTestId("image-card-use")).toBeVisible({
				timeout: 30_000,
			});
			await page.getByTestId("image-card-use").click();
			await expect(
				page.locator(CARD).last().getByTestId("image-card-use"),
			).toBeHidden({ timeout: 15_000 });
			await settle(page);

			// Edit the queued message: its text comes back, its old marks do not.
			mark(flow, "edit-queued");
			await page.getByTestId("edit-queued-button").click();
			await expect(page.getByTestId("message-input")).toHaveValue(
				"Move A to B",
			);
			await settle(page);
			metrics.chipAfterEdit = await page.locator(MARKS_CHIP).count();
			metrics.boxesAfterEdit = await page.locator(MARK_BOX).count();
			await page.getByTestId("stop-button").click();
			await settle(page);
		} finally {
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await closeFlow(flow, "queued-older-marks", metrics, {
				prefix: "t6",
				segments: ["new-version", "edit-queued"],
			});
		}
		expect(flow.errors, "the page logged an error").toEqual([]);
		expect(metrics.chipAfterEdit, "the old marks came back as a chip").toBe(0);
		expect(
			metrics.boxesAfterEdit,
			"the old boxes came back over the newer picture",
		).toBe(0);
	});
});
