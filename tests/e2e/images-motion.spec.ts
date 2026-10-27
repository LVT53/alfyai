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
import { AI_SMOKE_LATE_CARD_MARKER } from "../fixtures/ai/late-card-scenario";
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
import { createEmptyConversation, login, sendMessage } from "./helpers";
import {
	type FakeComfyUi,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
} from "./images-helpers";
import {
	installMotionRecorder,
	type MotionFrame,
	type MotionRun,
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
): Promise<void> {
	const { page, context } = flow;
	await updateUserModelPreference(page, flow.previousModel);
	await deleteTemporaryProvider(page, flow.providerId);
	await stopFakeComfyUiForSpec(page, flow.comfy);
	const video = page.video();
	await context.close();
	mkdirSync(OUT_DIR, { recursive: true });
	const videoPath = join(OUT_DIR, `t2-${name}.webm`);
	if (video) await video.saveAs(videoPath);
	writeFileSync(
		join(OUT_DIR, `t2-${name}.json`),
		`${JSON.stringify({ name, marks: flow.marks, pageErrors: flow.errors, ...metrics }, null, 2)}\n`,
	);
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
			join(OUT_DIR, `t2-${name}-sheet-%02d.png`),
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
