import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import { openBoard } from "./artifact-canvas-helpers";
import {
	openDocument,
	PROSE_MARKDOWN,
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import { createTourUser, markToursSeen } from "./artifact-tours-helpers";
import {
	createEmptyConversation,
	ensureSidebarExpanded,
	login,
	waitForMotionToSettle,
} from "./helpers";

/**
 * FB-9 (ruling 77 and its amendments): the owner's own finds on a phone. Real
 * touch at the widths a phone has (390, 360, and 430 for the large ones), in
 * Hungarian, where a label is longest.
 */

const PHONE_WIDTHS = [390, 360, 430] as const;

const SHOTS =
	"/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/f7d2fd3b-f0d9-4b30-80c5-6cbea0e7a6a4/scratchpad/p5/fb9-shots";

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

/**
 * A keyboard chord is "plain wasted space" on a touch screen (ruling 77's
 * amendment): where the primary pointer is a finger no button, tooltip or hint
 * writes one, and the shortcuts and their `aria-keyshortcuts` stay. A desktop
 * with a mouse is unchanged. `keyboard-shortcuts.ts` is the one rule.
 */
const CHORD = /Ctrl|⌘|⌥|⇧|Cmd\+/;

/** Every tooltip and accessible name under a surface that writes a keyboard chord. */
async function chordsWrittenUnder(root: Locator): Promise<string[]> {
	return root.evaluate((element, source) => {
		const chord = new RegExp(source);
		const found: string[] = [];
		for (const node of element.querySelectorAll("[title], [aria-label]")) {
			for (const name of ["title", "aria-label"]) {
				const value = node.getAttribute(name);
				if (value && chord.test(value)) found.push(`${name}="${value}"`);
			}
		}
		return found;
	}, CHORD.source);
}

test.describe("no keyboard chord on a touch screen (390 px, touch)", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test("the sidebar's search chip, the search legend and the composer's slash hint are gone", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Touch hints");
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(page.getByTestId("slash-shortcut-hint")).toHaveCount(0);

		await page.getByRole("button", { name: "Toggle sidebar" }).tap();
		const sidebar = page.locator("aside.sidebar-panel");
		await expect(sidebar).toBeVisible();
		await waitForMotionToSettle(page);
		const searchPill = sidebar.getByRole("button", {
			name: "Search conversations",
		});
		await expect(searchPill).toBeVisible();
		await expect(sidebar.getByTestId("search-shortcut-hint")).toBeHidden();

		await searchPill.tap();
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible();
		await expect(modal.locator(".search-kbd")).toHaveCount(0);
		await expect(modal.locator(".search-modal-footer")).toHaveCount(0);
	});

	test("the Document's toolbar names its Undo without keys, and keeps them for assistive technology", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Touch doc");
		await seedDocument(conversationId, {
			markdown: PROSE_MARKDOWN,
			pendingOps: 1,
		});
		const shell = await openDocument(page, conversationId);
		const toolbar = shell.getByRole("toolbar", { name: "Document" });
		const undo = toolbar.getByRole("button", { name: "Undo" });
		await expect(undo).toHaveAttribute("title", "Undo");
		await expect(undo).toHaveAttribute("aria-keyshortcuts", /Z/);
		expect(await chordsWrittenUnder(shell)).toEqual([]);
	});

	test("the board's toolbar and selection pill name no keys either", async ({
		page,
	}) => {
		await openBoard(page, "Touch board");
		const undo = page.getByTestId("canvas-undo");
		await expect(undo).toHaveAttribute("title", "Undo your last step");
		await expect(undo).toHaveAttribute("aria-keyshortcuts", /Z/);
		await page.locator('.svelte-flow__node[data-id="note-1"]').tap();
		const pill = page.getByTestId("canvas-selection-pill");
		await expect(pill).toBeVisible();
		await expect(page.getByTestId("canvas-selection-ask")).toHaveAttribute(
			"aria-keyshortcuts",
			/Alt\+A/,
		);
		expect(await chordsWrittenUnder(pill)).toEqual([]);
		expect(
			await chordsWrittenUnder(page.getByTestId("canvas-toolbar")),
		).toEqual([]);
	});
});

test.describe("keyboard chords stay on a desktop with a mouse", () => {
	test("the sidebar's chip, the search legend, the toolbar's and the pill's tooltips", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await openBoard(page, "Desktop board");
		await expect(page.getByTestId("canvas-undo")).toHaveAttribute(
			"title",
			/^Undo your last step \((Ctrl\+Z|⌘Z)\)$/,
		);
		await page.locator('.svelte-flow__node[data-id="note-1"]').click();
		await expect(page.getByTestId("canvas-selection-ask")).toHaveAttribute(
			"title",
			/^Ask Alfy \((Ctrl\+Alt\+A|⌥⌘A)\)$/,
		);
		await ensureSidebarExpanded(page);
		await expect(page.getByTestId("search-shortcut-hint")).toBeVisible();
		await page.getByRole("button", { name: "Search conversations" }).click();
		const modal = page.getByRole("dialog");
		await expect(modal.locator(".search-kbd").first()).toBeVisible();
	});
});

/**
 * FB-6 made the phone's review bar one row with two short words; in Hungarian
 * "Megtart" / "Visszavon" read as clipped verb stems (ruling 77's amendment: short,
 * natural Hungarian that does not crowd a row). The words are the pills' own.
 */
for (const [width, height, pendingOps] of [
	[390, 844, 1],
	[390, 844, 2],
	[360, 740, 2],
] as const) {
	test.describe(`the review bar on a phone, ${width} px, ${pendingOps} pending (Hungarian, touch)`, () => {
		test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });
		test.beforeEach(async ({ page }) => {
			await setUiLanguage("hu");
			await login(page);
		});
		test.afterEach(async () => {
			await setUiLanguage("en");
		});

		test("the two buttons say whole words, and the bar stays one row", async ({
			page,
		}) => {
			const conversationId = await createEmptyConversation(page, "Bar words");
			await seedDocument(conversationId, {
				markdown: PROSE_MARKDOWN,
				title: "Bécsi utazás",
				pendingOps,
			});
			const shell = await openDocument(page, conversationId);
			const bar = shell.getByRole("region", { name: "Alfy módosításai" });
			await expect(bar).toBeVisible({ timeout: 30_000 });
			await waitForMotionToSettle(page);

			// The accessible names do not change; the visible words are the pills' own.
			const keep = bar.getByRole("button", { name: "Mindet megtartom" });
			const undo = bar.getByRole("button", { name: "Mindet visszavonom" });
			await expect(keep).toHaveText("Megtartom", { useInnerText: true });
			await expect(undo).toHaveText("Visszavonom", { useInnerText: true });

			// Whole: the word fits inside its button, the button inside the bar.
			const barBox = await boxOf(bar);
			for (const [name, button] of [
				["keep", keep],
				["undo", undo],
			] as const) {
				const fits = await button.evaluate(
					(el) => el.scrollWidth <= el.clientWidth + 1,
				);
				expect(fits, `${name}'s word fits its button`).toBe(true);
				const b = await boxOf(button);
				expect(b.x, `${name} inside on the left`).toBeGreaterThanOrEqual(
					barBox.x,
				);
				expect(
					b.x + b.width,
					`${name} inside on the right`,
				).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
				expect(b.height, `${name} is a finger's size`).toBeGreaterThanOrEqual(
					43.5,
				);
			}
			// One row, and the stepper (with several changes) shares it.
			expect(barBox.height, "one row").toBeLessThanOrEqual(64);
			if (pendingOps > 1) {
				await expect(bar.getByText("1 / 2")).toBeVisible();
			}
			await page.screenshot({
				path: `${SHOTS}/review-bar-${width}-${pendingOps}.png`,
				clip: { x: 0, y: barBox.y - 6, width, height: barBox.height + 12 },
			});
		});
	});
}
