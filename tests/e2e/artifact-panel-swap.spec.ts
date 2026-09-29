import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	messages,
} from "../../src/lib/server/db/schema";
import { runReadArtifactTool } from "../../src/lib/server/services/normal-chat-tools/artifact-tools/read";
import {
	AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_EDIT_ARTIFACT_MARKER,
	encodeEditArtifactScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	seedDocument,
	setUiLanguage,
	testUserId,
} from "./artifact-document-polish-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
	createConversation,
	login,
	sendMessage,
	workspacePanel,
} from "./helpers";

// The panel builds a body for the open item, and builds it again whenever the
// item is opened again or another one is opened in its place (final polish
// re-check, rd/recheck2.md).
//
// D1: swap the item the panel shows — a chat card to another card, a list row
// to another row, a Document to an App and back — and the header lost its
// Comments toggle, its Download popover and its Versions button until a reload.
// The header's controls belong to the body that is mounted for the open item,
// and every item the panel shows, in whatever order, has to get them.
//
// D2: an Alfy edit that lands while a Document is open is applied once, by the
// body that is mounted for it. A body built afterwards restores what the server
// holds (the review state, ruling 61) and nothing else: the change used to be
// replayed on top of that on every later re-open, so it counted twice, survived
// Undo, and came back as pending after Keep.

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

	// The phone shell mounts the body at its own site in the workspace, with the
	// same header actions.
	test("on a phone, a second Document opened from the list has its header controls too", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await setUiLanguage("en");
		await login(page);
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Panel swap phone");
		await seedDocument(conversationId, {
			markdown: "First.\n\nSecond.",
			title: "Alpha",
		});
		await seedDocument(conversationId, {
			markdown: "Third.\n\nFourth.",
			title: "Beta",
		});
		await openChat(page, conversationId);

		const shell = page.getByTestId("document-workspace-mobile-shell");
		const list = page.getByTestId("artifact-panel-list-mobile");
		const expectControls = async (title: string, label: string) => {
			await expect(
				shell.getByRole("heading", { name: title }),
				`${label}: the panel is on ${title}`,
			).toBeVisible({ timeout: 30_000 });
			await expect(
				shell.locator(".document-editor-host .ProseMirror"),
				`${label}: ${title}'s text`,
			).toBeVisible({ timeout: 30_000 });
			for (const [name, control] of [
				["the Comments toggle", shell.getByTestId("artifact-comments-button")],
				["the Download button", shell.getByTestId("artifact-download-button")],
				[
					"the Versions button",
					shell.locator('button[data-testid="artifact-version-pill"]'),
				],
			] as const) {
				await expect(control, `${label}: ${name}`).toBeVisible({
					timeout: 15_000,
				});
			}
		};

		await page.getByTestId("artifact-count-button-compact").click();
		await list.getByRole("button", { name: /^Alpha, Document/ }).click();
		await expectControls("Alpha", "the first Document");

		await shell.locator(".artifact-panel-header-crumb").click();
		await expect(list).toBeVisible();
		await list.getByRole("button", { name: /^Beta, Document/ }).click();
		await expectControls("Beta", "the second Document");
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

// ---- D2: a live Alfy edit is applied once -----------------------------------

async function readBlocks(
	conversationId: string,
	artifactId: string,
): Promise<Array<{ blockId: string; hash: string; text: string }>> {
	const read = await runReadArtifactTool({
		userId: await testUserId(),
		conversationId,
		artifactId,
		detail: "blocks",
		abortSignal: new AbortController().signal,
	});
	return read.modelPayload.success && "blocks" in read.modelPayload
		? (read.modelPayload.blocks as Array<{
				blockId: string;
				hash: string;
				text: string;
			}>)
		: [];
}

test.describe("A live Alfy edit is applied once, however often the Document is opened again (D2)", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	/** Opens the chat with the Document already showing in the panel, so the body is mounted while Alfy's edit lands, then lets Alfy edit it (one applied block, one refused). */
	async function editWhileOpen(
		page: Page,
		conversationTitle: string,
	): Promise<{
		conversationId: string;
		artifactId: string;
		providerId: string;
		previousModelPreference: string | null;
	}> {
		await login(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		const previousModelPreference = await snapshotUserModelPreference(page);
		const conversationId = await createConversation(page, conversationTitle);
		const artifactId = await seedDocument(conversationId, {
			markdown: "Book the hotel.\n\nBook the flight.",
			title: "Trip plan",
		});
		const blocks = await readBlocks(conversationId, artifactId);
		const applyBlock = blocks.find((b) => b.text === "Book the hotel.");
		const refuseBlock = blocks.find((b) => b.text === "Book the flight.");
		expect(applyBlock, "the seeded hotel block").toBeTruthy();
		expect(refuseBlock, "the seeded flight block").toBeTruthy();

		const temporary = await createTemporaryFakeProviderModel(
			page,
			fakeProvider.baseURL,
		);
		await updateUserModelPreference(page, temporary.selectedModel);
		await openChat(page, conversationId);

		await openList(page);
		await listRow(page, /^Trip plan, Document/).click();
		await expectDocumentHeader(page, "Trip plan", "before the edit");

		await sendMessage(
			page,
			`${AI_SMOKE_EDIT_ARTIFACT_MARKER} ${encodeEditArtifactScenarioPayload({
				artifactId,
				applyBlockId: applyBlock?.blockId ?? "",
				applyBaseHash: applyBlock?.hash ?? "",
				refuseBlockId: refuseBlock?.blockId ?? "",
			})}`,
		);
		await expect(page.getByText(AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT)).toBeVisible(
			{ timeout: 30_000 },
		);
		await expect(
			page.getByRole("region", { name: "Changes from Alfy" }),
			"the live edit lands as one pending change",
		).toContainText("Alfy changed 1 part.", { timeout: 15_000 });
		return {
			conversationId,
			artifactId,
			providerId: temporary.providerId,
			previousModelPreference,
		};
	}

	test("opened again from the list and from the card the change still counts once, and Undo leaves nothing pending", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		let providerId: string | null = null;
		let previousModelPreference: string | null = null;
		try {
			const walk = await editWhileOpen(page, "Replay walk");
			providerId = walk.providerId;
			previousModelPreference = walk.previousModelPreference;
			const review = page.getByRole("region", { name: "Changes from Alfy" });
			const card = page.getByTestId("artifact-card-head");
			await expect(card).toContainText("1 change to review");

			// The list, then the Document again: the body is built anew and restores
			// the review state from the server — one change there, so one here.
			await openList(page);
			await expect(
				listRow(page, /^Trip plan, Document.*1 change to review$/),
				"the list row counts the change once",
			).toBeVisible();
			await listRow(page, /^Trip plan, Document/).click();
			await expectDocumentHeader(page, "Trip plan", "opened from the list");
			await expect(review, "opened again from the list").toContainText(
				"Alfy changed 1 part.",
			);
			await expect(card).toContainText("1 change to review");

			// Close the panel and open the Document from its card.
			await page
				.getByRole("button", { name: "Close document workspace" })
				.click();
			await expect(workspacePanel(page)).toHaveCount(0);
			await card.click();
			await expectDocumentHeader(page, "Trip plan", "opened from the card");
			await expect(review, "opened again from the card").toContainText(
				"Alfy changed 1 part.",
			);
			await expect(card).toContainText("1 change to review");

			// Undo the one change from its pill in the text: nothing is left pending,
			// here or on the card.
			await workspacePanel(page)
				.getByRole("button", { name: "Undo Alfy's change" })
				.click({ timeout: 15_000 });
			await expect(review).toHaveCount(0, { timeout: 10_000 });
			await expect(card).not.toContainText("change to review");

			await openList(page);
			await expect(
				listRow(page, /^Trip plan, Document/),
				"the list row after Undo",
			).not.toContainText("change to review");
			await listRow(page, /^Trip plan, Document/).click();
			await expectDocumentHeader(page, "Trip plan", "opened again after Undo");
			await expect(
				review,
				"the undone change does not come back as a phantom",
			).toHaveCount(0);
			await expect(card).not.toContainText("change to review");
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});

	test("a change that was Kept does not come back as pending when the Document is opened again", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		let providerId: string | null = null;
		let previousModelPreference: string | null = null;
		try {
			const walk = await editWhileOpen(page, "Replay keep walk");
			providerId = walk.providerId;
			previousModelPreference = walk.previousModelPreference;
			const review = page.getByRole("region", { name: "Changes from Alfy" });
			const card = page.getByTestId("artifact-card-head");

			await page
				.getByRole("button", { name: "Keep all" })
				.click({ timeout: 15_000 });
			await expect(review).toHaveCount(0, { timeout: 10_000 });
			await expect(card).not.toContainText("change to review");

			await openList(page);
			await listRow(page, /^Trip plan, Document/).click();
			await expectDocumentHeader(page, "Trip plan", "opened again after Keep");
			await expect(review, "the kept change is not pending again").toHaveCount(
				0,
			);
			await expect(card).not.toContainText("change to review");
			await openList(page);
			await expect(
				listRow(page, /^Trip plan, Document/),
				"the list row after Keep",
			).not.toContainText("change to review");
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});
});
