import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import {
	buildAiSdkUiStreamBody,
	createConversation,
	ensureSidebarExpanded,
	login,
	waitForAssistantResponse,
} from "./helpers";

// A generated title has to reach every surface that shows the conversation's
// title — the phone header, the desktop title bar, the sidebar row and the
// document <title> — the moment it lands, not on the next full page load.
//
// The real title endpoint short-circuits to `title: null` under
// PLAYWRIGHT_TEST=1 so the suite never depends on a live title model. This
// spec stands in for it at the network edge, for this spec only, and does
// what the real endpoint does: persist the title (through the ordinary rename
// route), then answer with it.

const GENERATED_TITLE = "Tidal Energy Basics";

async function mockGeneratedTitle(
	page: Page,
	options: { holdFor?: () => Promise<void> } = {},
) {
	await page.route("**/api/conversations/*/title", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		const conversationId = new URL(route.request().url()).pathname.split(
			"/",
		)[3];
		await options.holdFor?.();
		const persisted = await page.request.patch(
			`/api/conversations/${conversationId}`,
			{ data: { title: GENERATED_TITLE } },
		);
		expect(persisted.ok()).toBe(true);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ title: GENERATED_TITLE }),
		});
	});
}

/**
 * A titled conversation with messages, so the sidebar lists it. Inserted as
 * rows (as incognito-indicator.spec.ts does) rather than through the
 * services, which run a statement better-sqlite3 refuses inside the runner.
 */
async function seedConversation(id: string, title: string): Promise<void> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));

	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId: admin.id,
		title,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values([
		{
			id: `${id}-msg-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "An earlier question.",
			createdAt: now,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "An earlier answer.",
			createdAt: now,
		},
	]);
}

async function mockStream(page: Page) {
	await page.route("**/api/chat/stream", async (route) => {
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
			body: buildAiSdkUiStreamBody("Tides turn turbines twice a day."),
		});
	});
}

const phoneHeaderTitle = (page: Page) =>
	page.locator("header.header-bar [aria-live='polite']");
const desktopTitleBar = (page: Page) =>
	page.locator(".chat-title-bar h1 .chat-title-main");
const sidebarRow = (page: Page, conversationId: string) =>
	page.locator(
		`[data-testid="conversation-item"][data-conversation-id="${conversationId}"]`,
	);

test.describe("generated conversation title", () => {
	test("reaches the phone header of a new chat (375px)", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await login(page);
		await mockStream(page);
		await mockGeneratedTitle(page);

		await createConversation(page, "How does tidal energy work?");
		await waitForAssistantResponse(page);

		await expect(phoneHeaderTitle(page)).toHaveText(GENERATED_TITLE, {
			timeout: 10000,
		});
		await expect(page).toHaveTitle(GENERATED_TITLE);
	});

	test("reaches the desktop title bar and sidebar of a new chat (1280px)", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await login(page);
		await mockStream(page);
		await mockGeneratedTitle(page);

		const conversationId = await createConversation(
			page,
			"How does tidal energy work?",
		);
		await waitForAssistantResponse(page);

		await expect(desktopTitleBar(page)).toHaveText(GENERATED_TITLE, {
			timeout: 10000,
		});
		await expect(page).toHaveTitle(GENERATED_TITLE);
		await ensureSidebarExpanded(page);
		await expect(sidebarRow(page, conversationId)).toContainText(
			GENERATED_TITLE,
		);
	});

	for (const viewport of [
		{ name: "375px", width: 375, height: 812 },
		{ name: "1280px", width: 1280, height: 900 },
	]) {
		test(`a sidebar rename reaches the chat's own title (${viewport.name})`, async ({
			page,
		}) => {
			await page.setViewportSize(viewport);
			await login(page);
			await mockStream(page);
			await mockGeneratedTitle(page);

			const conversationId = await createConversation(
				page,
				"How does tidal energy work?",
			);
			await waitForAssistantResponse(page);
			await expect(page).toHaveTitle(GENERATED_TITLE, { timeout: 10000 });

			if (viewport.width < 1024) {
				await page.locator(".mobile-sidebar-toggle").click();
			} else {
				await ensureSidebarExpanded(page);
			}
			const row = sidebarRow(page, conversationId);
			await row.hover();
			await row.getByRole("button", { name: "Conversation options" }).click();
			await page.getByTestId("rename-option").click();
			const input = page.getByTestId("title-input");
			await input.fill("Renamed Tides");
			await input.press("Enter");
			await expect(row).toContainText("Renamed Tides");

			await expect(page).toHaveTitle("Renamed Tides", { timeout: 10000 });
			const surface =
				viewport.width < 1024 ? phoneHeaderTitle(page) : desktopTitleBar(page);
			await expect(surface).toHaveText("Renamed Tides");
		});
	}

	test("a title that lands after navigating away stays on its own chat", async ({
		page,
	}) => {
		const seededId = "e2e-title-refresh-seeded";
		await seedConversation(seededId, "Seeded Earlier Chat");
		await page.setViewportSize({ width: 1280, height: 900 });
		await login(page);
		await mockStream(page);

		// The new chat's title is held until the user has already moved
		// (client-side, through the sidebar) to another chat.
		let releaseTitle: () => void = () => {};
		const titleReleased = new Promise<void>((resolve) => {
			releaseTitle = resolve;
		});
		await mockGeneratedTitle(page, { holdFor: () => titleReleased });

		const newId = await createConversation(page, "How does tidal energy work?");
		await waitForAssistantResponse(page);

		await ensureSidebarExpanded(page);
		await sidebarRow(page, seededId).click();
		await expect(page).toHaveURL(`/chat/${seededId}`);
		await expect(desktopTitleBar(page)).toHaveText("Seeded Earlier Chat");

		releaseTitle();
		const newRow = sidebarRow(page, newId);
		await expect(newRow).toContainText(GENERATED_TITLE, { timeout: 10000 });
		// Still on the seeded chat: its surfaces keep its own title.
		await expect(desktopTitleBar(page)).toHaveText("Seeded Earlier Chat");
		await expect(page).toHaveTitle("Seeded Earlier Chat");

		// And back on the new chat, the late title is there.
		await newRow.click();
		await expect(page).toHaveURL(`/chat/${newId}`);
		await expect(desktopTitleBar(page)).toHaveText(GENERATED_TITLE);
		await expect(page).toHaveTitle(GENERATED_TITLE);
	});
});
