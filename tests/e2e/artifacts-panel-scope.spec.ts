import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import {
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
} from "./artifact-canvas-helpers";
import { ensureSidebarExpanded, login, workspacePanel } from "./helpers";

// A chat's panel is "what this chat made". The browser keeps ONE panel state
// for the whole tab (sessionStorage), so what a chat restores after a reload,
// or when the tab moves to another chat, has to be decided by who is asking:
//   - another chat's open items never open in this chat's panel;
//   - an incognito chat's items go nowhere else, and are not left in the tab's
//     stored state when the chat is left (docs/plans/incognito-one-way-spec.md:
//     the chat is saved and can be revisited, and nothing from it travels).
//
// Boards are seeded straight into the database, the way the Canvas specs do.

const STORED_PANEL_KEY = "alfyai-chat-document-workspace";

async function seedConversation(
	id: string,
	options: { title: string; memoryIncognito?: boolean },
): Promise<void> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId: admin.id,
		title: options.title,
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
			content: "Make me a board.",
			createdAt: now,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Here is the board.",
			createdAt: now,
		},
	]);
}

function boardWithNote(text: string): CanvasBody {
	return {
		...emptyCanvasBody(),
		nodes: [
			{
				id: "note-1",
				type: "sticky",
				position: { x: 40, y: 40 },
				width: 190,
				data: { kind: "sticky", text, tone: "yellow" },
			},
		],
	};
}

/** The item ids the tab's stored panel state holds right now. */
async function storedPanelItemIds(page: Page): Promise<string[]> {
	return page.evaluate((key) => {
		const raw = window.sessionStorage.getItem(key);
		if (!raw) return [];
		const record = JSON.parse(raw) as { documents: { id: string }[] };
		return record.documents.map((document) => document.id);
	}, STORED_PANEL_KEY);
}

async function goToChatInTheApp(page: Page, conversationId: string) {
	await ensureSidebarExpanded(page);
	await page
		.locator(
			`[data-testid="conversation-item"][data-conversation-id="${conversationId}"]`,
		)
		.click();
	await page.waitForURL(`**/chat/${conversationId}`);
	await expect(page.getByTestId("message-input")).toBeVisible();
}

test.describe("a chat's panel after a reload", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("chat B's panel, after a reload, is B's own: chat A's open board does not follow the tab", async ({
		page,
	}) => {
		const chatA = randomUUID();
		const chatB = randomUUID();
		await seedConversation(chatA, { title: "Scope chat A" });
		await seedConversation(chatB, { title: "Scope chat B" });
		await seedCanvas(chatA, boardWithNote("Only in A"), "Board of A");
		const boardB = await seedCanvas(
			chatB,
			boardWithNote("Only in B"),
			"Board of B",
		);

		// A's board is open in the panel, and the tab remembers it.
		await openChatAndReload(page, chatA);
		await openCanvasPanel(page);
		await expect(workspacePanel(page)).toHaveAccessibleName(
			"Board of A, Canvas",
		);

		// The tab goes to chat B and reloads: B has nothing open, and A's board
		// is not there.
		await openChatAndReload(page, chatB);
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(workspacePanel(page)).toHaveCount(0);
		await expect(page.getByTestId("canvas-editor")).toHaveCount(0);
		expect(await storedPanelItemIds(page)).toEqual([]);

		// B's own board opens, and that is what a reload gives back.
		await openCanvasPanel(page);
		await expect(workspacePanel(page)).toHaveAccessibleName(
			"Board of B, Canvas",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		await expect(workspacePanel(page)).toHaveAccessibleName(
			"Board of B, Canvas",
		);
		await expect(page.getByText("Board of A")).toHaveCount(0);
		expect(await storedPanelItemIds(page)).toEqual([boardB]);
	});

	test("moving from chat A to chat B inside the app does not carry A's panel along", async ({
		page,
	}) => {
		const chatA = randomUUID();
		const chatB = randomUUID();
		await seedConversation(chatA, { title: "Scope chat A" });
		await seedConversation(chatB, { title: "Scope chat B" });
		await seedCanvas(chatA, boardWithNote("Only in A"), "Board of A");
		await seedCanvas(chatB, boardWithNote("Only in B"), "Board of B");

		await openChatAndReload(page, chatA);
		await openCanvasPanel(page);

		await goToChatInTheApp(page, chatB);
		await expect(workspacePanel(page)).toHaveCount(0);
		await expect(page.getByText("Board of A")).toHaveCount(0);
		expect(await storedPanelItemIds(page)).toEqual([]);
	});

	test("an incognito chat's board reopens when that chat is reloaded, never in another chat, and is not left in the tab when the chat is left", async ({
		page,
	}) => {
		const incognitoChat = randomUUID();
		const normalChat = randomUUID();
		await seedConversation(incognitoChat, {
			title: "Scope incognito chat",
			memoryIncognito: true,
		});
		await seedConversation(normalChat, { title: "Scope normal chat" });
		const privateBoard = await seedCanvas(
			incognitoChat,
			boardWithNote("Private"),
			"Private board",
		);
		await seedCanvas(normalChat, boardWithNote("Public"), "Public board");

		// Its own reload gives the incognito chat its panel back.
		await openChatAndReload(page, incognitoChat);
		await openCanvasPanel(page);
		await expect(workspacePanel(page)).toHaveAccessibleName(
			"Private board, Canvas",
		);
		await page.reload({ waitUntil: "networkidle" });
		await openCanvasPanel(page);
		expect(await storedPanelItemIds(page)).toEqual([privateBoard]);

		// Leaving it inside the app leaves nothing of it in the stored state.
		await goToChatInTheApp(page, normalChat);
		await expect(workspacePanel(page)).toHaveCount(0);
		expect(await storedPanelItemIds(page)).toEqual([]);
	});

	test("an incognito chat's board is not restored into another chat even when the tab left it without the app noticing", async ({
		page,
	}) => {
		const incognitoChat = randomUUID();
		const normalChat = randomUUID();
		await seedConversation(incognitoChat, {
			title: "Scope incognito chat",
			memoryIncognito: true,
		});
		await seedConversation(normalChat, { title: "Scope normal chat" });
		await seedCanvas(incognitoChat, boardWithNote("Private"), "Private board");
		await seedCanvas(normalChat, boardWithNote("Public"), "Public board");

		await openChatAndReload(page, incognitoChat);
		await openCanvasPanel(page);

		// A plain address-bar visit: a whole new page load, so nothing in the
		// incognito chat's page gets to tidy up first.
		await page.goto(`/chat/${normalChat}`, { waitUntil: "networkidle" });
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(workspacePanel(page)).toHaveCount(0);
		await expect(page.getByText("Private board")).toHaveCount(0);
		expect(await storedPanelItemIds(page)).toEqual([]);
	});
});
