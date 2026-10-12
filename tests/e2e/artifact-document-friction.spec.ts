import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	box,
	openDocument,
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import {
	createEmptyConversation,
	login,
	waitForStableBoundingBox,
} from "./helpers";

// The friction build's Document findings (ruling 77, FB-6): F6 Alfy is visibly at
// work, F13 a one-row review bar on a phone, F14 an @Alfy comment feels answered,
// F18 Keep does not move the text, F24 the comments column takes no room until
// there is a comment, F28 the add-tab button says what it does. Hungarian, the
// owner's language; every action is a real pointer, key or touch.

const MARKDOWN = [
	"# Bécsi hétvége",
	"",
	"Két nap a barátnőddel: szombat és vasárnap. A programok nagy része esőben is megy.",
	"",
	"## Szombat",
	"",
	"Schönbrunn és a Gloriette kilátása. Érdemes korán érkezni a tömeg elkerülése végett.",
	"",
	"Délben a Naschmarkt, utána a Karlsplatz.",
].join("\n");

test.beforeEach(async ({ page }) => {
	await setUiLanguage("hu");
	await login(page);
});

test.afterEach(async () => {
	await setUiLanguage("en");
});

/** Selects one word of the text with a real double click, where the browser draws it. */
async function selectWord(
	page: Page,
	shell: Locator,
	word: string,
): Promise<void> {
	const rect = await shell
		.locator(".document-editor-host .ProseMirror")
		.evaluate((root, target) => {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = (node.textContent ?? "").indexOf(target);
				if (at === -1) continue;
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + target.length);
				const r = range.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			}
			throw new Error(`"${target}" is not in the text`);
		}, word);
	await page.mouse.dblclick(rect.x, rect.y);
}

test.describe("F28 the add-tab button says what it does", () => {
	test("the single-tab strip shows the button's words, not a bare plus", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F28");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		const add = shell.getByRole("button", { name: "Fül hozzáadása" });
		await expect(add).toBeVisible();
		// The words are on the button itself (not only in its accessible name).
		await expect(add).toHaveText("Fül hozzáadása");
		// And it still adds one.
		await add.click();
		await expect(shell.getByRole("tab")).toHaveCount(2);
	});
});

test.describe("F24 the comments column takes no room until there is a comment", () => {
	test("a Document with no comments has no column, a quiet way to open one, and the text gets the room", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F24");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		await expect(shell.locator(".document-content-rail")).toHaveCount(0);
		const content = await box(
			shell.locator(".document-main > .document-content"),
		);
		const text = await box(shell.locator(".document-content-text"));
		// Whatever stands beside the text is a quiet strip, not a 300 px column.
		expect(content.width - text.width).toBeLessThan(64);
		await expect(
			shell.getByTestId("document-comments-affordance"),
		).toBeVisible();
	});

	test("the first comment brings the column, with the comment in it", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F24 first");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		await expect(shell.locator(".document-content-rail")).toHaveCount(0);
		await selectWord(page, shell, "Naschmarkt");
		await page
			.getByTestId("selection-bubble")
			.getByRole("button", { name: "Megjegyzés", exact: true })
			.click();
		await page.getByRole("textbox").last().fill("Ide menjünk ebédelni.");
		await page
			.getByTestId("selection-bubble")
			.getByRole("button", { name: "Megjegyzés", exact: true })
			.last()
			.click();
		const rail = shell.locator(".document-content-rail");
		await expect(rail).toBeVisible();
		await expect(rail.getByText("Ide menjünk ebédelni.")).toBeVisible();
		await expect(shell.getByTestId("document-comments-affordance")).toHaveCount(
			0,
		);
	});

	test("the quiet way opens the empty column, and the header's button closes it again", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F24 toggle");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		await shell.getByTestId("document-comments-affordance").click();
		const rail = shell.locator(".document-content-rail");
		await expect(rail).toBeVisible();
		await expect(rail).toContainText("Még nincs megjegyzés");
		const toggle = shell.getByTestId("artifact-comments-button");
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await toggle.click();
		await expect(rail).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(
			shell.getByTestId("document-comments-affordance"),
		).toBeVisible();
	});
});

test.describe("F13 a pending change's review bar is one row on a phone", () => {
	test.use({ hasTouch: true });

	for (const [width, height, pendingOps] of [
		[390, 844, 2],
		[390, 844, 1],
		[360, 740, 2],
	] as const) {
		test(`count, the stepper where there is something to step through, Keep and Undo share one row of 44 px targets (${width}x${height}, ${pendingOps} pending)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height });
			const conversationId = await createEmptyConversation(page, "F13");
			await seedDocument(conversationId, {
				markdown: MARKDOWN,
				title: "Bécsi hétvége",
				pendingOps,
			});
			const shell = await openDocument(page, conversationId);
			const bar = shell.getByRole("region", { name: "Alfy módosításai" });
			await expect(bar).toBeVisible({ timeout: 30_000 });
			await waitForStableBoundingBox(bar);

			const keep = bar.getByRole("button", { name: /Mindet megtartom/ });
			const undo = bar.getByRole("button", { name: /Mindet visszavonom/ });
			const parts = [keep, undo];
			if (pendingOps > 1) {
				await expect(bar.getByText(`1 / ${pendingOps}`)).toBeVisible();
				parts.push(
					bar.getByRole("button", { name: "Előző módosítás" }),
					bar.getByRole("button", { name: "Következő módosítás" }),
					bar.getByText(`1 / ${pendingOps}`),
				);
			} else {
				await expect(bar).toContainText("Alfy 1 részt módosított");
			}

			// One row: the bar is one button tall, and every part is centred on that row.
			const barBox = await box(bar);
			expect(barBox.height, "the bar's height").toBeLessThanOrEqual(64);
			const centres: number[] = [];
			for (const part of parts) {
				const b = await box(part);
				centres.push(b.y + b.height / 2);
				expect(b.x, "inside the screen").toBeGreaterThanOrEqual(0);
				expect(b.x + b.width, "inside the screen").toBeLessThanOrEqual(width);
			}
			expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(
				2,
			);

			// 44 px targets, and a finger does the work.
			for (const control of parts.slice(0, pendingOps > 1 ? 4 : 2)) {
				const b = await box(control);
				expect(b.height).toBeGreaterThanOrEqual(43.5);
				expect(b.width).toBeGreaterThanOrEqual(43.5);
			}
			if (pendingOps > 1) {
				await bar.getByRole("button", { name: "Következő módosítás" }).tap();
				await expect(bar.getByText(`2 / ${pendingOps}`)).toBeVisible();
			}
			await keep.tap();
			await expect(bar).toBeHidden();
		});
	}
});
