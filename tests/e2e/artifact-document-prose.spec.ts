import { expect, test } from "@playwright/test";
import {
	box,
	openDocument,
	PROSE_MARKDOWN,
	seedDocument,
} from "./artifact-document-polish-helpers";
import { createConversation, login } from "./helpers";

test.describe("Document prose details (review 251-255)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	// The mockup's `.tasks .task`: 15.5px text at line-height 1.45 with 4px above
	// and below, no gap between rows: a 30.5px pitch. The editor stores every
	// task item as its own block, hence its own list.
	test("adjacent task lists read as one tight checklist, like the mockup's", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Checklist rhythm");
		await seedDocument(conversationId, { markdown: PROSE_MARKDOWN });
		const shell = await openDocument(page, conversationId);
		const rows = shell.locator(".document-editor-host li[data-checked]");
		await expect(rows).toHaveCount(6);
		const tops: number[] = [];
		for (let i = 0; i < 6; i++) tops.push((await box(rows.nth(i))).y);
		// Rows 0-2 are three separate lists, rows 3-5 one tight list.
		for (const [a, b] of [
			[0, 1],
			[1, 2],
			[3, 4],
			[4, 5],
		] as const) {
			const pitch = tops[b] - tops[a];
			expect(pitch, `rows ${a}->${b} pitch`).toBeGreaterThan(29.5);
			expect(pitch, `rows ${a}->${b} pitch`).toBeLessThan(31.5);
		}
	});

	// The mockup's `.task[aria-checked="true"] .task-label`: a ticked item's text
	// is muted and struck through; an open one is plain. Only the box was filled
	// before, so a finished list read as an unfinished one at a glance.
	test("ticked task items read struck through and muted, open ones do not, in both themes", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Ticked tasks");
		await seedDocument(conversationId, { markdown: PROSE_MARKDOWN });
		const shell = await openDocument(page, conversationId);
		const items = shell.locator(".document-editor-host li[data-checked]");
		await expect(items).toHaveCount(6);
		// Row 0 (Passport) is ticked in the seed, row 1 (Adapter) is open.
		await expect(items.nth(0)).toHaveAttribute("data-checked", "true");
		await expect(items.nth(1)).toHaveAttribute("data-checked", "false");
		const text = (i: number) => items.nth(i).locator("> div > p");

		for (const dark of [false, true]) {
			await page.evaluate(async (isDark) => {
				document.documentElement.classList.toggle("dark", isDark);
				// The text's colour eases over the standard duration: read it once
				// every transition the flip started has finished.
				await Promise.all(
					document
						.getAnimations()
						.filter(
							(a) => a.effect?.getComputedTiming().iterations !== Infinity,
						)
						.map((a) => a.finished.catch(() => undefined)),
				);
			}, dark);
			const tokens = await page.evaluate(() => {
				const probe = (token: string) => {
					const el = document.createElement("span");
					el.style.color = `var(${token})`;
					document.body.appendChild(el);
					const resolved = getComputedStyle(el).color;
					el.remove();
					return resolved;
				};
				return {
					muted: probe("--text-muted"),
					primary: probe("--text-primary"),
				};
			});
			const read = (i: number) =>
				text(i).evaluate((el) => {
					const style = getComputedStyle(el);
					return { line: style.textDecorationLine, color: style.color };
				});
			const ticked = await read(0);
			const open = await read(1);
			const label = dark ? "dark" : "light";
			expect(ticked.line, `ticked text is struck through (${label})`).toBe(
				"line-through",
			);
			expect(ticked.color, `ticked text is muted (${label})`).toBe(
				tokens.muted,
			);
			expect(open.line, `open text is not struck through (${label})`).toBe(
				"none",
			);
			expect(open.color, `open text keeps its colour (${label})`).not.toBe(
				tokens.muted,
			);
			// The checkbox label beside it is not struck: only the words are.
			expect(
				await items
					.nth(0)
					.locator("> label")
					.evaluate((el) => getComputedStyle(el).textDecorationLine),
			).toBe("none");
		}
	});

	// The mockup's `.doc-table td`: 9px above and below a 26px chip (or one
	// 23px line of text) — 45px rows and a 37px header. A cell's paragraph
	// used to keep the prose's 12px bottom margin, which made every row ~12px
	// taller and the content sit high in it.
	test("tracker table rows are as tall as the mockup's, with nothing hanging under the cell content", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Table rhythm");
		await seedDocument(conversationId, { markdown: PROSE_MARKDOWN });
		const shell = await openDocument(page, conversationId);
		const rows = shell.locator(".document-editor-host tr");
		await expect(rows).toHaveCount(3);
		const header = await box(rows.nth(0));
		expect(header.height, "header row").toBeGreaterThan(35);
		expect(header.height, "header row").toBeLessThan(39);
		for (const i of [1, 2]) {
			const row = await box(rows.nth(i));
			expect(row.height, `body row ${i}`).toBeGreaterThan(43);
			expect(row.height, `body row ${i}`).toBeLessThan(47);
		}
	});

	test("a status chip is as wide as the value it shows, not its longest option", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Chip width");
		await seedDocument(conversationId, { markdown: PROSE_MARKDOWN });
		const shell = await openDocument(page, conversationId);
		const selects = shell.locator(".document-editor-host .tracker-chip-select");
		await expect(selects).toHaveCount(4);
		// "Paid" is the shortest label, "Cancelled" the longest option.
		const widths = await selects.evaluateAll((els) =>
			els.map((el) => {
				const select = el as HTMLSelectElement;
				const label = select.selectedOptions[0]?.textContent ?? "";
				const probe = document.createElement("span");
				probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(select).font};letter-spacing:${getComputedStyle(select).letterSpacing}`;
				probe.textContent = label;
				document.body.appendChild(probe);
				const text = probe.getBoundingClientRect().width;
				probe.remove();
				return { label, width: select.getBoundingClientRect().width, text };
			}),
		);
		for (const { label, width, text } of widths) {
			expect(
				width - text,
				`the "${label}" select is ${width}px for ${text}px of text`,
			).toBeLessThan(8);
		}
		const paid = widths.find((w) => w.label === "Paid");
		const toBook = widths.find((w) => w.label === "To book");
		expect(paid && toBook).toBeTruthy();
		expect((paid?.width ?? 0) + 8).toBeLessThan(toBook?.width ?? 0);
	});
});
