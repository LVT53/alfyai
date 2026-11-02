import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
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
	// All of it in the past: a turn sent into the chat afterwards comes after it.
	const base = Date.now() - (turns + 1) * 120_000;
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

/** A chat with nothing said in it yet, open and ready for its first message. */
async function openEmptyChat(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeEnabled();
	await waitForHydration(page);
}

/**
 * Holds the next turn the page sends, at the browser, until `release` is called:
 * a reply that is still coming, with the composer free to type into. Release it
 * before the test ends.
 */
async function holdTheNextTurn(page: Page) {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/chat/stream", async (route) => {
		await held;
		await route.continue();
	});
	return release;
}

/**
 * True once the server has finished the turn's own work after the reply. The
 * reply is on screen before that: the stream ends first, then the server writes
 * the turn's state (where a landed turn deals with the draft) and only then its
 * evidence, so a settled evidence status says a draft was left on purpose.
 */
async function turnHasSettled(conversationId: string) {
	const [reply] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "assistant"),
			),
		);
	const status = reply?.metadataJson
		? (JSON.parse(reply.metadataJson) as { evidenceStatus?: string })
				.evidenceStatus
		: undefined;
	return status === "ready" || status === "none" || status === "failed";
}

/**
 * A text file picked in the composer and uploaded through the real routes: the
 * library item's id, once its chip is up and no longer busy. Text is read in the
 * server's own process, so the e2e build (which has no document service) can
 * send it.
 */
async function attachTextFile(
	page: Page,
	name: string,
	text: string,
): Promise<string> {
	const fileInput = page.locator('input[type="file"]').first();
	// The composer is rendered on the server with its input disabled until it
	// hydrates; a disabled input takes no files.
	await expect(fileInput).toBeEnabled({ timeout: 20_000 });
	const uploaded = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith("/api/knowledge/upload/raw"),
	);
	await fileInput.setInputFiles({
		name,
		mimeType: "text/plain",
		buffer: Buffer.from(text),
	});
	const response = await uploaded;
	expect(response.ok(), `upload -> ${response.status()}`).toBe(true);
	const { artifact } = (await response.json()) as { artifact: { id: string } };
	const chip = page
		.getByTestId("composer-chip-attachment")
		.filter({ hasText: name });
	await expect(chip).toBeVisible();
	await expect(chip).not.toHaveAttribute("aria-busy", "true", {
		timeout: 15_000,
	});
	return artifact.id;
}

type SavedMessage = {
	id: string;
	role: string;
	content: string;
	attachments?: Array<{ artifactId: string; name: string }>;
};

/** What the server holds of the chat, in order: what a reload would show. */
async function savedMessages(
	page: Page,
	conversationId: string,
): Promise<SavedMessage[]> {
	return page.evaluate(async (id) => {
		const response = await fetch(`/api/conversations/${id}`);
		const detail = (await response.json()) as { messages?: SavedMessage[] };
		return detail.messages ?? [];
	}, conversationId);
}

/** Every request the page makes to the chat routes and the message delete, in order, as "METHOD /path". */
function watchChatRequests(page: Page): string[] {
	const seen: string[] = [];
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (
			pathname.startsWith("/api/chat/") ||
			/^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
		) {
			seen.push(`${request.method()} ${pathname}`);
		}
	});
	return seen;
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

	test("a reload keeps the saved draft, in the middle of an edit too", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 2);
		await open(page, conversationId);
		const composer = page.getByTestId("message-input");
		await composer.fill("a half-written thought");
		await expect
			.poll(() => savedDraft(page, conversationId))
			.toBe("a half-written thought");

		await page.reload();
		await expect(composer).toHaveValue("a half-written thought");

		await waitForHydration(page);
		await pressPencil(page, userIds[0]);
		await composer.fill("words that were never sent");
		await page.reload();

		// The edit is gone with the page, and it never became the draft.
		await expect(composer).toHaveValue("a half-written thought");
		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		// Past the page's draft debounce, so anything wrongly emitted has landed.
		await page.waitForTimeout(600);
		expect(await savedDraft(page, conversationId)).toBe(
			"a half-written thought",
		);
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

	test("sending an edit takes the reader to the new turn, wherever they had scrolled", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		const { conversationId, userIds } = await seedTurns(page, 10);
		await open(page, conversationId);
		await pressPencil(page, userIds[8]);
		await page.getByTestId("message-input").fill("Question 9, asked again");

		await page.evaluate(() => {
			const scroller = document.querySelector<HTMLElement>(".scroll-container");
			if (scroller) scroller.scrollTop = 0;
		});
		await expect(
			page.locator(`[data-message-id="${userIds[0]}"]`),
		).toBeInViewport();
		await page.getByTestId("send-button").click();

		await expect(page.getByText("Question 9, asked again")).toBeInViewport({
			timeout: 10_000,
		});
	});

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

	test("while an edit is open the replies offer no way to start another turn", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 2);
		await open(page, conversationId);
		const regenerate = page.getByRole("button", { name: "Regenerate" });
		const pencils = page.getByRole("button", { name: "Edit message" });
		await expect(regenerate).toHaveCount(2);

		await pressPencil(page, userIds[0]);
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();

		await expect(regenerate).toHaveCount(0);
		await expect(pencils).toHaveCount(0);

		await page.getByTestId("composer-edit-cancel").click();

		await expect(regenerate).toHaveCount(2);
		await expect(pencils).toHaveCount(2);
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

		// The server keeps nothing of a turn that fails, so after one the page's list
		// ends in a message the server does not have. Retry sends that message again,
		// with its file, and leaves every reply above it where it is: it used to take
		// the last reply of the list, the turn before's, regenerate it and remove it.
		test("Retry after a failed turn keeps the earlier reply and sends the message again with its file", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId } = await seedTurns(page, 1);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const requests = watchChatRequests(page);
			const question = "And what is the lake called?";
			const lakeName = `Lake-${randomUUID().slice(0, 8)}`;
			try {
				await open(page, conversationId);
				const fileId = await attachTextFile(
					page,
					`notes-${lakeName}.txt`,
					`The lake in these notes is called ${lakeName}.`,
				);

				// The first try fails before it reaches the model: the server keeps
				// nothing of it, as of a turn that failed in the model.
				await page.route("**/api/chat/stream", (route) =>
					route.fulfill({
						status: 500,
						json: { error: "The model provider failed." },
					}),
				);
				await page.getByTestId("message-input").fill(question);
				await page.getByTestId("send-button").click();
				const retry = page.getByRole("button", { name: "Retry" });
				await expect(retry).toBeVisible();
				await page.unroute("**/api/chat/stream");

				// The message is on screen, the turn before still has its reply.
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				await expect(
					page.getByText("Answer number 1 about the lake."),
				).toBeVisible();

				const retried = page.waitForRequest(
					(request) =>
						request.method() === "POST" &&
						new URL(request.url()).pathname === "/api/chat/stream",
					{ timeout: 10_000 },
				);
				await retry.click();

				// It is the same message with the file it went with, to the stream.
				expect((await retried).postDataJSON()).toMatchObject({
					message: question,
					conversationId,
					attachmentIds: [fileId],
				});
				await expect(page.getByText(/fake provider response/i)).toBeVisible({
					timeout: 30_000,
				});
				await expect(
					page.getByText("Answer number 1 about the lake."),
				).toBeVisible();
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				expect(requests).not.toContain("POST /api/chat/retry");
				expect(
					requests.filter((r) => r === "POST /api/chat/stream"),
				).toHaveLength(2);

				// The file reached the model, and the server saved one message with it
				// (the file is linked to its message a moment after the reply).
				await expect
					.poll(() =>
						fakeProvider
							.requests()
							.some((request) =>
								(JSON.stringify(request.body) ?? "").includes(lakeName),
							),
					)
					.toBe(true);
				await expect
					.poll(async () =>
						(await savedMessages(page, conversationId))
							.at(2)
							?.attachments?.map((attachment) => attachment.artifactId),
					)
					.toEqual([fileId]);
				const saved = await savedMessages(page, conversationId);
				expect(saved.map((message) => message.role)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
				const sentMessage = saved[2];
				expect(sentMessage.content).toBe(question);
				// The bubble that was on screen is the one the server has: under its id,
				// with its pencil (a client id would leave edits nothing to find).
				const bubble = page.locator(`[data-message-id="${sentMessage.id}"]`);
				await expect(bubble).toBeVisible();
				await bubble.hover();
				await expect(
					page.locator(`#edit-button-${sentMessage.id}`),
				).toBeVisible();
			} finally {
				await page.unroute("**/api/chat/stream").catch(() => undefined);
				await restoreTheUsersModel(page, providerId);
			}
		});

		// The resend of an edit meets the turn's gate only after the delete. A file
		// deleted since (a page that is not up to date, or a model that cannot see the
		// photo) is refused there, and a reload showed the message and every reply
		// after it gone. The gate is asked first, and a refusal leaves the edit open.
		test("an edit the turn's gate refuses deletes nothing, keeps the edit and what was typed open, and a reload finds every message", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const conversationId = await createEmptyConversation(
				page,
				"A refused edit",
			);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const requests = watchChatRequests(page);
			const question = "What does this file say about the lake?";
			try {
				await openEmptyChat(page, conversationId);
				const fileId = await attachTextFile(
					page,
					"lake-notes.txt",
					"The lake is deep and cold.",
				);
				await page.getByTestId("message-input").fill(question);
				await page.getByTestId("send-button").click();
				await expect(page.getByText(/fake provider response/i)).toBeVisible({
					timeout: 30_000,
				});
				await expect.poll(() => turnHasSettled(conversationId)).toBe(true);
				const before = await savedMessages(page, conversationId);
				expect(before.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				const userMessageId = before[0].id;

				// The file is deleted while this page still shows it with the message.
				const removed = await page.request.delete(`/api/knowledge/${fileId}`);
				expect(removed.ok(), `file delete -> ${removed.status()}`).toBe(true);

				await pressPencil(page, userMessageId);
				const composer = page.getByTestId("message-input");
				await expect(composer).toHaveValue(question);
				const reworded = "What does this file say about the river?";
				await composer.fill(reworded);
				const deletesBefore = requests.filter((r) => r.startsWith("DELETE"));
				await page.getByTestId("send-button").click();

				// The gate's own sentence for it, on a page that has lost nothing.
				await expect(
					page.getByText("Attached file is no longer available."),
				).toBeVisible();
				await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
				await expect(composer).toHaveValue(reworded);
				await expect(page.getByText(question)).toBeVisible();
				await expect(page.getByText(/fake provider response/i)).toBeVisible();
				expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual(
					deletesBefore,
				);
				expect(requests).toContain("POST /api/chat/turn-check");
				expect(
					requests.filter((r) => r === "POST /api/chat/stream"),
				).toHaveLength(1);
				expect(await savedMessages(page, conversationId)).toHaveLength(2);

				// A reload finds the message and its reply, as they were.
				await page.reload();
				await expect(page.getByTestId("assistant-message")).toHaveCount(1);
				await expect(page.getByText(question)).toBeVisible();
				await expect(page.getByText(/fake provider response/i)).toBeVisible();
				const after = await savedMessages(page, conversationId);
				expect(after.map((message) => message.id)).toEqual(
					before.map((message) => message.id),
				);
			} finally {
				await restoreTheUsersModel(page, providerId);
			}
		});

		test("words typed while a reply is coming are still there after it lands and after a reload", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const conversationId = await createEmptyConversation(
				page,
				"A draft during a reply",
			);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const releaseTheReply = await holdTheNextTurn(page);
			try {
				await openEmptyChat(page, conversationId);
				const composer = page.getByTestId("message-input");
				await composer.fill("What is the plan for the weekend?");
				await page.getByTestId("send-button").click();

				// The reply is on its way and the composer is the person's again: what
				// goes into it is saved as the chat's draft.
				await composer.fill("an idea for after the reply");
				await expect
					.poll(() => savedDraft(page, conversationId))
					.toBe("an idea for after the reply");

				releaseTheReply();
				await expect(page.getByText(/fake provider response/i)).toBeVisible({
					timeout: 30_000,
				});
				await expect.poll(() => turnHasSettled(conversationId)).toBe(true);

				await expect(composer).toHaveValue("an idea for after the reply");
				expect(await savedDraft(page, conversationId)).toBe(
					"an idea for after the reply",
				);
				await page.reload();
				await expect(composer).toHaveValue("an idea for after the reply");
			} finally {
				releaseTheReply();
				await page.unroute("**/api/chat/stream");
				await restoreTheUsersModel(page, providerId);
			}
		});

		for (const lateSave of [false, true]) {
			test(`a message sent from the composer leaves no draft behind${lateSave ? ", even when a save of it lands after the send" : ""}`, async ({
				page,
			}) => {
				await page.setViewportSize({ width: 1280, height: 900 });
				const conversationId = await createEmptyConversation(
					page,
					"A sent draft",
				);
				const providerId = await pointTheUserAtFakeModel(
					page,
					fakeProvider.baseURL,
				);
				const releaseTheReply = await holdTheNextTurn(page);
				const sent = "What is the plan for the weekend?";
				try {
					await openEmptyChat(page, conversationId);
					const composer = page.getByTestId("message-input");
					await composer.fill(sent);
					await expect.poll(() => savedDraft(page, conversationId)).toBe(sent);

					await page.getByTestId("send-button").click();
					// The composer deletes its draft as it sends.
					await expect.poll(() => savedDraft(page, conversationId)).toBeNull();
					if (lateSave) {
						// A save that was on its way when the send went out lands after that
						// delete: only the turn that sent these words clears it.
						await saveDraft(page, conversationId, sent);
						await expect
							.poll(() => savedDraft(page, conversationId))
							.toBe(sent);
					}

					releaseTheReply();
					await expect(page.getByText(/fake provider response/i)).toBeVisible({
						timeout: 30_000,
					});
					await expect.poll(() => turnHasSettled(conversationId)).toBe(true);
					expect(await savedDraft(page, conversationId)).toBeNull();

					await page.reload();
					await expect(composer).toHaveValue("");
					expect(await savedDraft(page, conversationId)).toBeNull();
				} finally {
					releaseTheReply();
					await page.unroute("**/api/chat/stream");
					await restoreTheUsersModel(page, providerId);
				}
			});
		}

		test("a first message sent from the landing page while a save of it is on its way does not come back in the composer", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			// Held in the page and not with page.route, which would slow the delete
			// that has to reach the server ahead of the chat page's own read.
			await page.addInitScript(() => {
				const real = window.fetch;
				const holding = window as unknown as {
					holdDraftSaves?: boolean;
					draftSavesHeld?: number;
				};
				window.fetch = (input, init) => {
					const isSave =
						init?.method === "PUT" && String(input).endsWith("/draft");
					if (!isSave || !holding.holdDraftSaves) return real(input, init);
					holding.draftSavesHeld = (holding.draftSavesHeld ?? 0) + 1;
					return new Promise(() => undefined);
				};
			});
			try {
				await page.goto("/", { waitUntil: "domcontentloaded" });
				await waitForHydration(page);
				const composer = page.getByTestId("message-input");
				const firstSave = page.waitForResponse(
					(response) =>
						response.url().endsWith("/draft") &&
						response.request().method() === "PUT",
				);
				await composer.fill("What is the plan");
				await firstSave;

				await page.evaluate(() => {
					(window as unknown as { holdDraftSaves: boolean }).holdDraftSaves =
						true;
				});
				await composer.fill("What is the plan for the weekend?");
				await page.waitForFunction(
					() =>
						((window as unknown as { draftSavesHeld?: number })
							.draftSavesHeld ?? 0) > 0,
				);
				await page.getByTestId("send-button").click();

				await expect(page.getByText(/fake provider response/i)).toBeVisible({
					timeout: 30_000,
				});
				await expect(composer).toHaveValue("");
				await page.reload();
				await expect(composer).toHaveValue("");
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
