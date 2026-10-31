import { expect, type Page, test } from "@playwright/test";
import {
	createTourUser,
	IMAGE_ITEM_TITLE,
	markToursSeen,
	openItem,
	reopenChat,
	seedImageItem,
	startChatAs,
} from "./artifact-tours-helpers";

/**
 * History for pictures (plan 2b T4): the panel's strip and History agree.
 *
 * F11: a strip frame opens History on the rail entry that holds its version.
 * Two changes of Alfy's written in a row fold into one History moment, so the
 * strip draws one frame per moment (the decision recorded in the T4 report): a
 * frame always opens History on a row the reader can see, with the same
 * picture. Restore brings an older picture back, and the panel shows it.
 *
 * Real input only: clicks on the desktop, taps on the phone. The pictures are
 * gradients made for the test.
 */

const MODES = [
	{ name: "1440 mouse", viewport: { width: 1440, height: 900 }, touch: false },
	{ name: "390 touch", viewport: { width: 390, height: 844 }, touch: true },
] as const;

/** A reader with one Image: Alfy's picture, two changes of Alfy's in a row (one moment), then a take they picked. */
async function readerWithPicture(page: Page) {
	const user = await createTourUser("en");
	await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	const seeded = await seedImageItem(user, chatId, {
		versions: 4,
		authorOf: (index) => (index === 3 ? "picked" : "alfy"),
		decorate: (index) =>
			index === 1
				? {
						prompt: "Make the sky warmer",
						marks: [{ letter: "A", x: 0.1, y: 0.2, w: 0.3, h: 0.3 }],
					}
				: {},
	});
	await reopenChat(page, chatId);
	await openItem(page, IMAGE_ITEM_TITLE);
	await expect(
		page
			.locator(
				'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
			)
			.first(),
	).toBeVisible({ timeout: 20_000 });
	return seeded;
}

const frames = (page: Page) =>
	page.locator('[data-testid="image-version-frame"]:visible');

test.describe("History for pictures", () => {
	for (const mode of MODES) {
		test.describe(mode.name, () => {
			test.use({
				viewport: mode.viewport,
				hasTouch: mode.touch,
				isMobile: mode.touch,
			});

			test("a strip frame opens History on the rail entry that holds its version (F11)", async ({
				page,
			}) => {
				const { fileIds } = await readerWithPicture(page);
				// One frame per History moment: the first picture, Alfy's two changes
				// (one moment, its newer picture), the picked take.
				await expect(frames(page)).toHaveCount(3, { timeout: 15_000 });
				const middle = frames(page).nth(1);
				const versionId = await middle.getAttribute("data-version-id");
				expect(versionId).toBeTruthy();
				await expect(middle).toHaveAccessibleName(/Alfy made 2 changes/);
				if (mode.touch) await middle.tap();
				else await middle.click();

				const history = page.getByTestId("artifact-history");
				await expect(history).toBeVisible();
				// The version's picture, wiped against the one before the moment.
				const preview = history.getByTestId("image-version-preview");
				await expect(preview).toHaveAttribute("data-status", "ready");
				await expect(preview.getByTestId("compare-wipe-after")).toHaveAttribute(
					"src",
					new RegExp(fileIds[2]),
				);
				await expect(
					preview.getByTestId("compare-wipe-before"),
				).toHaveAttribute("src", new RegExp(fileIds[0]));
				// No change stepper for a picture.
				await expect(history.getByTestId("history-next-change")).toHaveCount(0);

				if (mode.touch) {
					// The phone pushed the preview over the list; back to the list shows the row.
					await history.getByRole("button", { name: "History" }).tap();
				}
				const selected = history.locator(
					'[data-testid="history-option"][aria-selected="true"]',
				);
				await expect(selected).toHaveAttribute(
					"data-version-id",
					versionId ?? "",
				);
				await expect(selected).toHaveAttribute("data-key", /^m:/);
				await expect(selected.getByTestId("history-thumb")).toBeVisible();
				await expect(
					selected.getByTestId("history-thumb").locator("img"),
				).toHaveAttribute("src", new RegExp(`${fileIds[2]}.*variant=thumb`));
			});

			test("Restore brings an older picture back into the panel", async ({
				page,
			}) => {
				const { fileIds } = await readerWithPicture(page);
				await page
					.locator('[data-testid="artifact-history-button"]:visible')
					.first()
					.click();
				const history = page.getByTestId("artifact-history");
				const options = history.getByTestId("history-option");
				// The picked take, Alfy's two changes folded under one moment (its two steps), the first picture.
				await expect(options.last()).toContainText("Alfy made the picture");
				if (mode.touch) await options.last().tap();
				else await options.last().click();
				// The first picture has no step of its own to show: it is compared with now.
				await expect(
					history.getByTestId("image-version-preview"),
				).toHaveAttribute("data-status", "ready");
				await expect(
					history.getByTestId("compare-wipe-before"),
				).toHaveAttribute("src", new RegExp(fileIds[3]));
				await page
					.locator('[data-testid="history-restore"]:visible')
					.first()
					.click();
				await page
					.locator('[data-testid="history-restore-confirm"]:visible')
					.first()
					.click();
				await expect(page.getByTestId("history-toast")).toContainText(
					"Restored",
				);
				if (mode.touch) {
					// The phone's sheet peels the preview first, then itself.
					await page.keyboard.press("Escape");
					await page.keyboard.press("Escape");
				} else {
					await page
						.locator('[data-testid="artifact-history-button"]:visible')
						.first()
						.click();
				}
				await expect(history).toHaveCount(0);
				await expect(
					page
						.locator(
							'[data-testid="image-body-picture"] [data-testid="image-picture-after"]',
						)
						.last(),
				).toHaveAttribute("src", new RegExp(fileIds[0]));
			});
		});
	}

	test("a version made with marks shows them and its prompt in History", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await readerWithPicture(page);
		await page
			.locator('[data-testid="artifact-history-button"]:visible')
			.first()
			.click();
		const history = page.getByTestId("artifact-history");
		// Alfy's first change (the marked one) is a step under its moment.
		await history
			.locator('[data-testid="history-option"][data-key^="s:"]')
			.first()
			.click();
		const mark = history.getByTestId("image-version-mark");
		await expect(mark).toHaveCount(1);
		await expect(mark).toHaveCSS("border-top-color", "rgb(229, 57, 53)");
		await expect(history.getByText("With marks A")).toBeVisible();
		const prompt = history.getByTestId("image-version-prompt");
		await expect(prompt).not.toHaveAttribute("open", "");
		await prompt.getByText("Prompt Alfy sent").click();
		await expect(prompt.getByText("Make the sky warmer")).toBeVisible();
	});
});

test.describe("the way back from the panel on a phone", () => {
	test.use({
		viewport: { width: 360, height: 780 },
		hasTouch: true,
		isMobile: true,
	});

	test("a changed picture's row holds Before / After, Mark and the longest button", async ({
		page,
	}) => {
		const user = await createTourUser("hu");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		await seedImageItem(user, chatId, { versions: 2 });
		await reopenChat(page, chatId);
		await openItem(page, IMAGE_ITEM_TITLE);
		await expect(
			page
				.locator(
					'[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded',
				)
				.first(),
		).toBeVisible({ timeout: 20_000 });

		await page.getByTestId("image-body-mark").tap();
		const box = await page.getByTestId("image-body-frame").boundingBox();
		if (!box) throw new Error("no picture frame on screen");
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
			steps: 8,
		});
		await page.mouse.up();

		for (const testId of ["mark-continue", "image-body-mark"]) {
			const control = await page.getByTestId(testId).boundingBox();
			if (!control) throw new Error(`${testId} is not on screen`);
			expect(control.x).toBeGreaterThanOrEqual(0);
			expect(control.x + control.width).toBeLessThanOrEqual(360);
		}
	});
});
