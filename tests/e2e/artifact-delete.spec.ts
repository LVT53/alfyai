import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	fileProductionJobFiles,
	fileProductionJobs,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import { createConversation, login, workspacePanel } from "./helpers";

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
		await expect(dialog).toContainText("This can't be undone.");
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
