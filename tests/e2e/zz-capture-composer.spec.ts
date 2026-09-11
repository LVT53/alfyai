// Screenshot capture for the composer's Direction B redesign. It asserts
// nothing CI needs — it drives the real app so every state can be
// photographed in both themes, and writes PNGs to a scratch directory that
// only exists on the machine that made them.
//
// So it SKIPS unless COMPOSER_CAPTURE=1. It stays a .spec.ts under
// tests/e2e/ so it keeps compiling against the same helpers and is
// type-checked with everything else, the way zz-capture-connections.spec.ts
// already is.
//
//   COMPOSER_CAPTURE=1 npx playwright test tests/e2e/zz-capture-composer.spec.ts
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	connectionPendingWrites,
	conversations,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import { login, openConversationComposer } from "./helpers";

test.skip(
	process.env.COMPOSER_CAPTURE !== "1",
	"screenshot capture helper — set COMPOSER_CAPTURE=1 to run it",
);

// Where the PNGs land, and how big the desktop window is. Both are env
// overrides so a second pass over the same states (a different window size,
// a different directory to compare against) does not need a second copy of
// this file.
const OUT =
	process.env.COMPOSER_CAPTURE_OUT ||
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/dc2da4d4-d513-4098-9b2b-8b6c426191eb/scratchpad/everyday-redesign/impl-composer";

const DESKTOP = {
	width: Number(process.env.COMPOSER_CAPTURE_WIDTH || 1280),
	height: Number(process.env.COMPOSER_CAPTURE_HEIGHT || 860),
};
const PHONE = { width: 390, height: 844 };

async function setTheme(page: Page, theme: "light" | "dark") {
	const res = await page.evaluate(async (next) => {
		const r = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: next }),
		});
		return r.status;
	}, theme);
	expect(res, `theme PATCH -> ${res}`).toBeLessThan(400);
	// The server preference is only read at boot (initTheme prefers it over
	// localStorage), so without this every "dark" capture in this file was a
	// light screenshot with a dark name on it.
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.classList.contains("dark")),
		)
		.toBe(theme === "dark");
}

async function settle(page: Page) {
	await page.waitForTimeout(600);
}

// Crop to the composer so the screenshots are about the composer, not the
// whole app chrome around it.
async function shotComposer(page: Page, name: string) {
	const composer = page.locator(".message-composer").first();
	await composer.scrollIntoViewIfNeeded();
	const box = await composer.boundingBox();
	if (!box) throw new Error(`composer not measurable for ${name}`);
	const viewport = page.viewportSize();
	if (!viewport) throw new Error(`no viewport size for ${name}`);
	await page.screenshot({
		path: `${OUT}/${name}.png`,
		clip: {
			x: Math.max(0, box.x - 24),
			y: Math.max(0, box.y - 320),
			width: Math.min(viewport.width, box.width + 48),
			height: Math.min(viewport.height, box.height + 340),
		},
	});
}

for (const theme of ["light", "dark"] as const) {
	test(`desktop ${theme}`, async ({ page }) => {
		await page.setViewportSize(DESKTOP);
		await login(page);
		await setTheme(page, theme);
		await openConversationComposer(page);
		await settle(page);

		await shotComposer(page, `desktop-${theme}-idle`);

		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
		await settle(page);
		await page.screenshot({ path: `${OUT}/desktop-${theme}-menu-open.png` });

		// The Model list as a flyout beside the menu — the state the old
		// "upward from the row" positioning drew on top of the menu's own
		// rows, so it is worth a picture of its own.
		await page.getByTestId("model-selector-trigger").click();
		await expect(
			page.getByRole("listbox", { name: /model/i }).first(),
		).toBeVisible();
		await settle(page);
		await page.screenshot({
			path: `${OUT}/desktop-${theme}-model-flyout.png`,
		});
		await page.keyboard.press("Escape");

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("composer-tools-menu")).toBeHidden();

		const thinking = page.getByTestId("thinking-bar-toggle");
		if (await thinking.isVisible().catch(() => false)) {
			if ((await thinking.getAttribute("aria-pressed")) !== "true") {
				await thinking.click();
			}
			await expect(thinking).toHaveAttribute("aria-pressed", "true");
		}
		await settle(page);
		await shotComposer(page, `desktop-${theme}-thinking-on`);

		await page.locator('input[type="file"]').setInputFiles({
			name: "battery-rules-draft.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("draft text for the composer screenshot"),
		});
		await expect(
			page.getByText("battery-rules-draft.txt", { exact: false }).first(),
		).toBeVisible({ timeout: 15000 });
		await settle(page);
		await shotComposer(page, `desktop-${theme}-file-attached`);
	});

	test(`phone ${theme}`, async ({ page }) => {
		await page.setViewportSize(PHONE);
		await login(page);
		await setTheme(page, theme);
		await openConversationComposer(page);
		await settle(page);

		await page.screenshot({ path: `${OUT}/phone-${theme}-idle.png` });

		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
		await settle(page);
		await page.screenshot({ path: `${OUT}/phone-${theme}-menu-sheet.png` });

		await page.getByTestId("model-selector-trigger").click();
		await expect(
			page.getByRole("listbox", { name: /model/i }).first(),
		).toBeVisible();
		await settle(page);
		await page.screenshot({
			path: `${OUT}/phone-${theme}-model-picker-sheet.png`,
		});
	});
}

// The "+" menu where it actually lives: on the bottom edge of the window, at
// the end of a thread long enough to scroll. On the landing page the composer
// is centred, so every capture above photographs a menu with half a screen of
// room above it — which is the one condition the clipping defect did not have.
for (const theme of ["light", "dark"] as const) {
	test(`desktop ${theme} menu at the bottom of a long conversation`, async ({
		page,
	}) => {
		const [admin] = await db
			.select()
			.from(users)
			.where(eq(users.email, "admin@local"))
			.limit(1);
		expect(admin, "the e2e admin must exist").toBeTruthy();

		const conversationId = `conv-menushot-${theme}`;
		const now = new Date();
		await db
			.delete(messages)
			.where(eq(messages.conversationId, conversationId));
		await db.delete(conversations).where(eq(conversations.id, conversationId));
		await db.insert(conversations).values({
			id: conversationId,
			userId: admin.id,
			title: `A long thread (${theme})`,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(messages).values(
			Array.from({ length: 24 }, (_, index) => ({
				id: `msg-menushot-${theme}-${index}`,
				conversationId,
				messageSequence: index + 1,
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content:
					index % 2 === 0
						? `Question number ${index / 2 + 1} about the battery rules.`
						: "A paragraph of answer, long enough that the thread scrolls and the composer ends up on the bottom edge of the window.",
				createdAt: now,
			})),
		);

		await page.setViewportSize(DESKTOP);
		await login(page);
		await setTheme(page, theme);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("message-input")).toBeVisible();
		await settle(page);

		await page.getByTestId("composer-tools-trigger").click();
		await expect(page.getByTestId("composer-tools-menu")).toBeVisible();
		await settle(page);
		await page.screenshot({
			path: `${OUT}/desktop-${theme}-menu-at-bottom.png`,
		});

		await page.getByTestId("model-selector-trigger").click();
		await expect(
			page.getByRole("listbox", { name: /model/i }).first(),
		).toBeVisible();
		await settle(page);
		await page.screenshot({
			path: `${OUT}/desktop-${theme}-model-flyout-at-bottom.png`,
		});
	});
}

// The write-confirm card renders from real rows — a write tool creates a
// pending write mid-turn, so there is no client-side way to fabricate one.
// Seeding is how the rest of this suite stages server state.
for (const theme of ["light", "dark"] as const) {
	test(`phone ${theme} write-confirm sheet`, async ({ page }) => {
		const [admin] = await db
			.select()
			.from(users)
			.where(eq(users.email, "admin@local"))
			.limit(1);
		expect(admin, "the e2e admin must exist").toBeTruthy();

		const conversationId = `conv-writeshot-${theme}`;
		const assistantId = `msg-writeshot-assistant-${theme}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: admin.id,
			title: `Write confirm sheet (${theme})`,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(messages).values([
			{
				id: `msg-writeshot-user-${theme}`,
				conversationId,
				messageSequence: 1,
				role: "user",
				content: "Save the Atlas report to Nextcloud.",
				createdAt: now,
			},
			{
				id: assistantId,
				conversationId,
				messageSequence: 2,
				role: "assistant",
				content: "One thing needs your OK first.",
				createdAt: now,
			},
		]);
		await db.insert(connectionPendingWrites).values({
			id: `pw-writeshot-${theme}`,
			userId: admin.id,
			connectionId: "conn-nextcloud",
			provider: "nextcloud",
			opJson: JSON.stringify({ kind: "put" }),
			idempotencyKey: `idem-writeshot-${theme}`,
			status: "pending",
			previewJson: JSON.stringify({
				title: "Save this report to Nextcloud?",
				detail:
					"/AlfyAI/Reports/atlas-battery-rules-2026-09.pdf — new file, 1.4 MB, PDF.",
				reversible: true,
				destructive: false,
				withinAllowlist: true,
				warnings: [],
			}),
			conversationId,
			assistantMessageId: assistantId,
		});

		await page.setViewportSize(PHONE);
		await login(page);
		await setTheme(page, theme);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByText("Save this report to Nextcloud?")).toBeVisible({
			timeout: 20000,
		});
		await settle(page);
		await page.screenshot({
			path: `${OUT}/phone-${theme}-write-confirm-sheet.png`,
		});
	});
}
