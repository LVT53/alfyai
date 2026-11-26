import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	expect,
	type Page,
} from "@playwright/test";
import { updateArtifactBody } from "../../src/lib/server/services/artifacts";
import {
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
} from "../fixtures/ai/late-picture-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	assistantAnswer,
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	expectTerminalActivityGone,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
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

/**
 * Where the owner's demo reel goes: set MOTION_VIDEO_DIR to record videos, numbers
 * and contact sheets there. Unset, nothing is recorded or written and the bars
 * are held all the same.
 */
export const OUT_DIR = process.env.MOTION_VIDEO_DIR ?? null;

export const DESKTOP = { width: 1440, height: 900 };

export const PHONE = { width: 390, height: 844 };

export const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';

const STAGE = '[data-testid="image-card-stage"]';

// Arrival geometry follows existing live status; final answer has its own boundary.
export const PROSE = '[data-testid="assistant-message"] .thinking-header';

export const BODY_STATE = (state: string) =>
	`[data-testid="image-card-body"][data-state="${state}"]`;

export const fakeProvider = createOpenAICompatibleProviderHarness();

export type Flow = {
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

export async function openFlow(
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
		recordVideo: OUT_DIR
			? { dir: join(OUT_DIR, ".raw"), size: options.viewport }
			: undefined,
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
export async function closeFlow(
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
export async function saveRecording(
	flow: Pick<Flow, "context" | "page" | "marks" | "errors">,
	name: string,
	metrics: Record<string, unknown>,
	options: { prefix?: string; segments?: string[] } = {},
): Promise<void> {
	const prefix = options.prefix ?? "t2";
	const { page, context } = flow;
	const video = page.video();
	await context.close();
	if (!OUT_DIR) return;
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

export function mark(
	flow: { marks: Record<string, number>; startedAt: number },
	label: string,
): void {
	flow.marks[label] = Date.now() - flow.startedAt;
}

export async function newChat(flow: Flow): Promise<string> {
	const conversationId = await createEmptyConversation(flow.page);
	await flow.page.goto(`/chat/${conversationId}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(flow.page.getByTestId("message-input")).toBeVisible();
	return conversationId;
}

/** The first frame (index) a tracked element is on screen, or -1. */
export function firstSeen(frames: MotionFrame[], name: string): number {
	return frames.findIndex((frame) => frame.tracked[name] != null);
}

export function boxes(frames: MotionFrame[], name: string): TrackedBox[] {
	return frames
		.map((frame) => frame.tracked[name])
		.filter((box): box is TrackedBox => box != null);
}

/** How far a tracked box's size wandered from its first frame, in px. */
export function sizeDrift(frames: MotionFrame[], name: string) {
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

export const isCardShift = (entry: MotionRun["shifts"][number]) =>
	(entry.sources ?? []).some((source) => CARD_SOURCES.test(source));

/** The card's own layout shifts in [from, to) ms, without the ones input caused (500 ms window). */
export function shiftsBetween(run: MotionRun, from: number, to: number) {
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

/** Long animation frames within `margin` ms of any of the given moments. */
export function longFramesAround(
	run: MotionRun,
	moments: number[],
	margin = 400,
) {
	return run.longFrames.filter((frame) =>
		moments.some(
			(moment) =>
				frame.t + frame.duration >= moment - margin &&
				frame.t <= moment + margin,
		),
	);
}

/** The time (ms since recording) of the first frame a state is on screen. */
export function momentOf(run: MotionRun, name: string): number | null {
	const index = firstSeen(run.frames, name);
	return index < 0 ? null : run.frames[index].t;
}

export const TRACK = {
	card: CARD,
	stage: STAGE,
	prose: PROSE,
	answer: '[data-testid="assistant-message"] .prose-container p',
	stop: '[data-testid="stop-button"]',
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

/** What `GET /api/conversations/[id]` says about its picture cards. */
export async function readCards(page: Page, conversationId: string) {
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

export const PANEL_LOADED =
	'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded';

export const DOC_BODY = ".workspace-stage .ProseMirror";

export const MOBILE_SHELL = '[data-testid="document-workspace-mobile-shell"]';

/** Makes a picture through the chat (fake model, fake ComfyUI's gradient) and returns its item. */
export async function makePicture(flow: Flow) {
	const { page, comfy } = flow;
	comfy.setOptions({ steps: 3, stepDelayMs: 150 });
	const conversationId = await newChat(flow);
	await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
	await expect(page.locator(TRACK.loaded).last()).toBeVisible({
		timeout: 45_000,
	});
	await expect(
		assistantAnswer(page).getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
	).toBeVisible({
		timeout: 30_000,
	});
	await expectTerminalActivityGone(page);
	await expect
		.poll(async () => (await readCards(page, conversationId))[0]?.artifactId, {
			timeout: 20_000,
		})
		.toBeTruthy();
	const [card] = await readCards(page, conversationId);
	return { conversationId, artifactId: card.artifactId as string };
}

/**
 * Waits for the page to be still, on its own state rather than a guessed
 * time (final review A-M4): no finite animation or transition running, no
 * scroll moving, every picture decoded and the shell's boxes unchanged, for
 * QUIET_FRAMES frames in a row. A step whose motion starts a few frames late
 * (after a fetch) resets the count instead of being measured mid-motion.
 */
const QUIET_FRAMES = 8;

export async function settle(page: Page) {
	await waitForMotionToSettle(page);
	await page.waitForFunction(
		(needed) => {
			type Quiet = { last: string; count: number };
			const store = window as unknown as { __settle?: Quiet };
			const running = document
				.getAnimations()
				.filter(
					(animation) =>
						animation.playState === "running" &&
						animation.effect?.getComputedTiming().iterations !== Infinity,
				).length;
			const box = (selector: string) => {
				const rect = document.querySelector(selector)?.getBoundingClientRect();
				return rect
					? [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(",")
					: "-";
			};
			const scrollers = [...document.querySelectorAll(".scroll-container")]
				.map((element) => Math.round(element.scrollTop))
				.join(",");
			const undecoded = [...document.images].filter(
				(image) => image.src && !image.complete,
			).length;
			const now = [
				running,
				undecoded,
				scrollers,
				box("aside.workspace-shell-desktop"),
				box(".workspace-content"),
				box('[data-testid="image-picture"]'),
			].join("|");
			const quiet = store.__settle ?? { last: "", count: 0 };
			quiet.count =
				running === 0 && undecoded === 0 && now === quiet.last
					? quiet.count + 1
					: 0;
			quiet.last = now;
			store.__settle = quiet;
			if (quiet.count < needed) return false;
			store.__settle = undefined;
			return true;
		},
		QUIET_FRAMES,
		{ polling: "raf", timeout: 10_000 },
	);
}

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
export type SeededFlow = {
	context: BrowserContext;
	page: Page;
	startedAt: number;
	marks: Record<string, number>;
	errors: string[];
	user: TourUser;
	chatId: string;
};

export const DOCUMENT_TITLE = "Trip notes";

export async function openSeededFlow(
	browser: Browser,
	baseURL: string,
	options: {
		viewport: { width: number; height: number };
		colorScheme?: "light" | "dark";
		reducedMotion?: "reduce" | "no-preference";
		/** The reader's language (T6's 360 px Hungarian row). */
		language?: "en" | "hu";
		/** T16: a reader who has not seen the tours, so the first open shows its card. */
		toursSeen?: boolean;
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
		recordVideo: OUT_DIR
			? { dir: join(OUT_DIR, ".raw"), size: options.viewport }
			: undefined,
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
	if (options.toursSeen !== false) await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	await seed(user, chatId);
	await reopenChat(page, chatId);
	return { context, page, startedAt, marks: {}, errors, user, chatId };
}

/** An Image of three versions: Alfy's picture, a marked change of Alfy's with its prompt, a picked take. */
export async function seedPictureHistory(
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
export async function seedDocumentHistory(user: TourUser, chatId: string) {
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

export async function nextFrame(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

/** Opens the seeded item and waits for its body to be drawn. */
export async function openSeededItem(
	flow: SeededFlow,
	kind: "image" | "document",
) {
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

export function historyButton(page: Page) {
	return page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first();
}

/** History's preview has drawn what it shows: the wipe's pictures (or the one picture) loaded, or the Document's text. */
export async function expectHistoryShown(
	page: Page,
	kind: "image" | "document",
) {
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

/**
 * Two one-finger taps whose touch events carry explicit times 80 ms apart
 * (CDP `timestamp`, which becomes the events' `timeStamp`), so the gap the
 * page measures is the one written here, whatever the dispatch latency.
 */
export async function doubleTap(
	client: CDPSession,
	at: { x: number; y: number },
): Promise<void> {
	const base = Date.now() / 1000;
	const send = (
		type: string,
		offsetMs: number,
		points: Array<{ x: number; y: number }>,
	) =>
		client.send("Input.dispatchTouchEvent", {
			type,
			timestamp: base + offsetMs / 1000,
			touchPoints: points.map((point, id) => ({ ...point, id })),
		});
	await send("touchStart", 0, [at]);
	await send("touchEnd", 10, []);
	await send("touchStart", 80, [at]);
	await send("touchEnd", 90, []);
}
