import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createTourUser,
	isMobile,
	markToursSeen,
	openPanelList,
	panelList,
	panelShell,
	reopenChat,
	seedImageItem,
	seedItem,
	startChatAs,
} from "./artifact-tours-helpers";
import { waitForMotionToSettle } from "./helpers";

/**
 * Task 22b, the owner: "I also meant a gallery view inside the chat artifact
 * list sidebar." The panel's "What this chat made" offers List and Grid; the
 * grid is the library's own gallery (`ItemGrid`), its columns follow the panel's
 * width (a container query), a tile opens its item as a row does, and the choice
 * is remembered for this viewer. Every wait is on a state the page shows.
 *
 * With MOTION_VIDEO_DIR set, the last test saves screenshots of the grid, docked,
 * expanded and on a phone, light and dark.
 */

const SHOTS_DIR = "/home/lvt53/alfyai-handoff/checks/t22";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const THUMB_LOADED =
	'[data-testid="item-grid-thumb"] [data-testid="image-picture-after"].is-loaded';

const SHIFTS_SCRIPT = () => {
	const shifts: Array<{ value: number; at: number }> = [];
	(window as unknown as { __shifts: typeof shifts }).__shifts = shifts;
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as Array<
			PerformanceEntry & { value: number; hadRecentInput: boolean }
		>) {
			if (!entry.hadRecentInput) {
				shifts.push({ value: entry.value, at: entry.startTime });
			}
		}
	}).observe({ type: "layout-shift", buffered: true });
};

async function shiftSince(page: Page, since: number): Promise<number> {
	return page.evaluate(
		(from) =>
			(
				window as unknown as { __shifts: Array<{ value: number; at: number }> }
			).__shifts
				.filter((entry) => entry.at >= from)
				.reduce((sum, entry) => sum + entry.value, 0),
		since,
	);
}

/** A chat that made two pictures, a Document and a Canvas. */
async function seededChat(page: Page): Promise<string> {
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
	await seedItem(user, conversationId, "document");
	await seedItem(user, conversationId, "canvas");
	return conversationId;
}

const grid = (page: Page) => panelList(page).getByTestId("artifact-panel-grid");

async function chooseGrid(page: Page): Promise<void> {
	const button = panelList(page).getByRole("button", { name: "Grid view" });
	if (isMobile(page)) await button.tap();
	else await button.click();
	await expect(grid(page)).toBeVisible();
	await expect(grid(page).locator(THUMB_LOADED)).toHaveCount(2);
	await waitForMotionToSettle(page);
}

test.describe("the panel list's gallery (Task 22b)", () => {
	test("List / Grid in the docked panel: tiles, no shift, a tile opens its item, the choice is remembered", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		await page.addInitScript(SHIFTS_SCRIPT);
		const conversationId = await seededChat(page);
		await reopenChat(page, conversationId);
		await openPanelList(page);
		await expect(
			panelList(page).getByRole("button", { name: "List view" }),
		).toHaveAttribute("aria-pressed", "true");

		const before = await page.evaluate(() => performance.now());
		await chooseGrid(page);
		// Thumbnails land in squares reserved before them: nothing moves.
		expect(await shiftSince(page, before)).toBe(0);
		await expect(panelList(page).getByTestId("artifact-row")).toHaveCount(0);
		const tiles = grid(page).getByTestId("artifact-panel-grid-tile");
		await expect(tiles).toHaveCount(4);
		for (const square of await grid(page).locator(".item-grid-picture").all()) {
			const box = await square.boundingBox();
			expect(
				Math.abs((box?.width ?? 0) - (box?.height ?? 1)),
			).toBeLessThanOrEqual(1);
		}
		// Every tile inside the panel's width.
		const panel = await panelShell(page).boundingBox();
		for (const tile of await tiles.all()) {
			const box = await tile.boundingBox();
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
				(panel?.x ?? 0) + (panel?.width ?? 0) + 1,
			);
		}

		// A tile opens its item as a row does.
		await tiles.filter({ hasText: "Harbour at dusk" }).click();
		await expect(
			panelShell(page).locator('[data-testid="image-body"]'),
		).toBeVisible();

		// Remembered: the list opens as a grid on the next visit.
		await panelShell(page)
			.getByRole("button", { name: "Back to this chat's items" })
			.click();
		await expect(grid(page)).toBeVisible();
		await reopenChat(page, conversationId);
		await openPanelList(page);
		await expect(grid(page)).toBeVisible();
		await expect(
			panelList(page).getByRole("button", { name: "Grid view" }),
		).toHaveAttribute("aria-pressed", "true");
		// And back to the list, remembered too.
		await panelList(page).getByRole("button", { name: "List view" }).click();
		await reopenChat(page, conversationId);
		await openPanelList(page);
		await expect(panelList(page).getByTestId("artifact-row")).toHaveCount(4);
	});

	test("on a phone the sheet's gallery holds two columns", async ({
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
			const conversationId = await seededChat(page);
			await reopenChat(page, conversationId);
			await openPanelList(page);
			await chooseGrid(page);
			const lefts = new Set<number>();
			for (const tile of await grid(page)
				.getByTestId("artifact-panel-grid-tile")
				.all()) {
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

async function capture(
	browser: Browser,
	baseURL: string | undefined,
	scheme: "light" | "dark",
	shape: "docked" | "expanded" | "phone",
): Promise<void> {
	const viewport = shape === "phone" ? PHONE : DESKTOP;
	const context = await browser.newContext({
		baseURL,
		viewport,
		colorScheme: scheme,
		hasTouch: shape === "phone",
		isMobile: shape === "phone",
	});
	const page = await context.newPage();
	try {
		const conversationId = await seededChat(page);
		await reopenChat(page, conversationId);
		if (shape === "expanded") {
			// Expanded is the open item's shape; the list keeps it on the way back.
			await openPanelList(page);
			await panelList(page)
				.getByTestId("artifact-row")
				.filter({ hasText: "Harbour at dusk" })
				.click();
			await panelShell(page).locator(".workspace-expand-button").click();
			await waitForMotionToSettle(page);
			await panelShell(page)
				.getByRole("button", { name: "Back to this chat's items" })
				.click();
			await expect(panelList(page)).toBeVisible();
		} else {
			await openPanelList(page);
		}
		await chooseGrid(page);
		await page.screenshot({
			path: join(SHOTS_DIR, `panel-grid-${shape}-${scheme}.png`),
		});
	} finally {
		await context.close();
	}
}

test.describe("the Task 22b screenshots", () => {
	test.skip(!process.env.MOTION_VIDEO_DIR, "set MOTION_VIDEO_DIR to save them");
	test.beforeAll(() => {
		mkdirSync(SHOTS_DIR, { recursive: true });
	});
	for (const scheme of ["light", "dark"] as const) {
		for (const shape of ["docked", "expanded", "phone"] as const) {
			test(`panel grid, ${shape}, ${scheme}`, async ({ browser, baseURL }) => {
				await capture(browser, baseURL, scheme, shape);
			});
		}
	}
});
