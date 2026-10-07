import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, users } from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import { login, waitForHydration } from "./helpers";

/**
 * A press inside the expanded panel's own popover keeps the panel (final re-check
 * RC-F, IMP-2).
 *
 * The Download and Versions popovers are painted outside the panel's markup, in
 * `<body>`, so to the panel's outside-press handler a press on one of them is a
 * press outside the panel. FX-B2 made the handler answer only while the panel is
 * the topmost layer when it sits over a dialog; on the Knowledge page the panel is
 * on no dialog, so a press anywhere in the Download popover closed the panel: a real
 * click on a download option closed the panel before the download began.
 *
 * One press closes one layer, the topmost, as Escape does. Real clicks and keys
 * only.
 */

const TITLE = "Press inside notes";

async function seedDocument(): Promise<{ conversationId: string }> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"));
	const conversationId = randomUUID();
	const now = new Date();
	await db.insert(conversations).values({
		id: conversationId,
		userId: user.id,
		title: "Popover press chat",
		createdAt: now,
		updatedAt: now,
	});
	await createDocumentArtifact({
		userId: user.id,
		conversationId,
		title: TITLE,
		markdown: `## ${TITLE}\n\nSaturday: Naschmarkt, then the Albertina.`,
		author: "alfy",
		summary: "Seeded for E2E",
	});
	return { conversationId };
}

/** The panel's title is on screen exactly once: the desktop shell (the phone's twin is hidden). */
function panelTitle(page: Page): Locator {
	return page.locator('[data-testid="artifact-panel-title"]:visible');
}

/** A real press on bare padding at the popover's bottom right corner. */
async function pressInside(page: Page, popover: Locator) {
	const box = await popover.boundingBox();
	if (!box) throw new Error("the popover has no box");
	await page.mouse.click(box.x + box.width - 5, box.y + box.height - 5);
}

async function openDownload(page: Page): Promise<Locator> {
	await page
		.locator('[data-testid="artifact-download-button"]:visible')
		.click();
	const popover = page.getByTestId("document-download-popover");
	await expect(popover).toBeVisible();
	return popover;
}

/** The expanded shell is the one on screen: a press that "closes" an expanded panel in the chat only docks it, so the title being there says nothing. */
function expandedShell(page: Page): Locator {
	return page.locator(".workspace-shell-expanded:visible");
}

/** A real press inside a popover keeps the popover and the panel; Escape then closes the popover only. */
async function expectPressInsideKeeps(page: Page, popover: Locator) {
	await expect(expandedShell(page)).toHaveCount(1);
	// A press inside the popover is the popover's own.
	await pressInside(page, popover);
	await page.waitForTimeout(400);
	await expect(popover, "the press closed the popover").toBeVisible();
	await expect(
		expandedShell(page),
		"the press closed (or docked) the panel",
	).toHaveCount(1);

	// Escape closes the popover only.
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);
	await expect(expandedShell(page)).toHaveCount(1);
}

/**
 * What one press on each layer does, in the order the layers stand: the popover,
 * then the panel. `leaves` is what a press outside an expanded panel does on this
 * page: it closes the panel on Knowledge, and docks it in the chat.
 */
async function expectOnePressOneLayer(
	page: Page,
	popover: Locator,
	leaves: "closed" | "docked",
) {
	await expectPressInsideKeeps(page, popover);
	// Escape hands focus back to what opened the popover.
	await expect(
		page.locator('[data-testid="artifact-download-button"]:visible'),
	).toBeFocused();

	// With nothing above it the panel answers a press outside it, as before.
	await page.mouse.click(1424, 500);
	await expect(expandedShell(page)).toHaveCount(0);
	await expect(panelTitle(page)).toHaveCount(leaves === "closed" ? 0 : 1);
}

/** The Document the chat made, opened from the chat's list and expanded to the whole window. */
async function openExpandedInChat(page: Page) {
	const { conversationId } = await seedDocument();
	await login(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	await page.getByTestId("artifact-count-button").click();
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.filter({ hasText: TITLE })
		.click();
	await expect(panelTitle(page)).toHaveCount(1, { timeout: 30_000 });
	await page.locator(".workspace-expand-button:visible").first().click();
	await page.waitForTimeout(900);
}

test.describe("the expanded panel's own popovers", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	test("on the Knowledge page, a press inside the Download popover keeps the popover and the panel; one press closes one layer", async ({
		page,
	}) => {
		await seedDocument();
		await login(page);
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByRole("tab", { name: /Documents/ }).click();
		await page.locator("tbody tr", { hasText: TITLE }).first().click();
		await expect(panelTitle(page)).toHaveCount(1, { timeout: 30_000 });
		await page.waitForTimeout(700);

		const popover = await openDownload(page);
		await expectOnePressOneLayer(page, popover, "closed");
	});

	test("in the chat's expanded panel, a press inside the Download popover keeps the popover and the panel; one press closes one layer", async ({
		page,
	}) => {
		await openExpandedInChat(page);

		const popover = await openDownload(page);
		await expectOnePressOneLayer(page, popover, "docked");
	});

	test("in the chat's expanded panel, a press inside the Versions popover keeps the popover and the panel", async ({
		page,
	}) => {
		await openExpandedInChat(page);

		await page.locator('[data-testid="artifact-version-pill"]:visible').click();
		const popover = page.getByTestId("document-versions-popover");
		await expect(popover).toBeVisible();
		await expectPressInsideKeeps(page, popover);
	});
});
