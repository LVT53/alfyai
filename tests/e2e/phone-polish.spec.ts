import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import { login, waitForMotionToSettle } from "./helpers";

/**
 * FB-9 (ruling 77 and its amendments): the owner's own finds on a phone. Real
 * touch at the widths a phone has (390, 360, and 430 for the large ones), in
 * Hungarian, where a label is longest.
 */

const PHONE_WIDTHS = [390, 360, 430] as const;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("no bounding box");
	return box;
}

function overlap(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width - 0.5 &&
		b.x < a.x + a.width - 0.5 &&
		a.y < b.y + b.height - 0.5 &&
		b.y < a.y + a.height - 0.5
	);
}

async function seedChat(
	userId: string,
	title: string,
	projectId: string | null,
	secondsAgo: number,
): Promise<string> {
	const id = randomUUID();
	const at = new Date(Date.now() - secondsAgo * 1000);
	await db.insert(conversations).values({
		id,
		userId,
		title,
		projectId,
		createdAt: at,
		updatedAt: at,
	});
	await db.insert(messages).values([
		{
			id: `${id}-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "Szia",
			createdAt: at,
		},
		{
			id: `${id}-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Szia!",
			createdAt: at,
		},
	]);
	return id;
}

async function openPhoneSidebar(page: Page) {
	await page.getByRole("button", { name: "Oldalsáv ki/bekapcsolása" }).click();
	await expect(page.locator("aside.sidebar-panel")).toBeVisible();
}

for (const width of PHONE_WIDTHS) {
	test.describe(`the sidebar on a phone, ${width} px wide (touch)`, () => {
		test.use({
			viewport: { width, height: 844 },
			hasTouch: true,
			isMobile: true,
		});

		test("the project folder's count and its buttons each have their own place, and each button takes a tap", async ({
			page,
		}) => {
			const user = await createTourUser("hu");
			await markToursSeen(user);
			const project = await createProject(user.id, "Bécsi utazás");
			const openChat = await seedChat(
				user.id,
				"Vonatok Budapestről Bécsbe",
				project.id,
				0,
			);
			await seedChat(
				user.id,
				"Szállás a belvárosban, a Ringhez közel, reggelivel együtt",
				project.id,
				1,
			);
			await seedChat(user.id, "Múzeumok és programok", project.id, 2);
			await seedChat(user.id, "Hazaút", null, 3);
			await login(page, user.email, user.password);
			await page.goto(`/chat/${openChat}`, { waitUntil: "networkidle" });
			await openPhoneSidebar(page);
			// The folder opens on a tap, so its chats sit right under it.
			const sidebar = page.locator("aside.sidebar-panel");
			await sidebar.getByText("Bécsi utazás").first().tap();
			await expect(sidebar.getByTestId("conversation-item")).toHaveCount(4);
			await waitForMotionToSettle(page);

			const count = page.getByTestId(`project-chat-count-${project.id}`);
			await expect(count).toHaveText("3");
			const projectRow = sidebar.locator(".group").filter({ has: count });
			const newChat = projectRow.getByRole("button", {
				name: /Bécsi utazás/,
			});
			const options = projectRow.getByRole("button", {
				name: "Projekt beállításai",
			});

			const countBox = await boxOf(count);
			const newChatBox = await boxOf(newChat);
			const optionsBox = await boxOf(options);
			const rowBox = await boxOf(projectRow);
			// Each has its own place: the number is not drawn over a button.
			expect(overlap(countBox, optionsBox), "count over the dots").toBe(false);
			expect(overlap(countBox, newChatBox), "count over new chat").toBe(false);
			expect(overlap(newChatBox, optionsBox), "the two buttons").toBe(false);
			// Finger-sized, and inside the row (no hit area spills onto the next one).
			for (const [name, box] of [
				["new chat", newChatBox],
				["options", optionsBox],
			] as const) {
				expect(box.width, `${name} width`).toBeGreaterThanOrEqual(43.5);
				expect(box.height, `${name} height`).toBeGreaterThanOrEqual(43.5);
				expect(box.y, `${name} top`).toBeGreaterThanOrEqual(rowBox.y - 0.5);
				expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(
					rowBox.y + rowBox.height + 0.5,
				);
			}
			// The title gives way, never the number or a button.
			const nameBox = await boxOf(projectRow.getByText("Bécsi utazás").first());
			expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(countBox.x + 0.5);

			// No two buttons of the list share a pixel: the folder's dots and the first
			// chat's dots (which sit right under it) used to share a few rows of them.
			const buttons = sidebar.locator(
				'[data-testid="conversation-item"] button, .group button',
			);
			const boxes: Box[] = [];
			for (const button of await buttons.all()) {
				if (await button.isVisible()) {
					boxes.push(await boxOf(button));
				}
			}
			expect(boxes.length).toBeGreaterThanOrEqual(6);
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					expect(overlap(boxes[i], boxes[j]), `buttons ${i} and ${j}`).toBe(
						false,
					);
				}
			}

			// A long chat title gives way to its dots, which stay whole inside the row.
			const long = sidebar
				.getByTestId("conversation-item")
				.filter({ hasText: "Szállás a belvárosban" });
			const longRow = await boxOf(long);
			const longDots = await boxOf(long.getByRole("button"));
			expect(longDots.x + longDots.width).toBeLessThanOrEqual(
				longRow.x + longRow.width + 0.5,
			);

			// A real tap on the dots opens the folder's menu.
			await page.touchscreen.tap(
				optionsBox.x + optionsBox.width / 2,
				optionsBox.y + optionsBox.height / 2,
			);
			await expect(page.locator(".project-menu")).toBeVisible();
		});
	});
}
