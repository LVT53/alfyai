import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	conversations,
	fileProductionJobFiles,
	fileProductionJobs,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import {
	createDocumentArtifact,
	deleteArtifact,
} from "../../src/lib/server/services/artifacts";
import { createConversationFork } from "../../src/lib/server/services/conversation-forks";
import {
	createConversation,
	login,
	waitForHydration,
	workspacePanel,
} from "./helpers";

// Polish G2-A: Delete for what is open in the panel and for each list row,
// what a chat card or file row says once its item is gone, and Regenerate.
//
// The Document a `create_artifact` call made is seeded the way that call leaves
// it: the artifact through the same creator the tool's handler uses, and the
// message with the persisted tool-call segment (the model's own arguments and
// the call's result metadata) that Regenerate makes it again from. It is not
// driven through the fake provider on purpose: that provider chooses its
// scenario by looking for a marker anywhere in the request, and the request
// quotes earlier conversations (a task's objective), so an edit marker left by
// a spec that ran before turned this create into an edit (found in the full
// gate run). The real call was walked once, in isolation, and the persisted
// arguments are what this seeds.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

async function listItems(page: Page, conversationId: string) {
	return page.evaluate(async (id) => {
		const response = await fetch(`/api/artifacts?conversationId=${id}`);
		const body = (await response.json()) as {
			artifacts?: Array<{ id: string; title: string }>;
		};
		return body.artifacts ?? [];
	}, conversationId);
}

const CREATED_TITLE = "Weekend plan";
const CREATED_BODY = "# Weekend plan\n\nBook the museum tickets.";

test.describe("Delete and Regenerate — a Document made by create_artifact", () => {
	test("deletes the Document from the panel header, the card says so, Regenerate brings it back under the same id", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createConversation(page, "Plan a weekend");
		const uid = await testUserId();
		const made = await createDocumentArtifact({
			userId: uid,
			conversationId,
			title: CREATED_TITLE,
			markdown: CREATED_BODY,
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		// The message the pipeline persists for that call: the model's own
		// arguments, and the result metadata (`runCreateArtifactTool`'s) the card
		// is drawn from.
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: 900,
			role: "assistant",
			content: "Made the document.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: "e2e-create-call",
					name: "create_artifact",
					input: {
						artifactType: "document",
						title: CREATED_TITLE,
						body: CREATED_BODY,
					},
					status: "done",
					outputSummary: `Created Document "${CREATED_TITLE}"`,
					sourceType: "tool",
					metadata: {
						ok: true,
						artifactId: made.id,
						artifactKind: "document",
						artifactTitle: CREATED_TITLE,
					},
				},
			]),
			createdAt: new Date(),
		});
		await openChatAndReload(page, conversationId);
		const card = page.getByTestId("artifact-card");
		await expect(card).toBeVisible();
		const [listed] = await listItems(page, conversationId);
		expect(listed?.id).toBe(made.id);

		// Open it, then delete it from the header.
		await card.getByTestId("artifact-card-head").click({ timeout: 30_000 });
		const workspace = workspacePanel(page);
		await expect(workspace).toBeVisible({ timeout: 30_000 });
		await expect(workspace.getByText("Book the museum tickets.")).toBeVisible({
			timeout: 30_000,
		});
		await workspace.getByRole("button", { name: "Delete document" }).click();
		const dialog = page.getByRole("dialog", { name: "Delete this document?" });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText(CREATED_TITLE);
		// The chat kept the model's own arguments, so it can make this again: the
		// confirm says the way back, not that it cannot be undone.
		await expect(dialog).toContainText("You can regenerate it from the chat.");
		await expect(dialog).not.toContainText("can't be undone");
		await dialog.getByRole("button", { name: "Delete" }).click();

		// The only item: the panel leaves with it, the card flips, a toast says so.
		await expect(page.getByTestId("workspace-main")).toBeHidden();
		await expect(page.getByTestId("artifact-count-button")).toBeHidden();
		await expect(page.getByTestId("artifact-card")).toHaveAttribute(
			"data-state",
			"deleted",
		);
		await expect(page.getByText("This document was deleted")).toBeVisible();
		await expect(page.getByTestId("artifact-card-head")).toHaveCount(0);
		await expect(page.getByText("Document deleted")).toBeVisible();
		expect(await listItems(page, conversationId)).toEqual([]);

		// A reload keeps it deleted: the server's own answer, not page state.
		await page.reload({ waitUntil: "networkidle" });
		const cardAfterReload = page.getByTestId("artifact-card");
		await expect(cardAfterReload).toHaveAttribute("data-state", "deleted");

		// Regenerate: the same id, from the arguments the model gave.
		await cardAfterReload
			.getByRole("button", { name: `Regenerate ${CREATED_TITLE}` })
			.click();
		await expect(page.getByTestId("artifact-card-head")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByTestId("artifact-card")).not.toHaveAttribute(
			"data-state",
			"deleted",
		);
		const [again] = await listItems(page, conversationId);
		expect(again?.id).toBe(made.id);
		await page.getByTestId("artifact-card-head").click();
		await expect(
			workspacePanel(page).getByText("Book the museum tickets."),
		).toBeVisible({ timeout: 30_000 });
	});
});

/**
 * A turn that made the Document, as the app leaves it: the artifact through the
 * creator the tool's handler uses, and an assistant message carrying the call
 * that made it and the evidence the evidence step wrote after it ("Made in this
 * chat"). Sources rows are read from this, so it is seeded rather than driven
 * through the fake provider (the reason is at the top of this file); the real
 * turn's own row is checked in artifact-chat-card.spec.ts.
 */
async function seedMadeDocumentTurn(
	conversationId: string,
	uid: string,
	{ sequence = 900, title = CREATED_TITLE } = {},
) {
	const made = await createDocumentArtifact({
		userId: uid,
		conversationId,
		title,
		markdown: CREATED_BODY,
		author: "alfy",
		summary: "Alfy wrote the first draft",
	});
	const messageId = randomUUID();
	await db.insert(messages).values({
		id: messageId,
		conversationId,
		messageSequence: sequence,
		role: "assistant",
		content: "Made the document.",
		toolCalls: JSON.stringify([
			{
				type: "tool_call",
				callId: "e2e-create-call",
				name: "create_artifact",
				input: {
					artifactType: "document",
					title,
					body: CREATED_BODY,
				},
				status: "done",
				outputSummary: `Created Document "${title}"`,
				sourceType: "tool",
				metadata: {
					ok: true,
					artifactId: made.id,
					artifactKind: "document",
					artifactTitle: title,
				},
			},
		]),
		metadataJson: JSON.stringify({
			evidenceStatus: "ready",
			evidenceSummary: {
				structuredWebSearch: false,
				groups: [
					{
						sourceType: "artifact",
						label: "Made in this chat",
						reranked: false,
						items: [
							{
								id: made.id,
								title,
								sourceType: "artifact",
								status: "reference",
								artifactId: made.id,
								description: null,
								channels: ["tool"],
								metadata: { artifactKind: "document" },
							},
						],
					},
				],
			},
		}),
		createdAt: new Date(),
	});
	return { made, messageId };
}

// Slice 5b · T4: the Sources panel's "Made in this chat" row opens through the
// same path a chat card's Open does, so an item that is gone shows the deleted
// state the card shows — it does not open an empty panel. M-1 of the final
// review: and the row itself says so, with the card's own words, instead of
// staying a live-looking link beside a card that says "deleted".
test.describe("A Sources row of an item that was deleted", () => {
	test("flips the card to deleted, says so, and opens nothing", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createConversation(page, "Plan a weekend");
		const uid = await testUserId();
		const { made } = await seedMadeDocumentTurn(conversationId, uid);
		await openChatAndReload(page, conversationId);
		await expect(page.getByTestId("artifact-card")).not.toHaveAttribute(
			"data-state",
			"deleted",
		);
		await page.getByRole("button", { name: /^Sources/ }).click();
		const group = page.getByRole("group", { name: "Made in this chat" });
		const row = group.getByRole("button", { name: /Weekend plan/ });
		await expect(row).toBeVisible();

		// Deleted elsewhere (another tab, the library) after this page loaded.
		const deleted = await deleteArtifact({
			userId: uid,
			artifactId: made.id,
			conversationId,
		});
		expect(deleted.ok).toBe(true);

		await row.click();

		await expect(page.getByTestId("artifact-card")).toHaveAttribute(
			"data-state",
			"deleted",
		);
		await expect(workspacePanel(page)).toHaveCount(0);
		await expect(page.getByTestId("workspace-main")).toBeHidden();
		// The row followed the card: it says what the card says, and is no link.
		await expect(group).toContainText("This document was deleted");
		await expect(group.getByRole("button")).toHaveCount(0);
	});

	test("says so when it was deleted from the library, and does not pretend to open", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createConversation(page, "Plan a weekend");
		const uid = await testUserId();
		// A title of its own: the library lists every Document the other specs
		// made in this database, "Weekend plan" among them.
		const title = `Library plan ${Date.now()}`;
		await seedMadeDocumentTurn(conversationId, uid, { title });

		// The reader's own clicks in the library: the row's Delete, then the
		// confirmation.
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByRole("tab", { name: "Documents" }).click();
		const libraryRow = page.locator("tbody tr", { hasText: title });
		await expect(libraryRow).toBeVisible();
		await libraryRow.getByRole("button", { name: /delete/i }).click();
		await page.getByTestId("confirm-delete").click();
		await expect(libraryRow).toHaveCount(0);

		// Back in the chat the card says the Document is gone — and the Sources
		// row says the same, in the same words, rather than offering to open it.
		await openChatAndReload(page, conversationId);
		await expect(page.getByTestId("artifact-card")).toHaveAttribute(
			"data-state",
			"deleted",
		);
		await page.getByRole("button", { name: /^Sources/ }).click();
		const group = page.getByRole("group", { name: "Made in this chat" });
		await expect(group).toContainText(title);
		await expect(group).toContainText("This document was deleted");
		await expect(group.getByRole("button")).toHaveCount(0);
		await expect(group.getByText("Document", { exact: true })).toHaveCount(0);

		// Nothing to open: a click on the row does nothing at all.
		await group.getByText(title).click();
		await expect(workspacePanel(page)).toHaveCount(0);
		await expect(page.getByTestId("workspace-main")).toBeHidden();
	});

	test("goes back to a live row when Regenerate makes the item again under the same id", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createConversation(page, "Plan a weekend");
		const uid = await testUserId();
		const { made } = await seedMadeDocumentTurn(conversationId, uid);
		const deleted = await deleteArtifact({
			userId: uid,
			artifactId: made.id,
			conversationId,
		});
		expect(deleted.ok).toBe(true);
		await openChatAndReload(page, conversationId);
		await page.getByRole("button", { name: /^Sources/ }).click();
		const group = page.getByRole("group", { name: "Made in this chat" });
		await expect(group).toContainText("This document was deleted");

		await page.getByTestId("artifact-card-regenerate").click();

		await expect(page.getByTestId("artifact-card")).not.toHaveAttribute(
			"data-state",
			"deleted",
			{ timeout: 30_000 },
		);
		await expect(
			group.getByRole("button", { name: /Weekend plan/ }),
		).toBeVisible();
		await expect(group).not.toContainText("was deleted");
	});
});

// M-2 of the final review: a fork copies the parent's messages, and with each
// assistant message its Sources as they were. What the parent's turn made was
// made in the ORIGINAL chat, so the copied group must not say "Made in this
// chat" — it says what the fork's own card says for an item out of reach.
test.describe("A fork's copied Sources", () => {
	test("say the item was made in the original chat, and the row still opens the parent's Document", async ({
		page,
	}) => {
		await login(page);
		const parentId = await createConversation(page, "Plan a weekend");
		const uid = await testUserId();
		const { messageId } = await seedMadeDocumentTurn(parentId, uid);

		// The reader forks from the message that made it, with their own clicks.
		await openChatAndReload(page, parentId);
		await page.locator(`[data-message-id="${messageId}"]`).hover();
		const fork = page.locator(`#fork-button-${messageId}`);
		await expect(fork).toHaveAccessibleName("Fork from here");
		await fork.click();
		await page.waitForURL(
			(url) => {
				const id = url.pathname.match(/^\/chat\/([^/]+)$/)?.[1];
				return Boolean(id && id !== parentId);
			},
			{ timeout: 15_000 },
		);
		await page.getByRole("button", { name: /^Sources/ }).click();

		const group = page.getByRole("group", {
			name: "Made in the original chat",
		});
		await expect(group).toContainText(CREATED_TITLE);
		await expect(
			page.getByRole("heading", { name: "Made in the original chat" }),
		).toBeVisible();
		await expect(page.getByText("Made in this chat")).toHaveCount(0);

		// The parent's Document is there and this chat may read it: the row opens it.
		await group.getByRole("button", { name: /Weekend plan/ }).click();
		await expect(
			workspacePanel(page).getByText("Book the museum tickets."),
		).toBeVisible({ timeout: 30_000 });
	});

	test("of an incognito chat say so too, and the row is plain: the parent's Document is out of reach", async ({
		page,
	}) => {
		await login(page);
		const parentId = await createConversation(page, "Incognito plan");
		await db
			.update(conversations)
			.set({ memoryIncognito: true })
			.where(eq(conversations.id, parentId));
		const uid = await testUserId();
		const { messageId } = await seedMadeDocumentTurn(parentId, uid);
		const fork = await createConversationFork({
			userId: uid,
			sourceConversationId: parentId,
			sourceMessageId: messageId,
		});
		expect(fork.conversation.memoryIncognito).toBe(true);

		await openChatAndReload(page, fork.conversation.id);
		await expect(page.getByTestId("artifact-card")).toHaveAttribute(
			"data-state",
			"unreachable",
		);
		await page.getByRole("button", { name: /^Sources/ }).click();

		const group = page.getByRole("group", {
			name: "Made in the original chat",
		});
		await expect(group).toContainText(CREATED_TITLE);
		await expect(page.getByText("Made in this chat")).toHaveCount(0);
		// Nothing to open, and nothing called deleted: the Document exists.
		await expect(group.getByRole("button")).toHaveCount(0);
		await expect(group.getByText("Document", { exact: true })).toBeVisible();
		await expect(page.getByText(/was deleted/)).toHaveCount(0);
		await group.getByText(CREATED_TITLE).click();
		await expect(workspacePanel(page)).toHaveCount(0);
	});

	test("leave the wording alone for what the fork itself makes", async ({
		page,
	}) => {
		await login(page);
		const parentId = await createConversation(page, "Plan a weekend");
		const uid = await testUserId();
		const { messageId } = await seedMadeDocumentTurn(parentId, uid);
		const fork = await createConversationFork({
			userId: uid,
			sourceConversationId: parentId,
			sourceMessageId: messageId,
		});
		// A turn of the fork's own, later than the copy: its Sources are its own.
		await seedMadeDocumentTurn(fork.conversation.id, uid, {
			sequence: 9000,
			title: "Fork's own plan",
		});

		await openChatAndReload(page, fork.conversation.id);
		await page
			.getByRole("button", { name: /^Sources/ })
			.first()
			.click();
		await page
			.getByRole("button", { name: /^Sources/ })
			.last()
			.click();

		await expect(
			page.getByRole("group", { name: "Made in the original chat" }),
		).toHaveCount(1);
		const own = page.getByRole("group", { name: "Made in this chat" });
		await expect(own).toHaveCount(1);
		await expect(own).toContainText("Fork's own plan");
	});
});

test.describe("Delete from the panel list", () => {
	test("each row's overflow asks first, then deletes that item and only that item; Escape returns focus to the overflow", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createConversation(page, "Two documents");
		const uid = await testUserId();
		const seed = async (title: string) =>
			createDocumentArtifact({
				userId: uid,
				conversationId,
				title,
				markdown: `${title} text.`,
				author: "alfy",
				summary: "Alfy wrote the first draft",
			});
		const keep = await seed("Packing list");
		const doomed = await seed("Vienna itinerary");
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button").click();
		const list = page.getByTestId("artifact-panel-list");
		await expect(list.getByTestId("artifact-row")).toHaveCount(2);

		// Keyboard: the overflow is a real button that Tab reaches.
		const overflow = list.getByRole("button", {
			name: "More actions for Vienna itinerary",
		});
		await overflow.focus();
		await expect(overflow).toBeFocused();
		await expect(overflow).toBeVisible();
		await overflow.press("Enter");
		const menuItem = page.getByRole("menuitem", { name: "Delete document" });
		await expect(menuItem).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menuItem).toBeHidden();
		await expect(overflow).toBeFocused();

		// Now through: menu → confirm → deleted.
		await overflow.click();
		await page.getByRole("menuitem", { name: "Delete document" }).click();
		const dialog = page.getByRole("dialog", { name: "Delete this document?" });
		await expect(dialog).toContainText("Vienna itinerary");
		// Seeded with no create call and no message it was kept from: nothing is
		// kept to make it again from, so the plain warning is the whole truth.
		await expect(dialog).toContainText("This can't be undone.");
		await dialog.getByRole("button", { name: "Delete" }).click();

		await expect(list.getByTestId("artifact-row")).toHaveCount(1);
		await expect(list).not.toContainText("Vienna itinerary");
		await expect(list).toContainText("Packing list");
		await expect(page.getByTestId("artifact-count-button")).toContainText("1");
		await expect(page.getByText("Document deleted")).toBeVisible();
		const remaining = await listItems(page, conversationId);
		expect(remaining.map((item) => item.id)).toEqual([keep.id]);

		// The route agrees: the deleted one is gone for good, the other is intact.
		const status = await page.evaluate(async (id) => {
			const response = await fetch(`/api/artifacts/${id}`);
			return response.status;
		}, doomed.id);
		expect(status).toBe(404);
	});
});

test.describe("A produced file that was deleted", () => {
	// Seeds what the file pipeline leaves — the chat file, the artifact that
	// stands for it and the succeeded job that made it, with the request the job
	// kept — so the panel's Delete, the deleted row and Regenerate can be walked
	// against the real server without a renderer or a worker in the way.
	async function seedProducedFile(conversationId: string) {
		const uid = await testUserId();
		const assistantMessageId = randomUUID();
		const chatFileId = randomUUID();
		const artifactId = randomUUID();
		const jobId = randomUUID();
		const now = new Date();
		await db.insert(messages).values({
			id: assistantMessageId,
			conversationId,
			role: "assistant",
			content: "Here is the trip summary.",
			messageSequence: 900,
			createdAt: now,
		});
		await db.insert(chatGeneratedFiles).values({
			id: chatFileId,
			conversationId,
			assistantMessageId,
			userId: uid,
			filename: "Trip summary.md",
			mimeType: "text/markdown",
			sizeBytes: 20,
			storagePath: `${conversationId}/${chatFileId}.md`,
			createdAt: now,
		});
		await db.insert(artifacts).values({
			id: artifactId,
			userId: uid,
			conversationId,
			type: "generated_output",
			retrievalClass: "durable",
			name: "Trip summary.md",
			mimeType: "text/markdown",
			contentText: "Generated file: Trip summary.md",
			metadataJson: JSON.stringify({
				generatedFile: true,
				originalChatFileId: chatFileId,
				generatedFilename: "Trip summary.md",
				documentLabel: "Trip summary.md",
				versionNumber: 1,
			}),
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(fileProductionJobs).values({
			id: jobId,
			conversationId,
			assistantMessageId,
			userId: uid,
			title: "Trip summary",
			status: "succeeded",
			origin: "produce_file",
			requestJson: JSON.stringify({
				sourceMode: "inline_text",
				outputs: [],
				documentIntent: null,
				templateHint: null,
				program: null,
				documentSource: null,
				inlineText: null,
			}),
			sourceMode: "inline_text",
			createdAt: now,
			updatedAt: now,
			completedAt: now,
		});
		await db.insert(fileProductionJobFiles).values({
			id: randomUUID(),
			jobId,
			chatGeneratedFileId: chatFileId,
			sortOrder: 0,
			createdAt: now,
		});
		return { jobId, artifactId, chatFileId };
	}

	test("Delete removes the file, its row says so with Regenerate, and Regenerate queues the same job again", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createConversation(page, "A file");
		const { jobId, artifactId, chatFileId } =
			await seedProducedFile(conversationId);
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button").click();
		const list = page.getByTestId("artifact-panel-list");
		await list
			.getByRole("button", { name: "More actions for Trip summary.md" })
			.click();
		await page.getByRole("menuitem", { name: "Delete file" }).click();
		const dialog = page.getByRole("dialog", { name: "Delete this file?" });
		// The job kept its request, so the file can be made again.
		await expect(dialog).toContainText("You can regenerate it from the chat.");
		await dialog.getByRole("button", { name: "Delete" }).click();

		// The chat's row for the file now says it is gone.
		const deletedRow = page.getByTestId("file-row-deleted");
		await expect(deletedRow).toBeVisible({ timeout: 15_000 });
		await expect(deletedRow).toContainText("Trip summary");
		await expect(deletedRow).toContainText("The file has been deleted");
		await expect(page.getByText("File deleted")).toBeVisible();

		// The file is gone for real: chat file row and artifact, not the job.
		const [chatFile] = await db
			.select({ id: chatGeneratedFiles.id })
			.from(chatGeneratedFiles)
			.where(eq(chatGeneratedFiles.id, chatFileId));
		expect(chatFile).toBeUndefined();
		const [artifact] = await db
			.select({ id: artifacts.id })
			.from(artifacts)
			.where(eq(artifacts.id, artifactId));
		expect(artifact).toBeUndefined();
		const [job] = await db
			.select({ status: fileProductionJobs.status })
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, jobId));
		expect(job?.status).toBe("succeeded");

		// A reload says the same (the server's answer).
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByTestId("file-row-deleted")).toBeVisible();

		// Regenerate queues the SAME job: the deleted row gives way to its work.
		const regenerated = page.waitForResponse(
			(response) =>
				response.url().endsWith(`/api/chat/files/jobs/${jobId}/regenerate`) &&
				response.request().method() === "POST",
		);
		await page
			.getByTestId("file-row-deleted")
			.getByRole("button", { name: "Regenerate Trip summary" })
			.click();
		expect((await regenerated).status()).toBe(200);
		await expect(page.getByTestId("file-row-deleted")).toHaveCount(0);
		const [after] = await db
			.select({ status: fileProductionJobs.status })
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, jobId));
		expect(after?.status).not.toBe("succeeded");
	});
});

// The security review's M1 and L1, in the browser: the fork of an incognito
// chat copies the parent's tool calls and not its items, and is incognito too.
// The parent's Document exists but is out of the fork's reach — the card says
// where it was made, never that it was deleted, and offers neither Open nor
// Regenerate. Containment is what it was: the fork lists and reads nothing.
test.describe("A fork of an incognito chat", () => {
	test("calls the parent's Document 'made in the original chat', not deleted", async ({
		page,
	}) => {
		await login(page);
		const parentId = await createConversation(page, "Incognito plan");
		await db
			.update(conversations)
			.set({ memoryIncognito: true })
			.where(eq(conversations.id, parentId));
		const uid = await testUserId();
		const made = await createDocumentArtifact({
			userId: uid,
			conversationId: parentId,
			title: CREATED_TITLE,
			markdown: CREATED_BODY,
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		const parentMessageId = randomUUID();
		await db.insert(messages).values({
			id: parentMessageId,
			conversationId: parentId,
			messageSequence: 900,
			role: "assistant",
			content: "Made the document.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: "e2e-fork-create-call",
					name: "create_artifact",
					input: {
						artifactType: "document",
						title: CREATED_TITLE,
						body: CREATED_BODY,
					},
					status: "done",
					outputSummary: `Created Document "${CREATED_TITLE}"`,
					sourceType: "tool",
					metadata: {
						ok: true,
						artifactId: made.id,
						artifactKind: "document",
						artifactTitle: CREATED_TITLE,
					},
				},
			]),
			createdAt: new Date(),
		});
		const fork = await createConversationFork({
			userId: uid,
			sourceConversationId: parentId,
			sourceMessageId: parentMessageId,
		});
		expect(fork.conversation.memoryIncognito).toBe(true);

		await openChatAndReload(page, fork.conversation.id);

		const card = page.getByTestId("artifact-card");
		await expect(card).toHaveAttribute("data-state", "unreachable");
		await expect(card).toContainText(CREATED_TITLE);
		await expect(card).toContainText("Made in the original chat");
		await expect(page.getByText(/was deleted/)).toHaveCount(0);
		await expect(page.getByTestId("artifact-card-head")).toHaveCount(0);
		await expect(card.getByRole("button", { name: /Regenerate/ })).toHaveCount(
			0,
		);

		// Containment is untouched: the fork lists none of it, and cannot read it.
		expect(await listItems(page, fork.conversation.id)).toEqual([]);
		const status = await page.evaluate(
			async ([id, conversation]) => {
				const response = await fetch(
					`/api/artifacts/${id}?conversationId=${conversation}`,
				);
				return response.status;
			},
			[made.id, fork.conversation.id],
		);
		expect(status).toBe(404);
		// And nothing can make a second one under that id.
		const regenerate = await page.evaluate(
			async ([id, conversation]) => {
				const response = await fetch(
					`/api/conversations/${conversation}/artifacts/${id}/regenerate`,
					{ method: "POST" },
				);
				return { status: response.status, body: await response.json() };
			},
			[made.id, fork.conversation.id],
		);
		expect(regenerate).toEqual({
			status: 409,
			body: { ok: false, reason: "unreachable" },
		});
	});
});
