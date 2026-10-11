import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	createDocumentArtifact,
	listVersions,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import { runReadArtifactTool } from "../../src/lib/server/services/normal-chat-tools/artifact-tools/read";
import {
	AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_EDIT_ARTIFACT_MARKER,
	encodeEditArtifactScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// FX-V (the review of the versioning batch, RV-V I-1 and I-4): History's
// guarantees when a version arrives while it is open, walked with real pointer
// and keyboard input and a REAL `edit_artifact` call (the fake provider
// harness drives `/api/chat/stream`, so the version reaches History the way a
// chat turn's does: announced to this tab, never found by a refresh alone).

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

/** A Document body the way the server stores it: a marker line (the block's stable id) before every block. */
const withIds = (...blocks: Array<[string, string]>): string =>
	blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");

async function serverVersions(artifactId: string) {
	return listVersions({ userId: await adminId(), artifactId });
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

function historyButton(page: Page): Locator {
	return page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first();
}

async function openDocumentFromPanel(page: Page): Promise<void> {
	const countButton = page.getByTestId("artifact-count-button");
	if ((await countButton.getAttribute("aria-pressed")) !== "true") {
		await countButton.click();
	}
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click({ timeout: 30_000 });
	await expect(historyButton(page)).toBeVisible({ timeout: 30_000 });
}

/** The message that makes the fake model call `edit_artifact` on the seeded Document (it applies "Book the hotel."). */
async function alfyEditMessage(
	artifactId: string,
	conversationId: string,
): Promise<string> {
	// Alfy's own read comes first, so her edit is not refused as "your words win".
	const read = await runReadArtifactTool({
		userId: await adminId(),
		conversationId,
		artifactId,
		detail: "blocks",
		abortSignal: new AbortController().signal,
	});
	const blocks =
		read.modelPayload.success && "blocks" in read.modelPayload
			? (read.modelPayload.blocks as Array<{
					blockId: string;
					hash: string;
					text: string;
				}>)
			: [];
	const applyBlock = blocks.find((b) => b.text === "Book the hotel.");
	const refuseBlock = blocks.find((b) => b.text.startsWith("Book the flight."));
	expect(applyBlock, "the hotel block").toBeTruthy();
	expect(refuseBlock, "the flight block").toBeTruthy();
	return `${AI_SMOKE_EDIT_ARTIFACT_MARKER} ${encodeEditArtifactScenarioPayload({
		artifactId,
		applyBlockId: applyBlock?.blockId ?? "",
		applyBaseHash: applyBlock?.hash ?? "",
		refuseBlockId: refuseBlock?.blockId ?? "",
	})}`;
}

test.describe("History while a chat turn writes", () => {
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

	test("an Alfy edit that lands in this chat while the restore question is open turns it into 'it changed', and nothing is written until the reader confirms on the new state (I-1)", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let providerId: string | null = null;
		try {
			const conversationId = await createEmptyConversation(page);
			const userId = await adminId();
			const artifact = await createDocumentArtifact({
				userId,
				conversationId,
				title: "Guard walk",
				markdown: withIds(
					["p1", "Book the hotel."],
					["p2", "Book the flight."],
				),
				author: "alfy",
				summary: "Alfy wrote the first draft",
			});
			const artifactId = artifact.id;
			await updateArtifactBody({
				userId,
				artifactId,
				conversationId,
				body: withIds(
					["p1", "Book the hotel."],
					["p2", "Book the flight. Window seat."],
				),
				author: "user",
				summary: "Edited",
			});
			const message = await alfyEditMessage(artifactId, conversationId);

			const temporary = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			providerId = temporary.providerId;
			await updateUserModelPreference(page, temporary.selectedModel);

			await openChatAndReload(page, conversationId);
			await openDocumentFromPanel(page);
			await historyButton(page).click();
			const region = page.getByRole("region", {
				name: "History of Guard walk",
			});
			const options = region.getByRole("option");
			await expect(options).toHaveCount(2);

			// The reader asks to bring back the first draft: the question is open.
			await options.last().click();
			await region.getByTestId("history-restore").click();
			const question = region.getByTestId("history-restore-question");
			await expect(question).toContainText(
				"What you have now stays in History.",
			);

			// With the question still open, a turn in the same chat makes Alfy edit
			// the Document. The version is announced to this tab, History refreshes.
			await sendMessage(page, message);
			await expect(
				page.getByText(AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });
			await expect(options).toHaveCount(3, { timeout: 15_000 });
			await expect(options.first()).toContainText("Waiting for you");

			// The question says what happened. It does not stay a plain "Restore?" over a
			// history that is not the one the reader decided on.
			await expect(question).toContainText(
				"It changed while you were looking. Here's the latest.",
			);
			// Nothing was written by any of it.
			expect(
				(await serverVersions(artifactId)).map((v) => v.versionNumber),
				"only Alfy's edit was written",
			).toEqual([3, 2, 1]);

			// The reader confirms on the state they were just shown: the restore lands
			// on top of Alfy's change, which stays in History.
			await region.getByTestId("history-restore-confirm").click();
			await expect(page.getByTestId("history-toast")).toContainText("Restored");
			await expect(options.first()).toContainText("You restored");
			await expect(options).toHaveCount(4);
			const versions = await serverVersions(artifactId);
			expect(versions.map((v) => v.versionNumber)).toEqual([4, 3, 2, 1]);
			expect(versions[0]?.summary).toBe("Restored v1");
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});
});

test.describe("History when the reader's own save outlasts the panel's wait", () => {
	test("a save that lands after History opened is told to the reader asking to restore, and the typed step stays in History (T5, I-1)", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const conversationId = await createEmptyConversation(page);
		const userId = await adminId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Late save",
			markdown: "Book the hotel.\n\nBook the flight.",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		await updateArtifactBody({
			userId,
			artifactId: artifact.id,
			conversationId,
			body: "Book the hotel.\n\nBook the flight. Window seat.",
			author: "alfy",
			summary: "Added a window seat",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		// The reader types; the save goes out when History opens, and is slower
		// than the panel's four seconds of patience (the network, not the server).
		await page.route(/\/api\/artifacts\/[^/]+\/body/, async (route) => {
			if (route.request().method() !== "PATCH") return route.continue();
			await new Promise((resolve) => setTimeout(resolve, 6000));
			await route.continue();
		});
		const editor = page.locator(".document-editor-host .document-content");
		await editor.getByText("Window seat.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Aisle.");
		await historyButton(page).click();
		const region = page.getByRole("region", { name: "History of Late save" });
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2, { timeout: 15_000 });

		// The reader asks to bring back the first draft before the save has landed.
		await options.last().click();
		await region.getByTestId("history-restore").click();
		const question = region.getByTestId("history-restore-question");
		await expect(question).toContainText("What you have now stays in History.");

		// The save lands: the reader is told, and nothing was written by the question.
		await expect(options).toHaveCount(3, { timeout: 20_000 });
		await expect(question).toContainText(
			"It changed while you were looking. Here's the latest.",
		);
		expect(
			(await serverVersions(artifact.id)).map((v) => v.versionNumber),
			"only the reader's save was written",
		).toEqual([3, 2, 1]);

		// Confirmed on the new state: the typed step is the moment before the restore.
		await region.getByTestId("history-restore-confirm").click();
		await expect(page.getByTestId("history-toast")).toContainText("Restored");
		await expect(options.nth(0)).toContainText("You restored");
		await expect(options.nth(1)).toContainText("You edited");
		expect((await serverVersions(artifact.id))[0]?.summary).toBe("Restored v1");
	});
});
