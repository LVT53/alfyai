import { expect, type Locator, type Page, test } from "@playwright/test";

import { login, waitForHydration } from "./helpers";

// The one instructions dialog, driven through the only entry point Slice C
// ships: the Settings row. Slice D and Slice F open this same component with a
// project scope and an appended line; what is checked here is the frame they
// are reusing — the title and its token, the live counter, and the two
// buttons — plus the rule the counter exists to enforce.

async function openDialog(page: Page) {
	// The row is server-rendered, so the button is clickable — and inert —
	// before the page hydrates. Playwright's actionability checks all pass on
	// that click, and it is silently swallowed. This must run on every open
	// path, not just the first one: a reload hands back an unhyrdated document
	// too.
	await waitForHydration(page);

	await page
		.getByRole("heading", { name: "Assistant behaviour", exact: true })
		.locator("xpath=ancestor::section[1]")
		.getByTestId("personal-instructions-open")
		.click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 10000 });
	return dialog;
}

async function openDialogFromSettings(page: Page) {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible(
		{ timeout: 15000 },
	);
	return openDialog(page);
}

const box = (page: Page) =>
	page.getByRole("textbox", { name: "Instructions for Personal" });

test.describe("Instructions dialog", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("opens on the personal scope with its token, counter and both buttons", async ({
		page,
	}) => {
		const dialog = await openDialogFromSettings(page);

		await expect(
			dialog.getByRole("heading", { name: "Instructions" }),
		).toBeVisible();
		// The scope is a token, never a word in a sentence.
		await expect(dialog.getByText("You", { exact: true })).toBeVisible();
		await expect(dialog.getByText("These apply in every chat.")).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Save" })).toBeVisible();

		// One scope passed means no switch to render.
		await expect(page.getByTestId("instructions-scope-switch")).toHaveCount(0);

		// The counter counts what is in the box, in code points. This string is
		// 11 code points and 12 UTF-16 units, so a counter built on `.length`
		// reports 12 here and disagrees with the server.
		await box(page).fill("árvíztűrő 👍");
		await expect(dialog.getByText("11 / 2000")).toBeVisible();
	});

	test("refuses 2,001 characters instead of truncating them, and saves 2,000", async ({
		page,
	}) => {
		const dialog = await openDialogFromSettings(page);
		const save = dialog.getByRole("button", { name: "Save" });

		// 2,000 ASCII characters plus one emoji: 2,001 code points, 2,002
		// UTF-16 units. Counting units would refuse a text the server takes.
		await box(page).fill(`${"a".repeat(2000)}👍`);
		await expect(dialog.getByText("2001 / 2000")).toBeVisible();
		await expect(
			dialog.getByText("Instructions can be at most 2000 characters."),
		).toBeVisible();
		await expect(save).toBeDisabled();
		// Refused, not trimmed: nothing was cut to make it fit.
		await expect(box(page)).toHaveValue(`${"a".repeat(2000)}👍`);

		await box(page).fill("a".repeat(2000));
		await expect(dialog.getByText("2000 / 2000")).toBeVisible();
		await expect(save).toBeEnabled();
		await save.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		// Reloading proves it reached the database rather than the page.
		await page.reload({ waitUntil: "domcontentloaded" });
		await openDialog(page);
		await expect(box(page)).toHaveValue("a".repeat(2000), {
			timeout: 15000,
		});
	});

	test("Cancel closes without writing what was typed", async ({ page }) => {
		const dialog = await openDialogFromSettings(page);
		await box(page).fill("This must not be saved.");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		// Reopening shows the stored text, not the abandoned edit — and nothing
		// was written over the API.
		const reopened = await openDialogFromSettings(page);
		await expect(box(page)).not.toHaveValue("This must not be saved.");
		await expect(reopened.getByRole("button", { name: "Save" })).toBeVisible();
	});
});

// §M2 is a phone screen. At 390×844 the shell renders the sheet presentation,
// and the sheet has to keep the counter and both buttons on screen: the editor
// grows to 40vh, so a sheet taller than the remaining space would put Save and
// Cancel past the bottom edge with no way to scroll them back.
test.describe("Instructions dialog — 390px", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("opens as a bottom sheet with the counter and both buttons on screen", async ({
		page,
	}) => {
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		const dialog = await openDialog(page);

		// The phone presentation, not the centred desktop panel.
		await expect(dialog).toHaveClass(/dialog-sheet/);

		// The sheet slides up over 250ms and is "visible" the whole way, so the
		// geometry is only meaningful once it has settled: bottom inside the
		// viewport. The poll keeps re-measuring until it is — a sheet that never
		// got there fails on the last reading instead of a lucky early one.
		const settledInViewport = (locator: Locator) =>
			expect
				.poll(
					async () => {
						const rect = await locator.boundingBox();
						return rect
							? Math.round(rect.y + rect.height)
							: Number.POSITIVE_INFINITY;
					},
					{ message: "to settle inside the phone viewport" },
				)
				.toBeLessThanOrEqual(844);

		await settledInViewport(dialog);
		await settledInViewport(dialog.getByRole("button", { name: "Save" }));
		await settledInViewport(dialog.getByRole("button", { name: "Cancel" }));

		const panel = await dialog.boundingBox();
		if (!panel) throw new Error("Instructions sheet did not lay out");
		expect(panel.x).toBeGreaterThanOrEqual(0);
		expect(panel.x + panel.width).toBeLessThanOrEqual(390);
		expect(panel.y).toBeGreaterThan(0);
		// Flush to the bottom edge, and no taller than the screen: past 88dvh the
		// editor scrolls rather than pushing the counter and buttons under it.
		expect(panel.y + panel.height).toBeGreaterThanOrEqual(840);
		expect(panel.height).toBeLessThanOrEqual(844);

		await expect(page.getByTestId("instructions-counter")).toBeVisible();
		await expect(page.getByTestId("instructions-textarea")).toBeVisible();

		// The counter still counts code points here, and Cancel is still a
		// leave-without-writing. (The save path at this width is covered by the
		// row's own 390px case in settings-profile-redesign.spec.ts.)
		await box(page).fill("árvíztűrő 👍");
		await expect(dialog.getByText("11 / 2000")).toBeVisible();
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
	});
});
