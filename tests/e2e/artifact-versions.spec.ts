import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	createDocumentArtifact,
	listVersions,
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
import { createConversation, login, sendMessage } from "./helpers";

// Wave 2.5 polish G1-B (owner: "the version numbers are all over the place —
// in the overview I see v5, inside it's only v3, and in the versions tab I
// see a v4 but no v5"). Four surfaces show one artifact's version: the panel
// list row, the in-chat card, the panel header's version button and the
// Versions popover's own current row. This walks the whole life of one
// Document — created, edited by the user, edited live by Alfy, that edit
// undone, an older version restored, the restore undone — and asks every
// surface at every step, against the server's own newest version row.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function serverVersions(artifactId: string) {
	return listVersions({ userId: await testUserId(), artifactId });
}

async function serverVersion(artifactId: string): Promise<number> {
	return (await serverVersions(artifactId))[0]?.versionNumber ?? 0;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

function versionOf(text: string | null | undefined): string | null {
	return text?.match(/\bv(\d+)\b/)?.[0] ?? null;
}

/** The desktop shell's own version button (both shells are real DOM nodes; only the visible one counts). */
function headerPill(page: Page): Locator {
	return page.locator('[data-testid="artifact-version-pill"]:visible').first();
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
	await expect(headerPill(page)).toBeVisible({ timeout: 30_000 });
}

async function backToList(page: Page): Promise<void> {
	await page.locator(".artifact-panel-header-crumb:visible").first().click();
	await expect(page.getByTestId("artifact-panel-list")).toBeVisible();
}

/** What the four surfaces say right now, read the way a person reads them. */
async function readSurfaces(page: Page, withCard: boolean) {
	const header = versionOf(await headerPill(page).textContent());

	// The Versions popover's own current row.
	await headerPill(page).click();
	const popover = page.getByTestId("document-versions-popover");
	await expect(popover).toBeVisible();
	await expect(popover.getByRole("listitem").first()).toBeVisible();
	const topRow = popover.getByRole("listitem").first();
	const versions = versionOf(await topRow.textContent());
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);

	// The chat card (only once Alfy has made a tool call in this chat).
	const card = withCard
		? versionOf(
				await page.getByTestId("artifact-card-head").last().textContent(),
			)
		: undefined;

	// The panel list row.
	await backToList(page);
	const list = versionOf(
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.first()
			.textContent(),
	);
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click();
	await expect(headerPill(page)).toBeVisible();

	return { header, versions, list, ...(withCard ? { card } : {}) };
}

async function expectAllSurfaces(
	page: Page,
	artifactId: string,
	expected: number,
	label: string,
	withCard: boolean,
) {
	await expect
		.poll(() => serverVersion(artifactId), {
			message: `${label}: the server's newest version`,
			timeout: 15_000,
		})
		.toBe(expected);
	// Let the passive surfaces settle before the interactive read below.
	await expect
		.poll(async () => versionOf(await headerPill(page).textContent()), {
			timeout: 6_000,
		})
		.toBe(`v${expected}`)
		.catch(() => undefined);
	const seen = await readSurfaces(page, withCard);
	const want = `v${expected}`;
	expect(seen, `${label} (server says v${expected})`).toEqual({
		header: want,
		versions: want,
		list: want,
		...(withCard ? { card: want } : {}),
	});
}

test.describe("one version number on every surface", () => {
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

	test("create → user edit → Alfy edit → Undo → restore → undo the restore: the list row, the chat card, the header and the Versions popover agree at every step, and after a reload", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let providerId: string | null = null;
		try {
			const conversationId = await createConversation(page, "Version walk");
			const userId = await testUserId();
			const artifact = await createDocumentArtifact({
				userId,
				conversationId,
				title: "Version walk",
				markdown: "Book the hotel.\n\nBook the flight.",
				author: "user",
				summary: "Seeded for E2E",
			});
			const artifactId = artifact.id;

			const temporary = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			providerId = temporary.providerId;
			await updateUserModelPreference(page, temporary.selectedModel);

			await openChatAndReload(page, conversationId);
			await openDocumentFromPanel(page);

			// v1 — created.
			await expectAllSurfaces(page, artifactId, 1, "created", false);

			// v2 — the user edits (autosave; a fresh version because v1 was a
			// seed, not an "Edited" burst).
			const editor = page.locator(".document-editor-host .document-content");
			await editor.getByText("Book the flight.").click();
			await page.keyboard.press("End");
			await page.keyboard.type(" Window seat.");
			await expectAllSurfaces(page, artifactId, 2, "user edit", false);

			// v3 — Alfy edits live (a real edit_artifact call). Alfy's own read
			// happens first, so her edit is not refused as "your words win".
			const read = await runReadArtifactTool({
				userId,
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
			const refuseBlock = blocks.find((b) =>
				b.text.startsWith("Book the flight."),
			);
			expect(applyBlock, "the hotel block").toBeTruthy();
			expect(refuseBlock, "the flight block").toBeTruthy();
			await sendMessage(
				page,
				`${AI_SMOKE_EDIT_ARTIFACT_MARKER} ${encodeEditArtifactScenarioPayload({
					artifactId,
					applyBlockId: applyBlock?.blockId ?? "",
					applyBaseHash: applyBlock?.hash ?? "",
					refuseBlockId: refuseBlock?.blockId ?? "",
				})}`,
			);
			await expect(
				page.getByText(AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });
			await expectAllSurfaces(page, artifactId, 3, "Alfy edit", true);

			// v4 — the user undoes Alfy's change.
			await page
				.getByTestId("alfy-change-bar")
				.getByRole("button", { name: "Undo Alfy's change" })
				.click();
			await expectAllSurfaces(page, artifactId, 4, "Undo", true);

			// v5 — restore v1 from the Versions popover (inline confirm).
			await headerPill(page).click();
			const popover = page.getByTestId("document-versions-popover");
			const v1Row = popover.getByRole("listitem").filter({ hasText: /\bv1\b/ });
			await v1Row.hover();
			await v1Row.getByRole("button", { name: "Restore" }).click();
			await v1Row.getByRole("button", { name: "Restore" }).click();
			await expect(page.getByTestId("toast-entry")).toContainText(
				"Restored v1 as v5",
			);
			await expectAllSurfaces(page, artifactId, 5, "restore", true);

			// v6 — the toast's Undo puts back what was current before the restore.
			await page
				.getByTestId("toast-entry")
				.getByRole("button", { name: "Undo" })
				.click();
			await expectAllSurfaces(page, artifactId, 6, "undo the restore", true);

			// A reload rebuilds every surface from stored state: the open item
			// comes back from the saved workspace snapshot, which was taken at
			// v1 — it must not win over the artifact's real version.
			await page.reload({ waitUntil: "networkidle" });
			await expect(headerPill(page)).toBeVisible({ timeout: 30_000 });
			await expectAllSurfaces(page, artifactId, 6, "after a reload", true);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});
});
