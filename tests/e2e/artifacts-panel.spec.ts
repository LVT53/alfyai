import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import { createConversation, login } from "./helpers";

// Surfaces 1-3 of the artifact-surfaces mockup: the chat header's quiet
// count button, the panel opening on its "what this chat made" list, and a
// File open through the panel.
//
// IMPORTANT — what this spec does NOT cover: there is no E2E fixture for a
// tool-call turn (`tests/e2e/helpers.ts`'s `buildAiSdkUiStreamBody` only
// scripts text deltas), so a produced file here is seeded directly through
// `db`, the way `conversation-title-refresh.spec.ts` and
// `home-projects.spec.ts` already seed their own rows. This proves the
// panel/count-button surface renders correctly from the conversation detail
// payload; it does NOT exercise `produce_file` itself or the tool-call
// stream path that would normally create these rows. A future spec with a
// scriptable tool-call stream fixture would be the one to cover that.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

/**
 * One produced file: an assistant message, its `chat_generated_files` row,
 * and the `artifacts` row (`type: "generated_output"`) that
 * `listArtifactsForConversation` finds through the file-production read
 * model's existing `originalChatFileId` link — the same join a real
 * produced file is found through, not a second one invented for this spec.
 */
async function seedProducedFile(
	conversationId: string,
	filename = "Vienna trip summary.pdf",
): Promise<void> {
	const userId = await testUserId();
	const assistantMessageId = randomUUID();
	const chatFileId = randomUUID();
	const artifactId = randomUUID();

	await db.insert(messages).values({
		id: assistantMessageId,
		conversationId,
		role: "assistant",
		content: "Here is the summary.",
	});
	await db.insert(chatGeneratedFiles).values({
		id: chatFileId,
		conversationId,
		assistantMessageId,
		userId,
		filename,
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
		name: filename,
		mimeType: "application/pdf",
		metadataJson: JSON.stringify({ originalChatFileId: chatFileId }),
	});
}

async function openChatAndReload(page: Page, conversationId: string) {
	// createConversation() sends the first message through the real composer
	// flow, which stores a "pending message" in sessionStorage for the chat
	// page to consume on mount and clears it once consumed. In this
	// environment the model backend is unreachable, so that first send
	// never completes — leaving the flag set. `+page.ts`'s load reads it
	// (hasPendingConversationMessage) to choose the cheap "bootstrap" view
	// over "full", so a reload while it is still set would silently see an
	// empty artifacts list forever. Clearing it directly is more reliable
	// than racing the client-side consume-on-mount logic.
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	// A real reload, not `page.goto` to the URL the page is already on: a
	// same-URL `goto` can be satisfied from SvelteKit's client-side router
	// cache instead of re-running `load`.
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

test.describe("the chat header's artifact count button and panel", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("renders no count button in a chat that has made nothing", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Just a plain question, nothing produced",
		);
		await openChatAndReload(page, conversationId);

		await expect(page.getByTestId("artifact-count-button")).toHaveCount(0);
		await expect(page.getByTestId("artifact-count-button-compact")).toHaveCount(
			0,
		);
	});

	test("shows the count and opens the panel on the list with the File row visible", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a trip summary",
		);
		await seedProducedFile(conversationId);
		await openChatAndReload(page, conversationId);

		const countButton = page.getByTestId("artifact-count-button");
		await expect(countButton).toBeVisible();
		await expect(countButton).toContainText("1");
		// Item 10 of the client review: the button reflects the open panel.
		await expect(countButton).toHaveAttribute("aria-pressed", "false");

		await countButton.click();

		await expect(page.getByTestId("artifact-panel-list")).toBeVisible();
		await expect(
			page
				.getByTestId("artifact-panel-list")
				.getByText("Vienna trip summary.pdf"),
		).toBeVisible();
		await expect(countButton).toHaveAttribute("aria-pressed", "true");
	});

	test("opens the File's preview from the list, and closing returns to the chat", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a trip summary",
		);
		await seedProducedFile(conversationId);
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button").click();
		// Each row is an ArtifactCard (chrome="full", Task S6): the title is
		// plain text, and Open is the row's one clickable affordance.
		await page
			.getByTestId("artifact-panel-list")
			.getByRole("button", { name: "Open" })
			.click();

		const shell = page.getByRole("complementary", {
			name: "Document workspace",
		});
		await expect(shell).toBeVisible();
		await expect(shell.getByTestId("page-scroll-container")).toBeVisible();

		await shell
			.getByRole("button", { name: "Close document workspace" })
			.click();

		await expect(shell).not.toBeVisible();
		// The chat surface — composer and message area — is untouched.
		await expect(page.getByTestId("message-input")).toBeVisible();
	});

	test("returns focus to the count button when the panel closes, not to the page body", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Make me a trip summary",
		);
		await seedProducedFile(conversationId);
		await openChatAndReload(page, conversationId);

		const countButton = page.getByTestId("artifact-count-button");
		await countButton.click();
		await page
			.getByTestId("artifact-panel-list")
			.getByRole("button", { name: "Open" })
			.click();
		await expect(page.getByTestId("page-scroll-container")).toBeVisible();

		await page
			.getByRole("button", { name: "Close document workspace" })
			.click();
		await expect(page.getByTestId("page-scroll-container")).not.toBeVisible();

		// A keyboard user who closes the panel from its own × must land
		// somewhere useful — the opener that is still on screen — rather than
		// falling back to <body>, which strands them at the top of the page.
		await expect(countButton).toBeFocused();
	});

	test("at 390x844 the button is reachable without scrolling and the panel opens with no horizontal overflow", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(
			page,
			"Make me a trip summary",
		);
		await seedProducedFile(conversationId);
		await openChatAndReload(page, conversationId);

		const compactButton = page.getByTestId("artifact-count-button-compact");
		await expect(compactButton).toBeVisible();
		const box = await compactButton.boundingBox();
		expect(box).not.toBeNull();
		// Reachable without scrolling: within the viewport already, no page
		// scroll needed to bring it into view.
		expect(box?.y).toBeGreaterThanOrEqual(0);
		expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(844);

		await expect(compactButton).toHaveAttribute("aria-pressed", "false");
		await compactButton.click();
		// Below `md`, the mobile backdrop shell renders the list, not the
		// desktop aside (its own, distinct test id — see the count button's
		// own comment above for why the two shells need separate ids).
		await expect(page.getByTestId("artifact-panel-list-mobile")).toBeVisible();
		// Item 10 of the client review: the compact button reflects the open
		// panel too.
		await expect(compactButton).toHaveAttribute("aria-pressed", "true");

		const hasHorizontalOverflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		);
		expect(hasHorizontalOverflow).toBe(false);
	});
});
