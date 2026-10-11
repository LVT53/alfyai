import { expect, type Locator, type Page, test } from "@playwright/test";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifactVersions, users } from "../../src/lib/server/db/schema";
import {
	applyDocumentPatch,
	createArtifact,
	createDocumentArtifact,
	getKv,
	listVersions,
	readDocumentForAlfy,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	madeAppSummary,
	VERSION_SUMMARY,
} from "../../src/lib/shared/artifacts/version-summaries";
import { createEmptyConversation, login } from "./helpers";

// FX-V (the review of the versioning batch, RV-V I-3 and I-4): what History says
// after a press is true. Real pointer and keyboard input against the real review
// bar, History, restore toast and naming; the rows are seeded through the
// artifact service in the vocabulary the server writes.

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function serverVersions(artifactId: string) {
	return listVersions({ userId: await adminId(), artifactId });
}

/** The reader's name for the newest version, as stored. */
async function newestLabel(artifactId: string): Promise<string | null> {
	const [row] = await db
		.select({ label: artifactVersions.label })
		.from(artifactVersions)
		.where(and(eq(artifactVersions.artifactId, artifactId)))
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(1);
	return row?.label ?? null;
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

test.describe("What History says after a press", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("Undo all takes back every one of Alfy's pending changes, and History calls each of them Undone, not only the newest (I-3)", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Undo all walk");
		const userId = await adminId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Undo all walk",
			markdown: "Book the hotel.\n\nBook the flight.",
			author: "user",
			summary: "Seeded for E2E",
		});
		// Two changes of Alfy's, one version each (a turn that calls edit_artifact twice).
		const rewrites = ["Book the hotel by Friday.", "Book the flight, aisle."];
		for (const [index, text] of rewrites.entries()) {
			const read = await readDocumentForAlfy({
				userId,
				artifactId: artifact.id,
				conversationId,
			});
			const block = read.blocks[index];
			const applied = await applyDocumentPatch({
				userId,
				artifactId: artifact.id,
				conversationId,
				patch: {
					patchId: `undo-all-${index}`,
					label: "Alfy edit",
					ops: [
						{
							opId: `undo-all-op-${index}`,
							kind: "replaceBlock" as const,
							blockId: block.blockId,
							baseHash: block.hash,
							blockLabel: block.label,
							text,
						},
					],
				},
			});
			expect(applied.ok, "the seeded patch applies").toBe(true);
		}
		expect((await serverVersions(artifact.id)).length).toBe(3);

		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		await expect(
			page.getByRole("region", { name: "Changes from Alfy" }),
		).toContainText("Alfy changed 2 parts.");
		await page.getByRole("button", { name: /^Undo all/ }).click();

		// One save puts both back, and says which of Alfy's versions it took back.
		await expect
			.poll(async () => (await serverVersions(artifact.id))[0]?.summary, {
				timeout: 15_000,
			})
			.toBe("Undid Alfy's changes: v2 to v3");

		await historyButton(page).click();
		const region = page.getByRole("region", {
			name: "History of Undo all walk",
		});
		const options = region.getByRole("option");
		// v3 with the Undo as its step, v2 on its own, and the reader's first draft.
		await expect(options).toHaveCount(4);
		await expect(options.nth(0)).toContainText("Undone");
		await expect(options.nth(1)).toContainText("You undid it");
		await expect(options.nth(2)).toContainText("hotel by Friday");
		await expect(options.nth(2)).toContainText("Undone");
		await expect(options.nth(2)).not.toContainText("Kept");
		await expect(options.nth(2)).toHaveAccessibleName(/Alfy.*Undone\./);
	});

	test("after the restore toast's Undo, History lands on the current version: one Now, and a name goes on it (I-4)", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Toast walk");
		const userId = await adminId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Toast walk",
			markdown: "Friday\n\nArrive and walk.",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		await updateArtifactBody({
			userId,
			artifactId: artifact.id,
			conversationId,
			body: "Friday\n\nArrive and walk.\n\nSaturday\n\nBelvedere.",
			author: "alfy",
			summary: "Added Saturday",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		await historyButton(page).click();
		const region = page.getByRole("region", { name: "History of Toast walk" });
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2);

		// Restore the first draft, then take the restore back with the toast's Undo.
		await options.last().click();
		await region.getByTestId("history-restore").click();
		await region.getByTestId("history-restore-confirm").click();
		const toast = page.getByTestId("history-toast");
		await expect(toast).toContainText("Restored");
		await toast.getByRole("button", { name: "Undo" }).click();
		await expect
			.poll(async () => (await serverVersions(artifact.id))[0]?.summary, {
				timeout: 15_000,
			})
			.toBe("Undid restoring v3");

		// The restore and the Undo that took it back are one quiet moment (the Undo is
		// its step); the entry that holds the newest row is the step, and that is where
		// History lands, with the text that is there now.
		await expect(options).toHaveCount(4);
		await expect(options.nth(0)).toContainText("You restored");
		await expect(options.nth(1)).toContainText("You undid the restore");
		await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
		await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
		await expect(region.getByText("Belvedere.").first()).toBeVisible();
		await expect(
			region.getByText("This is how it looks now", { exact: false }),
		).toBeVisible();
		// One Now, on the entry whose own row is the newest.
		await expect(region.locator(".marker-now")).toHaveCount(1);
		await expect(options.nth(1).locator(".marker-now")).toHaveCount(1);

		// A name lands on what is selected: the current version, not the undone restore.
		const versions = await serverVersions(artifact.id);
		expect(versions[0]?.versionNumber).toBe(4);
		await region.getByRole("button", { name: "Name", exact: true }).click();
		await page.keyboard.type("Before the client call");
		await page.keyboard.press("Enter");
		await expect
			.poll(() => newestLabel(artifact.id))
			.toBe("Before the client call");
		const labelled = await db
			.select({
				versionNumber: artifactVersions.versionNumber,
				label: artifactVersions.label,
			})
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, artifact.id));
		expect(
			labelled
				.filter((version) => version.label !== null)
				.map((version) => version.versionNumber),
			"only the current version is named",
		).toEqual([4]);
	});

	// RV-V M-5: a board's picture of a stored version changes nothing. Its App blocks
	// used to RUN there, with the writing bridge and today's saved data, so the reader
	// could press a button in the preview and change what the App saved.
	test("a board's History preview does not run its App blocks: a still image or a card, no frame, and nothing written (M-5)", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(
			page,
			"Board with an App",
		);
		const userId = await adminId();
		const made = await createArtifact({
			userId,
			conversationId,
			kind: "app",
			title: "Counter",
			body: COUNTER_APP_HTML,
			author: "alfy",
			versionSummary: madeAppSummary("a counter"),
		});
		if (!made.ok) throw new Error(made.reason);
		const appId = made.artifact.id;

		const note = (id: string, x: number, text: string): CanvasNode => ({
			id,
			type: "sticky",
			position: { x, y: 40 },
			width: 180,
			data: { kind: "sticky", text, tone: "yellow" },
		});
		const board = (...notes: CanvasNode[]): CanvasBody => ({
			version: 1,
			nodes: [
				{
					id: "app-1",
					type: "app",
					position: { x: 40, y: 40 },
					width: 400,
					height: 300,
					data: { kind: "app", artifactId: appId, title: "Counter" },
				},
				...notes,
			],
			edges: [],
			viewport: { x: 16, y: 16, zoom: 1 },
			annotations: [],
		});
		const created = await createArtifact({
			userId,
			conversationId,
			kind: "canvas",
			title: "Board with an App",
			body: boardJson(board(note("n1", 480, "Museum, 14:00"))),
			author: "alfy",
			versionSummary: VERSION_SUMMARY.alfyFirstDraft,
		});
		if (!created.ok) throw new Error(created.reason);
		await updateArtifactBody({
			userId,
			artifactId: created.artifact.id,
			conversationId,
			body: boardJson(
				board(note("n1", 480, "Museum, 14:00"), note("n2", 480, "Dinner")),
			),
			author: "alfy",
			summary: "Added dinner",
		});

		// Nothing a preview does may write the App's saved data.
		const writes: string[] = [];
		page.on("request", (request) => {
			if (
				/\/api\/artifacts\/[^/]+\/app\/kv/.test(request.url()) &&
				request.method() !== "GET"
			) {
				writes.push(`${request.method()} ${request.url()}`);
			}
		});

		await openChatAndReload(page, conversationId);
		// The chat made two items: the board is the one to open.
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.filter({ hasText: "Board with an App" })
			.click({ timeout: 30_000 });
		await expect(historyButton(page)).toBeVisible({ timeout: 30_000 });
		await historyButton(page).click();
		const region = page.getByRole("region", {
			name: "History of Board with an App",
		});
		const options = region.getByRole("option");
		await expect(options).toHaveCount(2);
		await options.last().click();

		const preview = region.getByTestId("history-preview");
		const still = preview.getByTestId("canvas-app-still");
		await expect(still).toBeVisible({ timeout: 15_000 });
		await expect(still).toContainText(
			"The App runs on the live board, not in History.",
		);
		await expect(preview.locator("iframe")).toHaveCount(0);
		// A press on the block does what a press on a picture does.
		await still.click({ force: true });
		await page.waitForTimeout(600);
		expect(writes).toEqual([]);
		expect(
			await getKv({ userId, artifactId: appId, conversationId, key: "n" }),
		).toBeNull();
	});
});

/** A counter that saves its count in its own storage when its button is pressed. */
const COUNTER_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Counter</title></head>
<body style="margin:0">
<button id="inc" type="button" style="width:100%;height:100%;font-size:2rem">Count</button>
<script>
(function () {
  var n = 0;
  document.getElementById('inc').addEventListener('click', function () {
    n += 1;
    if (window.alfy && window.alfy.storage) window.alfy.storage.set('n', n);
  });
})();
</script>
</body>
</html>`;
