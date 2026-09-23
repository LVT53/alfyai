import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { memoryReviewItems, users } from "../../src/lib/server/db/schema";
import { login, TEST_EMAIL } from "./helpers";

/**
 * The home-screen "memories need review" notice: an owner-approved slim,
 * dismissible line under the greeting band, shown only when the signed-in
 * user has open Memory Profile review items — the same count the Knowledge →
 * Memory tab badge uses.
 */

async function testUserId(): Promise<string> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!row) throw new Error(`Seeded user ${TEST_EMAIL} not found`);
	return row.id;
}

async function clearReviewFixtures(userId: string) {
	await db
		.delete(memoryReviewItems)
		.where(eq(memoryReviewItems.userId, userId));
	await db
		.update(users)
		.set({ homeMemoryReviewDismissedAt: null, memoryEnabled: true })
		.where(eq(users.id, userId));
}

async function seedReviewItem(
	userId: string,
	subjectKey: string,
	createdAt = new Date(),
): Promise<void> {
	await db.insert(memoryReviewItems).values({
		id: randomUUID(),
		userId,
		subjectKey,
		subjectLabel: subjectKey,
		question: "Is this still true?",
		reason: "Two conflicting statements from recent chats.",
		createdAt,
		updatedAt: createdAt,
	});
}

async function gotoHome(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15000,
	});
	await page.getByTestId("home-board").waitFor({ timeout: 15000 });
}

test.describe("home memory review notice", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test.afterEach(async () => {
		await clearReviewFixtures(await testUserId());
	});

	test("shows the count and link when there are open review items", async ({
		page,
	}) => {
		const userId = await testUserId();
		await clearReviewFixtures(userId);
		await seedReviewItem(userId, "review-a");
		await seedReviewItem(userId, "review-b");

		await gotoHome(page);

		const notice = page.getByTestId("home-memory-review-notice");
		await expect(notice).toBeVisible();
		await expect(notice).toContainText(
			"2 memories from recent chats need a quick look.",
		);
		await expect(page.getByTestId("home-memory-review-link")).toHaveAttribute(
			"href",
			"/knowledge?tab=memory#memory-review",
		);
	});

	test("uses the singular sentence for exactly one item", async ({ page }) => {
		const userId = await testUserId();
		await clearReviewFixtures(userId);
		await seedReviewItem(userId, "review-solo");

		await gotoHome(page);

		await expect(page.getByTestId("home-memory-review-notice")).toContainText(
			"1 memory from recent chats needs a quick look.",
		);
	});

	test("is absent when there is nothing to review", async ({ page }) => {
		const userId = await testUserId();
		await clearReviewFixtures(userId);

		await gotoHome(page);

		await expect(
			page.getByTestId("home-memory-review-notice"),
		).not.toBeAttached();
	});

	test("dismiss hides it and it stays hidden across a reload", async ({
		page,
	}) => {
		const userId = await testUserId();
		await clearReviewFixtures(userId);
		await seedReviewItem(userId, "review-dismiss-me");

		await gotoHome(page);
		const notice = page.getByTestId("home-memory-review-notice");
		await expect(notice).toBeVisible();

		await page.getByTestId("home-memory-review-dismiss").click();
		await expect(notice).not.toBeAttached();

		// The dismiss write is fire-and-forget from the browser's side; give it
		// a beat to land before reloading.
		await page.waitForTimeout(300);
		await gotoHome(page);
		await expect(
			page.getByTestId("home-memory-review-notice"),
		).not.toBeAttached();
	});

	test("the link opens the Knowledge Memory tab's Needs Review section", async ({
		page,
	}) => {
		const userId = await testUserId();
		await clearReviewFixtures(userId);
		await seedReviewItem(userId, "review-jump-target");

		await gotoHome(page);
		await page.getByTestId("home-memory-review-link").click();

		await expect(page).toHaveURL(/\/knowledge\?tab=memory#memory-review/);
		await expect(page.locator("#memory-review")).toBeVisible();
	});

	test("the link lands on the Needs Review section at phone width", async ({
		page,
	}) => {
		const userId = await testUserId();
		await clearReviewFixtures(userId);
		await seedReviewItem(userId, "review-jump-target-phone");
		await page.setViewportSize({ width: 375, height: 812 });

		await gotoHome(page);
		const link = page.getByTestId("home-memory-review-link");
		await expect(link).toBeVisible();
		await link.click();

		await expect(page).toHaveURL(/\/knowledge\?tab=memory#memory-review/);
		// On a phone the review rail stacks under the profile, so the jump has
		// to scroll it into view rather than merely render it.
		await expect(page.locator("#memory-review")).toBeInViewport();
	});
});
