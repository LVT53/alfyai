import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	atlasJobs,
	conversations,
	homeSuggestionEvents,
	usageEvents,
	userConnections,
	users,
} from "../../src/lib/server/db/schema";
import { createConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import { login, TEST_EMAIL } from "./helpers";

/**
 * Screenshot capture for the chat home redesign review. Named zzz- so it runs
 * last, after the assertion specs have had the database to themselves.
 */

const OUT =
	process.env.HOME_SHOT_DIR ??
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/everyday-redesign/impl-home";

const RECENTS: Array<[string, number]> = [
	["Reply to Kata about the September invoice", 4],
	["Nextcloud folder clean-up plan", 12],
	["Atlas report on EU battery rules", 6],
];

async function seedBoard() {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!user) throw new Error("seeded admin missing");
	const userId = user.id;

	await db.delete(atlasJobs).where(eq(atlasJobs.userId, userId));
	await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
	await db
		.delete(homeSuggestionEvents)
		.where(eq(homeSuggestionEvents.userId, userId));
	await db.delete(conversations).where(eq(conversations.userId, userId));
	await db.delete(userConnections).where(eq(userConnections.userId, userId));

	// Two connected accounts, so the rail shows what it is actually for: a
	// calendar chip and a files chip built from granted-and-enabled
	// capabilities, rather than three conversation titles.
	await db.insert(userConnections).values([
		{
			id: randomUUID(),
			userId,
			provider: "google",
			label: "Google Calendar",
			accountIdentifier: "admin@local",
			status: "connected",
			capabilitiesJson: JSON.stringify(["calendar", "contacts"]),
			oauthScopesJson: JSON.stringify([
				"https://www.googleapis.com/auth/calendar.readonly",
			]),
			lastUsedAt: new Date(Date.now() - 30 * 60_000),
		},
		{
			id: randomUUID(),
			userId,
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: "admin",
			status: "connected",
			capabilitiesJson: JSON.stringify(["files", "contacts"]),
			lastUsedAt: new Date(Date.now() - 40 * 60_000),
		},
	]);

	let atlasConversationId = "";
	let ageHours = 2;
	for (const [title, turns] of RECENTS) {
		const conversation = await createConversation(userId, title);
		for (let i = 0; i < turns; i += 1) {
			await createMessage(
				conversation.id,
				i % 2 === 0 ? "user" : "assistant",
				"…",
			);
		}
		if (title.startsWith("Atlas report")) atlasConversationId = conversation.id;
		// Push the rows into the past so the "when" column reads like a real
		// history rather than three "just now"s.
		await db
			.update(conversations)
			.set({ updatedAt: new Date(Date.now() - ageHours * 3_600_000) })
			.where(eq(conversations.id, conversation.id));
		ageHours += 22;
	}

	await db.insert(atlasJobs).values({
		id: randomUUID(),
		userId,
		conversationId: atlasConversationId,
		action: "create",
		profile: "overview",
		normalizedQueryHash: "hash-battery",
		clientAtlasTurnId: randomUUID(),
		idempotencyKey: randomUUID(),
		title: "EU battery rules",
		status: "succeeded",
		stage: "render",
		progressPercent: 100,
		progressDetailsJson: "{}",
	});

	const running = await createConversation(
		userId,
		"Hungarian EV charging subsidies, 2024-2026",
	);
	await createMessage(running.id, "user", "Research EV subsidies.");
	// Ten minutes old, so the two connected accounts (which the rail is
	// actually for) outrank it rather than tying with it on the same second.
	await db
		.update(conversations)
		.set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
		.where(eq(conversations.id, running.id));
	await db.insert(atlasJobs).values({
		id: randomUUID(),
		userId,
		conversationId: running.id,
		action: "create",
		profile: "in-depth",
		normalizedQueryHash: "hash-ev",
		clientAtlasTurnId: randomUUID(),
		idempotencyKey: randomUUID(),
		title: "Hungarian EV charging subsidies, 2024-2026",
		status: "running",
		stage: "curate",
		progressPercent: 58,
		progressDetailsJson: JSON.stringify({ pipelineVersion: 2, phase: "write" }),
		startedAt: new Date(Date.now() - 6 * 60 * 1000),
	});

	// Twelve weeks of turns, with one week away, so the bars have a shape.
	// No messages on it, so it never appears as a Recent line or a chip.
	const conversation = await createConversation(userId, "Usage fixture");
	const now = Date.now();
	await db
		.update(conversations)
		.set({ updatedAt: new Date(now - 30 * 86_400_000) })
		.where(eq(conversations.id, conversation.id));
	const perWeek = [22, 31, 18, 27, 0, 34, 29, 41, 25, 33, 38, 45];
	const billingMonth = new Date().toISOString().slice(0, 7);
	for (let week = 0; week < perWeek.length; week += 1) {
		const weeksAgo = perWeek.length - 1 - week;
		for (let i = 0; i < (perWeek[week] ?? 0); i += 1) {
			await db.insert(usageEvents).values({
				id: randomUUID(),
				userId,
				conversationId: conversation.id,
				messageId: randomUUID(),
				modelId: "home-shot-model",
				billingMonth,
				createdAt: new Date(
					now - weeksAgo * 7 * 86_400_000 - i * 60_000 - 3 * 3_600_000,
				),
			});
		}
	}
}

async function setTheme(page: Page, theme: "light" | "dark") {
	await page.evaluate((value) => {
		document.documentElement.classList.toggle("dark", value === "dark");
		document.documentElement.dataset.theme = value;
		localStorage.setItem("theme", value);
	}, theme);
	await page.waitForTimeout(300);
}

async function gotoHome(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15000,
	});
	await page.getByTestId("home-board").waitFor({ timeout: 15000 });
	await page.waitForTimeout(500);
}

test.describe("capture chat home", () => {
	test("desktop and phone, light and dark", async ({ page }) => {
		mkdirSync(OUT, { recursive: true });
		await seedBoard();
		await login(page);

		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoHome(page);
		await setTheme(page, "light");
		await page.screenshot({ path: `${OUT}/home-desktop-light.png` });

		await setTheme(page, "dark");
		await page.screenshot({ path: `${OUT}/home-desktop-dark.png` });

		// Hover a chip so the source tooltip target and the hover state are in
		// at least one frame.
		await setTheme(page, "light");
		await page.getByTestId("home-suggestion-chip").first().hover();
		await page.waitForTimeout(400);
		await page.screenshot({ path: `${OUT}/home-desktop-light-chip-hover.png` });

		await page.setViewportSize({ width: 390, height: 844 });
		await gotoHome(page);
		await setTheme(page, "light");
		await page.screenshot({ path: `${OUT}/home-phone-light.png` });
		await setTheme(page, "dark");
		await page.screenshot({ path: `${OUT}/home-phone-dark.png` });
	});
});
