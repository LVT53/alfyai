import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import {
	createTourUser,
	ITEM_TITLES,
	markToursSeen,
	panelList,
	panelShell,
	reopenChat,
	seedItem,
	startChatAs,
	type TourUser,
} from "./artifact-tours-helpers";
import { ensureSidebarExpanded } from "./helpers";

/**
 * Back closes the top layer of the panel before it leaves the chat (FB-5, ruling
 * 77: F7).
 *
 * The audit's phone reader opened the list and an item, pressed Back, and found
 * herself on the landing page: the panel had added no history entry, so the
 * browser's Back skipped over everything the panel had shown. The panel's layers
 * are the panel (the list, or an item opened straight from a chat card), and an
 * item opened from the list; each opening adds one entry, and a Back (or a
 * forward and back) closes or reopens exactly one layer.
 *
 * Real input: taps on the phone, clicks and keys on the desktop, and the
 * browser's own Back and Forward (`page.goBack()`), never the page's callbacks.
 */

const MODES = [
	{
		name: "390 touch",
		viewport: { width: 390, height: 844 },
		touch: true,
	},
	{
		name: "1440 mouse",
		viewport: { width: 1440, height: 900 },
		touch: false,
	},
] as const;

/** A fresh reader with a Document and an App in a chat, opened with a real reload. */
async function readerWithTwoItems(
	page: Page,
): Promise<{ user: TourUser; chatId: string; documentId: string }> {
	const user = await createTourUser("en");
	await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	const documentId = await seedItem(user, chatId, "document");
	await seedItem(user, chatId, "app");
	await reopenChat(page, chatId);
	return { user, chatId, documentId };
}

function countButton(page: Page): Locator {
	const phone = (page.viewportSize()?.width ?? 1440) < 768;
	return page.getByTestId(
		phone ? "artifact-count-button-compact" : "artifact-count-button",
	);
}

/** The title of the item the panel shows: the panel's own, once on screen (the phone's twin is hidden). */
function itemTitle(page: Page): Locator {
	return page.locator('[data-testid="artifact-panel-title"]:visible');
}

async function press(locator: Locator, touch: boolean): Promise<void> {
	if (touch) await locator.tap();
	else await locator.click();
}

async function openListThenItem(
	page: Page,
	touch: boolean,
	title: string,
): Promise<void> {
	await press(countButton(page), touch);
	await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
	await press(
		panelList(page).getByTestId("artifact-row").filter({ hasText: title }),
		touch,
	);
	await expect(itemTitle(page)).toHaveText(title, { timeout: 15_000 });
}

/** The panel is not on screen and its count button says so. */
async function expectPanelClosed(page: Page, label: string): Promise<void> {
	await expect(panelShell(page), `${label}: no panel`).toBeHidden();
	await expect(panelList(page), `${label}: no list`).toBeHidden();
	await expect(countButton(page), `${label}: the count button`).toHaveAttribute(
		"aria-pressed",
		"false",
	);
}

/** One assistant message whose `create_artifact` call made this Document: the chat card that opens it straight from the chat. */
async function seedCreateCall(
	chatId: string,
	artifactId: string,
	title: string,
): Promise<void> {
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId: chatId,
		messageSequence: 900,
		role: "assistant",
		content: "Made the document.",
		toolCalls: JSON.stringify([
			{
				type: "tool_call",
				callId: "e2e-create-history",
				name: "create_artifact",
				input: {
					artifactType: "document",
					title,
					body: `# ${title}\n\nBody of ${title}.`,
				},
				status: "done",
				outputSummary: `Created Document "${title}"`,
				sourceType: "tool",
				metadata: {
					ok: true,
					artifactId,
					artifactKind: "document",
					artifactTitle: title,
				},
			},
		]),
		createdAt: new Date(),
	});
}

for (const mode of MODES) {
	test.describe(`the panel's history entries at ${mode.name}`, () => {
		test.use({
			viewport: mode.viewport,
			hasTouch: mode.touch,
			isMobile: mode.touch,
		});

		test("Back closes the item, then the list, then the panel, then leaves the chat", async ({
			page,
		}) => {
			const { chatId } = await readerWithTwoItems(page);
			const chatUrl = new RegExp(`/chat/${chatId}$`);
			await openListThenItem(page, mode.touch, ITEM_TITLES.document);

			await page.goBack();
			await expect(
				panelList(page),
				"Back from the item shows the list the item was opened from",
			).toBeVisible({ timeout: 15_000 });
			await expect(page).toHaveURL(chatUrl);

			await page.goBack();
			await expectPanelClosed(page, "Back from the list");
			await expect(page).toHaveURL(chatUrl);

			await page.goBack();
			await expect(page, "only the third Back leaves the chat").not.toHaveURL(
				/\/chat\//,
			);
		});

		test("a forward and back round trip lands where it started", async ({
			page,
		}) => {
			await readerWithTwoItems(page);
			await openListThenItem(page, mode.touch, ITEM_TITLES.document);

			await page.goBack();
			await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
			await page.goForward();
			await expect(
				itemTitle(page),
				"Forward from the list reopens the item",
			).toHaveText(ITEM_TITLES.document, { timeout: 15_000 });

			await page.goBack();
			await page.goBack();
			await expectPanelClosed(page, "two Backs");
			await page.goForward();
			await expect(
				panelList(page),
				"Forward from the closed chat reopens the list",
			).toBeVisible({ timeout: 15_000 });
			await page.goForward();
			await expect(itemTitle(page)).toHaveText(ITEM_TITLES.document, {
				timeout: 15_000,
			});
		});

		test("an item opened straight from a chat card is one entry: one Back closes the panel", async ({
			page,
		}) => {
			const user = await createTourUser("en");
			await markToursSeen(user);
			const chatId = await startChatAs(page, user);
			const documentId = await seedItem(user, chatId, "document");
			await seedCreateCall(chatId, documentId, ITEM_TITLES.document);
			await reopenChat(page, chatId);

			const head = page
				.getByTestId("artifact-card")
				.getByTestId("artifact-card-head");
			await press(head, mode.touch);
			await expect(itemTitle(page)).toHaveText(ITEM_TITLES.document, {
				timeout: 30_000,
			});

			await page.goBack();
			await expectPanelClosed(page, "Back from a card-opened item");
			await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
			await page.goBack();
			await expect(page).not.toHaveURL(/\/chat\//);
		});

		test("the header's way back to the list steps one layer down, and a close leaves no entry behind", async ({
			page,
		}) => {
			const { chatId } = await readerWithTwoItems(page);
			const chatUrl = new RegExp(`/chat/${chatId}$`);
			await openListThenItem(page, mode.touch, ITEM_TITLES.document);

			// The crumb is a Back of the panel's own: the list shows, and one more Back closes.
			await press(
				panelShell(page).locator(".artifact-panel-header-crumb:visible"),
				mode.touch,
			);
			await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
			await page.goBack();
			await expectPanelClosed(page, "Back after the crumb");
			await expect(page).toHaveURL(chatUrl);

			// Closing with the panel's own X leaves nothing behind: one Back leaves the chat.
			await openListThenItem(page, mode.touch, ITEM_TITLES.app);
			await press(
				panelShell(page).locator(".workspace-close-button:visible").first(),
				mode.touch,
			);
			await expectPanelClosed(page, "the X");
			await page.goBack();
			await expect(
				page,
				"the X took its history entries with it",
			).not.toHaveURL(/\/chat\//);
		});

		test("the count button opens the list, and what closes it leaves no entry behind", async ({
			page,
		}) => {
			await readerWithTwoItems(page);
			await press(countButton(page), mode.touch);
			await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
			if (mode.touch) {
				// The phone's panel covers the header: its own X closes it.
				await press(
					page.locator(".workspace-close-button:visible").first(),
					true,
				);
			} else {
				await press(countButton(page), false);
			}
			await expectPanelClosed(page, "closing the list");
			await page.goBack();
			await expect(page).not.toHaveURL(/\/chat\//);
		});

		test("the count button brings back the item the panel was closed on", async ({
			page,
		}) => {
			await readerWithTwoItems(page);
			await openListThenItem(page, mode.touch, ITEM_TITLES.document);
			// The phone's panel covers the header, so the panel's own X closes it there.
			await press(
				panelShell(page).locator(".workspace-close-button:visible").first(),
				mode.touch,
			);
			await expectPanelClosed(page, "the X over an item");
			await press(countButton(page), mode.touch);
			await expect(
				itemTitle(page),
				"the item comes back, not the list",
			).toHaveText(ITEM_TITLES.document, { timeout: 15_000 });

			// A Back closes through the same function: the item comes back the same way.
			await page.goBack();
			await expectPanelClosed(
				page,
				"Back over the item the count button brought back",
			);
			await press(countButton(page), mode.touch);
			await expect(
				itemTitle(page),
				"closed by a Back on the item: the item",
			).toHaveText(ITEM_TITLES.document, { timeout: 15_000 });

			// Closed from the list, it is the list that comes back.
			await press(
				panelShell(page).locator(".artifact-panel-header-crumb:visible"),
				mode.touch,
			);
			await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
			await page.goBack();
			await expectPanelClosed(page, "Back from the list");
			await press(countButton(page), mode.touch);
			await expect(
				panelList(page),
				"closed from the list: the list",
			).toBeVisible({ timeout: 15_000 });
		});
	});
}

test.describe("Escape and Back", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("Escape closes the panel and leaves no entry behind", async ({
		page,
	}) => {
		await readerWithTwoItems(page);
		await press(countButton(page), false);
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		await page.keyboard.press("Escape");
		await expectPanelClosed(page, "Escape");
		await page.goBack();
		await expect(page).not.toHaveURL(/\/chat\//);
	});

	test("after a reload with an item open, Back still closes the panel before it leaves", async ({
		page,
	}) => {
		const { chatId } = await readerWithTwoItems(page);
		await openListThenItem(page, false, ITEM_TITLES.document);
		await page.reload({ waitUntil: "networkidle" });
		await expect(itemTitle(page)).toHaveText(ITEM_TITLES.document, {
			timeout: 30_000,
		});

		// Back steps down through the layers the browser kept (the list), then closes.
		await page.goBack();
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		await page.goBack();
		await expectPanelClosed(page, "the second Back after a reload");
		await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
		await page.goBack();
		await expect(page).not.toHaveURL(/\/chat\//);
	});

	test("switching to another chat and coming back with Back finds the panel layer by layer", async ({
		page,
	}) => {
		const { user, chatId } = await readerWithTwoItems(page);
		// A second chat of the reader's, with a message so the sidebar lists it.
		const otherId = randomUUID();
		await db.insert(conversations).values({
			id: otherId,
			userId: user.id,
			title: "Another chat",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await db.insert(messages).values({
			id: `${otherId}-msg-1`,
			conversationId: otherId,
			messageSequence: 1,
			role: "user" as const,
			content: "Hello there",
			createdAt: new Date(),
		});
		await reopenChat(page, chatId);
		await openListThenItem(page, false, ITEM_TITLES.document);

		await ensureSidebarExpanded(page);
		await page
			.locator(
				`[data-testid="conversation-item"][data-conversation-id="${otherId}"]`,
			)
			.click();
		await expect(page).toHaveURL(new RegExp(`/chat/${otherId}$`));
		// The other chat made nothing: no count button, and no panel of its own.
		await expect(panelShell(page)).toBeHidden();
		await expect(panelList(page)).toBeHidden();

		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
		await expect(
			itemTitle(page),
			"Back finds this chat's panel on the item",
		).toHaveText(ITEM_TITLES.document, { timeout: 15_000 });
		await page.goBack();
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		await page.goBack();
		await expectPanelClosed(page, "the third Back");
		await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
	});
});
