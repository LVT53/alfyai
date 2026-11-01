import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { createEmptyConversation, login } from "./helpers";

// The chat's type (the approved refresh): replies, the person's own message and
// the composer are set in Nimbus Sans, 14px on a desktop and 15px on a phone
// (the composer stays 16px there so iOS does not zoom on focus), and nothing in
// the message list is set in the Documents serif. Inline code carries no
// literal backticks.

const REPLY = [
	"## Mit érdemes megnézni először",
	"",
	"A Balaton északi partja három dologért jó: a **borvidékekért**, a kis falvakért és azért, mert ősszel szinte üres.",
	"",
	"> A szezon utáni hetekben a szállások ára gyakran a felére esik.",
	"",
	"- Tihany: az apátság és a Belső-tó körüli séta.",
	"- Badacsony: a kilátó, utána egy könnyű ebéd.",
	"",
	"Ha vonattal mennél, a `MÁV` menetrendje hétvégén ritkább.",
].join("\n");

async function seedChat(page: Page): Promise<string> {
	const conversationId = await createEmptyConversation(page, "Chat type");
	const base = Date.now() - 60_000;
	await db.insert(messages).values([
		{
			id: randomUUID(),
			conversationId,
			messageSequence: 1,
			role: "user" as const,
			content: "Tervezz nekem egy hétvégét a Balatonra.",
			createdAt: new Date(base),
		},
		{
			id: randomUUID(),
			conversationId,
			messageSequence: 2,
			role: "assistant" as const,
			content: REPLY,
			createdAt: new Date(base + 30_000),
		},
	]);
	return conversationId;
}

async function open(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("assistant-message").first()).toBeVisible();
	await expect(
		page.locator(".prose-container .prose code").first(),
	).toBeVisible();
}

type Style = { family: string; size: string; leading: string };

function styleOf(page: Page, selector: string): Promise<Style> {
	return page
		.locator(selector)
		.first()
		.evaluate((node) => {
			const style = getComputedStyle(node);
			return {
				family: style.fontFamily,
				size: style.fontSize,
				leading: style.lineHeight,
			};
		});
}

test.describe("Chat type", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("desktop: sans at 14px, nothing in the list is the serif, no backticks", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1180, height: 900 });
		await open(page, await seedChat(page));

		const user = await styleOf(
			page,
			'[data-testid="user-message"] .whitespace-pre-wrap',
		);
		expect(user.family).toContain("Nimbus Sans L");
		expect(user.size).toBe("14px");
		expect(user.leading).toBe("22.4px");

		const reply = await styleOf(page, ".prose-container .prose p");
		expect(reply.family).toContain("Nimbus Sans L");
		expect(reply.size).toBe("14px");
		expect(reply.leading).toBe("22.4px");

		const composer = await styleOf(page, '[data-testid="message-input"]');
		expect(composer.family).toContain("Nimbus Sans L");
		expect(composer.size).toBe("14px");
		expect(composer.leading).toBe("21px");

		// Headings sit close to the body size: h2 is 1.18em, not the plugin's 1.5em.
		const heading = await styleOf(page, ".prose-container .prose h2");
		expect(heading.size).toBe("16.52px");

		const serifInList = await page
			.locator(".message-area-surface, .message-area-surface *")
			.evaluateAll(
				(nodes) =>
					nodes.filter((node) =>
						getComputedStyle(node).fontFamily.includes("Libre Baskerville"),
					).length,
			);
		expect(serifInList).toBe(0);

		const backtick = await page
			.locator(".prose-container .prose code")
			.first()
			.evaluate((node) => ({
				before: getComputedStyle(node, "::before").content,
				after: getComputedStyle(node, "::after").content,
			}));
		expect(backtick).toEqual({ before: "none", after: "none" });
	});

	test("phone: replies and the person's message are 15px, the composer stays 16px", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page, await seedChat(page));

		const user = await styleOf(
			page,
			'[data-testid="user-message"] .whitespace-pre-wrap',
		);
		expect(user.family).toContain("Nimbus Sans L");
		expect(user.size).toBe("15px");
		expect(user.leading).toBe("24px");

		const reply = await styleOf(page, ".prose-container .prose p");
		expect(reply.family).toContain("Nimbus Sans L");
		expect(reply.size).toBe("15px");
		expect(reply.leading).toBe("24px");

		const inlineCode = await styleOf(page, ".prose-container .prose code");
		expect(inlineCode.size).toBe("13px");

		const composer = await styleOf(page, '[data-testid="message-input"]');
		expect(composer.family).toContain("Nimbus Sans L");
		expect(composer.size).toBe("16px");
		expect(composer.leading).toBe("24px");
	});
});
