import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import {
	AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT,
	AI_SMOKE_EDIT_PHOTO_MARKER,
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_INTRO,
	AI_SMOKE_LATE_PICTURE_MARKER,
	AI_SMOKE_TRANSPARENT_PICTURE_MARKER,
} from "../fixtures/ai/late-picture-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import {
	clearAdminConfig,
	createEmptyConversation,
	login,
	sendMessage,
} from "./helpers";
import {
	attachPhoto,
	type FakeComfyUi,
	randomPng,
	releaseSpecChatModel,
	type SpecChatModel,
	saveSpecVideo,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
	useSpecChatModel,
	VIDEO_DIR,
} from "./images-helpers";

// The picture card, the panel and History, end to end (docs/plans/image-generation,
// part 2b Task 8). The fake chat model calls the app's real make_image tool, the
// real job engine sends the work to a fake ComfyUI, and the reader presses the
// card's own buttons. Every wait is on a state the page shows, never on a pause.
// Each test leaves one video in the handoff folder (t8-<name>.webm) for the owner.

const fakeProvider = createOpenAICompatibleProviderHarness();
const PROVIDER_PREFIX = "images_t8_";

const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';
const LOADED = `${CARD} [data-testid="image-card-stage"] [data-testid="image-picture-after"].is-loaded`;
const INTRO_START = AI_SMOKE_LATE_PICTURE_INTRO[0].slice(0, 20);

type Detail = {
	imageCards: Array<{
		artifactId: string | null;
		pickedTakeId: string | null;
		takes: Array<{ id: string; status: string; fileId: string | null }>;
	}>;
};

async function readDetail(page: Page, conversationId: string): Promise<Detail> {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	expect(response.ok(), `detail read -> ${response.status()}`).toBe(true);
	return (await response.json()) as Detail;
}

async function openChat(page: Page): Promise<string> {
	const conversationId = await createEmptyConversation(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible();
	return conversationId;
}

/** Sends the late-picture turn and waits until the picture is on the card and the reply is whole. */
async function makePicture(page: Page, marker = AI_SMOKE_LATE_PICTURE_MARKER) {
	await sendMessage(page, marker);
	await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
	await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
}

/** Waits for the card's take, its pick and its Image item to be written (three writes, not one). */
async function waitForSettledCard(
	page: Page,
	conversationId: string,
	takes: number,
) {
	await expect
		.poll(
			async () => {
				const [card] = (await readDetail(page, conversationId)).imageCards;
				const settled =
					card?.takes.length === takes &&
					card.takes.every((entry) => entry.status === "succeeded") &&
					card.pickedTakeId !== null &&
					card.artifactId !== null;
				return settled ? "settled" : JSON.stringify(card ?? null);
			},
			{ message: `the card holds ${takes} settled take(s)`, timeout: 30_000 },
		)
		.toBe("settled");
	return (await readDetail(page, conversationId)).imageCards[0];
}

test.use({
	video: VIDEO_DIR ? { mode: "on", size: { width: 1440, height: 900 } } : "off",
});

test.describe("Pictures end to end", () => {
	let fake: FakeComfyUi | null = null;
	let model: SpecChatModel | null = null;
	let fakeStopped = false;
	let videoName = "unnamed";

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		fakeStopped = false;
		await login(page);
		model = await useSpecChatModel(page, fakeProvider.baseURL, PROVIDER_PREFIX);
		fake = await startFakeComfyUiForSpec(page);
	});

	test.afterEach(async ({ page }) => {
		if (fakeStopped) await clearAdminConfig(page, ["COMFYUI_URL"]);
		else if (fake) await stopFakeComfyUiForSpec(page, fake);
		fake = null;
		if (model) await releaseSpecChatModel(page, model);
		model = null;
		await saveSpecVideo(page, videoName);
	});

	test("makes a picture and shows it under the reply", {
		tag: "@smoke",
	}, async ({ page }) => {
		videoName = "makes-a-picture";
		const comfy = fake as FakeComfyUi;
		comfy.setOptions({ steps: 10, stepDelayMs: 300 });
		comfy.holdQueue(true);
		const conversationId = await openChat(page);

		// Every frame: where the reply's first sentence is, what the card holds,
		// and how big its picture box is (the method of artifact-card-arrival.spec.ts).
		await page.evaluate((introStart) => {
			type Frame = {
				top: number | null;
				user: number | null;
				cards: number;
				making: boolean;
				stage: [number, number] | null;
			};
			const frames: Frame[] = [];
			(window as unknown as { __frames: Frame[] }).__frames = frames;
			const tick = () => {
				let top: number | null = null;
				for (const paragraph of document.querySelectorAll(
					'[data-testid="assistant-message"] p',
				)) {
					if (paragraph.textContent?.startsWith(introStart)) {
						top = paragraph.getBoundingClientRect().top;
						break;
					}
				}
				const card = document.querySelector(
					'[data-testid="message-deliverables"] [data-testid="artifact-card"]',
				);
				const stage = card
					?.querySelector('[data-testid="image-card-stage"]')
					?.getBoundingClientRect();
				frames.push({
					top,
					user:
						document
							.querySelector('[data-testid="user-message"]')
							?.getBoundingClientRect().top ?? null,
					cards: document.querySelectorAll(
						'[data-testid="message-deliverables"] [data-testid="artifact-card"]',
					).length,
					making: card?.textContent?.includes("Making the picture") ?? false,
					stage: stage ? [stage.width, stage.height] : null,
				});
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		}, INTRO_START);

		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		const card = page.locator(CARD).last();
		await expect(card).toBeVisible({ timeout: 30_000 });
		comfy.holdQueue(false);
		await expect(card.getByText("Making the picture…")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
			timeout: 30_000,
		});

		// The card is drawn after the prose, inside the message's deliverables.
		const sentences = page
			.getByTestId("assistant-message")
			.getByText(INTRO_START);
		const sentencesBox = await sentences.boundingBox();
		const cardBox = await card.boundingBox();
		expect(sentencesBox && cardBox, "both are laid out").toBeTruthy();
		expect(
			(cardBox?.y ?? 0) >=
				(sentencesBox?.y ?? 0) + (sentencesBox?.height ?? 0) - 1,
			"the card starts below the sentences",
		).toBe(true);

		// Review Focus 1: the first sentence keeps its top edge, frame by frame,
		// from the frame before the card came to the end of the turn, and the
		// picture box keeps the size it was reserved at through waiting, making
		// and the picture loading.
		const frames = await page.evaluate(
			() =>
				(
					window as unknown as {
						__frames: Array<{
							top: number | null;
							user: number | null;
							cards: number;
							making: boolean;
							stage: [number, number] | null;
						}>;
					}
				).__frames,
		);
		// The sentence is placed against the reader's own message above it: the
		// thread follows the bottom while a reply streams, which scrolls both.
		const seen = frames
			.filter((frame) => frame.top !== null && frame.user !== null)
			.map((frame) => ({
				...frame,
				top: (frame.top as number) - (frame.user as number),
			}));
		const arrival = seen.findIndex((frame) => frame.cards > 0);
		expect(
			arrival,
			"the card arrived after the first sentence",
		).toBeGreaterThan(0);
		const before = seen[arrival - 1].top as number;
		const moved = seen
			.slice(arrival)
			.map((frame) => Math.abs((frame.top as number) - before));
		expect(
			Math.max(...moved),
			"how far the first sentence moved once the card was there, in px",
		).toBeLessThanOrEqual(1);
		expect(
			frames.some((frame) => frame.making),
			"the card said it was making the picture",
		).toBe(true);
		const stages = frames
			.map((frame) => frame.stage)
			.filter((stage): stage is [number, number] => stage !== null);
		const [width, height] = stages[0];
		for (const stage of stages) {
			expect(Math.abs(stage[0] - width)).toBeLessThanOrEqual(0.5);
			expect(Math.abs(stage[1] - height)).toBeLessThanOrEqual(0.5);
		}

		await waitForSettledCard(page, conversationId, 1);
	});

	// Task 11, the owner on ai.dev: "the file didn't appear, I had to refresh".
	// A first message from the home page whose card arrives with the take
	// already being made (progress above 0, as a real render is by the first
	// poll) froze every update of the page on Svelte 5.55.8 (see
	// svelte-scheduler.test.ts): the card said "Making the picture…" for good.
	test("a picture asked for from the home page lands on its card without a reload", async ({
		page,
	}) => {
		videoName = "home-page-picture";
		(fake as FakeComfyUi).setOptions({ steps: 10, stepDelayMs: 600 });
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		await page.waitForURL(/\/chat\/[^/?]+/);
		const conversationId = new URL(page.url()).pathname.split("/").at(-1);
		const card = page.locator(CARD).last();
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
			timeout: 30_000,
		});
		await waitForSettledCard(page, conversationId as string, 1);
	});

	test("Another adds a take and Use this moves the tick", async ({ page }) => {
		videoName = "another-and-use-this";
		const comfy = fake as FakeComfyUi;
		comfy.setOptions({ steps: 3, stepDelayMs: 100 });
		const conversationId = await openChat(page);
		await makePicture(page);
		await waitForSettledCard(page, conversationId, 1);

		await page.getByTestId("image-card-another").click();
		await expect(page.getByTestId("image-card-use")).toBeVisible({
			timeout: 30_000,
		});
		const tiles = page.getByTestId("image-card-tile");
		await expect(tiles).toHaveCount(2);
		// The first take is still the one in use.
		await expect(tiles.nth(0).getByTestId("image-card-in-use")).toBeVisible();
		await expect(tiles.nth(1).getByTestId("image-card-in-use")).toHaveCount(0);

		await page.getByTestId("image-card-use").click();
		await expect(tiles.nth(1).getByTestId("image-card-in-use")).toBeVisible({
			timeout: 15_000,
		});
		await expect(tiles.nth(0).getByTestId("image-card-in-use")).toHaveCount(0);
		await expect(page.getByTestId("image-card-use")).toBeHidden();

		// History lists both versions, each with a thumbnail.
		await page.getByRole("button", { name: "More" }).click();
		await page.getByTestId("image-card-history").click();
		const history = page.getByTestId("artifact-history");
		await expect(history).toBeVisible({ timeout: 20_000 });
		const options = history.getByTestId("history-option");
		await expect(options).toHaveCount(2);
		for (const thumb of await history.getByTestId("history-thumb").all()) {
			await expect(thumb.locator("img")).toBeVisible();
		}
		await expect(history.getByTestId("history-thumb")).toHaveCount(2);
	});

	test("changes an uploaded photo", async ({ page }) => {
		videoName = "changes-a-photo";
		const conversationId = await openChat(page);
		const photo = await randomPng();
		await attachPhoto(page, photo, 1);
		await sendMessage(page, AI_SMOKE_EDIT_PHOTO_MARKER);
		await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
		await expect(
			page.getByText(AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT),
		).toBeVisible({ timeout: 30_000 });
		await waitForSettledCard(page, conversationId, 1);

		const card = page.locator(CARD).last();
		await expect(card).toContainText("Image · from your photo");

		// Before / After flips the card's picture between the photo and the change.
		const picture = card.getByTestId("image-picture");
		await expect(picture).toHaveAttribute("data-showing", "after");
		await card.getByTestId("image-card-before").click();
		await expect(picture).toHaveAttribute("data-showing", "before");
		await expect(card.getByTestId("image-card-before")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await card.getByTestId("image-card-after").click();
		await expect(picture).toHaveAttribute("data-showing", "after");

		// The panel's strip starts with the photo.
		await card.getByTestId("artifact-card-head").click();
		const frames = page.locator('[data-testid="image-version-frame"]:visible');
		await expect(frames.first()).toBeVisible({ timeout: 20_000 });
		await expect(frames.first()).toHaveAttribute("aria-label", /Your photo$/);
		await expect(frames).toHaveCount(2);
	});

	test("History compares and restores", async ({ page }) => {
		videoName = "history-compare-restore";
		const comfy = fake as FakeComfyUi;
		comfy.setOptions({ steps: 3, stepDelayMs: 100 });
		const conversationId = await openChat(page);
		await makePicture(page);
		await waitForSettledCard(page, conversationId, 1);
		await page.getByTestId("image-card-another").click();
		await expect(page.getByTestId("image-card-use")).toBeVisible({
			timeout: 30_000,
		});
		await page.getByTestId("image-card-use").click();
		const settled = await waitForSettledCard(page, conversationId, 2);
		await expect
			.poll(async () => {
				const [card] = (await readDetail(page, conversationId)).imageCards;
				return card.pickedTakeId;
			})
			.toBe(settled.takes[1].id);
		const firstFileId = settled.takes[0].fileId as string;

		await page.locator(CARD).last().getByTestId("artifact-card-head").click();
		await expect(
			page
				.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
				)
				.first(),
		).toBeVisible({ timeout: 20_000 });
		await page
			.locator('[data-testid="artifact-history-button"]:visible')
			.first()
			.click();
		const history = page.getByTestId("artifact-history");
		await expect(history).toBeVisible();
		const options = history.getByTestId("history-option");
		// The newest first: the picked take, then the picture Alfy made.
		await expect(options).toHaveCount(2);
		await options.last().click();
		await expect(history.getByTestId("image-version-preview")).toHaveAttribute(
			"data-status",
			"ready",
		);

		// The wipe moves with the keyboard: the cut at either end differs.
		const range = history.getByTestId("compare-wipe-range");
		await range.focus();
		const clipOf = () =>
			history
				.getByTestId("compare-wipe-after")
				.evaluate((element) => (element as HTMLElement).style.clipPath);
		await page.keyboard.press("Home");
		const atHome = await clipOf();
		await page.keyboard.press("End");
		await expect.poll(clipOf).not.toBe(atHome);

		await page
			.locator('[data-testid="history-restore"]:visible')
			.first()
			.click();
		await page
			.locator('[data-testid="history-restore-confirm"]:visible')
			.first()
			.click();
		await expect(page.getByTestId("history-toast")).toContainText("Restored");
		await page
			.locator('[data-testid="artifact-history-button"]:visible')
			.first()
			.click();
		await expect(history).toHaveCount(0);
		await expect(
			page
				.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-after"]',
				)
				.last(),
		).toHaveAttribute("src", new RegExp(firstFileId));
	});

	test.describe("a transparent picture", () => {
		test.use({ colorScheme: "dark" });

		test("shows the checkerboard in dark mode and downloads with its alpha channel", async ({
			page,
		}) => {
			videoName = "transparent-picture";
			const conversationId = await openChat(page);
			await makePicture(page, AI_SMOKE_TRANSPARENT_PICTURE_MARKER);
			await waitForSettledCard(page, conversationId, 1);

			const card = page.locator(CARD).last();
			await expect(card).toContainText("Lighthouse cut-out");
			const picture = card.getByTestId("image-picture");
			await expect(picture).toHaveClass(/image-checkerboard/);
			await expect(picture).toHaveCSS("background-image", /conic-gradient/);
			expect(
				await page.evaluate(
					() => matchMedia("(prefers-color-scheme: dark)").matches,
				),
				"the page is in dark mode",
			).toBe(true);

			// Download keeps the alpha channel: the stored file is a PNG with four channels.
			const downloading = page.waitForEvent("download");
			await card.getByRole("button", { name: "More" }).click();
			await page.getByTestId("image-card-download").click();
			const download = await downloading;
			const path = await download.path();
			const meta = await sharp(readFileSync(path)).metadata();
			expect(meta.format).toBe("png");
			expect(meta.hasAlpha, "the downloaded picture has an alpha channel").toBe(
				true,
			);
			expect(meta.channels).toBe(4);
			// The see-through part really is clear: left opaque, right fully transparent.
			const { data, info } = await sharp(readFileSync(path))
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
			const alphaAt = (fx: number) =>
				data[
					(Math.floor(info.height / 2) * info.width +
						Math.floor(info.width * fx)) *
						4 +
						3
				];
			expect(alphaAt(0.2)).toBe(255);
			expect(alphaAt(0.9)).toBe(0);
		});
	});

	test("pictures can't be made right now", async ({ page }) => {
		videoName = "pictures-unavailable";
		const comfy = fake as FakeComfyUi;
		// The setting still points at the fake; the fake is gone.
		await comfy.close();
		fakeStopped = true;
		await openChat(page);
		await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
		const card = page.locator(CARD).last();
		await expect(
			card.getByText("Pictures can't be made right now."),
		).toBeVisible({ timeout: 45_000 });
		await expect(card.getByTestId("image-card-retry")).toHaveText("Try again");
	});

	test.describe("a phone in Hungarian", () => {
		test.use({
			viewport: { width: 360, height: 780 },
			hasTouch: true,
			isMobile: true,
		});

		test("fits the card's actions, the takes strip and the composer's chips in 360 px", async ({
			page,
		}) => {
			videoName = "phone-hungarian";
			// A Hungarian reader with the right to set the picture server up.
			const reader = await createTourUser("hu", "admin");
			await markToursSeen(reader);
			await releaseSpecChatModel(page, model as SpecChatModel);
			model = null;
			await login(page, reader.email, reader.password);
			model = await useSpecChatModel(
				page,
				fakeProvider.baseURL,
				PROVIDER_PREFIX,
			);
			const comfy = fake as FakeComfyUi;
			comfy.setOptions({ steps: 3, stepDelayMs: 100 });
			const conversationId = await openChat(page);
			await makePicture(page);
			await waitForSettledCard(page, conversationId, 1);
			await page.getByTestId("image-card-another").click();
			await expect(page.getByTestId("image-card-use")).toBeVisible({
				timeout: 30_000,
			});

			const card = page.locator(CARD).last();
			await expect(card.getByTestId("image-card-another")).toHaveText(/Másik/);
			await expect(card.getByTestId("image-card-use")).toHaveText(/Ez legyen/);

			// A numbered chip in the composer: the shown take's picture, attached from its card.
			await card.getByRole("button", { name: "Továbbiak" }).click();
			await page.getByTestId("image-card-attach").click();
			await expect(page.getByTestId("composer-chip-picture")).toHaveCount(1);

			const overflowing = await page.evaluate(() => {
				const probes: Array<[string, Element | null]> = [
					[
						"the card",
						document.querySelector(
							'[data-testid="message-deliverables"] [data-testid="artifact-card"]',
						),
					],
					[
						"the card's actions",
						document.querySelector(
							'[data-testid="message-deliverables"] .image-card-actions',
						),
					],
					[
						"the takes strip",
						document.querySelector('[data-testid="image-card-strip"]'),
					],
					[
						"the composer's chips",
						document
							.querySelector('[data-testid="composer-chip-picture"]')
							?.closest("ul") ?? null,
					],
					["the page", document.documentElement],
				];
				return probes
					.map(([name, element]) => ({
						name,
						found: element !== null,
						scrollWidth: element?.scrollWidth ?? 0,
						clientWidth: element?.clientWidth ?? 0,
					}))
					.filter(
						(probe) => !probe.found || probe.scrollWidth > probe.clientWidth,
					);
			});
			expect(overflowing, "what is wider than its box at 360 px").toEqual([]);
		});
	});
});
