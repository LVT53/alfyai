import { expect, type Page, test } from "@playwright/test";
import {
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import { createConversation, login, workspacePanel } from "./helpers";

// Review 276-279 (G3): the panel is named for what it shows and a list row says
// what it is. Role and name queries, in both UI languages, because the accessible
// name is the product here.

async function openList(page: Page, id: string) {
	await page.evaluate((conversationId) => {
		window.sessionStorage.removeItem(`pending-chat-message:${conversationId}`);
	}, id);
	await page.goto(`/chat/${id}`);
	await page.reload({ waitUntil: "networkidle" });
	await page.getByTestId("artifact-count-button").click();
	await expect(page.getByTestId("artifact-panel-list")).toBeVisible({
		timeout: 30_000,
	});
}

test.describe("The panel's names (review 276-279)", () => {
	test.afterEach(async () => {
		await setUiLanguage("en");
	});

	test("English: the list is named for its heading, each row says title, kind, facts, version and time, and an open item names the panel", async ({
		page,
	}) => {
		await setUiLanguage("en");
		await login(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Panel names");
		await seedDocument(conversationId, {
			markdown: "# A\n\nB.",
			title: "Budget",
			tabs: [
				{ id: "a", title: "Plan", startBlockId: "" },
				{ id: "b", title: "Costs", startBlockId: "" },
			],
		});
		await seedDocument(conversationId, {
			markdown: "First.\n\nSecond.",
			title: "Trip notes",
			pendingOps: 1,
		});
		await openList(page, conversationId);

		await expect(
			page.getByRole("complementary", { name: "What this chat made" }),
		).toBeVisible();
		const list = page.getByTestId("artifact-panel-list");
		await expect(
			list.getByRole("button", { name: /^Budget, Document, 2 tabs, v1, / }),
		).toBeVisible();
		await expect(
			list.getByRole("button", {
				name: /^Trip notes, Document, 1 tab, v2, .*, 1 change to review$/,
			}),
		).toBeVisible();

		await list.getByRole("button", { name: /^Budget, / }).click();
		const panel = workspacePanel(page);
		await expect(panel).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByRole("complementary", { name: "Budget, Document" }),
		).toBeVisible();
		// The generic name every item used to share is gone.
		await expect(
			page.getByRole("complementary", { name: "Document workspace" }),
		).toHaveCount(0);
	});

	test("Hungarian: the same names in Hungarian", async ({ page }) => {
		await setUiLanguage("hu");
		await login(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Panel names HU");
		await seedDocument(conversationId, {
			markdown: "Szöveg.\n\nMásik.",
			title: "Bécsi utazás",
			pendingOps: 1,
		});
		await openList(page, conversationId);

		await expect(
			page.getByRole("complementary", {
				name: "Amit ez a beszélgetés készített",
			}),
		).toBeVisible();
		const list = page.getByTestId("artifact-panel-list");
		const row = list.getByRole("button", {
			name: /^Bécsi utazás, Dokumentum, 1 fül, v2, .*, 1 módosítás vár rád$/,
		});
		await expect(row).toBeVisible();

		await row.click();
		await expect(
			page.getByRole("complementary", { name: "Bécsi utazás, Dokumentum" }),
		).toBeVisible({ timeout: 30_000 });
	});
});
