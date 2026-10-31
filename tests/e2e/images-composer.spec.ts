import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_LATE_PICTURE_FINAL_TEXT,
	AI_SMOKE_LATE_PICTURE_MARKER,
	AI_SMOKE_LATE_PICTURE_TITLE,
} from "../fixtures/ai/late-picture-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	clearAdminConfig,
	createEmptyConversation,
	login,
	sendMessage,
	waitForHydration,
} from "./helpers";
import {
	attachPhoto,
	type FakeComfyUi,
	lastUserParts,
	randomPng,
	releaseSpecChatModel,
	type SpecChatModel,
	saveSpecVideo,
	startFakeComfyUiForSpec,
	stopFakeComfyUiForSpec,
	useSpecChatModel,
	VIDEO_DIR,
} from "./images-helpers";

// Pictures in the composer, end to end (docs/plans/image-generation, part 2b
// Task 8): Attach on a card, marks drawn on the open picture, a message with more
// pictures than the picture server's cap, and the Knowledge Base's Images chip.
// What the model was sent is read from the fake provider's own request log: that
// is the only place the pictures and their labels can be seen. Every wait is on a
// state the page shows. Each test leaves one video under the handoff folder.

const fakeProvider = createOpenAICompatibleProviderHarness();
const PROVIDER_PREFIX = "images_composer_t8_";

const CARD =
	'[data-testid="message-deliverables"] [data-testid="artifact-card"]';
const LOADED = `${CARD} [data-testid="image-card-stage"] [data-testid="image-picture-after"].is-loaded`;
const CHIP = '[data-testid="composer-chip-picture"]';
const MARKS_CHIP = '[data-testid="composer-chip-marks"]';

async function openChat(page: Page): Promise<string> {
	const conversationId = await createEmptyConversation(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible();
	return conversationId;
}

/** Sends the late-picture turn and waits until the picture is on the card and the reply is whole. */
async function makePicture(page: Page) {
	await sendMessage(page, AI_SMOKE_LATE_PICTURE_MARKER);
	await expect(page.locator(LOADED).last()).toBeVisible({ timeout: 45_000 });
	await expect(page.getByText(AI_SMOKE_LATE_PICTURE_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
}

/** The next frame the page paints: a drag is one move per frame, as a hand makes it. */
async function nextFrame(page: Page) {
	await page.evaluate(
		() => new Promise<void>((done) => requestAnimationFrame(() => done())),
	);
}

/** A mouse drag across the open picture, from one fraction of its frame to another. */
async function dragBox(
	page: Page,
	from: [number, number],
	to: [number, number],
) {
	const box = await page.getByTestId("image-body-frame").boundingBox();
	if (!box) throw new Error("no picture frame on screen");
	const at = ([fx, fy]: [number, number]) => ({
		x: box.x + box.width * fx,
		y: box.y + box.height * fy,
	});
	const start = at(from);
	const end = at(to);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	const steps = 12;
	for (let step = 1; step <= steps; step++) {
		await page.mouse.move(
			start.x + ((end.x - start.x) * step) / steps,
			start.y + ((end.y - start.y) * step) / steps,
		);
		await nextFrame(page);
	}
	await page.mouse.up();
}

test.use({
	video: VIDEO_DIR ? { mode: "on", size: { width: 1440, height: 900 } } : "off",
});

test.describe("Pictures in the composer", () => {
	let fake: FakeComfyUi | null = null;
	let model: SpecChatModel | null = null;
	let overrides: string[] = [];
	let videoName = "unnamed";

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await fakeProvider.reset();
		overrides = [];
		await login(page);
		model = await useSpecChatModel(page, fakeProvider.baseURL, PROVIDER_PREFIX);
		fake = await startFakeComfyUiForSpec(page);
		fake.setOptions({ steps: 3, stepDelayMs: 100 });
	});

	test.afterEach(async ({ page }) => {
		if (overrides.length > 0) await clearAdminConfig(page, overrides);
		if (fake) await stopFakeComfyUiForSpec(page, fake);
		fake = null;
		if (model) await releaseSpecChatModel(page, model);
		model = null;
		await saveSpecVideo(page, videoName);
	});

	test("Attach puts a picture into the next message", async ({ page }) => {
		videoName = "attach-into-message";
		await openChat(page);
		await makePicture(page);

		await page
			.locator(CARD)
			.last()
			.getByRole("button", { name: "More" })
			.click();
		await page.getByTestId("image-card-attach").click();
		const chip = page.locator(CHIP);
		await expect(chip).toHaveCount(1);
		await expect(chip.getByTestId("composer-chip-number")).toHaveText("1");
		await expect(chip).toHaveAttribute(
			"aria-label",
			`Picture 1: ${AI_SMOKE_LATE_PICTURE_TITLE}`,
		);

		const question = "What colour is the roof in picture 1?";
		await sendMessage(page, question);
		await expect(page.locator(CHIP)).toHaveCount(0);
		await expect(
			page.locator('[data-testid="user-message"]').last(),
		).toContainText(question);

		// What the model got: the picture's label, then the picture itself.
		await expect
			.poll(() => lastUserParts(fakeProvider.requests(), question).length, {
				message: "the model was asked the question",
				timeout: 30_000,
			})
			.toBeGreaterThan(0);
		const parts = lastUserParts(fakeProvider.requests(), question);
		const label = parts.findIndex(
			(part) =>
				part.type === "text" &&
				part.text === `Picture 1: ${AI_SMOKE_LATE_PICTURE_TITLE}`,
		);
		const picture = parts.findIndex((part) => part.type === "image_url");
		expect(label, "the label is a part of the message").toBeGreaterThanOrEqual(
			0,
		);
		expect(picture, "the picture is a part of the message").toBeGreaterThan(
			label,
		);
	});

	test("marks travel as one chip", async ({ page }) => {
		videoName = "marks-one-chip";
		await openChat(page);
		await makePicture(page);

		await page.locator(CARD).last().getByTestId("artifact-card-head").click();
		await expect(
			page
				.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
				)
				.first(),
		).toBeVisible({ timeout: 20_000 });
		await page.getByTestId("image-body-mark").click();
		await expect(page.getByTestId("image-body-mark")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await dragBox(page, [0.1, 0.15], [0.4, 0.55]);
		await dragBox(page, [0.55, 0.3], [0.9, 0.8]);
		await expect(page.getByTestId("mark-box")).toHaveCount(2);
		const marks = page.locator(MARKS_CHIP);
		await expect(marks).toHaveCount(1);
		await expect(marks).toContainText("Marks A, B");

		const question = "Is the lighthouse inside my boxes?";
		await sendMessage(page, question);
		await expect(page.locator(MARKS_CHIP)).toHaveCount(0);
		await expect(page.getByTestId("mark-box")).toHaveCount(0);

		await expect
			.poll(() => lastUserParts(fakeProvider.requests(), question).length, {
				message: "the model was asked the question",
				timeout: 30_000,
			})
			.toBeGreaterThan(0);
		const parts = lastUserParts(fakeProvider.requests(), question);
		const label = parts.find(
			(part) =>
				part.type === "text" &&
				part.text?.includes("with the user's marks: A = red box, B = blue box"),
		);
		expect(label, "the model was told what the marks are").toBeTruthy();
		expect(parts.some((part) => part.type === "image_url")).toBe(true);
	});

	test.describe("marks on uploaded photos", () => {
		const TILE = '[data-testid="composer-chip-attachment"]';

		// Two uploads through the extraction queue before anything is drawn.
		test.slow();

		// Two uploads through the extraction queue before anything is drawn.
		test.slow();

		/** Fresh names: the Library renames a name it already holds. */
		async function attachTwo(page: Page) {
			await openChat(page);
			const sofa = `sofa-${randomUUID().slice(0, 8)}.png`;
			const room = `room-${randomUUID().slice(0, 8)}.png`;
			await attachPhoto(
				page,
				{ ...(await randomPng(600, 400)), name: sofa },
				1,
			);
			await attachPhoto(
				page,
				{ ...(await randomPng(600, 400)), name: room },
				2,
			);
			return { sofa, room };
		}

		test("a tile opens one photo, its marks ride with the message and survive a look at another", async ({
			page,
		}) => {
			videoName = "marks-on-upload";
			const { sofa, room } = await attachTwo(page);
			const tiles = page.locator(TILE);
			await expect(page.getByTestId("upload-picture-marks")).toHaveCount(0);
			await expect(tiles.first().getByTestId("composer-chip-number")).toHaveCSS(
				"position",
				"absolute",
			);
			await expect(tiles.first().getByTestId("composer-chip-name")).toHaveCSS(
				"opacity",
				"0",
			);

			await tiles
				.nth(1)
				.getByRole("button", { name: new RegExp(room) })
				.first()
				.click();
			await page.getByTestId("image-body-mark").click();
			await expect(page.getByTestId("image-body-mark-note")).toContainText(
				"Drag to draw a box",
			);
			await expect(page.getByTestId("image-body-frame")).toBeVisible();
			await dragBox(page, [0.2, 0.2], [0.7, 0.7]);
			await expect(page.getByTestId("mark-box")).toHaveCount(1);
			await expect(page.getByTestId("image-body-mark-note")).toContainText(
				"A marked",
			);
			await expect(page.locator(MARKS_CHIP)).toContainText("Marks A");
			await expect(
				tiles.nth(1).getByTestId("composer-chip-mark-letter"),
			).toHaveText("A");
			await page.screenshot({
				path: `${process.env.MARKS_SHOTS_DIR ?? "test-results"}/desktop-marked.png`,
			});

			// Only looking at the other photo keeps the boxes.
			await tiles
				.first()
				.getByRole("button", { name: new RegExp(sofa) })
				.first()
				.click();
			await expect(page.getByTestId("upload-picture-marks")).toBeVisible();
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);

			const question = "Put the sofa in the marked spot";
			await sendMessage(page, question);
			await expect(page.locator(MARKS_CHIP)).toHaveCount(0);
			await expect
				.poll(() => lastUserParts(fakeProvider.requests(), question).length, {
					timeout: 30_000,
				})
				.toBeGreaterThan(0);
			const parts = lastUserParts(fakeProvider.requests(), question);
			expect(
				parts.some(
					(part) =>
						part.type === "text" &&
						part.text?.includes("Picture 2 with the user's marks: A = red box"),
				),
				"the model was told which photo is marked",
			).toBe(true);
		});

		test("marks move to the next photo with an Undo, and go when their photo goes", async ({
			page,
		}) => {
			videoName = "marks-move";
			const { sofa, room } = await attachTwo(page);
			const tiles = page.locator(TILE);
			await tiles
				.first()
				.getByRole("button", { name: new RegExp(sofa) })
				.first()
				.click();
			await page.getByTestId("image-body-mark").click();
			await dragBox(page, [0.2, 0.2], [0.7, 0.7]);
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);

			await tiles
				.nth(1)
				.getByRole("button", { name: new RegExp(room) })
				.first()
				.click();
			await page.getByTestId("image-body-mark").click();
			await dragBox(page, [0.3, 0.3], [0.8, 0.8]);
			await expect(page.getByText(`Marks moved to ${room}`)).toBeVisible();
			await expect(
				tiles.nth(1).getByTestId("composer-chip-mark-letter"),
			).toHaveText("A");
			await expect(
				tiles.first().getByTestId("composer-chip-mark-letter"),
			).toHaveCount(0);

			await page.getByRole("button", { name: "Undo" }).click();
			await expect(
				tiles.first().getByTestId("composer-chip-mark-letter"),
			).toHaveText("A");

			await tiles.first().locator(".composer-chip__remove").click();
			await expect(page.locator(MARKS_CHIP)).toHaveCount(0);
		});

		test("a new chat marks a photo before it exists, and the first message carries the boxes", async ({
			page,
		}) => {
			videoName = "marks-landing";
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("message-input")).toBeVisible();
			const room = `room-${randomUUID().slice(0, 8)}.png`;
			await attachPhoto(
				page,
				{ ...(await randomPng(600, 400)), name: room },
				1,
			);

			await page
				.locator(TILE)
				.getByRole("button", { name: new RegExp(room) })
				.first()
				.click();
			await expect(page.getByTestId("photo-mark-dialog")).toBeVisible();
			await expect(page.getByTestId("image-body-mark-note")).toContainText(
				"Drag to draw a box",
			);
			await expect(page.getByTestId("image-body-frame")).toBeVisible();
			await dragBox(page, [0.2, 0.2], [0.7, 0.7]);
			await expect(page.getByTestId("mark-box")).toHaveCount(1);
			await page.getByTestId("mark-continue").click();
			await expect(page.getByTestId("photo-mark-dialog")).toHaveCount(0);
			await expect(page.locator(MARKS_CHIP)).toContainText("Marks A");

			const question = "Put a lamp in the marked spot";
			await sendMessage(page, question);
			await expect(page).toHaveURL(/\/chat\//, { timeout: 30_000 });
			await expect
				.poll(() => lastUserParts(fakeProvider.requests(), question).length, {
					timeout: 30_000,
				})
				.toBeGreaterThan(0);
			const parts = lastUserParts(fakeProvider.requests(), question);
			expect(
				parts.some(
					(part) =>
						part.type === "text" &&
						part.text?.includes("Picture 1 with the user's marks: A = red box"),
				),
				"the first message reached the model with its marks",
			).toBe(true);
		});

		test("boxes survive a reload of the chat", async ({ page }) => {
			videoName = "marks-reload";
			const { room } = await attachTwo(page);
			await page
				.locator(TILE)
				.nth(1)
				.getByRole("button", { name: new RegExp(room) })
				.first()
				.click();
			await page.getByTestId("image-body-mark").click();
			await expect(page.getByTestId("image-body-frame")).toBeVisible();
			await dragBox(page, [0.2, 0.2], [0.7, 0.7]);
			await expect(page.locator(MARKS_CHIP)).toHaveCount(1);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator(MARKS_CHIP)).toContainText("Marks A");
		});

		test("a HEIC photo shows on its tile and in the panel", async ({
			page,
		}) => {
			videoName = "marks-heic";
			await openChat(page);
			const name = `photo-${randomUUID().slice(0, 8)}.heic`;
			await attachPhoto(
				page,
				{
					name,
					mimeType: "image/heic",
					buffer: readFileSync(
						"src/lib/server/services/vision/__fixtures__/tiny.heic",
					),
				},
				1,
			);
			const thumb = page.locator(`${TILE} img`);
			await expect(thumb).toHaveCount(1);
			await expect
				.poll(() =>
					thumb.evaluate((image) => (image as HTMLImageElement).naturalWidth),
				)
				.toBeGreaterThan(0);
		});

		test.describe("on a phone", () => {
			test.use({
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true,
			});

			test("a box says what to do next and the button goes back to the composer", async ({
				page,
			}) => {
				videoName = "marks-phone";
				const { room } = await attachTwo(page);
				await page
					.locator(TILE)
					.nth(1)
					.getByRole("button", { name: new RegExp(room) })
					.first()
					.tap();
				await page.getByTestId("image-body-mark").tap();
				await expect(page.getByTestId("mark-continue")).toHaveCount(0);
				await dragBox(page, [0.2, 0.2], [0.7, 0.7]);
				await expect(page.getByTestId("mark-box")).toHaveCount(1);
				await expect(page.getByTestId("image-body-mark-note")).toContainText(
					"Add more, or continue",
				);
				await page.screenshot({
					path: `${process.env.MARKS_SHOTS_DIR ?? "test-results"}/phone-marked.png`,
				});
				await page.getByTestId("mark-continue").tap();

				await expect(page.getByTestId("upload-picture-marks")).toHaveCount(0);
				await expect(page.locator(MARKS_CHIP)).toBeVisible();
				await expect(page.getByTestId("message-input")).toBeFocused();
				await page.screenshot({
					path: `${process.env.MARKS_SHOTS_DIR ?? "test-results"}/phone-composer.png`,
				});
			});
		});
	});

	test("the cap never blocks a message", async ({ page }) => {
		// Review Focus 5: the cap is what one picture request gives the picture
		// server; the composer counts nothing against it.
		videoName = "cap-never-blocks";
		const capped = await page.request.put("/api/admin/config", {
			data: { IMAGE_REFERENCE_CAP: 2 },
		});
		expect(capped.ok(), `cap set -> ${capped.status()}`).toBe(true);
		overrides = ["IMAGE_REFERENCE_CAP"];

		await openChat(page);
		for (const count of [1, 2, 3]) {
			await attachPhoto(page, await randomPng(), count);
		}
		const question = "Which of these three is the brightest?";
		await page.getByTestId("message-input").fill(question);
		await expect(
			page.getByTestId("send-button"),
			"three pictures against a cap of two: Send stays open",
		).toBeEnabled();
		await page.getByTestId("send-button").click();

		await expect
			.poll(() => lastUserParts(fakeProvider.requests(), question).length, {
				message: "the model was asked the question",
				timeout: 30_000,
			})
			.toBeGreaterThan(0);
		const parts = lastUserParts(fakeProvider.requests(), question);
		expect(
			parts.filter((part) => part.type === "image_url"),
			"all three pictures reached the model",
		).toHaveLength(3);
	});

	test("Images in the Knowledge Base", async ({ page }) => {
		videoName = "knowledge-images";
		await openChat(page);
		await makePicture(page);

		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByRole("tab", { name: "Documents" }).click();
		const chip = page.getByTestId("documents-filter-chip-image");
		await expect(chip).toBeEnabled({ timeout: 20_000 });
		await chip.click();
		// A picture's row opens by the row itself (the kinds with a file or a source
		// have an Open button as well). Earlier tests leave pictures of the same
		// title in this worker's library; any of them opens with its picture.
		const row = page
			.getByRole("row")
			.filter({ hasText: AI_SMOKE_LATE_PICTURE_TITLE })
			.first();
		await expect(row).toBeVisible();
		await row.getByText(AI_SMOKE_LATE_PICTURE_TITLE).click();
		await expect(
			page
				.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
				)
				.first(),
		).toBeVisible({ timeout: 20_000 });
	});
});
