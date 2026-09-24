import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	conversationContextStatus,
	conversations,
	messages,
	usageEvents,
	users,
} from "../../src/lib/server/db/schema";
import { login } from "./helpers";

// The context-usage ring sits at the bottom of the composer and its panel is
// anchored to the ring's LEFT edge, growing right. On a wide window the panel
// fits; on a narrow one it does not — at 390x844 the panel's right edge landed
// at 587px, so roughly half of it, the layer chips included, was off screen.
//
// The viewport here is deliberately NOT a touch device. `isTouchDevice()`
// keys off `matchMedia("(hover: none) and (pointer: coarse)")`, so a narrow
// window driven by a mouse takes the ring-anchored path rather than the phone
// sheet variant — that is the path this spec pins. The phone-with-touch sheet
// is covered by the mobile specs.
//
// The ring only renders once there is something to measure, so the spec seeds
// a real conversation plus its persisted context status and usage row and
// loads the ordinary chat route: the panel under test is the production one,
// with production data.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const RING_CONVERSATION_ID = "e2e-context-ring-popover";

async function seedConversationWithContext(): Promise<void> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	const id = RING_CONVERSATION_ID;
	await db.delete(usageEvents).where(eq(usageEvents.conversationId, id));
	await db
		.delete(conversationContextStatus)
		.where(eq(conversationContextStatus.conversationId, id));
	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));

	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId: admin.id,
		title: "Context ring popover layout",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values([
		{
			id: `${id}-msg-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "Summarise what you know about this project.",
			createdAt: now,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Here is the summary you asked for.",
			createdAt: now,
		},
	]);
	// Layers are what the popover's chip row renders — the part that was cut
	// off screen — and the usage row is what gives the panel its cost hero.
	await db.insert(conversationContextStatus).values({
		conversationId: id,
		userId: admin.id,
		estimatedTokens: 51200,
		promptTokens: 51200,
		promptTokensSource: "provider",
		maxContextTokens: 262144,
		thresholdTokens: 209715,
		targetTokens: 157286,
		compactionMode: "none",
		recentTurnCount: 12,
		layersUsedJson: JSON.stringify(["session", "documents", "working_set"]),
		updatedAt: now,
	});
	await db.insert(usageEvents).values({
		id: `${id}-usage-1`,
		userId: admin.id,
		conversationId: id,
		messageId: `${id}-msg-2`,
		modelId: "model1",
		promptTokens: 48000,
		completionTokens: 3200,
		totalTokens: 51200,
		billingMonth: "2026-09",
		costUsdMicros: 420000,
		createdAt: now,
	});
}

/**
 * A campaign modal can swallow the click that opens the panel. A fresh e2e
 * database has no campaign, but the spec does not depend on that.
 */
async function dismissCampaignModal(page: Page): Promise<void> {
	const modal = page.locator('[role="dialog"][aria-label*="ampaign"]');
	if (await modal.isVisible().catch(() => false)) {
		await modal.getByRole("button", { name: "Close" }).first().click();
		await expect(modal).toBeHidden();
	}
}

const popover = (page: Page) => page.locator(".ring-popover");

/**
 * Open the ring's panel and wait for it to actually be shown. `opacity: 0`
 * still counts as "visible" to Playwright, so the panel's own computed opacity
 * is the assertion that it is really on screen.
 */
async function openRingPopover(page: Page) {
	await page.locator(".ring-button").click();
	await expect
		.poll(() => popover(page).evaluate((el) => getComputedStyle(el).opacity))
		.toBe("1");
}

test.beforeEach(async ({ page }) => {
	await seedConversationWithContext();
	await login(page);
	await page.goto(`/chat/${RING_CONVERSATION_ID}`, {
		waitUntil: "domcontentloaded",
	});
	await dismissCampaignModal(page);
	await expect(page.locator(".ring-button")).toBeVisible({ timeout: 15000 });
});

test.describe("context-usage popover on a narrow viewport", () => {
	test.use({ viewport: PHONE });

	test("keeps the whole panel inside a 390x844 viewport", async ({ page }) => {
		await openRingPopover(page);

		const box = await popover(page).boundingBox();
		expect(box, "the panel must have a box once it is open").not.toBeNull();
		if (!box) return;

		// The measured failure: right edge at 587 on a 390px viewport.
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);

		// Nothing may be pushed sideways to make room for it.
		const horizontalOverflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		expect(horizontalOverflow).toBeLessThanOrEqual(0);

		// Every row, and the layer chips, are on screen and reachable.
		const chips = page.locator(".popover-chip");
		await expect(chips).toHaveCount(3);
		for (let index = 0; index < 3; index += 1) {
			const chipBox = await chips.nth(index).boundingBox();
			expect(chipBox).not.toBeNull();
			if (!chipBox) continue;
			expect(chipBox.x).toBeGreaterThanOrEqual(0);
			expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(PHONE.width);
			expect(chipBox.y).toBeGreaterThanOrEqual(0);
			expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(PHONE.height);
		}
	});
});

test.describe("context-usage popover on desktop", () => {
	test.use({ viewport: DESKTOP });

	test("keeps the panel anchored to the ring at 1440x900", async ({ page }) => {
		await openRingPopover(page);

		const ringBox = await page.locator(".ring-root").boundingBox();
		const box = await popover(page).boundingBox();
		expect(ringBox).not.toBeNull();
		expect(box).not.toBeNull();
		if (!ringBox || !box) return;

		// Unchanged desktop behaviour: left edge on the ring's left edge and
		// the full 25rem width.
		expect(Math.abs(box.x - ringBox.x)).toBeLessThanOrEqual(1);
		expect(box.width).toBeCloseTo(400, 0);
		expect(box.x + box.width).toBeLessThanOrEqual(DESKTOP.width);
	});
});
