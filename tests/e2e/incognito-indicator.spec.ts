import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import {
	ensureSidebarExpanded,
	login,
	openConversationComposer,
} from "./helpers";

/**
 * Incognito redesign — how the state is shown.
 *
 * The full-width accent notice above the composer is gone. While incognito is
 * on, the action row grows a fifth face (a mask in accent, like every other
 * active face), the empty textarea
 * says what the mask means, the face opens a small card with the same switch
 * the "+" menu has, and the conversation's sidebar row carries a mask before
 * its title. This covers the three surfaces and the live update between them.
 */

const PHONE = { width: 390, height: 844 };
const PLACEHOLDER = "Incognito · nothing here is remembered";
const PLACEHOLDER_PHONE = "Incognito · not remembered";
const RESTING_PLACEHOLDER = "Type a message...";

/**
 * A computed `color` comes back as `rgb(...)`; resolve a token through the
 * browser so the two are comparable in whichever theme the run is in.
 */
async function tokenRgb(page: Page, token: string): Promise<string> {
	return page.evaluate((name) => {
		const raw = getComputedStyle(document.documentElement)
			.getPropertyValue(name)
			.trim();
		if (raw === "") throw new Error(`${name} is not defined`);
		const probe = document.createElement("span");
		probe.style.color = raw;
		document.body.appendChild(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return resolved;
	}, token);
}

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

/** Flip incognito from the "+" menu and put the menu away again. */
async function flipFromMenu(page: Page, expectAfter: "true" | "false") {
	await page.getByTestId("composer-tools-trigger").click();
	const toggle = page.getByTestId("incognito-toggle");
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", expectAfter);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("composer-tools-menu")).toBeHidden();
}

function sidebarMark(page: Page, id: string): Locator {
	return page
		.locator(`[data-testid="conversation-item"][data-conversation-id="${id}"]`)
		.getByTestId("conversation-incognito-mark");
}

test.describe("Incognito indicator — desktop", () => {
	const CONVERSATION_ID = "e2e-incognito-indicator";

	test.beforeEach(async ({ page }) => {
		await seedConversation(CONVERSATION_ID);
		await login(page);
	});

	test("turning it on raises the mask face and the placeholder, and no notice row", async ({
		page,
	}) => {
		await openChat(page, CONVERSATION_ID);
		const textarea = page.getByTestId("message-input");
		await expect(page.getByTestId("incognito-face")).toHaveCount(0);
		await expect(textarea).toHaveAttribute("placeholder", RESTING_PLACEHOLDER);

		await flipFromMenu(page, "true");

		// The fifth face: after thinking, the same size as its neighbours,
		// drawn in accent like the other active faces.
		const face = page.getByTestId("incognito-face");
		await expect(face).toBeVisible();
		await expect(face).toHaveAttribute("aria-label", "Incognito is on");
		await expect(face).toHaveAttribute("aria-expanded", "false");
		const faceBox = await face.boundingBox();
		const thinkingBox = await page
			.getByTestId("thinking-bar-toggle")
			.boundingBox();
		if (!faceBox || !thinkingBox) throw new Error("faces not measurable");
		expect(Math.abs(faceBox.width - thinkingBox.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(faceBox.height - thinkingBox.height)).toBeLessThanOrEqual(
			1,
		);
		expect(faceBox.x).toBeGreaterThan(thinkingBox.x);
		expect(
			await face.evaluate((element) => getComputedStyle(element).color),
		).toBe(await tokenRgb(page, "--accent"));

		await expect(textarea).toHaveAttribute("placeholder", PLACEHOLDER);
		await expect(page.locator(".composer-incognito-notice")).toHaveCount(0);
		await expect(page.getByText(/won't be saved to memory/i)).toHaveCount(0);

		// And the placeholder gives way to what is typed, as any placeholder.
		await textarea.fill("Draft a note about the storage rules");
		await expect(face).toBeVisible();
		await textarea.fill("");
		await expect(textarea).toHaveAttribute("placeholder", PLACEHOLDER);
	});

	test("the sidebar row grows a mask the moment it is turned on, and loses it when off", async ({
		page,
	}) => {
		await openChat(page, CONVERSATION_ID);
		await ensureSidebarExpanded(page);
		await expect(sidebarMark(page, CONVERSATION_ID)).toHaveCount(0);

		await flipFromMenu(page, "true");
		const mark = sidebarMark(page, CONVERSATION_ID);
		await expect(mark).toBeVisible();
		await expect(mark).toHaveAttribute("title", "Incognito — not remembered");

		// Leading, not trailing: the mark comes before the title, and the
		// three-dots button is still where it was.
		const row = page.locator(
			`[data-testid="conversation-item"][data-conversation-id="${CONVERSATION_ID}"]`,
		);
		const menuButton = row.getByRole("button", {
			name: "Conversation options",
		});
		await expect(menuButton).toBeVisible();
		const markBox = await mark.boundingBox();
		const menuBox = await menuButton.boundingBox();
		const rowBox = await row.boundingBox();
		if (!markBox || !menuBox || !rowBox) throw new Error("row not measurable");
		expect(markBox.x + markBox.width).toBeLessThan(menuBox.x);
		expect(rowBox.height).toBeGreaterThanOrEqual(32);
		expect(rowBox.height).toBeLessThanOrEqual(34);

		// It survives a reload — the list payload carries the flag.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("incognito-face")).toBeVisible();
		await ensureSidebarExpanded(page);
		await expect(sidebarMark(page, CONVERSATION_ID)).toBeVisible();

		await flipFromMenu(page, "false");
		await expect(sidebarMark(page, CONVERSATION_ID)).toHaveCount(0);
		await expect(page.getByTestId("incognito-face")).toHaveCount(0);
	});

	test("the face opens a card whose switch turns it off", async ({ page }) => {
		await seedConversation(CONVERSATION_ID, { memoryIncognito: true });
		await openChat(page, CONVERSATION_ID);
		await ensureSidebarExpanded(page);
		const face = page.getByTestId("incognito-face");
		await expect(face).toBeVisible();
		await expect(sidebarMark(page, CONVERSATION_ID)).toBeVisible();
		await expect(page.getByTestId("incognito-popover")).toHaveCount(0);

		await face.click();
		const popover = page.getByTestId("incognito-popover");
		await expect(popover).toBeVisible();
		await expect(face).toHaveAttribute("aria-expanded", "true");
		await expect(popover).toContainText("Incognito is on");
		await expect(popover).toContainText("Nothing in this chat is remembered.");

		// Above the face, inside the window.
		const popoverBox = await popover.boundingBox();
		const faceBox = await face.boundingBox();
		const viewport = page.viewportSize();
		if (!popoverBox || !faceBox || !viewport)
			throw new Error("popover not measurable");
		expect(popoverBox.y).toBeGreaterThanOrEqual(0);
		expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(faceBox.y);
		expect(popoverBox.x).toBeGreaterThanOrEqual(0);
		expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width);
		expect(Math.round(popoverBox.width)).toBe(292);

		const toggle = page.getByTestId("incognito-popover-toggle");
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(toggle).toBeFocused();

		await toggle.click();
		await expect(popover).toBeHidden();
		await expect(face).toHaveCount(0);
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			RESTING_PLACEHOLDER,
		);
		await expect(sidebarMark(page, CONVERSATION_ID)).toHaveCount(0);

		// The "+" menu agrees.
		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("incognito-toggle")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	test("Escape closes the card and hands focus back to the face; a click outside closes it too", async ({
		page,
	}) => {
		await seedConversation(CONVERSATION_ID, { memoryIncognito: true });
		await openChat(page, CONVERSATION_ID);
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

	test("the landing composer shows the face and placeholder before the first message", async ({
		page,
	}) => {
		await openConversationComposer(page);
		await flipFromMenu(page, "true");

		const face = page.getByTestId("incognito-face");
		await expect(face).toBeVisible();
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			PLACEHOLDER,
		);

		// The card opens above the landing composer, not clipped by the home
		// column.
		await face.click();
		const popover = page.getByTestId("incognito-popover");
		await expect(popover).toBeVisible();
		const popoverBox = await popover.boundingBox();
		const faceBox = await face.boundingBox();
		if (!popoverBox || !faceBox) throw new Error("popover not measurable");
		expect(popoverBox.y).toBeGreaterThanOrEqual(0);
		expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(faceBox.y);

		await page.getByTestId("incognito-popover-toggle").click();
		await expect(face).toHaveCount(0);
	});
});

test.describe("Incognito indicator — phone", () => {
	const CONVERSATION_ID = "e2e-incognito-indicator-phone";

	test.use({
		viewport: PHONE,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await seedConversation(CONVERSATION_ID, { memoryIncognito: true });
		await login(page);
	});

	test("the face is a 44px target and its card is a bottom sheet", async ({
		page,
	}) => {
		await openChat(page, CONVERSATION_ID);

		const face = page.getByTestId("incognito-face");
		await expect(face).toBeVisible();
		const faceBox = await face.boundingBox();
		expect(faceBox?.width).toBeGreaterThanOrEqual(44);
		expect(faceBox?.height).toBeGreaterThanOrEqual(44);
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			PLACEHOLDER_PHONE,
		);

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

		const toggle = page.getByTestId("incognito-popover-toggle");
		const toggleBox = await toggle.boundingBox();
		expect(toggleBox?.height).toBeGreaterThanOrEqual(44);

		// The grabber puts it away; the switch turns it off.
		await page.getByTestId("incognito-popover-grabber").click();
		await expect(sheet).toBeHidden();
		await face.click();
		await expect(sheet).toBeVisible();
		await toggle.click();
		await expect(sheet).toBeHidden();
		await expect(face).toHaveCount(0);
	});
});
