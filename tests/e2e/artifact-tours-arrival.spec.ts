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
import {
	waitForHydration,
	waitForMotionToSettle,
	waitForStableBoundingBox,
} from "./helpers";

// How the tour card ARRIVES (TR-D1; RC-T's I-1 and its Minors 5, 6, 7, 8b, 11).
// The card used to land after the item was on screen and shove it down in one
// frame, and a populated Canvas that had already fitted itself was left with
// rows under the fold. Here every answer is held back as a slow network would
// hold it, and every flow is real pointer and keyboard input: a person opens an
// item from the panel's list, reads, pans, presses keys. What is measured is
// what is on the screen, frame by frame, from the page's own animation loop.

const EDITOR = ".document-editor-host .ProseMirror";

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

/**
 * The moments (in the page's own clock) the page asked for a tour, so "before the
 * reader reaches for the item" is a number. An init script: the question is asked
 * as the chat loads, which is before any test could patch the page it is asked from.
 */
async function watchTourAsks(page: Page) {
	await page.addInitScript(() => {
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

/**
 * Like `readerWith`, for the case where the answer is late: every tour answer is
 * held on the wire from the moment the chat loads (the panel asks as soon as the
 * chat has an item of a kind), and the page is not waited on to go idle, which a
 * held request would never let it. `hold.release()` lets the answers through.
 */
async function readerWithHeldAnswers(
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
	const hold = await holdTourAnswers(page);
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, chatId);
	await page.goto(`/chat/${chatId}`);
	await page.reload();
	await waitForHydration(page);
	await expect(page.getByTestId("artifact-count-button")).toBeVisible({
		timeout: 30_000,
	});
	return { user, chatId, hold };
}

test.describe("the tour card arrives without moving what is being read", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	/** Opens the Document from the list with the tour answer held; the card lands once the page has been readable for a moment. */
	async function documentWithLateCard(page: Page) {
		const { hold } = await readerWithHeldAnswers(page, "document");
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

	test("the tour is asked for before the reader reaches for the item, once, and the card is there when the page is", async ({
		page,
	}) => {
		const user = await createTourUser("hu");
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await watchTourAsks(page);
		await reopenChat(page, chatId);
		await openPanelList(page);
		const pressedAt = await page.evaluate(() => performance.now());
		await startSampling(page, `aside.workspace-shell-desktop ${EDITOR}`);
		await panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: ITEM_TITLES.document })
			.click();
		await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
		await expect(panelShell(page).locator(EDITOR)).toBeVisible({
			timeout: 30_000,
		});
		const frames = await stopSampling(page);
		// The first frame the text is on screen in, and whether the card is already up in it.
		const painted = frames.find((f) => f.top !== null);
		expect(painted, "the text painted").toBeTruthy();
		expect(painted?.card, "the card is up when the text first paints").toBe(
			true,
		);
		const asks = await page.evaluate(
			() => (window as unknown as { __asks: number[] }).__asks,
		);
		expect(asks, "the page asked, once, for the one kind it has").toHaveLength(
			1,
		);
		console.log(
			`[timeline] asked at ${asks[0].toFixed(0)} ms, the reader pressed the row at ${pressedAt.toFixed(0)} ms, the text first painted at ${(painted?.t ?? 0).toFixed(0)} ms with the card up`,
		);
		expect(asks[0], "asked before the press").toBeLessThan(pressedAt);
	});

	test("a populated board shows every note with the card up, and after it closes", async ({
		page,
	}) => {
		const { hold } = await readerWithHeldAnswers(page, "canvas", {
			board: bigBoard(),
			title: "Big board",
		});
		await openItem(page, "Big board");

		// The board paints and fits itself first; the card grows in later and the board follows it.
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
		const { hold } = await readerWithHeldAnswers(page, "canvas", {
			board: bigBoard(),
			title: "Big board",
		});
		await openItem(page, "Big board");
		await expect(page.getByTestId("canvas-node")).toHaveCount(21, {
			timeout: 30_000,
		});
		await expectEveryNote(page, "the board is fitted first");
		const fitted = await cameraOf(page);

		// The reader pans with the middle button and zooms with a pinch (Control and the wheel).
		const pane = await page.getByTestId("canvas-board").boundingBox();
		const x = (pane?.x ?? 0) + (pane?.width ?? 0) / 2;
		const y = (pane?.y ?? 0) + (pane?.height ?? 0) / 2;
		await page.mouse.move(x, y);
		await page.mouse.down({ button: "middle" });
		await page.mouse.move(x - 70, y - 50, { steps: 8 });
		await page.mouse.up({ button: "middle" });
		await page.keyboard.down("Control");
		await page.mouse.wheel(0, -240);
		await page.keyboard.up("Control");
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

// ---- The card has its room from the first frame (FX-2, RC-A #4; ruling 77) ----
//
// The tour card used to be a layer laid over the top of the item (FB-3): nothing
// moved, but it covered the Document's toolbar and first lines, the App's status
// row and the board's top (214 of 844 px on a phone). Ruling 77 says the room is
// made before the body paints: the answer is in hand before the reader reaches
// for the item (the panel asks as soon as the chat has an item of a kind), so the
// card is in the page's flow from the item's first frame. What is measured is
// what is on the screen, frame by frame, relative to the panel.

type Edge = { top: number; bottom: number };
type RoomFrame = {
	t: number;
	card: Edge | null;
	root: Edge | null;
	first: Edge | null;
};

/** The item's own root (it must not move) and the first thing in it that a person reaches for (the card must not stand over it). */
const ROOM_PARTS: Record<TourKind, { root: string; first: string }> = {
	document: {
		root: ".document-body",
		first: ".document-toolbar, .mobile-toolbar",
	},
	app: { root: ".app-body", first: '[data-testid="app-status-row"]' },
	canvas: {
		root: '[data-testid="canvas-editor"]',
		first: '[data-testid="canvas-board"]',
	},
};

/** From now on, once per animation frame: the card, the item's root and its first part, as edges inside the panel. */
async function startRoomLog(page: Page, kind: TourKind) {
	await page.evaluate((parts) => {
		const bag = window as unknown as {
			__room: RoomFrame[];
			__logging: boolean;
		};
		bag.__room = [];
		bag.__logging = true;
		const panel = () =>
			[
				...document.querySelectorAll(
					"aside.workspace-shell-desktop, [data-testid='document-workspace-mobile-shell']",
				),
			].find((shell) => shell.getBoundingClientRect().width > 0) ?? null;
		const tick = () => {
			if (!bag.__logging) return;
			const shell = panel();
			const base = shell?.getBoundingClientRect().top ?? 0;
			const edge = (selector: string) => {
				// The first match that takes room: the desktop toolbar is in the page, empty, on a phone.
				for (const element of shell?.querySelectorAll(selector) ?? []) {
					const rect = element.getBoundingClientRect();
					if (rect.width > 0 || rect.height > 0) {
						return { top: rect.top - base, bottom: rect.bottom - base };
					}
				}
				return null;
			};
			bag.__room.push({
				t: performance.now(),
				card: edge('[data-testid="artifact-tour"]'),
				root: edge(parts.root),
				first: edge(parts.first),
			});
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, ROOM_PARTS[kind]);
}

async function stopRoomLog(page: Page): Promise<RoomFrame[]> {
	return page.evaluate(() => {
		const bag = window as unknown as {
			__room: RoomFrame[];
			__logging: boolean;
		};
		bag.__logging = false;
		return bag.__room;
	});
}

function range(values: number[]): number {
	return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

/**
 * What the frames of an item that opened with its tour card have to say: the card
 * was in the page in the frame the item first showed, it stood over nothing of the
 * item in any frame, and neither the item nor the card moved from then on. (What
 * the Document's own tab strip does when its editor is ready is the Document's.)
 */
function expectRoomFromTheFirstFrame(frames: RoomFrame[], what: string) {
	const start = frames.findIndex((frame) => frame.root !== null);
	expect(start, `${what}: the item never showed`).toBeGreaterThanOrEqual(0);
	const shown = frames.slice(start);
	expect(
		shown[0].card,
		`${what}: the card is in the page in the item's first frame`,
	).not.toBeNull();
	const covered = shown.filter(
		(frame) =>
			frame.card &&
			[frame.root, frame.first].some(
				(part) => part && part.top < (frame.card?.bottom ?? 0) - 0.5,
			),
	);
	expect(
		covered.map((frame) => ({
			card: frame.card?.bottom,
			root: frame.root?.top,
			first: frame.first?.top,
		})),
		`${what}: the card stands over nothing`,
	).toEqual([]);
	const roots = shown.flatMap((frame) => (frame.root ? [frame.root] : []));
	const cards = shown.flatMap((frame) => (frame.card ? [frame.card] : []));
	for (const [name, edges] of [
		["the item", roots],
		["the card", cards],
	] as const) {
		expect(
			range(edges.map((edge) => edge.top)),
			`${what}: ${name} did not move (top)`,
		).toBeLessThan(1);
		expect(
			range(edges.map((edge) => edge.bottom)),
			`${what}: ${name} did not move (bottom)`,
		).toBeLessThan(1);
	}
	return { cardHeight: (cards[0]?.bottom ?? 0) - (cards[0]?.top ?? 0) };
}

for (const kind of ["document", "app", "canvas"] as const) {
	test.describe(`a ${kind}'s tour card has its room from the first frame (desktop)`, () => {
		test.use({ viewport: { width: 1440, height: 900 } });

		test("a reader's first open: the card is in the page with the item, and nothing moves or is covered", async ({
			page,
		}) => {
			await readerWith(page, kind);
			await openPanelList(page);
			await startRoomLog(page, kind);
			await panelList(page)
				.getByTestId("artifact-row")
				.filter({ hasText: ITEM_TITLES[kind] })
				.click();
			await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
			await waitForMotionToSettle(page);
			await page.waitForTimeout(400);
			const frames = await stopRoomLog(page);
			const { cardHeight } = expectRoomFromTheFirstFrame(
				frames,
				`${kind}, first open`,
			);
			expect(cardHeight, "the card has its height").toBeGreaterThan(100);
		});
	});
}

test.describe("a tour card has its room from the first frame (phone, touch)", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test("the Document's card is in the page with the Document, above its toolbar, and nothing moves", async ({
		page,
	}) => {
		await readerWith(page, "document");
		await page.getByTestId("artifact-count-button-compact").tap();
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		await startRoomLog(page, "document");
		await panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: ITEM_TITLES.document })
			.tap();
		await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
		await waitForMotionToSettle(page);
		await page.waitForTimeout(400);
		const frames = await stopRoomLog(page);
		const { cardHeight } = expectRoomFromTheFirstFrame(
			frames,
			"phone, Document, first open",
		);
		console.log(
			`[phone] the card is ${cardHeight.toFixed(0)} px of 844, the toolbar starts under it`,
		);
	});
});

/**
 * Reopens the chat and returns what the tour routes saw during the LAST load only:
 * `reopenChat` is a visit and then a reload, and each page load asks once for its
 * own (the panel asks as soon as the chat has an item of a kind), so a count that
 * began before the visit would be the visit's as well.
 */
async function reopenChatCounting(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	const requests = watchTourRequests(page);
	await page.reload({ waitUntil: "networkidle" });
	return requests;
}

test.describe("one answer per kind per page load", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a kind that was answered is not asked for again, and a finished tour stays finished", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document", { title: "First notes" });
		await seedItem(user, chatId, "document", { title: "Second notes" });
		const requests = await reopenChatCounting(page, chatId);

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
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document", { title: "First notes" });
		await seedItem(user, chatId, "document", { title: "Second notes" });
		const requests = await reopenChatCounting(page, chatId);

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
