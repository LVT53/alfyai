import { expect, test } from "@playwright/test";
import {
	box,
	openDocument,
	PROSE_MARKDOWN,
	seedDocument,
	tapArea,
} from "./artifact-document-polish-helpers";
import { createConversation, login } from "./helpers";

test.describe("Document phone touch targets (review 233-238)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the mobile toolbar buttons are 44px targets, and the row stays within its budget", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Toolbar targets");
		await seedDocument(conversationId, { markdown: "Some text." });
		await openDocument(page, conversationId);

		const toolbar = page.getByRole("toolbar", { name: "Document" });
		const buttons = toolbar.getByRole("button");
		await expect(buttons).toHaveCount(7);
		for (let i = 0; i < 7; i++) {
			const b = await box(buttons.nth(i));
			expect(b.width, `button ${i} width`).toBeGreaterThanOrEqual(43.5);
			expect(b.height, `button ${i} height`).toBeGreaterThanOrEqual(43.5);
		}
		// The 48px budget of `artifact-document.spec.ts` still holds: the row's own
		// vertical padding gave way to the taller buttons.
		expect((await box(toolbar)).height).toBeLessThanOrEqual(48);
	});

	test("chip selects and task checkboxes are tappable over 44px, and a tap on that area acts", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Chip targets");
		await seedDocument(conversationId, { markdown: PROSE_MARKDOWN });
		const shell = await openDocument(page, conversationId);
		const host = shell.locator(".document-editor-host");

		const selects = host.locator(".tracker-chip-select");
		await expect(selects).toHaveCount(4);
		for (let i = 0; i < 4; i++) {
			// The pill keeps its 26px: the 44px area is the select alone, pulled back in.
			const pill = await box(selects.nth(i).locator(".."));
			expect(pill.height, `chip ${i} pill height`).toBeLessThanOrEqual(26.5);
			const area = await tapArea(selects.nth(i));
			expect(area.height, `chip select ${i} height`).toBeGreaterThanOrEqual(
				43.5,
			);
			expect(area.width, `chip select ${i} width`).toBeGreaterThanOrEqual(43.5);
		}

		const checkboxes = host.locator("li[data-checked] input[type=checkbox]");
		await expect(checkboxes).toHaveCount(6);
		for (let i = 0; i < 6; i++) {
			// The label wraps the box, so the label's own area is what a finger hits.
			const area = await tapArea(
				host.locator("li[data-checked] > label").nth(i),
			);
			expect(area.height, `checkbox ${i} height`).toBeGreaterThanOrEqual(43.5);
			expect(area.width, `checkbox ${i} width`).toBeGreaterThanOrEqual(43.5);
		}

		// The area is only real if a tap on it acts. Rows are 30.5px apart, so each
		// area ends halfway to the next row's box: a tap always reaches the nearest.
		const items = host.locator("li[data-checked]");
		const rect = async (i: number) => box(checkboxes.nth(i));

		// 12px to the left of the first box (ticked in the seed), outside the 17px
		// square: unticks it, and again.
		const first = await rect(0);
		await expect(items.nth(0)).toHaveAttribute("data-checked", "true");
		await page.mouse.click(first.x - 12, first.y + first.height / 2);
		await expect(items.nth(0)).toHaveAttribute("data-checked", "false");
		await page.mouse.click(first.x - 12, first.y + first.height / 2);
		await expect(items.nth(0)).toHaveAttribute("data-checked", "true");

		// 5px below the second box, still nearer to it than to the third: ticks the second.
		const second = await rect(1);
		await page.mouse.click(
			second.x + second.width / 2,
			second.y + second.height + 5,
		);
		await expect(items.nth(1)).toHaveAttribute("data-checked", "true");
		await expect(items.nth(2)).toHaveAttribute("data-checked", "false");

		// 10px below the second box is nearer to the third one: ticks the third.
		await page.mouse.click(
			second.x + second.width / 2,
			second.y + second.height + 10,
		);
		await expect(items.nth(2)).toHaveAttribute("data-checked", "true");
		await expect(items.nth(1)).toHaveAttribute("data-checked", "true");

		// The last box of a run has no neighbour to share with: 15px below it acts.
		const last = await rect(5);
		await expect(items.nth(5)).toHaveAttribute("data-checked", "false");
		await page.mouse.click(last.x + last.width / 2, last.y + last.height + 15);
		await expect(items.nth(5)).toHaveAttribute("data-checked", "true");
	});
});
