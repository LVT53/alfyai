import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	applyDocumentPatch,
	createDocumentArtifact,
	listVersions,
	readDocumentForAlfy,
} from "../../src/lib/server/services/artifacts";
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
});
