import { expect, test } from "@playwright/test";
import {
	box,
	openDocument,
	PROSE_MARKDOWN,
	seedDocument,
	tapArea,
} from "./artifact-document-polish-helpers";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

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

	// Review 233-238: the tabs were 28px tall, the ⋯ 20x20 and the + 24x24.
	test("the tabs, the ⋯ and the + reach 44px, and the ⋯ still sits right after the active tab's label", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Tab targets");
		await seedDocument(conversationId, {
			markdown: "# Plan\n\nBook the hotel.\n\n# Budget\n\nEstimate: 500.",
			tabs: [
				{ id: "tab-plan", title: "Plan", startBlockId: "" },
				{ id: "tab-budget", title: "Budget", startBlockId: "" },
			],
		});
		const shell = await openDocument(page, conversationId);
		const strip = shell.getByTestId("document-tabs");
		await waitForStableBoundingBox(strip);

		const tabs = shell.getByRole("tab");
		await expect(tabs).toHaveCount(2);
		for (let i = 0; i < 2; i++) {
			const b = await box(tabs.nth(i));
			expect(b.height, `tab ${i} height`).toBeGreaterThanOrEqual(43.5);
			expect(b.width, `tab ${i} width`).toBeGreaterThanOrEqual(43.5);
		}
		const options = shell.getByRole("button", { name: "Tab options" });
		const add = shell.getByRole("button", { name: "Add a tab" });
		for (const [name, control] of [
			["options", options],
			["add", add],
		] as const) {
			const b = await box(control);
			expect(b.width, `${name} width`).toBeGreaterThanOrEqual(43.5);
			expect(b.height, `${name} height`).toBeGreaterThanOrEqual(43.5);
		}

		// Nothing overlaps: the ⋯ starts where the active tab's label ends, and the
		// next tab starts after the ⋯ (the active tab reserves the room).
		const active = await box(tabs.nth(0));
		const optionsBox = await box(options);
		const next = await box(tabs.nth(1));
		expect(optionsBox.x).toBeGreaterThanOrEqual(active.x + active.width - 0.5);
		expect(optionsBox.x - (active.x + active.width)).toBeLessThan(8);
		expect(next.x).toBeGreaterThanOrEqual(
			optionsBox.x + optionsBox.width - 0.5,
		);
		// The sliding underline sits under the active tab, not at the strip's start.
		await shell.getByRole("tab", { name: "Budget" }).click();
		await waitForStableBoundingBox(shell.locator(".document-tabs-ink"));
		const ink = await box(shell.locator(".document-tabs-ink"));
		const budget = await box(shell.getByRole("tab", { name: "Budget" }));
		expect(Math.abs(ink.x - budget.x)).toBeLessThan(1.5);
		expect(Math.abs(ink.width - budget.width)).toBeLessThan(1.5);
	});

	// Final polish D3 (rd/recheck2.md): the + is a flex item of the scrolling
	// strip, and once the tabs used up the strip's width it shrank — 14x44 with
	// four tabs at 390px, 41x44 with three — well under a fingertip.
	for (const { width, tabCount } of [
		{ width: 390, tabCount: 4 },
		{ width: 360, tabCount: 3 },
	]) {
		test(`the + stays 44x44 when ${tabCount} tabs overflow the strip at ${width}px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 844 });
			const conversationId = await createConversation(page, "Overflowing tabs");
			const titles = [
				"Trip overview",
				"Detailed itinerary",
				"Budget and costs",
				"Packing list",
			].slice(0, tabCount);
			await seedDocument(conversationId, {
				markdown: titles.map((title) => `# ${title}\n\nText.`).join("\n\n"),
				tabs: titles.map((title, index) => ({
					id: `tab-${index}`,
					title,
					startBlockId: "",
				})),
			});
			const shell = await openDocument(page, conversationId);
			const strip = shell.getByTestId("document-tabs");
			await waitForStableBoundingBox(strip);
			await expect(shell.getByRole("tab")).toHaveCount(tabCount);
			// The case is only the case when a 44px + does not fit beside the tabs
			// (the strip then scrolls; before the fix the + gave way instead).
			const roomBesideTabs = await strip.evaluate((el) => {
				const list = el.querySelector<HTMLElement>('[role="tablist"]');
				const style = getComputedStyle(el);
				const padding =
					Number.parseFloat(style.paddingLeft) +
					Number.parseFloat(style.paddingRight);
				return (
					el.clientWidth - padding - (list?.getBoundingClientRect().width ?? 0)
				);
			});
			expect(
				roomBesideTabs,
				"less than a 44px + fits beside the tabs",
			).toBeLessThan(44);

			const add = await box(shell.getByRole("button", { name: "Add a tab" }));
			expect(add.width, "the + width").toBeGreaterThanOrEqual(43.5);
			expect(add.height, "the + height").toBeGreaterThanOrEqual(43.5);
		});
	}

	test("a document with one section keeps a 44px + on a phone", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Single tab target");
		await seedDocument(conversationId, { markdown: "Some text." });
		const shell = await openDocument(page, conversationId);
		const add = await box(shell.getByRole("button", { name: "Add a tab" }));
		expect(add.width).toBeGreaterThanOrEqual(43.5);
		expect(add.height).toBeGreaterThanOrEqual(43.5);
	});
});
