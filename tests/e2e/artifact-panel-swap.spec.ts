import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	messages,
} from "../../src/lib/server/db/schema";
import {
	seedDocument,
	setUiLanguage,
	testUserId,
} from "./artifact-document-polish-helpers";
import { createConversation, login, workspacePanel } from "./helpers";

// Final polish re-check, D1 (rd/recheck2.md): swap the item the panel shows —
// a chat card to another card, a list row to another row, a Document to an App
// and back — and the header lost its Comments toggle, its Download popover and
// its Versions button until a reload. The header's controls belong to the body
// that is mounted for the open item, and every item the panel shows, in
// whatever order, has to get them.

async function seedApp(conversationId: string, title: string): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	const html = `<!doctype html><html><body><h1>${title}</h1></body></html>`;
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body: html,
		bodyHash: `seed-${artifactId}`,
		createdAt: now,
	});
	return artifactId;
}

/** One assistant message whose `create_artifact` calls made these Documents, the way the pipeline persists them: one chat card each. */
async function seedCreateCalls(
	conversationId: string,
	made: { id: string; title: string }[],
): Promise<void> {
	await db.insert(messages).values({
		id: randomUUID(),
		conversationId,
		messageSequence: 900,
		role: "assistant",
		content: "Made the documents.",
		toolCalls: JSON.stringify(
			made.map((item, index) => ({
				type: "tool_call",
				callId: `e2e-create-${index}`,
				name: "create_artifact",
				input: {
					artifactType: "document",
					title: item.title,
					body: `# ${item.title}\n\nBody of ${item.title}.`,
				},
				status: "done",
				outputSummary: `Created Document "${item.title}"`,
				sourceType: "tool",
				metadata: {
					ok: true,
					artifactId: item.id,
					artifactKind: "document",
					artifactTitle: item.title,
				},
			})),
		),
		createdAt: new Date(),
	});
}

async function openChat(page: Page, conversationId: string): Promise<void> {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

function listRow(page: Page, name: RegExp): Locator {
	return page.getByTestId("artifact-panel-list").getByRole("button", { name });
}

async function openList(page: Page): Promise<void> {
	const list = page.getByTestId("artifact-panel-list");
	if (await list.isVisible()) return;
	const countButton = page.getByTestId("artifact-count-button");
	if ((await countButton.getAttribute("aria-pressed")) === "true") {
		// The panel is open on an item: the breadcrumb goes back to the list.
		await page.locator(".artifact-panel-header-crumb:visible").first().click();
	} else {
		await countButton.click();
	}
	await expect(list).toBeVisible();
}

/** What the header of the open item offers: the Document's three controls, or the App's one. */
async function expectDocumentHeader(
	page: Page,
	title: string,
	label: string,
): Promise<void> {
	const panel = workspacePanel(page);
	await expect(
		page.getByRole("complementary", { name: `${title}, Document` }),
		`${label}: the panel is on ${title}`,
	).toBeVisible({ timeout: 30_000 });
	await expect(
		panel.locator(".document-editor-host .ProseMirror"),
		`${label}: ${title}'s text`,
	).toBeVisible({ timeout: 30_000 });
	await expect(
		panel.getByTestId("artifact-comments-button"),
		`${label}: the Comments toggle`,
	).toBeVisible({ timeout: 15_000 });
	await expect(
		panel.getByTestId("artifact-download-button"),
		`${label}: the Download button`,
	).toBeVisible({ timeout: 15_000 });
	// Until the body registers its Versions action the same pill is plain text.
	await expect(
		panel.locator('button[data-testid="artifact-version-pill"]'),
		`${label}: the Versions button`,
	).toBeVisible({ timeout: 15_000 });
}

/** The three controls do what they say, not just exist (the closures they call are the open body's). */
async function useHeaderControls(page: Page, label: string): Promise<void> {
	const panel = workspacePanel(page);
	const comments = panel.getByTestId("artifact-comments-button");
	const before = await comments.getAttribute("aria-pressed");
	await comments.click();
	await expect(comments, `${label}: Comments toggles`).not.toHaveAttribute(
		"aria-pressed",
		before ?? "",
	);
	await comments.click();
	await expect(comments).toHaveAttribute("aria-pressed", before ?? "");

	await panel.getByTestId("artifact-download-button").click();
	await expect(
		page.getByTestId("document-download-popover"),
		`${label}: Download opens its popover`,
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("document-download-popover")).toHaveCount(0);

	await panel.locator('button[data-testid="artifact-version-pill"]').click();
	await expect(
		page.getByTestId("document-versions-popover"),
		`${label}: Versions opens its popover`,
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("document-versions-popover")).toHaveCount(0);
}

test.describe("The panel header follows the item the panel shows (D1)", () => {
	test.afterEach(async () => {
		await setUiLanguage("en");
	});

	test("list → one Document → back → another Document → an App → a Document again: every one has its header controls", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await setUiLanguage("en");
		await login(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Panel swap");
		await seedDocument(conversationId, {
			markdown: "First.\n\nSecond.",
			title: "Alpha",
		});
		await seedDocument(conversationId, {
			markdown: "Third.\n\nFourth.",
			title: "Beta",
		});
		await seedApp(conversationId, "Gamma app");
		await openChat(page, conversationId);

		await openList(page);
		await listRow(page, /^Alpha, Document/).click();
		await expectDocumentHeader(page, "Alpha", "the first Document");
		await useHeaderControls(page, "the first Document");

		await openList(page);
		await listRow(page, /^Beta, Document/).click();
		await expectDocumentHeader(page, "Beta", "the second Document");
		await useHeaderControls(page, "the second Document");

		await openList(page);
		await listRow(page, /^Beta, Document/).click();
		await expectDocumentHeader(page, "Beta", "the same Document, opened again");

		await openList(page);
		await listRow(page, /^Gamma app, App/).click();
		const panel = workspacePanel(page);
		await expect(
			page.getByRole("complementary", { name: "Gamma app, App" }),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			panel.getByTestId("artifact-download-button"),
			"the App's own Download button",
		).toBeVisible({ timeout: 15_000 });
		await expect(
			panel.getByTestId("artifact-comments-button"),
			"an App has no comments to toggle",
		).toHaveCount(0);

		await openList(page);
		await listRow(page, /^Alpha, Document/).click();
		await expectDocumentHeader(page, "Alpha", "a Document after an App");
		await useHeaderControls(page, "a Document after an App");
	});

	test("chat card → another card, with the panel staying open: the second Document has its header controls too", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await setUiLanguage("en");
		await login(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Card swap");
		const alpha = await seedDocument(conversationId, {
			markdown: "# Alpha\n\nBody of Alpha.",
			title: "Alpha",
		});
		const beta = await seedDocument(conversationId, {
			markdown: "# Beta\n\nBody of Beta.",
			title: "Beta",
		});
		await seedCreateCalls(conversationId, [
			{ id: alpha, title: "Alpha" },
			{ id: beta, title: "Beta" },
		]);
		await openChat(page, conversationId);

		const cards = page.getByTestId("artifact-card");
		await expect(cards).toHaveCount(2);
		await cards.nth(0).getByTestId("artifact-card-head").click();
		await expectDocumentHeader(page, "Alpha", "the first card");

		await cards.nth(1).getByTestId("artifact-card-head").click();
		await expectDocumentHeader(page, "Beta", "the second card");
		await useHeaderControls(page, "the second card");

		await cards.nth(0).getByTestId("artifact-card-head").click();
		await expectDocumentHeader(page, "Alpha", "back to the first card");
		await useHeaderControls(page, "back to the first card");
	});
});
