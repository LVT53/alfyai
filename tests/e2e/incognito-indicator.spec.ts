import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { INCOGNITO_GREETINGS } from "../../src/lib/i18n/chat";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import { ensureSidebarExpanded, login, sendMessage } from "./helpers";

/**
 * Incognito, one-way (docs/plans/incognito-one-way-spec.md).
 *
 * The toggle exists in exactly one place — the landing page's mask button
 * (and its phone-header twin), before a conversation exists — and disappears
 * the moment it is tapped or a conversation exists by any other route. Once a
 * conversation is incognito it stays that way for its whole life: there is no
 * switch anywhere, on the composer, in the "+" menu or in the face's own
 * card, that turns it back off. This covers the landing arm, the ambient
 * tint, the conversation surfaces (sidebar mark, opening mark, face,
 * popover), persistence across reload, the absence of every removed switch,
 * and the server's refusal of a direct PATCH false.
 */

const PHONE = { width: 390, height: 844 };
const PLACEHOLDER = "Incognito · nothing here is remembered";
const PLACEHOLDER_PHONE = "Incognito · not remembered";
const RESTING_PLACEHOLDER = "Type a message...";

/**
 * A conversation with a couple of messages, so the sidebar lists it. Inserted
 * as rows rather than through the services, which run a sequence-repair
 * statement better-sqlite3 refuses inside the Playwright runner.
 */
async function seedConversation(
	id: string,
	options: { memoryIncognito?: boolean; title?: string } = {},
): Promise<void> {
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
		title: options.title ?? "Battery rules",
		memoryIncognito: options.memoryIncognito ?? false,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values([
		{
			id: `${id}-msg-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "What are the rules for storing lithium batteries?",
			createdAt: now,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Keep them cool, dry and at a partial charge.",
			createdAt: now,
		},
	]);
}

async function openChat(page: Page, id: string) {
	await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible();
	await expect(page.getByTestId("message-input")).toBeEnabled();
}

function sidebarMark(page: Page, id: string): Locator {
	return page
		.locator(`[data-testid="conversation-item"][data-conversation-id="${id}"]`)
		.getByTestId("conversation-incognito-mark");
}

test.describe("Incognito, one-way — desktop", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("arming on the landing page hides the button, tints the stage, dashes the composer and picks a greeting from the pool", async ({
		page,
	}) => {
		const arm = page.getByTestId("incognito-arm");
		await expect(arm).toBeVisible();
		await expect(page.locator(".chat-stage")).not.toHaveClass(
			/stage--incognito/,
		);
		// The composer's own hairline is solid until armed.
		await expect(page.locator(".message-composer")).toHaveCSS(
			"border-style",
			"solid",
		);

		await arm.click();

		await expect(arm).toHaveCount(0);
		await expect(page.locator(".chat-stage")).toHaveClass(/stage--incognito/);
		await expect(page.locator(".message-composer")).toHaveCSS(
			"border-style",
			"dashed",
		);
		// The weekly bars (drawn inside the normal greeting's own markup) and
		// the whole board underneath the composer are gone.
		await expect(page.locator(".home-greeting-full")).toHaveCount(0);
		await expect(page.getByTestId("home-board")).toHaveCount(0);

		const greeting = (
			await page.getByTestId("home-greeting").innerText()
		).trim();
		expect(INCOGNITO_GREETINGS.en).toContain(greeting);

		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			PLACEHOLDER,
		);
	});

	test("sending creates an incognito conversation with the sidebar mark, the opening mark and the face; it survives a reload; the '+' menu has no switch; a direct PATCH false is refused", async ({
		page,
	}) => {
		await page.getByTestId("incognito-arm").click();
		await sendMessage(page, "What's the raise negotiation script?");
		await page.waitForURL(/\/chat\//, { timeout: 15000 });
		const conversationId = new URL(page.url()).pathname.split("/").pop();
		if (!conversationId) throw new Error("conversation id missing from URL");

		await expect(page.locator(".chat-stage")).toHaveClass(/stage--incognito/);

		await ensureSidebarExpanded(page);
		await expect(sidebarMark(page, conversationId)).toBeVisible();

		const opening = page.getByTestId("incognito-opening");
		await expect(opening).toBeVisible();
		await expect(opening).toContainText("Off the record from here");

		const face = page.getByTestId("incognito-face");
		await expect(face).toBeVisible();
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			PLACEHOLDER,
		);

		await face.click();
		const popover = page.getByTestId("incognito-popover");
		await expect(popover).toBeVisible();
		await expect(popover).toContainText("Incognito is on");
		await expect(popover).toContainText(
			"Nothing in this chat is remembered or counted.",
		);
		// One-way: no switch anywhere in the card.
		await expect(page.getByTestId("incognito-popover-toggle")).toHaveCount(0);
		await expect(popover.locator('[role="switch"]')).toHaveCount(0);

		const newChat = page.getByTestId("incognito-popover-new-chat");
		await expect(newChat).toBeVisible();
		await expect(newChat).toBeFocused();
		await page.keyboard.press("Escape");

		// Reload keeps it — the flag is on the conversation, not a client guess.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("incognito-face")).toBeVisible();
		await expect(page.getByTestId("incognito-opening")).toBeVisible();
		await ensureSidebarExpanded(page);
		await expect(sidebarMark(page, conversationId)).toBeVisible();

		// The "+" menu never draws an incognito row, on or off.
		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("incognito-toggle")).toHaveCount(0);
		await page.keyboard.press("Escape");

		// Defence in depth: the server refuses a direct false, whatever the
		// client ever does. There is no UI path that sends this any more.
		const falseResponse = await page.request.patch(
			`/api/conversations/${conversationId}`,
			{ data: { memoryIncognito: false } },
		);
		expect(falseResponse.status()).toBe(409);
		expect((await falseResponse.json()).error).toBe("incognito_is_one_way");

		// "New chat" navigates away rather than turning this chat back to
		// normal, which cannot be done. Reopened fresh — the reload above
		// closed the earlier card.
		await page.getByTestId("incognito-face").click();
		await page.getByTestId("incognito-popover-new-chat").click();
		await expect(page).toHaveURL("/", { timeout: 10000 });
	});

	test("a fresh incognito conversation opened directly shows the sidebar mark and the opening mark", async ({
		page,
	}) => {
		const conversationId = "e2e-incognito-indicator-seeded";
		await seedConversation(conversationId, { memoryIncognito: true });
		await openChat(page, conversationId);
		await ensureSidebarExpanded(page);

		await expect(sidebarMark(page, conversationId)).toBeVisible();
		await expect(sidebarMark(page, conversationId)).toHaveAttribute(
			"title",
			"Incognito — not remembered",
		);
		await expect(page.getByTestId("incognito-opening")).toBeVisible();
		await expect(page.getByTestId("incognito-face")).toBeVisible();
	});

	test("Escape closes the card and hands focus back to the face; a click outside closes it too", async ({
		page,
	}) => {
		const conversationId = "e2e-incognito-indicator-escape";
		await seedConversation(conversationId, { memoryIncognito: true });
		await openChat(page, conversationId);
		const face = page.getByTestId("incognito-face");

		await face.click();
		await expect(page.getByTestId("incognito-popover")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("incognito-popover")).toBeHidden();
		await expect(face).toHaveAttribute("aria-expanded", "false");
		await expect(face).toBeFocused();

		await face.click();
		await expect(page.getByTestId("incognito-popover")).toBeVisible();
		// The card hangs over the textarea, so "outside" is the thread above it.
		await page.getByTestId("assistant-message").first().click();
		await expect(page.getByTestId("incognito-popover")).toBeHidden();
		await expect(face).toBeVisible();
	});

	test("the '+' menu draws no incognito row on a normal conversation either", async ({
		page,
	}) => {
		const conversationId = "e2e-incognito-indicator-normal";
		await seedConversation(conversationId, { memoryIncognito: false });
		await openChat(page, conversationId);

		await expect(page.getByTestId("incognito-face")).toHaveCount(0);
		await expect(page.getByTestId("incognito-opening")).toHaveCount(0);
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			RESTING_PLACEHOLDER,
		);

		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("incognito-toggle")).toHaveCount(0);
	});
});

test.describe("Incognito, one-way — phone", () => {
	test.use({
		viewport: PHONE,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the header mask button arms it; the face is a 44px target and its card is a bottom sheet", async ({
		page,
	}) => {
		const headerButton = page.getByTestId("incognito-arm-phone");
		await expect(headerButton).toBeVisible();

		await headerButton.click();
		await expect(headerButton).toHaveCount(0);
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			PLACEHOLDER_PHONE,
		);

		await sendMessage(page, "Phone incognito arm test");
		await page.waitForURL(/\/chat\//, { timeout: 15000 });

		const face = page.getByTestId("incognito-face");
		await expect(face).toBeVisible();
		const faceBox = await face.boundingBox();
		expect(faceBox?.width).toBeGreaterThanOrEqual(44);
		expect(faceBox?.height).toBeGreaterThanOrEqual(44);
		// The header's mask-arm slot is gone now a conversation exists — the
		// header instead shows a mask mark before the title. Scoped to the
		// header: the sidebar row's own mark (off-screen behind the closed
		// drawer) carries the same accessible name.
		await expect(page.getByTestId("incognito-arm-phone")).toHaveCount(0);
		await expect(
			page.locator("header").getByLabel("Incognito — not remembered"),
		).toBeVisible();

		await face.click();
		const sheet = page.getByTestId("incognito-popover");
		await expect(sheet).toBeVisible();
		await expect(page.getByTestId("incognito-popover-grabber")).toBeVisible();
		// Pinned to the viewport's bottom edge — polled, because it flies up.
		await expect
			.poll(
				async () => {
					const box = await sheet.boundingBox();
					if (!box) return Number.POSITIVE_INFINITY;
					return Math.abs(box.y + box.height - PHONE.height);
				},
				{ timeout: 3000 },
			)
			.toBeLessThanOrEqual(2);
		const sheetBox = await sheet.boundingBox();
		expect(sheetBox?.x).toBe(0);
		expect(sheetBox?.width).toBe(PHONE.width);

		// One-way: no switch in the sheet either.
		await expect(page.getByTestId("incognito-popover-toggle")).toHaveCount(0);
		const newChat = page.getByTestId("incognito-popover-new-chat");
		await expect(newChat).toBeVisible();
		const newChatBox = await newChat.boundingBox();
		expect(newChatBox?.height).toBeGreaterThanOrEqual(44);

		await page.getByTestId("incognito-popover-grabber").click();
		await expect(sheet).toBeHidden();
	});
});
