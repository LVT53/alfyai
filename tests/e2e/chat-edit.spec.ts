import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { messages, users } from "../../src/lib/server/db/schema";
import { createEmptyConversation, login, waitForHydration } from "./helpers";

// Editing a sent message happens in the real composer (the approved refresh):
// the pencil puts the message's text there, the bubble dims, the draft the
// person had is set aside and comes back afterwards, and when later replies
// would be deleted the strip says so in one line.

async function seedTurns(page: Page, turns: number) {
	const conversationId = await createEmptyConversation(page, "Edit");
	const base = Date.now() - turns * 120_000;
	const userIds: string[] = [];
	const rows = [];
	for (let i = 1; i <= turns; i += 1) {
		const userId = randomUUID();
		userIds.push(userId);
		rows.push(
			{
				id: userId,
				conversationId,
				messageSequence: i * 2 - 1,
				role: "user" as const,
				content: `Question number ${i} about the lake`,
				createdAt: new Date(base + i * 120_000),
			},
			{
				id: randomUUID(),
				conversationId,
				messageSequence: i * 2,
				role: "assistant" as const,
				content: `Answer number ${i} about the lake.`,
				createdAt: new Date(base + i * 120_000 + 30_000),
			},
		);
	}
	await db.insert(messages).values(rows);
	return { conversationId, userIds };
}

async function open(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("assistant-message").first()).toBeVisible();
	// A press before the page is hydrated lands on inert markup.
	await waitForHydration(page);
}

async function pressPencil(page: Page, userMessageId: string) {
	await page.locator(`[data-message-id="${userMessageId}"]`).hover();
	await page.locator(`#edit-button-${userMessageId}`).click();
}

test.describe("Editing a message in the composer", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the pencil moves the message into the composer; sending deletes the later turns and the earlier draft comes back", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 4);
		await open(page, conversationId);
		const composer = page.getByTestId("message-input");
		await composer.fill("a half-written thought");

		await pressPencil(page, userIds[1]);

		// The composer holds the message, the strip says what is going on, and the
		// message itself steps back.
		await expect(composer).toHaveValue("Question number 2 about the lake");
		const strip = page.getByTestId("composer-edit-strip");
		await expect(strip).toBeVisible();
		await expect(page.getByTestId("composer-edit-label")).toHaveText(
			"2 later replies will be deleted.",
		);
		await expect(page.locator(`[data-message-id="${userIds[1]}"]`)).toHaveClass(
			/being-edited/,
		);
		await expect(page.locator(`#edit-button-${userIds[1]}`)).toHaveCount(0);
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
		// The faces that would add to the edit are off.
		await expect(page.getByTestId("attach-toggle")).toBeDisabled();
		await expect(page.getByTestId("composer-tools-trigger")).toBeDisabled();

		await composer.fill("Question number 2, asked again");
		await page.getByTestId("send-button").click();

		// Everything from the edited message on is gone; the new question is there.
		await expect(page.getByText("Answer number 3 about the lake.")).toHaveCount(
			0,
		);
		await expect(page.getByText("Answer number 4 about the lake.")).toHaveCount(
			0,
		);
		await expect(
			page.getByText("Question number 4 about the lake"),
		).toHaveCount(0);
		await expect(
			page.getByText("Question number 2, asked again"),
		).toBeVisible();
		await expect(
			page.getByText("Answer number 1 about the lake."),
		).toBeVisible();
		// The composer is the person's again, with the draft they had.
		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		await expect(composer).toHaveValue("a half-written thought");
	});

	test("cancel keeps every message and the draft, by the button and by Esc", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 3);
		await open(page, conversationId);
		const composer = page.getByTestId("message-input");
		await composer.fill("keep me");

		await pressPencil(page, userIds[0]);
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
		await page.getByTestId("composer-edit-cancel").click();

		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		await expect(composer).toHaveValue("keep me");
		await expect(page.getByTestId("user-message")).toHaveCount(3);
		await expect(page.getByTestId("assistant-message")).toHaveCount(3);
		await expect(
			page.locator(`[data-message-id="${userIds[0]}"]`),
		).not.toHaveClass(/being-edited/);

		await pressPencil(page, userIds[2]);
		await expect(page.getByTestId("composer-edit-label")).toHaveText(
			"Edit message",
		);
		await composer.press("Escape");

		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		await expect(composer).toHaveValue("keep me");
		await expect(page.getByTestId("user-message")).toHaveCount(3);
	});

	test.describe("a 360 px phone", () => {
		test.use({
			viewport: { width: 360, height: 740 },
			hasTouch: true,
			isMobile: true,
		});

		for (const language of ["en", "hu"] as const) {
			test(`the strip stays on one line (${language}), even for a long count`, async ({
				page,
			}) => {
				await db
					.update(users)
					.set({ uiLanguage: language })
					.where(eq(users.email, "admin@local"));
				try {
					const { conversationId, userIds } = await seedTurns(page, 14);
					await open(page, conversationId);

					await pressPencil(page, userIds[0]);

					const label = page.getByTestId("composer-edit-label");
					await expect(label).toContainText(/13/);
					const fit = await label.evaluate((node) => {
						const box = node.getBoundingClientRect();
						const style = getComputedStyle(node);
						return {
							// Nothing is cut off by the ellipsis...
							clipped: node.scrollWidth > node.clientWidth,
							// ...and it is one line of text, not two.
							lines: Math.round(
								box.height / Number.parseFloat(style.lineHeight || "16"),
							),
						};
					});
					expect(fit.clipped, "the label must not be cut off").toBe(false);
					expect(fit.lines).toBe(1);
					const strip = await page
						.getByTestId("composer-edit-strip")
						.boundingBox();
					expect(strip?.height ?? 999).toBeLessThan(44);
					await expect(page.getByTestId("composer-edit-cancel")).toBeVisible();
				} finally {
					await db
						.update(users)
						.set({ uiLanguage: "en" })
						.where(eq(users.email, "admin@local"));
				}
			});
		}
	});
});
