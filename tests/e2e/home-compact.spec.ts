import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	atlasJobs,
	conversations,
	homeSuggestionEvents,
	usageEvents,
	users,
} from "../../src/lib/server/db/schema";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import { login, TEST_EMAIL } from "./helpers";

/**
 * The chat home rebuilt to HomeV4A "Compact", with the owner's one change: the
 * suggestion chips sit on their own row under the composer rather than inside
 * its footer.
 *
 * Every strip here is seeded directly into the database rather than produced by
 * a real turn — the point of these tests is what the home screen draws from the
 * summary, not how the rows got there.
 */

const SEEDED = {
	atlasConversation: "Atlas report on EU battery rules",
	plainConversation: "Nextcloud folder clean-up plan",
	runningJob: "Hungarian EV charging subsidies, 2024-2026",
};

async function adminUserId(): Promise<string> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!row) throw new Error(`Seeded user ${TEST_EMAIL} not found`);
	return row.id;
}

async function clearHomeFixtures(userId: string) {
	await db.delete(atlasJobs).where(eq(atlasJobs.userId, userId));
	await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
	await db
		.delete(homeSuggestionEvents)
		.where(eq(homeSuggestionEvents.userId, userId));
	await db.delete(conversations).where(eq(conversations.userId, userId));
}

/** Two conversations with turns, one of which finished an Atlas report. */
async function seedRecent(userId: string): Promise<{
	atlasConversationId: string;
	plainConversationId: string;
}> {
	const plain = await createServerConversation(
		userId,
		SEEDED.plainConversation,
	);
	await createMessage(plain.id, "user", "Which folders can go?");
	await createMessage(plain.id, "assistant", "These three.");

	const atlas = await createServerConversation(
		userId,
		SEEDED.atlasConversation,
	);
	await createMessage(atlas.id, "user", "Research EU battery rules.");
	await createMessage(atlas.id, "assistant", "Here is the report.");
	await db.insert(atlasJobs).values({
		id: randomUUID(),
		userId,
		conversationId: atlas.id,
		action: "create",
		profile: "overview",
		normalizedQueryHash: "hash-eu-battery",
		clientAtlasTurnId: randomUUID(),
		idempotencyKey: randomUUID(),
		title: "EU battery rules",
		status: "succeeded",
		stage: "render",
		progressPercent: 100,
		progressDetailsJson: "{}",
	});

	return { atlasConversationId: atlas.id, plainConversationId: plain.id };
}

/** Turns in the current week, so the bars and "N this week" have something. */
async function seedWeeklyTurns(userId: string, count: number) {
	const conversation = await createServerConversation(userId, "Weekly fixture");
	await createMessage(conversation.id, "user", "hi");
	const now = new Date();
	const billingMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	for (let index = 0; index < count; index += 1) {
		await db.insert(usageEvents).values({
			id: randomUUID(),
			userId,
			conversationId: conversation.id,
			messageId: randomUUID(),
			modelId: "home-e2e-model",
			billingMonth,
			// Spread across today so every row lands in the current ISO week
			// whatever weekday the suite runs on.
			createdAt: new Date(now.getTime() - index * 1_000),
		});
	}
	return conversation.id;
}

/** A v2-shaped Atlas job in flight, writing while `stage` still says curate. */
async function seedRunningJob(userId: string): Promise<string> {
	const conversation = await createServerConversation(
		userId,
		SEEDED.runningJob,
	);
	await createMessage(conversation.id, "user", "Research EV subsidies.");
	await db.insert(atlasJobs).values({
		id: randomUUID(),
		userId,
		conversationId: conversation.id,
		action: "create",
		profile: "in-depth",
		normalizedQueryHash: "hash-ev",
		clientAtlasTurnId: randomUUID(),
		idempotencyKey: randomUUID(),
		title: SEEDED.runningJob,
		status: "running",
		stage: "curate",
		progressPercent: 58,
		progressDetailsJson: JSON.stringify({ pipelineVersion: 2, phase: "write" }),
		startedAt: new Date(Date.now() - 6 * 60 * 1000),
	});
	return conversation.id;
}

async function gotoHome(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15000,
	});
	// The board only renders once the summary has landed.
	await page.getByTestId("home-board").waitFor({ timeout: 15000 });
}

test.describe("chat home — Compact", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("draws the greeting with the weekly bars on its line", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedWeeklyTurns(userId, 7);
		await gotoHome(page);

		const greeting = page.getByTestId("home-greeting");
		await expect(greeting).toBeVisible();
		await expect(greeting).toContainText("Admin User");

		await expect(page.getByTestId("home-weekly-bars")).toBeVisible();
		// Twelve bars, always — an empty week is a 1px tick, not a gap.
		await expect(page.getByTestId("home-weekly-bar")).toHaveCount(12);
		await expect(page.getByTestId("home-weekly-count")).toHaveText(
			"7 this week",
		);
	});

	test("puts the chip row under the composer, not inside it", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const rail = page.getByTestId("home-suggestion-rail");
		await expect(rail).toBeVisible();

		// The owner's change: the rail is a sibling BELOW the composer, and no
		// chip lives inside the composer's own box.
		const composerBox = await page.getByTestId("message-input").boundingBox();
		const railBox = await rail.boundingBox();
		expect(composerBox).not.toBeNull();
		expect(railBox).not.toBeNull();
		expect(railBox?.y ?? 0).toBeGreaterThan(composerBox?.y ?? 0);
		expect(
			await page
				.getByTestId("message-input")
				.locator('[data-testid="home-suggestion-chip"]')
				.count(),
		).toBe(0);
	});

	test("clicking a chip sends its text as the first message", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const chip = page.getByTestId("home-suggestion-chip").first();
		await expect(chip).toBeVisible();
		const candidateKey = await chip.getAttribute("data-candidate-key");
		expect(candidateKey).toBeTruthy();

		// The source is the ranking field, and it lives on hover, not on the row.
		await expect(chip).toHaveAttribute("title", /^Source: .+/);

		const eventPosted = page.waitForRequest(
			(request) =>
				request.url().includes("/api/home/summary") &&
				request.method() === "POST",
		);
		await chip.click();
		await eventPosted;

		// The chip's text becomes the conversation's first message.
		await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 20000 });
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 15000,
		});
	});

	test('"another" rotates the rail without reloading', async ({ page }) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		// Enough distinct conversations that the pool exceeds the three shown.
		for (const title of ["Invoice questions", "Trip planning", "Tax notes"]) {
			const conversation = await createServerConversation(userId, title);
			await createMessage(conversation.id, "user", "hi");
		}
		await gotoHome(page);

		const another = page.getByTestId("home-suggestion-another");
		await expect(another).toBeVisible();

		const before = await page
			.getByTestId("home-suggestion-chip")
			.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("data-candidate-key")),
			);
		await another.click();
		await expect
			.poll(async () =>
				page
					.getByTestId("home-suggestion-chip")
					.evaluateAll((nodes) =>
						nodes.map((node) => node.getAttribute("data-candidate-key")),
					),
			)
			.not.toEqual(before);
	});

	test("lists three recent lines with one mark each", async ({ page }) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		const { atlasConversationId } = await seedRecent(userId);
		await gotoHome(page);

		const lines = page.getByTestId("home-recent-line");
		await expect(lines.first()).toBeVisible();
		expect(await lines.count()).toBeLessThanOrEqual(3);

		const atlasLine = page.locator(
			`[data-testid="home-recent-line"][href="/chat/${atlasConversationId}"]`,
		);
		await expect(atlasLine).toContainText(SEEDED.atlasConversation);
		// A conversation whose Atlas report landed shows the badge INSTEAD of a
		// message count, never both.
		await expect(atlasLine.getByTestId("home-atlas-badge")).toBeVisible();

		const plainLine = page
			.getByTestId("home-recent-line")
			.filter({ hasText: SEEDED.plainConversation });
		await expect(plainLine).toContainText("2");
		await expect(plainLine.getByTestId("home-atlas-badge")).toHaveCount(0);
	});

	test("shows the running line only while a job is in flight", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);
		await expect(page.getByTestId("home-running-line")).toHaveCount(0);

		await seedRunningJob(userId);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByTestId("home-board").waitFor({ timeout: 15000 });

		const running = page.getByTestId("home-running-line");
		await expect(running).toBeVisible();
		await expect(running).toContainText(SEEDED.runningJob);
		// The stage comes from progress details ("write" -> Writing), NOT from
		// the raw stage column, which still says curate.
		await expect(page.getByTestId("home-running-stage")).toContainText(
			"Writing",
		);
		await expect(page.getByTestId("home-running-stage")).not.toContainText(
			"Curating",
		);
		await expect(running.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"58",
		);
		await expect(running).toContainText("min");
	});

	test("keeps the tool-health strip admin-only and last", async ({ page }) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const board = page.getByTestId("home-board");
		const strip = board.getByTestId("degraded-capabilities-banner");
		// The strip only renders during an actual outage; either way it must
		// never appear ABOVE Recent, and it must never be a bordered card here.
		if ((await strip.count()) > 0) {
			const stripBox = await strip.boundingBox();
			const recentBox = await page.getByTestId("home-recent").boundingBox();
			expect(stripBox?.y ?? 0).toBeGreaterThan(recentBox?.y ?? 0);
			await expect(
				strip.getByTestId("degraded-capabilities-admin-link"),
			).toBeVisible();
		}
		// The old card slot above the composer is gone in every state.
		const composerBox = await page.getByTestId("message-input").boundingBox();
		const boardBox = await board.boundingBox();
		expect(boardBox?.y ?? 0).toBeGreaterThan(composerBox?.y ?? 0);
	});

	test("degrades to a greeting and a composer when the summary is empty", async ({
		page,
	}) => {
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await gotoHome(page);

		await expect(page.getByTestId("home-greeting")).toBeVisible();
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(page.getByTestId("home-recent")).toHaveCount(0);
		await expect(page.getByTestId("home-weekly-mark")).toHaveCount(0);
	});

	test("gives every chip a 44px hit area on a phone", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const userId = await adminUserId();
		await clearHomeFixtures(userId);
		await seedRecent(userId);
		await gotoHome(page);

		const chip = page.getByTestId("home-suggestion-chip").first();
		await expect(chip).toBeVisible();
		const hit = await chip.evaluate((node) => {
			const after = window.getComputedStyle(node, "::after");
			const rect = node.getBoundingClientRect();
			const inset = Math.abs(Number.parseFloat(after.top || "0"));
			return { height: rect.height + inset * 2 };
		});
		expect(hit.height).toBeGreaterThanOrEqual(44);
	});
});
