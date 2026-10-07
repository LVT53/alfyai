import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	conversations,
	messages,
	providerModels,
	providers,
	users,
} from "../../src/lib/server/db/schema";
import { login } from "./helpers";

/**
 * Two dialogs that had no keyboard behaviour at all: the image lightbox and
 * the model guide. Both said `aria-modal="true"` and nothing else — focus
 * stayed on the page behind, Tab walked out into it, and Escape was heard by
 * every layer at once.
 *
 * Everything inside the dialog is driven by real keys. The one exception is
 * the click that opens the lightbox: a picture in a reply is not a control, so
 * there is no key that reaches it.
 */

const IMAGE_A = "/e2e-fu2-lightbox-a.svg";
const IMAGE_B = "/e2e-fu2-lightbox-b.svg";

function pictureSvg(fill: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${fill}"/></svg>`;
}

async function seedConversation(id: string, assistantReply: string) {
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
		title: "A reply with pictures",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values([
		{
			id: `${id}-msg-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "Show me two pictures.",
			createdAt: now,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: assistantReply,
			createdAt: now,
		},
	]);
}

async function removeConversation(id: string) {
	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));
}

async function bodyOverflow(page: Page): Promise<string> {
	return page.evaluate(() => document.body.style.overflow);
}

test.describe("Image lightbox from the keyboard", () => {
	const conversationId = randomUUID();

	test.beforeEach(async ({ page }) => {
		await seedConversation(
			conversationId,
			`Here they are.\n\n![First picture](${IMAGE_A})\n\n![Second picture](${IMAGE_B})`,
		);
		await page.route(`**${IMAGE_A}`, (route) =>
			route.fulfill({
				contentType: "image/svg+xml",
				body: pictureSvg("#b8945f"),
			}),
		);
		await page.route(`**${IMAGE_B}`, (route) =>
			route.fulfill({
				contentType: "image/svg+xml",
				body: pictureSvg("#5f94b8"),
			}),
		);
		await login(page);
	});

	test.afterEach(async () => {
		await removeConversation(conversationId);
	});

	test("takes focus, keeps Tab and Shift+Tab inside, pages with the arrows, holds the page still, and closes on Escape", async ({
		page,
	}) => {
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		const pictures = page.locator(".markdown-html img");
		await expect(pictures).toHaveCount(2);
		const scrollBefore = await bodyOverflow(page);

		await pictures.first().click();
		const lightbox = page.getByTestId("image-lightbox");
		await expect(lightbox).toBeVisible();
		await expect(lightbox).toHaveAttribute("aria-modal", "true");
		await expect(lightbox).toBeFocused();
		expect(await bodyOverflow(page)).toBe("hidden");

		const close = lightbox.getByRole("button", { name: "Close" });
		const previous = lightbox.getByRole("button", { name: "Previous image" });
		const next = lightbox.getByRole("button", { name: "Next image" });
		const inside = lightbox.locator(":focus");

		// Shift+Tab from the dialog itself wraps to its last control ...
		await page.keyboard.press("Shift+Tab");
		await expect(next).toBeFocused();
		// ... Tab from the last one wraps to the first, and every press on the
		// way round lands on a control of the dialog, never on the page.
		await page.keyboard.press("Tab");
		await expect(close).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(previous).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(next).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(close).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(next).toBeFocused();
		await expect(inside).toHaveCount(1);

		// The arrow keys page through the pictures, wrapping at the ends.
		const counter = page.getByTestId("image-lightbox-counter");
		await expect(counter).toHaveText("1 / 2");
		await page.keyboard.press("ArrowRight");
		await expect(counter).toHaveText("2 / 2");
		await page.keyboard.press("ArrowRight");
		await expect(counter).toHaveText("1 / 2");
		await page.keyboard.press("ArrowLeft");
		await expect(counter).toHaveText("2 / 2");
		await expect(inside).toHaveCount(1);

		await page.keyboard.press("Escape");
		await expect(lightbox).toBeHidden();
		expect(await bodyOverflow(page)).toBe(scrollBefore);
		// Focus is not left in the dialog that went away.
		await expect(page.locator("body")).toBeFocused();
	});
});

test.describe("Model guide from the keyboard", () => {
	const providerId = randomUUID();
	const conversationId = randomUUID();

	test.beforeEach(async ({ page }) => {
		// A provider with a privacy-policy link, so the guide has a control at
		// each end: the close button first, the link last.
		const now = new Date();
		await db.insert(providers).values({
			id: providerId,
			name: `guide_probe_${providerId.slice(0, 8)}`,
			displayName: "Guide Probe Provider",
			baseUrl: "https://guide-probe.example.com/v1",
			apiKeyEncrypted: "probe-encrypted",
			apiKeyIv: "probe-iv",
			privacyPolicyUrl: "https://guide-probe.example.com/privacy",
			sortOrder: 999,
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(providerModels).values({
			id: randomUUID(),
			providerId,
			name: "guide-probe-1",
			displayName: "Guide Probe Model",
			enabled: 1,
			sortOrder: 0,
			createdAt: now,
			updatedAt: now,
		});
		await seedConversation(conversationId, "Nothing to see here.");
		await login(page);
	});

	test.afterEach(async () => {
		await db.delete(providers).where(eq(providers.id, providerId));
		await removeConversation(conversationId);
	});

	test("takes focus, keeps Tab inside, closes on its own Escape and hands focus back to the button that opened it", async ({
		page,
	}) => {
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("message-input")).toBeVisible();

		// The "+" menu, opened with the keyboard, and the guide's "?" in its
		// Model row.
		const trigger = page.getByTestId("composer-tools-trigger");
		await expect(trigger).toBeEnabled();
		await trigger.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByTestId("composer-tools-menu");
		await expect(menu).toBeVisible();
		const guideButton = menu.getByRole("button", { name: "Open model guide" });
		await expect(guideButton).toBeEnabled();
		await guideButton.focus();
		await page.keyboard.press("Enter");

		const guide = page.getByRole("dialog", { name: "Model guide" });
		await expect(guide).toBeVisible();
		await expect(guide).toBeFocused();

		const close = guide.getByRole("button", { name: "Close" });
		const policy = guide.getByRole("link", { name: "Provider privacy policy" });
		await page.keyboard.press("Shift+Tab");
		await expect(policy).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(close).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(policy).toBeFocused();
		await expect(guide.locator(":focus")).toHaveCount(1);

		// One Escape belongs to the guide, the layer on top. The menu it was
		// opened from stays, and the "?" has focus again.
		await page.keyboard.press("Escape");
		await expect(guide).toBeHidden();
		await expect(menu).toBeVisible();
		await expect(guideButton).toBeFocused();

		// The next one is the menu's.
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	});
});
