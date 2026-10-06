import { expect, type Page, test } from "@playwright/test";
import { ARTIFACT_TOUR_DEFAULTS } from "../../src/lib/server/artifact-tour-defaults";
import { cameraOf, settledCamera } from "./artifact-canvas-helpers";
import {
	backToList,
	bigBoard,
	createTourUser,
	finishTour,
	ITEM_TITLES,
	markToursSeen,
	openItem,
	openPanelList,
	panelList,
	panelShell,
	reopenChat,
	seedItem,
	startChatAs,
	type TourKind,
	tourCard,
	watchTourRequests,
} from "./artifact-tours-helpers";
import { waitForMotionToSettle, waitForStableBoundingBox } from "./helpers";

// How the tour card ARRIVES (TR-D1; RC-T's I-1 and its Minors 5, 6, 7, 8b, 11).
// The card used to land after the item was on screen and shove it down in one
// frame, and a populated Canvas that had already fitted itself was left with
// rows under the fold. Here every answer is held back as a slow network would
// hold it, and every flow is real pointer and keyboard input: a person opens an
// item from the panel's list, reads, pans, presses keys. What is measured is
// what is on the screen, frame by frame, from the page's own animation loop.

const ANSWER_DELAY_MS = 450;
const EDITOR = ".document-editor-host .ProseMirror";

/** Holds every tour answer back, as a slow link does. The seen write is not held. */
async function delayTourAnswers(page: Page, ms = ANSWER_DELAY_MS) {
	await page.route("**/api/artifact-tours/*", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await new Promise((resolve) => setTimeout(resolve, ms));
		return route.continue();
	});
}

/**
 * Keeps every tour answer on the wire until the test lets it go: the answer
 * arrives after the reader can already read the item, however long this
 * machine takes to paint it (a cold dev server needs seconds, a real one
 * milliseconds), which is the case the card used to get wrong.
 */
async function holdTourAnswers(page: Page) {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/artifact-tours/*", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await released;
		return route.continue();
	});
	return { release: () => release() };
}

/** The moments (in the page's own clock) the page asked for a tour, so "as the item opens" is a number. */
async function watchTourAsks(page: Page) {
	await page.evaluate(() => {
		const bag = window as unknown as {
			__asks: number[];
			fetch: typeof fetch;
		};
		bag.__asks = [];
		const original = bag.fetch.bind(window);
		bag.fetch = (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (
				new URL(url, location.href).pathname.startsWith("/api/artifact-tours/")
			) {
				bag.__asks.push(performance.now());
			}
			return original(input, init);
		};
	});
}

type Frame = { t: number; top: number | null; card: boolean };

/** From now on, once per animation frame: where `selector` is and whether the card is in the page. */
async function startSampling(page: Page, selector: string) {
	await page.evaluate((target) => {
		const bag = window as unknown as {
			__frames: Frame[];
			__sampling: boolean;
		};
		bag.__frames = [];
		bag.__sampling = true;
		const tick = () => {
			if (!bag.__sampling) return;
			const element = document.querySelector(target);
			bag.__frames.push({
				t: performance.now(),
				top: element ? element.getBoundingClientRect().top : null,
				card: document.querySelector('[data-testid="artifact-tour"]') !== null,
			});
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, selector);
}

async function stopSampling(page: Page): Promise<Frame[]> {
	return page.evaluate(() => {
		const bag = window as unknown as {
			__frames: Frame[];
			__sampling: boolean;
		};
		bag.__sampling = false;
		return bag.__frames;
	});
}

/**
 * What the frames say about one move of the page: how far it went, the most it
 * went in a single frame, how many frames it moved in and how long it took.
 */
function moveOf(frames: Frame[]) {
	const seen = frames.filter((f) => f.top !== null);
	const tops = seen.map((f) => f.top as number);
	const start = tops[0];
	const end = tops[tops.length - 1];
	const steps = tops.slice(1).map((top, i) => Math.abs(top - tops[i]));
	const movedAt = seen.filter((_, i) => i > 0 && steps[i - 1] > 0.5);
	return {
		shift: end - start,
		maxStep: Math.max(0, ...steps),
		movingFrames: movedAt.length,
		spanMs: movedAt.length ? movedAt[movedAt.length - 1].t - movedAt[0].t : 0,
	};
}

/**
 * The frames of the card's arrival (from the one before it first showed) and of
 * its leaving (from the one before the reader pressed Skip), told apart by the
 * moment of the press.
 */
function arrivalAndLeaving(frames: Frame[], pressedAt: number) {
	const appeared = frames.findIndex((f) => f.card);
	expect(appeared, "the card never showed").toBeGreaterThan(0);
	const pressed = frames.findIndex((f) => f.t >= pressedAt);
	expect(pressed, "the page was not sampled after the press").toBeGreaterThan(
		0,
	);
	return {
		arriving: moveOf(frames.slice(appeared - 1, pressed)),
		leaving: moveOf(frames.slice(pressed - 1)),
	};
}

/** Whether every note of the board is inside the pane and clear of the toolbar. */
async function everyNoteShows(page: Page) {
	const pane = await page.getByTestId("canvas-board").boundingBox();
	const toolbar = await page.getByTestId("canvas-toolbar").boundingBox();
	expect(pane).not.toBeNull();
	expect(toolbar).not.toBeNull();
	const limit = Math.min(
		(pane?.y ?? 0) + (pane?.height ?? 0),
		toolbar?.y ?? Number.POSITIVE_INFINITY,
	);
	const nodes = page.getByTestId("canvas-node");
	const count = await nodes.count();
	const hidden: string[] = [];
	for (let index = 0; index < count; index++) {
		const box = await nodes.nth(index).boundingBox();
		const id =
			(await nodes.nth(index).getAttribute("data-node-id")) ?? `#${index}`;
		if (
			!box ||
			box.y < (pane?.y ?? 0) - 0.5 ||
			box.y + box.height > limit + 0.5 ||
			box.x < (pane?.x ?? 0) - 0.5 ||
			box.x + box.width > (pane?.x ?? 0) + (pane?.width ?? 0) + 0.5
		) {
			hidden.push(id);
		}
	}
	return { count, hidden };
}

async function expectEveryNote(page: Page, message: string) {
	await waitForMotionToSettle(page);
	await expect
		.poll(async () => (await everyNoteShows(page)).hidden, { message })
		.toEqual([]);
	expect((await everyNoteShows(page)).count).toBe(21);
}

function sameCamera(
	a: { x: number; y: number; zoom: number },
	b: { x: number; y: number; zoom: number },
) {
	expect(a.x).toBeCloseTo(b.x, 1);
	expect(a.y).toBeCloseTo(b.y, 1);
	expect(a.zoom).toBeCloseTo(b.zoom, 3);
}

/** Opens a chat with one item of `kind` for a reader who has seen no tour. */
async function readerWith(
	page: Page,
	kind: TourKind,
	options: {
		language?: "en" | "hu";
		board?: ReturnType<typeof bigBoard>;
		title?: string;
	} = {},
) {
	const user = await createTourUser(options.language ?? "hu");
	const chatId = await startChatAs(page, user);
	await seedItem(user, chatId, kind, {
		board: options.board,
		title: options.title,
	});
	await reopenChat(page, chatId);
	return { user, chatId };
}

test.describe("the tour card arrives without moving what is being read", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	/** Opens the Document from the list with the tour answer held; the card lands once the page has been readable for a moment. */
	async function documentWithLateCard(page: Page) {
		await readerWith(page, "document");
		const hold = await holdTourAnswers(page);
		await openPanelList(page);
		await startSampling(page, `aside.workspace-shell-desktop ${EDITOR}`);
		await panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: ITEM_TITLES.document })
			.click();
		const editor = panelShell(page).locator(EDITOR);
		await expect(editor).toBeVisible({ timeout: 30_000 });
		await waitForMotionToSettle(page);
		await waitForStableBoundingBox(editor);
		hold.release();
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await waitForMotionToSettle(page);
		return card;
	}

	test("the Document's text slides down over a transition when the answer is late, and back up when the card goes", async ({
		page,
	}) => {
		const card = await documentWithLateCard(page);

		// Leaving: Skip is a real click, and the text comes back up the same way.
		const pressedAt = await page.evaluate(() => performance.now());
		await card.getByTestId("artifact-tour-skip").click();
		await expect(card).toHaveCount(0);
		await waitForMotionToSettle(page);
		const { arriving, leaving } = arrivalAndLeaving(
			await stopSampling(page),
			pressedAt,
		);

		// The card pushes the page down by about its own height, and it does that
		// in many small steps, none of them more than half of the way.
		expect(arriving.shift).toBeGreaterThan(120);
		expect(arriving.movingFrames).toBeGreaterThanOrEqual(4);
		expect(arriving.spanMs).toBeGreaterThanOrEqual(120);
		expect(arriving.maxStep).toBeLessThanOrEqual(arriving.shift * 0.5);

		expect(leaving.shift).toBeLessThan(-120);
		expect(leaving.movingFrames).toBeGreaterThanOrEqual(4);
		expect(leaving.spanMs).toBeGreaterThanOrEqual(120);
		expect(leaving.maxStep).toBeLessThanOrEqual(Math.abs(leaving.shift) * 0.5);
		console.log(
			`[arrival] shift ${arriving.shift.toFixed(0)} px, largest step ${arriving.maxStep.toFixed(1)} px, ${arriving.movingFrames} frames, ${arriving.spanMs.toFixed(0)} ms; leaving ${leaving.shift.toFixed(0)} px, largest step ${leaving.maxStep.toFixed(1)} px, ${leaving.movingFrames} frames`,
		);
	});

	test("under reduced motion the card is there at once, and goes at once", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const card = await documentWithLateCard(page);
		const pressedAt = await page.evaluate(() => performance.now());
		await card.getByTestId("artifact-tour-skip").click();
		await expect(card).toHaveCount(0);
		await waitForMotionToSettle(page);
		const { arriving, leaving } = arrivalAndLeaving(
			await stopSampling(page),
			pressedAt,
		);

		expect(arriving.shift).toBeGreaterThan(120);
		expect(arriving.movingFrames).toBeLessThanOrEqual(2);
		expect(arriving.spanMs).toBeLessThanOrEqual(60);
		expect(leaving.shift).toBeLessThan(-120);
		expect(leaving.movingFrames).toBeLessThanOrEqual(2);
	});

	test("the tour is asked for as the item opens, before its page has painted", async ({
		page,
	}) => {
		await readerWith(page, "document");
		await delayTourAnswers(page, 250);
		await openPanelList(page);
		await watchTourAsks(page);
		await startSampling(page, `aside.workspace-shell-desktop ${EDITOR}`);
		await panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: ITEM_TITLES.document })
			.click();
		await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
		const frames = await stopSampling(page);
		const painted = frames.find((f) => f.top !== null)?.t ?? 0;
		const asked = await page.evaluate(
			() => (window as unknown as { __asks: number[] }).__asks[0] ?? -1,
		);
		expect(asked, "the page asked for the tour").toBeGreaterThan(0);
		expect(painted, "the page painted").toBeGreaterThan(0);
		console.log(
			`[timeline] asked at ${asked.toFixed(0)} ms, the page painted at ${painted.toFixed(0)} ms`,
		);
		expect(asked).toBeLessThanOrEqual(painted);
	});

	test("a populated board shows every note with the card up, and after it closes", async ({
		page,
	}) => {
		await readerWith(page, "canvas", { board: bigBoard(), title: "Big board" });
		const hold = await holdTourAnswers(page);
		await openItem(page, "Big board");

		// The board paints and fits itself first; the card lands over it later.
		await expect(page.getByTestId("canvas-node")).toHaveCount(21, {
			timeout: 30_000,
		});
		await expectEveryNote(page, "every note shows before the card arrives");
		hold.release();
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expectEveryNote(page, "every note shows with the card up");

		await card.getByTestId("artifact-tour-skip").click();
		await expect(card).toHaveCount(0);
		await expectEveryNote(page, "every note shows after the card has closed");
	});

	test("a board the reader has moved keeps its camera when the card arrives and when it goes", async ({
		page,
	}) => {
		await readerWith(page, "canvas", { board: bigBoard(), title: "Big board" });
		const hold = await holdTourAnswers(page);
		await openItem(page, "Big board");
		await expect(page.getByTestId("canvas-node")).toHaveCount(21, {
			timeout: 30_000,
		});
		await expectEveryNote(page, "the board is fitted first");
		const fitted = await cameraOf(page);

		// The reader pans with the middle button and zooms with the wheel.
		const pane = await page.getByTestId("canvas-board").boundingBox();
		const x = (pane?.x ?? 0) + (pane?.width ?? 0) / 2;
		const y = (pane?.y ?? 0) + (pane?.height ?? 0) / 2;
		await page.mouse.move(x, y);
		await page.mouse.down({ button: "middle" });
		await page.mouse.move(x - 70, y - 50, { steps: 8 });
		await page.mouse.up({ button: "middle" });
		await page.mouse.wheel(0, -240);
		const moved = await settledCamera(page);
		expect(moved.x).not.toBeCloseTo(fitted.x, 0);
		expect(moved.zoom).not.toBeCloseTo(fitted.zoom, 2);

		// The card arrives over a camera that is theirs now: nothing is fitted again.
		hold.release();
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await waitForMotionToSettle(page);
		sameCamera(await settledCamera(page), moved);

		await card.getByTestId("artifact-tour-skip").click();
		await expect(card).toHaveCount(0);
		await waitForMotionToSettle(page);
		sameCamera(await settledCamera(page), moved);
	});

	test("a window resize fits an untouched board again, and leaves a moved one alone", async ({
		page,
	}) => {
		const user = await createTourUser("hu");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "canvas", {
			board: bigBoard(),
			title: "Big board",
		});
		await reopenChat(page, chatId);
		await openItem(page, "Big board");
		await expect(page.getByTestId("canvas-node")).toHaveCount(21, {
			timeout: 30_000,
		});
		await expectEveryNote(page, "fitted at 1440 x 900");
		const before = await cameraOf(page);

		await page.setViewportSize({ width: 1180, height: 640 });
		await expectEveryNote(page, "fitted again at 1180 x 640");
		const smaller = await cameraOf(page);
		expect(smaller.zoom).toBeLessThan(before.zoom);

		await page.setViewportSize({ width: 1440, height: 900 });
		await expectEveryNote(page, "fitted again back at 1440 x 900");

		// Once the reader has moved it, a resize is not theirs to undo.
		const pane = await page.getByTestId("canvas-board").boundingBox();
		const x = (pane?.x ?? 0) + (pane?.width ?? 0) / 2;
		const y = (pane?.y ?? 0) + (pane?.height ?? 0) / 2;
		await page.mouse.move(x, y);
		await page.mouse.down({ button: "middle" });
		await page.mouse.move(x - 60, y - 40, { steps: 6 });
		await page.mouse.up({ button: "middle" });
		const moved = await settledCamera(page);
		await page.setViewportSize({ width: 1180, height: 640 });
		await waitForMotionToSettle(page);
		sameCamera(await settledCamera(page), moved);
	});
});

test.describe("one answer per kind per page load", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a kind that was answered is not asked for again, and a finished tour stays finished", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document", { title: "First notes" });
		await seedItem(user, chatId, "document", { title: "Second notes" });
		await reopenChat(page, chatId);

		await openItem(page, "First notes");
		await finishTour(page);
		await expect.poll(() => requests.posts().length).toBe(1);
		expect(requests.gets()).toHaveLength(1);

		// The second Document of the page load: no question, no card.
		await backToList(page);
		await openItem(page, "Second notes");
		// The answer is in hand, so a card would be there by the time the page is:
		// the editor is a network round trip behind it.
		await expect(panelShell(page).locator(EDITOR)).toBeVisible({
			timeout: 20_000,
		});
		await waitForMotionToSettle(page);
		await expect(tourCard(page)).toHaveCount(0);
		expect(requests.gets()).toHaveLength(1);
	});

	test("a tour closed half-way is met again from the answer already in hand", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document", { title: "First notes" });
		await seedItem(user, chatId, "document", { title: "Second notes" });
		await reopenChat(page, chatId);

		await openItem(page, "First notes");
		await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
		await backToList(page);
		await openItem(page, "Second notes");
		await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
		await expect(tourCard(page).getByTestId("artifact-tour-step")).toHaveText(
			"Step 1 of 3",
		);
		expect(requests.gets()).toHaveLength(1);
		expect(requests.posts()).toHaveLength(0);
	});
});

test.describe("what the card says to those who cannot see it move", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("pressing Next or Back announces the new step's position and title", async ({
		page,
	}) => {
		await readerWith(page, "document", { language: "en" });
		await openItem(page, ITEM_TITLES.document);
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 20_000 });
		const live = card.getByTestId("artifact-tour-live");
		const slides = ARTIFACT_TOUR_DEFAULTS.document.slides;
		await expect(live).toHaveAttribute("aria-live", "polite");

		await card.getByTestId("artifact-tour-next").click();
		await expect(live).toHaveText(`Step 2 of 3. ${slides[1].title.en}`);
		await card.getByTestId("artifact-tour-next").click();
		await expect(live).toHaveText(`Step 3 of 3. ${slides[2].title.en}`);
		await card.getByTestId("artifact-tour-back").click();
		await expect(live).toHaveText(`Step 2 of 3. ${slides[1].title.en}`);
	});

	test("the Hungarian step line reads '1. lépés / 3'", async ({ page }) => {
		await readerWith(page, "document", { language: "hu" });
		await openItem(page, ITEM_TITLES.document);
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 20_000 });
		const step = card.getByTestId("artifact-tour-step");
		await expect(step).toHaveText("1. lépés / 3");
		await card.getByTestId("artifact-tour-next").click();
		await expect(step).toHaveText("2. lépés / 3");
	});
});

test.describe("the list row's menu is a menu", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("opens on its first item, the arrows move between the items, Escape closes it and gives the focus back", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);
		await openPanelList(page);

		const trigger = panelList(page).getByTestId(/^artifact-row-menu-/);
		await trigger.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByRole("menu");
		await expect(menu).toBeVisible();
		const replay = menu.getByRole("menuitem", { name: "How this kind works" });
		const remove = menu.getByRole("menuitem", { name: "Delete document" });
		await expect(replay).toBeFocused();

		await page.keyboard.press("ArrowDown");
		await expect(remove).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(replay).toBeFocused();
		await page.keyboard.press("ArrowUp");
		await expect(remove).toBeFocused();
		await page.keyboard.press("Home");
		await expect(replay).toBeFocused();
		await page.keyboard.press("End");
		await expect(remove).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});
});
