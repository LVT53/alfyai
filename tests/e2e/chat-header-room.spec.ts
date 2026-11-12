import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations, messages } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import {
	createTourUser,
	markToursSeen,
	openItem,
	panelList,
	panelShell,
	seedItem,
} from "./artifact-tours-helpers";
import { login, waitForMotionToSettle } from "./helpers";

// FX-1 items 4 and 7 (RC-A new #5 and the crowded-label sweep): beside a docked
// panel the chat column is 320-420 px, and two of its lines were wider than that.
//
// - The header's title ("Bécsi hétvége / Bécsi szombati programtippek") ran under
//   the count chip in a project chat: 0, 4 and 19 px at 1440, 1280 and 1100 (a
//   check of the project crumb alone, which stops short, had passed).
// - The composer's placeholder, "Kérdezz erről: <long title>", wrapped to two lines.
//
// Real clicks open the panel and the item; what is measured is where the browser
// put the words. In Hungarian, the owner's language and the longer text.

const PROJECT_NAME = "Bécsi hétvége";
const CHAT_TITLE = "Bécsi szombati programtippek";
const LONG_ITEM_TITLE = "Bécsi hétvégi útiterv — szombat és vasárnap";
const LONG_APP_TITLE = "Borravaló-kalkulátor és számlafelosztó Bécsbe";

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
	options: { openPanel?: boolean; turns?: number } = {},
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
	if (options.turns) await seedTurns(chatId, options.turns);
	await login(page, user.email, user.password);
	await page.goto(`/chat/${chatId}`, { waitUntil: "networkidle" });
	if (options.openPanel !== false) {
		await openItem(page, title);
		await expect(panelShell(page)).toBeVisible();
		await waitForMotionToSettle(page);
		await page.waitForTimeout(400);
	}
	return { user, chatId };
}

/** A thread long enough for the Chat Scroller's capsule to appear. */
async function seedTurns(conversationId: string, turns: number) {
	const base = Date.now() - turns * 120_000;
	const rows = [];
	for (let turn = 1; turn <= turns; turn += 1) {
		rows.push(
			{
				id: randomUUID(),
				conversationId,
				messageSequence: turn * 2 - 1,
				role: "user" as const,
				content: `Kérdés ${turn} a bécsi hétvégéről`,
				createdAt: new Date(base + turn * 120_000),
			},
			{
				id: randomUUID(),
				conversationId,
				messageSequence: turn * 2,
				role: "assistant" as const,
				content: [
					`Válasz ${turn}. A bécsi hétvége három dolgot jelent: a naschmarkti reggelit, a szecessziós épületeket és a kávéházakat.`,
					"Egy hétvége elég a belvárosra, ha korán indulsz és laza a terv.",
					"Szállás a szezon után körülbelül a felébe kerül, és a legtöbb étterem még nyitva van.",
				].join("\n\n"),
				createdAt: new Date(base + turn * 120_000 + 30_000),
			},
		);
	}
	await db.insert(messages).values(rows);
}

/** What the composer's placeholder is, and how wide it is next to the room the field gives it. */
async function placeholderFit(page: Page) {
	return page.evaluate(() => {
		const field = document.querySelector(
			'[data-testid="message-input"]',
		) as HTMLTextAreaElement;
		const style = getComputedStyle(field, "::placeholder");
		const context = document.createElement("canvas").getContext("2d");
		if (!context) throw new Error("no canvas");
		context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		const own = getComputedStyle(field);
		return {
			text: field.placeholder,
			width: context.measureText(field.placeholder).width,
			room:
				field.clientWidth -
				Number.parseFloat(own.paddingLeft) -
				Number.parseFloat(own.paddingRight),
		};
	});
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

test.describe("the composer beside a docked panel", () => {
	for (const width of [1100, 1280, 1440]) {
		test(`the placeholder is one line, and still names the item (${width} px)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await readerWithItem(page, "document", LONG_ITEM_TITLE);

			const fit = await placeholderFit(page);
			expect(fit.text).toMatch(/^Kérdezz erről: Bécsi/);
			expect(
				fit.width,
				`"${fit.text}" is ${Math.round(fit.width)} px in a field that gives it ${Math.round(fit.room)}`,
			).toBeLessThanOrEqual(fit.room);
		});
	}

	test("an App's placeholder says in a few words what to ask, and fits as well", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await readerWithItem(page, "app", LONG_APP_TITLE);

		const fit = await placeholderFit(page);
		expect(fit.text).toMatch(/^Kérj módosítást: Borravaló/);
		expect(fit.width).toBeLessThanOrEqual(fit.room);
	});

	test("a short title is the whole title, not cut", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await readerWithItem(page, "document", "Útiterv");

		const fit = await placeholderFit(page);
		expect(fit.text).toBe("Kérdezz erről: Útiterv");
	});
});

/** Resolves once the thread has stopped changing height (fonts, late rows). */
async function waitForThreadToSettle(page: Page) {
	let last = -1;
	let unchanged = 0;
	await expect
		.poll(
			async () => {
				const height = await page.evaluate(
					() => document.querySelector(".scroll-container")?.scrollHeight ?? 0,
				);
				unchanged = height === last ? unchanged + 1 : 0;
				last = height;
				return unchanged;
			},
			{ intervals: [200], timeout: 15_000 },
		)
		.toBeGreaterThanOrEqual(3);
}

// W6 — below the phone breakpoint the artifact counter leaves the header row
// and becomes a floating pill in the jump-to-latest controls' corner: the
// capsule, or the round button, above the composer. These are the two portrait
// sizes the owner named, measured on the real rendered page: the target is at
// least 44x44, it never sits over the composer or the capsule, it keeps the
// header button's accessible name, it opens the same list, and it leaves while
// the panel covers the chat. Above the breakpoint nothing moves.
test.describe("the phone's artifact counter", () => {
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
	] as const) {
		test(`is a 44 px floating pill above the composer (${viewport.width}x${viewport.height})`, async ({
			page,
		}) => {
			await page.setViewportSize(viewport);
			await readerWithItem(page, "document", LONG_ITEM_TITLE, {
				openPanel: false,
			});
			await waitForThreadToSettle(page);

			// The owner's case: the composer is focused (as when the person is
			// about to type) and the pill must still be out of its way.
			await page.getByTestId("message-input").click();

			const pill = page.getByTestId("artifact-count-button-compact");
			await expect(pill).toBeVisible();
			const box = await boxOf(pill);
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);

			// Its own corner, not the header row: floating at the top of the chat,
			// below the app's header and above the composer (owner, 2026-11-12:
			// the reader's old top position, only floating now).
			const composer = await boxOf(page.locator(".composer-shell"));
			expect(
				box.y + box.height,
				"the pill must sit above the composer",
			).toBeLessThanOrEqual(composer.y);
			const header = await boxOf(page.locator("header.header-bar"));
			expect(
				box.y,
				"the pill must sit below the app header",
			).toBeGreaterThanOrEqual(header.y + header.height);
			expect(
				box.y - (header.y + header.height),
				"the pill floats at the top of the chat, not down by the composer",
			).toBeLessThanOrEqual(24);

			// Same counters as the header's button, which is not drawn here.
			const headerButton = page.getByTestId("artifact-count-button");
			await expect(headerButton).toBeHidden();
			expect(await pill.getAttribute("aria-label")).toBe(
				await headerButton.getAttribute("aria-label"),
			);
			await expect(page.getByTestId("artifact-counter-pill")).toHaveCount(1);
		});
	}

	test("opens the same list, and leaves while the panel is open", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await readerWithItem(page, "document", LONG_ITEM_TITLE, {
			openPanel: false,
		});
		await waitForThreadToSettle(page);

		await page.getByTestId("artifact-count-button-compact").click();
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		const pill = page.getByTestId("artifact-counter-pill");
		await expect(
			pill,
			"the panel covers the chat: the pill must not float over it",
		).toBeHidden();
		// It stays mounted while hidden: other surfaces read the compact button's
		// aria-pressed to tell that the panel is already open.
		await expect(
			page.getByTestId("artifact-count-button-compact"),
		).toHaveAttribute("aria-pressed", "true");
	});

	test("floats at the top while the jump capsule holds the bottom", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await readerWithItem(page, "document", LONG_ITEM_TITLE, {
			openPanel: false,
			turns: 8,
		});
		await expect(page.getByTestId("assistant-message").first()).toBeVisible({
			timeout: 15_000,
		});
		await waitForThreadToSettle(page);

		// Leave the bottom, so the capsule takes the jump controls' corner.
		await page.evaluate(() => {
			const scroller = document.querySelector<HTMLElement>(".scroll-container");
			if (!scroller) throw new Error("The thread is not mounted.");
			scroller.scrollTop =
				(scroller.scrollHeight - scroller.clientHeight) * 0.5;
		});
		const capsule = page.getByTestId("jump-rail-capsule");
		await expect(capsule).toBeVisible();

		const pillBox = await boxOf(page.getByTestId("artifact-counter-pill"));
		const capsuleBox = await boxOf(capsule);
		// The owner's split: the counter stays in the reader's top corner while
		// the jump controls hold the bottom one, so the two never compete.
		expect(
			pillBox.y + pillBox.height,
			"the pill stays at the top, clear of the jump capsule",
		).toBeLessThanOrEqual(capsuleBox.y);
		const header = await boxOf(page.locator("header.header-bar"));
		expect(
			pillBox.y - (header.y + header.height),
			"the pill floats at the top of the chat",
		).toBeLessThanOrEqual(24);
		const composer = await boxOf(page.locator(".composer-shell"));
		expect(capsuleBox.y + capsuleBox.height).toBeLessThanOrEqual(composer.y);
	});

	test("above the breakpoint the header's counter is unchanged and the pill is not drawn", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await readerWithItem(page, "document", LONG_ITEM_TITLE, {
			openPanel: false,
		});
		await waitForThreadToSettle(page);

		await expect(page.getByTestId("artifact-count-button")).toBeVisible();
		await expect(page.getByTestId("artifact-counter-pill")).toBeHidden();
		await expect(
			page.getByTestId("artifact-count-button-compact"),
		).toBeHidden();
	});
});
