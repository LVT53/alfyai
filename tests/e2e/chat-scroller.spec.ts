import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { createEmptyConversation, expectTopmost, login } from "./helpers";

// The Chat Scroller (the approved refresh): in a wide chat a ruler of at most
// 13 ticks with one orange mark, and a list of every turn that opens on hover
// at the current row; in a narrow one nothing until the reader has left the
// bottom, then a capsule ("11 / 30" and a chevron) whose number opens the same
// list as a sheet above the composer.

const TURNS = 30;

async function seedThirtyTurns(page: Page) {
	const conversationId = await createEmptyConversation(page, "Scroller");
	const base = Date.now() - TURNS * 120_000;
	const assistantIds: string[] = [];
	const rows = [];
	for (let i = 1; i <= TURNS; i += 1) {
		const assistantId = randomUUID();
		assistantIds.push(assistantId);
		rows.push(
			{
				id: randomUUID(),
				conversationId,
				messageSequence: i * 2 - 1,
				role: "user" as const,
				content: `Question ${i} about the north shore of Balaton`,
				createdAt: new Date(base + i * 120_000),
			},
			{
				id: assistantId,
				conversationId,
				messageSequence: i * 2,
				role: "assistant" as const,
				content: [
					`Answer ${i}. The north shore is good for three things: the wine regions, the small villages, and how empty it gets in autumn.`,
					"A single weekend is enough from Tihany to Badacsony if you start early and keep the plan loose.",
					"Rooms cost about half after the season ends, and most of the restaurants are still open.",
				].join("\n\n"),
				createdAt: new Date(base + i * 120_000 + 30_000),
			},
		);
	}
	await db.insert(messages).values(rows);
	return { conversationId, assistantIds };
}

async function open(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("assistant-message").first()).toBeVisible();
}

/**
 * The thread opens held at its bottom while its replies render (a lazily loaded
 * parser, then late content), and a scroll made in that window is undone by the
 * hold. Wait until the thread has stopped changing height, then scroll.
 */
async function waitForThreadToSettle(page: Page) {
	let last = -1;
	let unchanged = 0;
	await expect
		.poll(
			async () => {
				const height = await page.evaluate(
					() => document.querySelector(".scroll-container")?.scrollHeight ?? 0,
				);
				unchanged = height === last ? unchanged + 1 : 0;
				last = height;
				return unchanged;
			},
			{ intervals: [200], timeout: 15_000 },
		)
		.toBeGreaterThanOrEqual(3);
}

async function scrollThreadTo(page: Page, fraction: number) {
	await waitForThreadToSettle(page);
	await page.evaluate((at) => {
		const scroller = document.querySelector<HTMLElement>(".scroll-container");
		if (!scroller) return;
		scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * at;
	}, fraction);
}

test.describe("Chat Scroller", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("desktop: a short ruler, a list that opens on hover at the current row, and a row that jumps", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const { conversationId, assistantIds } = await seedThirtyTurns(page);
		await open(page, conversationId);

		// Thirty turns, thirteen ticks, and the ruler stays small.
		await expect(page.getByTestId("jump-rail-trigger")).toBeVisible();
		await expect(page.getByTestId("jump-rail-tick")).toHaveCount(13);
		const ruler = await page.locator(".jr-ruler").boundingBox();
		expect(ruler?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
		// The round button is not what this width scrolls with.
		await expect(page.getByTestId("jump-rail-capsule")).toHaveCount(0);

		// Read from the middle of the thread: the mark leaves the last tick.
		await scrollThreadTo(page, 0.5);
		await expect
			.poll(async () => {
				const style = await page.locator(".jr-ruler").getAttribute("style");
				return Number(/--needle:\s*(\d+)/.exec(style ?? "")?.[1]);
			})
			.toBeLessThan(9);

		// Hovering opens the list with the current row in the middle of it.
		await page.getByTestId("jump-rail-trigger").hover();
		const list = page.getByTestId("jump-rail-list");
		await expect(list).toBeVisible();
		const current = list.locator('[aria-current="true"]');
		await expect(current).toHaveCount(1);
		await expect
			.poll(async () => {
				const listBox = await list.boundingBox();
				const rowBox = await current.boundingBox();
				if (!listBox || !rowBox) return Number.POSITIVE_INFINITY;
				return Math.abs(
					rowBox.y + rowBox.height / 2 - (listBox.y + listBox.height / 2),
				);
			})
			.toBeLessThan(40);

		// A click on a row jumps there and closes the list.
		await list.getByTestId("jump-rail-row").nth(2).click();
		await expect(list).toBeHidden();
		await expect(
			page.locator(`[data-message-id="${assistantIds[2]}"]`),
		).toBeInViewport({ timeout: 10_000 });
	});

	test("a narrow window: the number opens a centred panel at the current row, not at the first", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 760, height: 760 });
		const { conversationId } = await seedThirtyTurns(page);
		await open(page, conversationId);
		await scrollThreadTo(page, 0.5);

		await page.getByTestId("jump-rail-capsule-where").click();

		const panel = page.getByRole("dialog");
		await expect(panel).toBeVisible();
		const current = panel.locator(
			'[data-testid="jump-rail-row"][aria-current="true"]',
		);
		await expect(current).toBeFocused();
		await expect(current).toBeInViewport({ ratio: 1 });
		await expect(
			panel.getByTestId("jump-rail-row").first(),
		).not.toBeInViewport();
	});

	test.describe("a phone", () => {
		test.use({
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
		});

		test("no capsule at the bottom; it appears after scrolling up, and its number opens a sheet above the composer", async ({
			page,
		}) => {
			const { conversationId } = await seedThirtyTurns(page);
			await open(page, conversationId);

			// At the bottom there is nothing: neither a ruler nor a capsule.
			await expect(page.getByTestId("conversation-jump-rail")).toHaveCount(0);
			await expect(page.getByTestId("jump-rail-capsule")).toHaveCount(0);

			// Scroll up and the capsule says where the reader is.
			await scrollThreadTo(page, 0.5);
			const capsule = page.getByTestId("jump-rail-capsule");
			await expect(capsule).toBeVisible();
			await expect(capsule).toHaveText(/\d+\s*\/\s*30/);
			// The pill is what a finger lands on at its middle.
			await expectTopmost(capsule, {
				message: "the capsule paints above the thread and the composer",
				probe: "center",
			});
			await expect(page.getByTestId("jump-to-latest-button")).toHaveCount(0);

			// Its number opens the list as a sheet that sits above the composer.
			await page.getByTestId("jump-rail-capsule-where").tap();
			const sheet = page.getByRole("dialog");
			await expect(sheet).toBeVisible();
			await expectTopmost(sheet, {
				message: "the sheet paints above the composer",
				probe: "center",
			});
			const bottomEdgeIsTheSheet = await sheet.evaluate((node) => {
				const rect = node.getBoundingClientRect();
				const hit = document.elementFromPoint(
					rect.x + rect.width / 2,
					rect.bottom - 10,
				);
				return !!hit && node.contains(hit);
			});
			expect(bottomEdgeIsTheSheet).toBe(true);
			await expect(
				sheet.locator('[data-testid="jump-rail-row"][aria-current="true"]'),
			).toBeInViewport();

			// A row jumps and closes it.
			await sheet.getByTestId("jump-rail-row").nth(0).tap();
			await expect(sheet).toBeHidden();
		});

		test("the chevron goes back to the latest message and the capsule leaves", async ({
			page,
		}) => {
			const { conversationId } = await seedThirtyTurns(page);
			await open(page, conversationId);
			await scrollThreadTo(page, 0.3);
			await expect(page.getByTestId("jump-rail-capsule")).toBeVisible();

			await page.getByTestId("jump-rail-capsule-latest").tap();

			await expect(page.getByTestId("jump-rail-capsule")).toHaveCount(0, {
				timeout: 10_000,
			});
		});
	});
});
