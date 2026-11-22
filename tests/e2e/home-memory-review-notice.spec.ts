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

test("legacy review rows do not expose a dead review destination", async ({
	page,
}) => {
	await login(page);
	const userId = await testUserId();
	await clearReviewFixtures(userId);
	await seedReviewItem(userId, "legacy-review");
	try {
		await gotoHome(page);
		await expect(page.getByTestId("home-memory-review-notice")).toHaveCount(0);
		await page.goto("/knowledge?tab=memory");
		await expect(page.getByTestId("memory-replacement")).toBeVisible();
		await expect(page.locator("#memory-review")).toHaveCount(0);
	} finally {
		await clearReviewFixtures(userId);
	}
});
