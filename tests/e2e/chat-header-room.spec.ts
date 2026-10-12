import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import {
	createTourUser,
	markToursSeen,
	openItem,
	panelShell,
	seedItem,
} from "./artifact-tours-helpers";
import { login, waitForMotionToSettle } from "./helpers";

// FX-1 item 4 (RC-A new #5): beside a docked panel the chat column is 320-420 px,
// and the header's title ("Bécsi hétvége / Bécsi szombati programtippek") ran under
// the count chip in a project chat: 0, 11 and 26 px at 1440, 1280 and 1100. (FB-3's
// check measured the project crumb, which stops short; the title's end is what ran
// under.)
//
// Real clicks open the panel and the item; what is measured is where the browser
// put the words. In Hungarian, the owner's language and the longer text.

const PROJECT_NAME = "Bécsi hétvége";
const CHAT_TITLE = "Bécsi szombati programtippek";
const LONG_ITEM_TITLE = "Bécsi hétvégi útiterv — szombat és vasárnap";

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("nothing on screen to measure");
	return box;
}

/** A Hungarian reader in a chat of a project, with one long-named item made in it. */
async function readerWithItem(
	page: Page,
	kind: "document" | "app",
	title: string,
) {
	const user = await createTourUser("hu");
	await markToursSeen(user);
	const project = await createProject(user.id, PROJECT_NAME);
	const chatId = randomUUID();
	await db.insert(conversations).values({
		id: chatId,
		userId: user.id,
		title: CHAT_TITLE,
		projectId: project.id,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	await seedItem(user, chatId, kind, { title });
	await login(page, user.email, user.password);
	await page.goto(`/chat/${chatId}`, { waitUntil: "networkidle" });
	await openItem(page, title);
	await expect(panelShell(page)).toBeVisible();
	await waitForMotionToSettle(page);
	await page.waitForTimeout(400);
	return { user, chatId };
}

test.describe("the chat header beside a docked panel", () => {
	for (const width of [1100, 1280, 1440]) {
		test(`the header's title stops short of the count chip in a project chat (${width} px)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await readerWithItem(page, "document", LONG_ITEM_TITLE);

			const title = await boxOf(page.locator("h1:has(.chat-title-main)"));
			const count = await boxOf(page.getByTestId("artifact-count-button"));
			expect(
				title.x + title.width,
				`the title (right edge ${Math.round(title.x + title.width)}) runs under the count chip (left edge ${Math.round(count.x)})`,
			).toBeLessThanOrEqual(count.x);
			// What is left of the title is still a title: the project, a slash and some of the chat's name.
			expect(title.width).toBeGreaterThan(120);
			await expect(page.getByTestId("chat-title-project-link")).toBeVisible();
		});
	}
});
