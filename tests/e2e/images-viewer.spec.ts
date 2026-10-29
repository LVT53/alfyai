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
import {
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
} from "../fixtures/ai/late-picture-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
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
	releaseSpecChatModel,
	type SpecChatModel,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
	useSpecChatModel,
} from "./images-helpers";

/**
 * Plan 2b Task 22, end to end: the owner's "it should be possible to actually
 * enlarge the picture" and "in the list of images there should be [a] preview
 * present, and also an alternative view that shows the images as a gallery grid".
 *
 * - The panel's picture and the card's picture open the one full-screen viewer
 *   on the full-size file; the wheel, a drag, a double click, the keys and a
 *   pinch zoom and pan it; Esc, x and the backdrop close it.
 * - "What this chat made" and the Knowledge Base show each picture's thumbnail
 *   with no layout shift; the Knowledge Base's grid is remembered.
 *
 * With MOTION_VIDEO_DIR set, the last tests record videos (t22-*), their numbers
 * and contact sheets there, and screenshots to the T22 checks folder. Every wait
 * is on a state the page shows.
 */

const OUT_DIR = process.env.MOTION_VIDEO_DIR ?? null;
const SHOTS_DIR = "/home/lvt53/alfyai-handoff/checks/t22";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const VIEWER = '[data-testid="image-lightbox"]';
const VIEWER_IMAGE = '[data-testid="image-lightbox-image"]';

/** Layout shifts not caused by input, and long animation frames, from page load. */
const METRICS_SCRIPT = () => {
	const store = {
		shifts: [] as Array<{ value: number; at: number }>,
		loafs: [] as Array<{ duration: number; at: number }>,
	};
	(window as unknown as { __t22: typeof store }).__t22 = store;
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as Array<
			PerformanceEntry & { value: number; hadRecentInput: boolean }
		>) {
			if (!entry.hadRecentInput) {
				store.shifts.push({ value: entry.value, at: entry.startTime });
			}
		}
	}).observe({ type: "layout-shift", buffered: true });
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (entry.duration > 50) {
					store.loafs.push({ duration: entry.duration, at: entry.startTime });
				}
			}
		}).observe({ type: "long-animation-frame", buffered: true });
	} catch {
		// Not every engine reports long animation frames.
	}
};

type Metrics = { cls: number; longFrames: number[] };

async function now(page: Page): Promise<number> {
	return page.evaluate(() => performance.now());
}

async function metricsSince(page: Page, since: number): Promise<Metrics> {
	return page.evaluate((from) => {
		const store = (
			window as unknown as {
				__t22: {
					shifts: Array<{ value: number; at: number }>;
					loafs: Array<{ duration: number; at: number }>;
				};
			}
		).__t22;
		return {
			cls: store.shifts
				.filter((entry) => entry.at >= from)
				.reduce((sum, entry) => sum + entry.value, 0),
			longFrames: store.loafs
				.filter((entry) => entry.at >= from)
				.map((entry) => Math.round(entry.duration)),
		};
	}, since);
}

/** What the viewer's picture is transformed by now: [scale, x, y]. */
async function viewerTransform(page: Page): Promise<[number, number, number]> {
	return page.locator(VIEWER_IMAGE).evaluate((image) => {
		const matrix = new DOMMatrixReadOnly(getComputedStyle(image).transform);
		return [matrix.a, matrix.e, matrix.f] as [number, number, number];
	});
}

async function zoomLevel(page: Page): Promise<number> {
	const text = await page.getByTestId("image-lightbox-zoom-level").innerText();
	return Number(text.replace("%", ""));
}

/**
 * Starts noting every property the page animates through `element.animate`
 * (Svelte's transitions, the app's WAAPI calls) inside the viewer, on its way in
 * or out; `animatedProperties` reads them back.
 */
async function watchAnimations(page: Page): Promise<void> {
	await page.evaluate(() => {
		const seen = new Set<string>();
		(window as unknown as { __t22Animated: Set<string> }).__t22Animated = seen;
		const original = Element.prototype.animate;
		Element.prototype.animate = function (keyframes, options) {
			if (this.closest('[data-testid="image-lightbox"]')) {
				const frames = Array.isArray(keyframes)
					? keyframes
					: keyframes
						? [keyframes]
						: [];
				for (const frame of frames) {
					for (const key of Object.keys(frame as object)) {
						if (!["offset", "easing", "composite"].includes(key)) seen.add(key);
					}
				}
			}
			return original.call(this, keyframes, options);
		};
	});
}

async function animatedProperties(page: Page): Promise<string[]> {
	return page.evaluate(() => [
		...((window as unknown as { __t22Animated?: Set<string> }).__t22Animated ??
			[]),
	]);
}

/** The panel's pieces that are on screen (the phone sheet and the dock may both be in the page). */
const shown = (page: Page, testId: string) =>
	page.getByTestId(testId).filter({ visible: true });
const closeViewer = (page: Page) =>
	page.locator(VIEWER).getByRole("button", { name: "Close", exact: true });

async function openViewerFromPanel(page: Page): Promise<void> {
	await shown(page, "image-body-enlarge").click();
	await waitForViewerPicture(page);
}

async function waitForViewerPicture(page: Page): Promise<void> {
	await expect(page.locator(VIEWER)).toBeVisible();
	await expect
		.poll(() =>
			page
				.locator(VIEWER_IMAGE)
				.evaluate(
					(image: HTMLImageElement) => image.complete && image.naturalWidth,
				),
		)
		.toBeGreaterThan(0);
	await waitForMotionToSettle(page);
}

/** Two touch pointers, spread from `from` px apart to `to` px apart about the picture's centre. */
async function pinch(page: Page, from: number, to: number): Promise<void> {
	await page.locator('[data-testid="image-lightbox-stage"]').evaluate(
		async (stage, [start, end]) => {
			const image = stage.querySelector("img") as HTMLImageElement;
			const rect = image.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const fire = (type: string, id: number, x: number) =>
				stage.dispatchEvent(
					new PointerEvent(type, {
						pointerId: id,
						pointerType: "touch",
						isPrimary: id === 11,
						clientX: x,
						clientY: cy,
						bubbles: true,
						cancelable: true,
					}),
				);
			const frame = () =>
				new Promise((resolve) => requestAnimationFrame(resolve));
			fire("pointerdown", 11, cx - start / 2);
			fire("pointerdown", 12, cx + start / 2);
			for (let step = 1; step <= 8; step++) {
				const gap = start + ((end - start) * step) / 8;
				fire("pointermove", 11, cx - gap / 2);
				fire("pointermove", 12, cx + gap / 2);
				await frame();
			}
			fire("pointerup", 12, cx + end / 2);
			fire("pointerup", 11, cx - end / 2);
			await frame();
			await frame();
		},
		[from, to],
	);
}

/** Two quick taps of one finger at the picture's centre. */
async function doubleTap(page: Page): Promise<void> {
	await page
		.locator('[data-testid="image-lightbox-stage"]')
		.evaluate(async (stage) => {
			const image = stage.querySelector("img") as HTMLImageElement;
			const rect = image.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			const fire = (type: string) =>
				stage.dispatchEvent(
					new PointerEvent(type, {
						pointerId: 21,
						pointerType: "touch",
						isPrimary: true,
						clientX: x,
						clientY: y,
						bubbles: true,
						cancelable: true,
					}),
				);
			fire("pointerdown");
			fire("pointerup");
			fire("pointerdown");
			fire("pointerup");
			await new Promise((resolve) => requestAnimationFrame(resolve));
		});
}

async function seededChat(
	page: Page,
	options: { width?: number; height?: number; seeThrough?: boolean } = {},
): Promise<{ user: TourUser; conversationId: string; fileId: string }> {
	const user = await createTourUser();
	await markToursSeen(user);
	const conversationId = await startChatAs(page, user);
	const seeded = await seedImageItem(user, conversationId, {
		width: options.width ?? 2048,
		height: options.height ?? 1024,
		seeThroughOf: () => options.seeThrough ?? false,
	});
	return { user, conversationId, fileId: seeded.fileIds[0] };
}

test.describe("enlarging a picture (Task 22)", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(METRICS_SCRIPT);
	});

	test("the panel's picture opens full screen, zooms, pans and closes", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		const { conversationId, fileId } = await seededChat(page);
		await reopenChat(page, conversationId);

		// "What this chat made": the picture's row shows its thumbnail, no shift.
		const listShown = await now(page);
		await openPanelList(page);
		const thumb = panelList(page).locator(
			'[data-testid="artifact-row-thumb"] [data-testid="image-picture-after"]',
		);
		await expect(thumb).toHaveClass(/is-loaded/);
		expect(await thumb.getAttribute("src")).toContain("variant=thumb");
		expect((await metricsSince(page, listShown)).cls).toBe(0);

		await openItem(page, IMAGE_ITEM_TITLE);
		await expect(
			page.locator(
				'[data-testid="image-body-picture"] [data-testid="image-picture-after"]',
			),
		).toHaveClass(/is-loaded/);

		const opened = await now(page);
		await watchAnimations(page);
		await shown(page, "image-body-enlarge").click();
		await expect(page.locator(VIEWER)).toBeVisible();
		// It opens on opacity and transform alone.
		const animated = await animatedProperties(page);
		expect(animated.length).toBeGreaterThan(0);
		for (const property of animated)
			expect(["opacity", "transform"]).toContain(property);
		await waitForViewerPicture(page);
		expect((await metricsSince(page, opened)).cls).toBe(0);

		const image = page.locator(VIEWER_IMAGE);
		expect(await image.getAttribute("src")).toBe(
			`/api/images/files/${fileId}?conversationId=${conversationId}`,
		);
		// Fit: a 2048 px picture is drawn under its own size, and says so.
		const fit = await zoomLevel(page);
		expect(fit).toBeLessThan(100);
		await expect(page.locator(VIEWER)).toBeFocused();

		// The wheel zooms in about the pointer.
		const box = await image.boundingBox();
		if (!box) throw new Error("no picture box");
		await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
		await page.mouse.wheel(0, -400);
		await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fit);
		const [zoomedScale, zoomedX] = await viewerTransform(page);
		expect(zoomedScale).toBeGreaterThan(1);

		// A drag pans the zoomed picture, and the click it ends with closes nothing.
		const centre = { x: DESKTOP.width / 2, y: DESKTOP.height / 2 };
		await page.mouse.move(centre.x, centre.y);
		await page.mouse.down();
		await page.mouse.move(centre.x + 60, centre.y, { steps: 4 });
		await page.mouse.move(centre.x + 120, centre.y, { steps: 4 });
		await page.mouse.up();
		await expect
			.poll(async () => (await viewerTransform(page))[1])
			.not.toBe(zoomedX);
		await expect(page.locator(VIEWER)).toBeVisible();

		// A double click goes back to fit, another to 100%.
		await image.dblclick();
		await expect.poll(() => zoomLevel(page)).toBe(fit);
		await image.dblclick();
		await expect.poll(() => zoomLevel(page)).toBe(100);

		// The keys: 0 fits, + and - step.
		await page.keyboard.press("0");
		await expect.poll(() => zoomLevel(page)).toBe(fit);
		await page.keyboard.press("+");
		await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fit);
		await page.keyboard.press("-");
		await expect.poll(() => zoomLevel(page)).toBe(fit);

		// Esc closes it and hands focus back to Enlarge; the panel stays open.
		await page.keyboard.press("Escape");
		await expect(page.locator(VIEWER)).toHaveCount(0);
		await expect(shown(page, "image-body-enlarge")).toBeFocused();
		await expect(shown(page, "image-body")).toBeVisible();

		// A click on the backdrop closes it, and so does x.
		// The 2:1 picture fills the width at fit: the band above it is backdrop.
		await openViewerFromPanel(page);
		const fitted = await page.locator(VIEWER_IMAGE).boundingBox();
		expect(fitted?.y ?? 0).toBeGreaterThan(80);
		await page.mouse.click(DESKTOP.width / 2, (fitted?.y ?? 80) / 2 + 20);
		await expect(page.locator(VIEWER)).toHaveCount(0);
		await openViewerFromPanel(page);
		await closeViewer(page).click();
		await expect(page.locator(VIEWER)).toHaveCount(0);
		await expect(shown(page, "image-body")).toBeVisible();
	});

	test("a see-through picture lies on the checkerboard in the viewer", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		const { conversationId } = await seededChat(page, {
			width: 512,
			height: 512,
			seeThrough: true,
		});
		await reopenChat(page, conversationId);
		await openItem(page, IMAGE_ITEM_TITLE);
		await openViewerFromPanel(page);
		await expect(page.locator(VIEWER_IMAGE)).toHaveClass(/image-checkerboard/);
		// A picture that fits at its own size: fit is 100%, and the double click goes to 2x.
		expect(await zoomLevel(page)).toBe(100);
		await page.locator(VIEWER_IMAGE).dblclick();
		await expect.poll(() => zoomLevel(page)).toBe(200);
	});

	test("on a phone the sheet's picture enlarges, pinches and double-taps", async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({
			baseURL,
			viewport: PHONE,
			hasTouch: true,
			isMobile: true,
		});
		const page = await context.newPage();
		await page.addInitScript(METRICS_SCRIPT);
		try {
			const { conversationId } = await seededChat(page);
			await reopenChat(page, conversationId);
			await openItem(page, IMAGE_ITEM_TITLE);
			await expect(shown(page, "image-body-enlarge")).toBeVisible();
			await shown(page, "image-body-enlarge").tap();
			await expect(page.locator(VIEWER)).toBeVisible();
			await expect
				.poll(() =>
					page
						.locator(VIEWER_IMAGE)
						.evaluate((image: HTMLImageElement) => image.naturalWidth),
				)
				.toBeGreaterThan(0);
			await waitForMotionToSettle(page);
			// The viewer is on top of the phone sheet: its picture is what a finger meets.
			const onTop = await page.evaluate(() => {
				const hit = document.elementFromPoint(
					window.innerWidth / 2,
					window.innerHeight / 2,
				);
				return Boolean(hit?.closest('[data-testid="image-lightbox"]'));
			});
			expect(onTop).toBe(true);
			// 44 px targets.
			const zoomIn = await page
				.getByTestId("image-lightbox-zoom-in")
				.boundingBox();
			expect(zoomIn?.height ?? 0).toBeGreaterThanOrEqual(44);

			const fit = await zoomLevel(page);
			await pinch(page, 60, 220);
			await expect
				.poll(async () => (await viewerTransform(page))[0])
				.toBeGreaterThan(2);
			expect(await zoomLevel(page)).toBeGreaterThan(fit);
			await doubleTap(page);
			await expect.poll(() => zoomLevel(page)).toBe(fit);
			await doubleTap(page);
			await expect.poll(() => zoomLevel(page)).toBe(100);

			await closeViewer(page).tap();
			await expect(page.locator(VIEWER)).toHaveCount(0);
			await expect(shown(page, "image-body")).toBeVisible();
		} finally {
			await context.close();
		}
	});
});

test.describe("enlarging the card's picture (Task 22)", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();
	let fake: FakeComfyUi | null = null;
	let model: SpecChatModel | null = null;

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		await login(page);
		model = await useSpecChatModel(page, fakeProvider.baseURL, "images_t22_");
		fake = await startFakeComfyUiForSpec(page);
	});
	test.afterEach(async ({ page }) => {
		if (fake) await stopFakeComfyUiForSpec(page, fake);
		fake = null;
		if (model) await releaseSpecChatModel(page, model);
		model = null;
	});

	test("the card's picture still opens the panel; its Enlarge opens the viewer", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("message-input")).toBeVisible();
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		const card = page
			.locator(
				'[data-testid="message-deliverables"] [data-testid="artifact-card"]',
			)
			.last();
		await expect(
			card.locator(
				'[data-testid="image-card-stage"] [data-testid="image-picture-after"]',
			),
		).toHaveClass(/is-loaded/, { timeout: 45_000 });
		await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
			timeout: 30_000,
		});
		const shownSrc = await card
			.locator('[data-testid="image-picture-after"]')
			.getAttribute("src");
		const fileId = /files\/([^?]+)/.exec(shownSrc ?? "")?.[1];
		expect(fileId).toBeTruthy();

		await card.getByTestId("image-card-enlarge").click();
		await expect(page.locator(VIEWER)).toBeVisible();
		expect(await page.locator(VIEWER_IMAGE).getAttribute("src")).toBe(
			`/api/images/files/${fileId}?conversationId=${conversationId}`,
		);
		await page.keyboard.press("Escape");
		await expect(page.locator(VIEWER)).toHaveCount(0);
		await expect(shown(page, "image-body")).toHaveCount(0);

		await card.getByTestId("image-card-picture").click();
		await expect(shown(page, "image-body")).toBeVisible();
	});
});

/** A user whose library holds two pictures and a Document. */
async function seededLibrary(page: Page): Promise<TourUser> {
	const user = await createTourUser();
	await markToursSeen(user);
	const conversationId = await startChatAs(page, user);
	await seedImageItem(user, conversationId, { title: "Harbour at dusk" });
	await seedImageItem(user, conversationId, {
		title: "See-through logo",
		width: 832,
		height: 1248,
		seeThroughOf: () => true,
	});
	await seedItem(user, conversationId, "document", { title: "Trip notes" });
	return user;
}

const KB_THUMBS =
	'[data-testid="document-thumb"] [data-testid="image-picture-after"]';

test.describe("pictures in the Knowledge Base (Task 22)", () => {
	test("rows show thumbnails without a shift; the grid is remembered and opens an item", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		await page.addInitScript(METRICS_SCRIPT);
		await seededLibrary(page);

		// Hold the thumbnails until the table is drawn, then let them land.
		const held: Array<() => Promise<void>> = [];
		let holding = true;
		await page.route(/\/api\/images\/files\/.*variant=thumb/, (route) => {
			if (holding) held.push(() => route.continue());
			else void route.continue();
		});
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await expect(page.locator(".documents-table")).toBeVisible();
		await expect.poll(() => held.length).toBeGreaterThanOrEqual(2);
		await waitForMotionToSettle(page);
		const before = await now(page);
		holding = false;
		for (const release of held.splice(0)) await release();
		await page.unroute(/\/api\/images\/files\/.*variant=thumb/);
		await expect(
			page.locator(`.documents-table ${KB_THUMBS}.is-loaded`),
		).toHaveCount(2);
		await waitForMotionToSettle(page);
		expect((await metricsSince(page, before)).cls).toBe(0);
		// The Document keeps its icon.
		const docRow = page
			.locator(".documents-table tr")
			.filter({ hasText: "Trip notes" });
		await expect(docRow.getByTestId("document-thumb")).toHaveCount(0);

		// Grid: a square tile per item, the title under it.
		await page.getByRole("button", { name: "Grid view" }).click();
		const grid = page.getByTestId("documents-grid");
		await expect(grid).toBeVisible();
		await expect(page.locator(".documents-table")).toHaveCount(0);
		await expect(grid.getByTestId("documents-grid-tile")).toHaveCount(3);
		await expect(grid.locator(`${KB_THUMBS}.is-loaded`)).toHaveCount(2);
		for (const picture of await grid.locator(".documents-grid-picture").all()) {
			const box = await picture.boundingBox();
			expect(
				Math.abs((box?.width ?? 0) - (box?.height ?? 1)),
			).toBeLessThanOrEqual(1);
		}

		// Remembered for the next visit, and drawn on the first client frame.
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByTestId("documents-grid")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Grid view" }),
		).toHaveAttribute("aria-pressed", "true");

		// A tile opens the item as a row does.
		await page
			.getByTestId("documents-grid-tile")
			.filter({ hasText: "Harbour at dusk" })
			.click();
		await expect(shown(page, "image-body")).toBeVisible();

		// And back to the list, remembered too.
		await page.goto("/knowledge", { waitUntil: "networkidle" });
		await page.getByRole("button", { name: "List view" }).click();
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.locator(".documents-table")).toBeVisible();
	});

	test("the grid holds two columns on a phone", async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({
			baseURL,
			viewport: PHONE,
			hasTouch: true,
			isMobile: true,
		});
		const page = await context.newPage();
		try {
			await seededLibrary(page);
			await page.goto("/knowledge", { waitUntil: "networkidle" });
			await page.getByRole("button", { name: "Grid view" }).tap();
			const tiles = page.getByTestId("documents-grid-tile");
			await expect(tiles).toHaveCount(3);
			const lefts = new Set<number>();
			for (const tile of await tiles.all()) {
				const box = await tile.boundingBox();
				lefts.add(Math.round(box?.x ?? 0));
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
					PHONE.width,
				);
			}
			expect(lefts.size).toBe(2);
		} finally {
			await context.close();
		}
	});
});

// --- The owner's reel: videos, numbers, contact sheets and screenshots --------

function contactSheet(video: string): void {
	try {
		execFileSync("ffmpeg", [
			"-y",
			"-loglevel",
			"error",
			"-i",
			video,
			"-vf",
			"fps=12,scale=480:-1,tile=6x4",
			// One sheet per two seconds of video, numbered: the whole flow, not its start.
			video.replace(/\.webm$/, "-sheet-%02d.png"),
		]);
	} catch {
		// No ffmpeg on this machine: the video still stands.
	}
}

async function recorded(
	browser: Browser,
	baseURL: string | undefined,
	options: {
		viewport: { width: number; height: number };
		colorScheme: "light" | "dark";
		reducedMotion?: "reduce" | "no-preference";
	},
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		baseURL,
		viewport: options.viewport,
		colorScheme: options.colorScheme,
		reducedMotion: options.reducedMotion ?? "no-preference",
		hasTouch: options.viewport.width < 500,
		isMobile: options.viewport.width < 500,
		recordVideo: OUT_DIR
			? { dir: join(OUT_DIR, ".raw"), size: options.viewport }
			: undefined,
	});
	const page = await context.newPage();
	await page.addInitScript(METRICS_SCRIPT);
	return { context, page };
}

async function finish(
	context: BrowserContext,
	page: Page,
	name: string,
	numbers: Record<string, unknown>,
): Promise<void> {
	const video = page.video();
	await context.close();
	if (!OUT_DIR || !video) return;
	mkdirSync(OUT_DIR, { recursive: true });
	const target = join(OUT_DIR, `t22-${name}.webm`);
	await video.saveAs(target);
	writeFileSync(
		join(OUT_DIR, `t22-${name}.json`),
		`${JSON.stringify(numbers, null, 2)}\n`,
	);
	contactSheet(target);
}

const shot = (name: string) => join(SHOTS_DIR, `${name}.png`);

test.describe("the Task 22 reel", () => {
	test.skip(!OUT_DIR, "set MOTION_VIDEO_DIR to record the reel");
	test.beforeAll(() => {
		mkdirSync(SHOTS_DIR, { recursive: true });
	});

	for (const scheme of ["light", "dark"] as const) {
		for (const [shape, viewport] of [
			["desktop", DESKTOP],
			["phone", PHONE],
		] as const) {
			test(`viewer, ${shape}, ${scheme}`, async ({ browser, baseURL }) => {
				const { context, page } = await recorded(browser, baseURL, {
					viewport,
					colorScheme: scheme,
				});
				const { conversationId } = await seededChat(page);
				await reopenChat(page, conversationId);
				await openItem(page, IMAGE_ITEM_TITLE);
				await expect(
					page.locator(
						'[data-testid="image-body-picture"] [data-testid="image-picture-after"]',
					),
				).toHaveClass(/is-loaded/);
				await waitForMotionToSettle(page);
				await page.screenshot({
					path: shot(`panel-enlarge-${shape}-${scheme}`),
				});
				const opened = await now(page);
				await watchAnimations(page);
				const enlarge = shown(page, "image-body-enlarge");
				if (shape === "phone") await enlarge.tap();
				else await enlarge.click();
				await expect(page.locator(VIEWER)).toBeVisible();
				const animated = await animatedProperties(page);
				await expect
					.poll(() =>
						page
							.locator(VIEWER_IMAGE)
							.evaluate((image: HTMLImageElement) => image.naturalWidth),
					)
					.toBeGreaterThan(0);
				await waitForMotionToSettle(page);
				const openMetrics = await metricsSince(page, opened);
				await page.screenshot({ path: shot(`viewer-fit-${shape}-${scheme}`) });
				const zoomed = await now(page);
				if (shape === "phone") {
					await pinch(page, 60, 220);
				} else {
					const box = await page.locator(VIEWER_IMAGE).boundingBox();
					if (!box) throw new Error("no box");
					await page.mouse.move(
						box.x + box.width * 0.6,
						box.y + box.height * 0.5,
					);
					for (let step = 0; step < 6; step++) await page.mouse.wheel(0, -120);
					await expect.poll(() => zoomLevel(page)).toBeGreaterThan(100);
					await page.mouse.down();
					await page.mouse.move(viewport.width / 2 + 160, viewport.height / 2, {
						steps: 12,
					});
					await page.mouse.up();
				}
				await waitForMotionToSettle(page);
				const zoomMetrics = await metricsSince(page, zoomed);
				await page.screenshot({
					path: shot(`viewer-zoomed-${shape}-${scheme}`),
				});
				const closed = await now(page);
				if (shape === "phone") {
					await closeViewer(page).tap();
				} else {
					await page.keyboard.press("Escape");
				}
				await expect(page.locator(VIEWER)).toHaveCount(0);
				await waitForMotionToSettle(page);
				const closeMetrics = await metricsSince(page, closed);
				expect(openMetrics.cls).toBe(0);
				for (const property of animated) {
					expect(["opacity", "transform"]).toContain(property);
				}
				await finish(context, page, `viewer-${shape}-${scheme}`, {
					open: openMetrics,
					zoom: zoomMetrics,
					close: closeMetrics,
					animatedProperties: animated,
				});
			});
		}
	}

	test("viewer, reduced motion", async ({ browser, baseURL }) => {
		const { context, page } = await recorded(browser, baseURL, {
			viewport: DESKTOP,
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		const { conversationId } = await seededChat(page);
		await reopenChat(page, conversationId);
		await openItem(page, IMAGE_ITEM_TITLE);
		await watchAnimations(page);
		await shown(page, "image-body-enlarge").click();
		await expect(page.locator(VIEWER)).toBeVisible();
		// No animation at all on the way in.
		expect(await animatedProperties(page)).toEqual([]);
		await page.locator(VIEWER_IMAGE).dblclick();
		await expect.poll(() => zoomLevel(page)).toBe(100);
		await page.keyboard.press("Escape");
		await expect(page.locator(VIEWER)).toHaveCount(0);
		await finish(context, page, "viewer-reduced-motion", {});
	});

	for (const scheme of ["light", "dark"] as const) {
		for (const [shape, viewport] of [
			["desktop", DESKTOP],
			["phone", PHONE],
		] as const) {
			test(`library list and grid, ${shape}, ${scheme}`, async ({
				browser,
				baseURL,
			}) => {
				const { context, page } = await recorded(browser, baseURL, {
					viewport,
					colorScheme: scheme,
				});
				await seededLibrary(page);
				await page.goto("/knowledge", { waitUntil: "networkidle" });
				await expect(page.locator(`${KB_THUMBS}.is-loaded`)).toHaveCount(2);
				await waitForMotionToSettle(page);
				const loaded = await metricsSince(page, 0);
				await page.screenshot({
					path: shot(`kb-list-${shape}-${scheme}`),
					fullPage: true,
				});
				const toggled = await now(page);
				const grid = page.getByRole("button", { name: "Grid view" });
				if (shape === "phone") await grid.tap();
				else await grid.click();
				await expect(
					page.locator(`[data-testid="documents-grid"] ${KB_THUMBS}.is-loaded`),
				).toHaveCount(2);
				await waitForMotionToSettle(page);
				const toggleMetrics = await metricsSince(page, toggled);
				await page.screenshot({
					path: shot(`kb-grid-${shape}-${scheme}`),
					fullPage: true,
				});
				await finish(context, page, `kb-grid-${shape}-${scheme}`, {
					pageLoad: loaded,
					toggleToGrid: toggleMetrics,
				});
			});
		}
	}
});
