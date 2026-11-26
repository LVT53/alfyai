import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT,
	AI_SMOKE_CHANGE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_TITLE,
} from "../fixtures/ai/late-picture-scenario";
import {
	assistantAnswer,
	expectTerminalActivityGone,
} from "./artifact-live-edit.helpers";
import {
	backToList,
	createTourUser,
	IMAGE_ITEM_TITLE,
	markToursSeen,
	openItem,
	openPanelList,
	panelList,
	reopenChat,
	seedImageItem,
	seedItem,
	startChatAs,
} from "./artifact-tours-helpers";
import { sendMessage, waitForMotionToSettle } from "./helpers";
import {
	CARD,
	closeFlow,
	DESKTOP,
	DOC_BODY,
	DOCUMENT_TITLE,
	doubleTap,
	expectHistoryShown,
	fakeProvider,
	historyButton,
	longFramesAround,
	MOBILE_SHELL,
	makePicture,
	mark,
	newChat,
	nextFrame,
	OUT_DIR,
	openFlow,
	openSeededFlow,
	openSeededItem,
	PANEL_LOADED,
	PHONE,
	readCards,
	type SeededFlow,
	saveRecording,
	seedDocumentHistory,
	seedPictureHistory,
	settle,
	shiftsBetween,
	sizeDrift,
	TRACK,
} from "./images-motion-helpers";
import {
	installMotionRecorder,
	type MotionFrame,
	type MotionRun,
	shiftSum,
	startRecording,
	stopRecording,
} from "./panel-motion-helpers";

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
					assistantAnswer(page).getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT),
				).toBeVisible({ timeout: 45_000 });
				await expectTerminalActivityGone(page);
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
					assistantAnswer(page).getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
				).toBeVisible({ timeout: 45_000 });
				await expectTerminalActivityGone(page);
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
			expect(Math.round(chips[0].h), "the photo tile is 56 px tall").toBe(56);
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
			expect(Math.round(one.h)).toBe(56);
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
				recordVideo: OUT_DIR
					? { dir: join(OUT_DIR, ".raw"), size: variant.viewport }
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
					// The panel gave way; the count button opens the list (Task 14), and the
					// row opens the item again.
					await openItem(page, IMAGE_ITEM_TITLE);
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
				expect(Math.round(chip.h)).toBe(56);
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
	/** Two taps 80 ms apart by their own event times (a mouse: two clicks). */
	doubleTap(at: { x: number; y: number }): Promise<void>;
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
			async doubleTap(at) {
				await page.mouse.click(at.x, at.y);
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
		async doubleTap(at) {
			await doubleTap(client, at);
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
					await hand.doubleTap(empty);
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
			expect(chip.number).toBeNull();
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

	test("other-item-keeps: opening another item keeps the marks and their chip, and the picture draws its boxes again when it is opened (stop losing boxes)", async ({
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
			// Marks stay until they are sent, moved or cleared (c263cf35e, "stop losing
			// boxes": opening another item used to drop them, and a reader lost boxes they
			// had drawn). The chip says they are held and lets them go with its x; the
			// document is not their picture, so it draws none, and the next send carries
			// them with their picture (F14, below).
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);
			await expect(page.locator(MARK_BOX)).toHaveCount(0);
			metrics.chipAfterOther = await page.locator(MARKS_CHIP).count();
			// Back on the picture: the box is where it was drawn.
			await backToList(page);
			await openItem(page, IMAGE_ITEM_TITLE);
			await expect(page.locator(PANEL_LOADED).first()).toBeVisible({
				timeout: 20_000,
			});
			await expect(page.locator(MARK_BOX)).toHaveCount(1);
			metrics.boxesBack = await page.locator(MARK_BOX).count();
			metrics.chipBack = await page.locator(MARKS_CHIP).count();
		} finally {
			await saveRecording(flow, "other-item-keeps", metrics, {
				prefix: "t6",
			});
		}
		expect(flow.errors).toEqual([]);
		expect(metrics.chipAfterOther).toBe(1);
		expect(metrics.boxesBack).toBe(1);
		expect(metrics.chipBack).toBe(1);
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
				assistantAnswer(page).getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
			).toBeVisible({ timeout: 45_000 });
			await expectTerminalActivityGone(page);
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

// ---- Plan 2b T16: the Image's first-open tour -----------------------------------

/**
 * The Image's first-open tour (plan 2b T16) against the Document's, recorded the same
 * way (MOTION-PARITY "By measurement"): a reader who has seen no tour opens the item,
 * the card is in the page with it (nothing under it moves), Next twice slides the
 * steps, and "Got it" gives the card's room back as a short glide. Desktop light and
 * dark and the phone sheet, each beside the Document's, to `t16-tour-*`.
 */
test.describe("the Image's first-open tour moves like the Document's (T16)", () => {
	test.describe.configure({ mode: "serial" });

	const TOUR_CARD = '[data-testid="artifact-tour"]';
	const TOUR_BODY = {
		image: '.workspace-stage [data-testid="image-body"]',
		document: DOC_BODY,
	} as const;

	type TourMetrics = {
		arrivalTopMove: number;
		arrivalShift: number;
		stepLongFrames: number;
		leaveLongFrames: number;
		leaveShift: number;
		room: number;
		leaveTravel: number;
		leaveMaxStep: number;
		leaveMovingFrames: number;
		leaveSpanMs: number;
		/** The card's own motion (the step slide and the exit), as `duration easing` per animated part. */
		cardCurves: string[];
	};

	function bodyGlide(frames: MotionFrame[]) {
		const samples = frames.flatMap((frame) =>
			frame.tracked.body ? [{ t: frame.t, y: frame.tracked.body.y }] : [],
		);
		let maxStep = 0;
		let moving = 0;
		let firstMove = -1;
		let lastMove = 0;
		for (let index = 1; index < samples.length; index++) {
			const step = Math.abs(samples[index].y - samples[index - 1].y);
			maxStep = Math.max(maxStep, step);
			if (step > 0.5) {
				moving += 1;
				if (firstMove < 0) firstMove = samples[index].t;
				lastMove = samples[index].t;
			}
		}
		return {
			travel: (samples[0]?.y ?? 0) - (samples.at(-1)?.y ?? 0),
			maxStep,
			moving,
			spanMs: firstMove < 0 ? 0 : lastMove - firstMove,
		};
	}

	function curvesOf(...runs: MotionRun[]) {
		const seen = new Set<string>();
		for (const run of runs) {
			// The card's own motion; a part that only nudges for a frame or two (under
			// 50 ms) is not a curve anyone sees.
			for (const entry of run.animations) {
				if (!/tour/.test(entry.target) || entry.duration < 50) continue;
				seen.add(`${Math.round(entry.duration)} ${entry.easing}`);
			}
			for (const entry of run.transitions) {
				if (!/tour/.test(entry.target) || entry.duration < 50) continue;
				seen.add(`${Math.round(entry.duration)} ${entry.easing}`);
			}
		}
		return [...seen].sort();
	}

	async function tourFlow(
		flow: SeededFlow,
		kind: "image" | "document",
	): Promise<TourMetrics> {
		const { page } = flow;
		const body = TOUR_BODY[kind];
		await openPanelList(page);
		await settle(page);

		// ARRIVING: the card is in the page with the item; nothing under it moves.
		await startRecording(page, { card: TOUR_CARD, body });
		mark(flow, `tour-open-${kind}`);
		await panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: kind === "image" ? IMAGE_ITEM_TITLE : DOCUMENT_TITLE })
			.click();
		const card = page.getByTestId("artifact-tour");
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(
			page
				.locator(kind === "image" ? PANEL_LOADED : `${DOC_BODY}:visible`)
				.first(),
		).toBeVisible({ timeout: 20_000 });
		await settle(page);
		const arrival = await stopRecording(page);
		const cardAt = arrival.frames.findIndex(
			(frame) => frame.tracked.card !== null,
		);
		expect(cardAt, "the card never showed").toBeGreaterThanOrEqual(0);
		const sinceCard = arrival.frames.slice(Math.max(cardAt - 1, 0));
		const firstBody = sinceCard.find((frame) => frame.tracked.body)?.tracked
			.body;
		const arrivalTopMove = Math.max(
			0,
			...sinceCard.flatMap((frame) =>
				frame.tracked.body && firstBody
					? [Math.abs(frame.tracked.body.y - firstBody.y)]
					: [],
			),
		);
		// THE STEPS: Next twice, each a short slide inside the card.
		await startRecording(page, { card: TOUR_CARD, body });
		mark(flow, `tour-steps-${kind}`);
		for (let step = 0; step < 2; step++) {
			await card.getByTestId("artifact-tour-next").click();
			await page.waitForTimeout(450);
		}
		await settle(page);
		const steps = await stopRecording(page);

		// The room the card holds as the reader leaves it: its height on the last step
		// (a longer step is a taller card) and the margin above it.
		const room = await card.evaluate(
			(element) =>
				element.getBoundingClientRect().height +
				Number.parseFloat(getComputedStyle(element).marginTop),
		);

		// LEAVING: "Got it" gives the room back as the card's own short glide.
		await startRecording(page, { body });
		mark(flow, `tour-leave-${kind}`);
		await card.getByTestId("artifact-tour-done").click();
		await expect(card).toHaveCount(0);
		await page.waitForTimeout(300);
		await settle(page);
		const leave = await stopRecording(page);
		const glide = bodyGlide(leave.frames);

		return {
			arrivalTopMove,
			arrivalShift: shiftSum(arrival),
			stepLongFrames: steps.longFrames.filter((entry) => entry.duration > 50)
				.length,
			leaveLongFrames: leave.longFrames.filter((entry) => entry.duration > 50)
				.length,
			leaveShift: shiftSum(leave),
			room,
			leaveTravel: glide.travel,
			leaveMaxStep: glide.maxStep,
			leaveMovingFrames: glide.moving,
			leaveSpanMs: glide.spanMs,
			cardCurves: curvesOf(steps, leave),
		};
	}

	function holdTour(metrics: TourMetrics, kind: string) {
		expect(
			metrics.arrivalTopMove,
			`${kind}: moved when its card arrived`,
		).toBeLessThan(1.5);
		expect(metrics.room, `${kind}: the card holds room`).toBeGreaterThan(100);
		expect(metrics.stepLongFrames, `${kind}: a long frame while stepping`).toBe(
			0,
		);
		expect(metrics.leaveLongFrames, `${kind}: a long frame while leaving`).toBe(
			0,
		);
		expect(
			metrics.leaveMovingFrames,
			`${kind}: the room closed in one cut`,
		).toBeGreaterThanOrEqual(4);
		expect(
			metrics.leaveMaxStep,
			`${kind}: one frame took most of the way`,
		).toBeLessThanOrEqual(Math.abs(metrics.leaveTravel) * 0.5 + 1);
		expect(
			metrics.leaveSpanMs,
			`${kind}: the room took too long to close`,
		).toBeLessThanOrEqual(600);
		expect(
			Math.abs(metrics.leaveTravel - metrics.room),
			`${kind}: did not end where it would be without the card`,
		).toBeLessThan(2);
	}

	const VARIANTS = [
		{ name: "tour-desktop-light", viewport: DESKTOP, colorScheme: "light" },
		{ name: "tour-desktop-dark", viewport: DESKTOP, colorScheme: "dark" },
		{ name: "tour-phone-light", viewport: PHONE, colorScheme: "light" },
	] as const;

	for (const variant of VARIANTS) {
		test(`${variant.name}: the Image's tour arrives, steps and leaves on the Document's curve`, async ({
			browser,
		}, testInfo) => {
			test.setTimeout(180_000);
			const options = {
				viewport: variant.viewport,
				colorScheme: variant.colorScheme,
				toursSeen: false,
			};
			const baseURL = testInfo.project.use.baseURL as string;

			const docFlow = await openSeededFlow(
				browser,
				baseURL,
				options,
				(user, chatId) => seedItem(user, chatId, "document"),
			);
			let document: TourMetrics | null = null;
			try {
				document = await tourFlow(docFlow, "document");
			} finally {
				await saveRecording(
					docFlow,
					`document-${variant.name}`,
					{ document },
					{
						prefix: "t16",
						segments: [
							"tour-open-document",
							"tour-steps-document",
							"tour-leave-document",
						],
					},
				);
			}
			expect(docFlow.errors, "the page logged an error").toEqual([]);

			const flow = await openSeededFlow(
				browser,
				baseURL,
				options,
				(user, chatId) => seedImageItem(user, chatId),
			);
			let image: TourMetrics | null = null;
			try {
				image = await tourFlow(flow, "image");
			} finally {
				await saveRecording(
					flow,
					variant.name,
					{ image, document, sideBySide: { image, document } },
					{
						prefix: "t16",
						segments: [
							"tour-open-image",
							"tour-steps-image",
							"tour-leave-image",
						],
					},
				);
			}
			expect(flow.errors, "the page logged an error").toEqual([]);

			if (!image || !document) throw new Error("a flow did not finish");
			holdTour(document, "document");
			holdTour(image, "image");
			// Side by side: the same card on the same curves, gone in the same time.
			expect(image.cardCurves, "the Image's card ran on other curves").toEqual(
				document.cardCurves,
			);
			expect(
				Math.abs(image.leaveSpanMs - document.leaveSpanMs),
				"the Image's card took another time to go",
			).toBeLessThanOrEqual(80);
		});
	}
});
