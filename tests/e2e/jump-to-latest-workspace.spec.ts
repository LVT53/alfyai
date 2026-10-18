import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	conversations,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import {
	createEmptyConversation,
	login,
	waitForHydration,
	waitForStableBoundingBox,
} from "./helpers";

/**
 * B2's "jump to latest" button is anchored to the message area's right edge,
 * but the composer is a centred, max-width layer. Once the artifact panel
 * narrows the chat column, the composer spans the full column and the button
 * at its right edge sat underneath the composer's textarea. The button now
 * follows the composer layer's measured height, so it stays above it at every
 * width; this test opens the panel at a desktop size and proves the button is
 * the topmost element at its own centre with a real gap above the composer.
 */

let seededConversationId: string | null = null;
let seededArtifactId: string | null = null;

test.afterAll(async () => {
	if (seededArtifactId) {
		await db.delete(artifacts).where(eq(artifacts.id, seededArtifactId));
	}
	if (seededConversationId) {
		await db
			.delete(conversations)
			.where(eq(conversations.id, seededConversationId));
	}
});

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	if (!user) throw new Error("the e2e admin must exist");
	return user.id;
}

async function seedConversationWithArtifact(page: Page): Promise<string> {
	const conversationId = await createEmptyConversation(
		page,
		"Jump to latest with the document panel open",
	);
	seededConversationId = conversationId;
	const userId = await adminId();
	const createdAt = Date.now();
	for (let index = 0; index < 30; index += 1) {
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: index + 1,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `Message ${index + 1}: a line long enough to make the thread scroll.`,
			createdAt: new Date(createdAt - (30 - index) * 60_000),
		});
	}

	const assistantMessageId = randomUUID();
	const chatFileId = randomUUID();
	const artifactId = randomUUID();
	seededArtifactId = artifactId;
	await db.insert(messages).values({
		id: assistantMessageId,
		conversationId,
		messageSequence: 31,
		role: "assistant",
		content: "Here is the document.",
		createdAt: new Date(createdAt),
	});
	await db.insert(chatGeneratedFiles).values({
		id: chatFileId,
		conversationId,
		assistantMessageId,
		userId,
		filename: "Report.pdf",
		mimeType: "application/pdf",
		sizeBytes: 2048,
		storagePath: `test/${chatFileId}.pdf`,
	});
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "generated_output",
		retrievalClass: "ephemeral_followup",
		name: "Report.pdf",
		mimeType: "application/pdf",
		metadataJson: JSON.stringify({ originalChatFileId: chatFileId }),
	});
	return conversationId;
}

async function jumpButtonClearance(page: Page): Promise<{
	gap: number;
	topmost: boolean;
}> {
	return page.evaluate(() => {
		const button = document.querySelector(
			'[data-testid="jump-to-latest-button"]',
		);
		const composer = document.querySelector(".composer-layer");
		if (
			!(button instanceof HTMLElement) ||
			!(composer instanceof HTMLElement)
		) {
			return { gap: Number.NEGATIVE_INFINITY, topmost: false };
		}
		const b = button.getBoundingClientRect();
		const c = composer.getBoundingClientRect();
		const atCenter = document.elementFromPoint(
			b.left + b.width / 2,
			b.top + b.height / 2,
		);
		return {
			gap: c.top - b.bottom,
			topmost: Boolean(atCenter && button.contains(atCenter)),
		};
	});
}

test("the jump-to-latest button stays above a full-width composer", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	const conversationId = await seedConversationWithArtifact(page);
	await page.goto(`/chat/${conversationId}`, {
		waitUntil: "domcontentloaded",
	});
	await waitForHydration(page);

	const scroll = page.locator(".scroll-container").first();
	await expect(scroll).toBeVisible();
	await scroll.evaluate((element) => {
		element.scrollTop = 0;
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	const button = page.getByTestId("jump-to-latest-button");
	await expect(button).toBeVisible();

	await page.getByTestId("artifact-count-button").click();
	await expect(page.getByTestId("artifact-panel-list")).toBeVisible();
	await waitForStableBoundingBox(button);

	const clearance = await jumpButtonClearance(page);
	expect(clearance.topmost, "the composer must not cover the button").toBe(
		true,
	);
	expect(
		clearance.gap,
		"the button must sit above the composer, not inside it",
	).toBeGreaterThanOrEqual(6);
});
