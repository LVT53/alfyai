import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { messages, users } from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createEmptyConversation,
	ensureSidebarExpanded,
	login,
	waitForHydration,
} from "./helpers";

// Editing a sent message happens in the real composer (the approved refresh):
// the pencil puts the message's text there, the bubble dims, the draft the
// person had is set aside and comes back afterwards, and when later replies
// would be deleted the strip says so in one line.

async function seedTurns(page: Page, turns: number, title = "Edit") {
	const conversationId = await createEmptyConversation(page, title);
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

/** What the server holds as this chat's draft: what a reload would find. */
async function savedDraft(page: Page, conversationId: string) {
	return page.evaluate(async (id) => {
		const response = await fetch(`/api/conversations/${id}`);
		const detail = (await response.json()) as {
			draft?: { draftText: string } | null;
		};
		return detail.draft?.draftText ?? null;
	}, conversationId);
}

async function saveDraft(page: Page, conversationId: string, text: string) {
	await page.evaluate(
		async ({ id, draftText }) => {
			await fetch(`/api/conversations/${id}/draft`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ draftText, selectedAttachmentIds: [] }),
			});
		},
		{ id: conversationId, draftText: text },
	);
}

/** Each e2e file keeps its own copy of the fake provider's setup, as the others do. */
async function pointTheUserAtFakeModel(page: Page, baseUrl: string) {
	return page.evaluate(
		async ({ apiKey, base, modelName }) => {
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `fake_edit_provider_${Date.now()}`,
					displayName: "Fake Edit Provider",
					baseUrl: base,
					apiKey,
				}),
			});
			const { provider } = (await providerResponse.json()) as {
				provider: { id: string };
			};
			const modelResponse = await fetch(
				`/api/admin/providers/${provider.id}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						models: [
							{
								name: modelName,
								displayName: "Fake Edit Model",
								contextLength: 8192,
								supportsChat: true,
								supportsTools: true,
							},
						],
					}),
				},
			);
			const { models } = (await modelResponse.json()) as {
				models: Array<{ id: string }>;
			};
			const preference = await fetch("/api/settings/preferences", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					preferredModel: `provider:${provider.id}:${models[0].id}`,
				}),
			});
			if (!preference.ok) throw new Error(`model ${preference.status}`);
			return provider.id;
		},
		{ apiKey: AI_SMOKE_API_KEY, base: baseUrl, modelName: AI_SMOKE_MODEL_ID },
	);
}

async function restoreTheUsersModel(page: Page, providerId: string) {
	await page.evaluate(async (id) => {
		await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel: null }),
		});
		await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
	}, providerId);
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

	for (const setAside of ["", "a draft of chat one"]) {
		test(`moving to another chat keeps both chats' drafts (${setAside ? "a draft set aside" : "nothing set aside"})`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const chatOne = await seedTurns(page, 2, "Chat one");
			const chatTwo = await seedTurns(page, 1, "Chat two");
			await saveDraft(page, chatTwo.conversationId, "a draft of chat two");
			await open(page, chatOne.conversationId);
			const composer = page.getByTestId("message-input");
			if (setAside) {
				await composer.fill(setAside);
				await expect
					.poll(() => savedDraft(page, chatOne.conversationId))
					.toBe(setAside);
			}
			await ensureSidebarExpanded(page);
			await pressPencil(page, chatOne.userIds[0]);
			await expect(page.getByTestId("composer-edit-strip")).toBeVisible();

			await page
				.locator(
					`[data-testid="conversation-item"][data-conversation-id="${chatTwo.conversationId}"]`,
				)
				.click();

			await expect(page).toHaveURL(new RegExp(chatTwo.conversationId));
			await expect(composer).toHaveValue("a draft of chat two");
			await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
			// Past the page's draft debounce, so anything wrongly emitted has landed.
			await page.waitForTimeout(600);
			expect(await savedDraft(page, chatTwo.conversationId)).toBe(
				"a draft of chat two",
			);
			expect(await savedDraft(page, chatOne.conversationId)).toBe(
				setAside || null,
			);
		});
	}

	test("a delete that fails keeps the edit, what was typed and the messages; sending again works", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 3);
		await open(page, conversationId);
		await pressPencil(page, userIds[0]);
		const composer = page.getByTestId("message-input");
		await composer.fill("Question number 1, asked again");
		const deleteRoute = `**/api/conversations/${conversationId}/messages`;
		await page.route(deleteRoute, (route) =>
			route.request().method() === "DELETE"
				? route.fulfill({ status: 500, json: { error: "Delete failed" } })
				: route.fallback(),
		);

		await page.getByTestId("send-button").click();

		await expect(page.getByText("Delete failed")).toBeVisible();
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
		await expect(composer).toHaveValue("Question number 1, asked again");
		await expect(
			page.getByText("Answer number 3 about the lake."),
		).toBeVisible();

		await page.unroute(deleteRoute);
		await page.getByTestId("send-button").click();

		await expect(page.getByText("Answer number 3 about the lake.")).toHaveCount(
			0,
		);
		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
	});

	test.describe("with a model that answers", () => {
		const fakeProvider = createOpenAICompatibleProviderHarness();

		test.beforeAll(async () => {
			await fakeProvider.start();
		});

		test.afterAll(async () => {
			await fakeProvider.stop();
		});

		test.beforeEach(async () => {
			await fakeProvider.reset();
		});

		test("the draft set aside outlives the resend's turn and a reload", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId, userIds } = await seedTurns(page, 2);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			try {
				await open(page, conversationId);
				const composer = page.getByTestId("message-input");
				await composer.fill("a half-written thought");
				await expect
					.poll(() => savedDraft(page, conversationId))
					.toBe("a half-written thought");

				await pressPencil(page, userIds[0]);
				await composer.fill("Question number 1, asked again");
				await page.getByTestId("send-button").click();

				// The turn has landed: its reply is there and carries its actions.
				await expect(page.getByText(/fake provider response/i)).toBeVisible({
					timeout: 30_000,
				});
				await expect(
					page.getByRole("button", { name: "Regenerate" }),
				).toHaveCount(1, { timeout: 30_000 });
				await expect(composer).toHaveValue("a half-written thought");
				await expect
					.poll(() => savedDraft(page, conversationId))
					.toBe("a half-written thought");

				await page.reload();
				await expect(composer).toHaveValue("a half-written thought");
				await expect(
					page.getByText("Question number 1, asked again"),
				).toBeVisible();
				await expect(
					page.getByText("Answer number 2 about the lake."),
				).toHaveCount(0);
			} finally {
				await restoreTheUsersModel(page, providerId);
			}
		});
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
