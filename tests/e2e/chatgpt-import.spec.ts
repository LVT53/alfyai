import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { login } from "./helpers";

// The import dialog lists the conversations of a ChatGPT export and lets the
// person tick the ones to bring over. The server used to import every
// conversation of the ZIP whatever was ticked, so this runs the whole path in a
// browser: a real ZIP read by the dialog, the posted selection, the server's
// parse and the conversations it leaves.

const RUN = randomUUID().slice(0, 8);
const KEEP_ONE = `Import e2e ${RUN} keep one`;
const LEAVE_OUT = `Import e2e ${RUN} leave out`;
const KEEP_TWO = `Import e2e ${RUN} keep two`;
const TITLE_PREFIX = `Import e2e ${RUN}`;

function exportEntry(title: string) {
	const id = randomUUID();
	return {
		id,
		conversation_id: id,
		title,
		create_time: 1700000000,
		update_time: 1700000100,
		current_node: "question",
		mapping: {
			question: {
				id: "question",
				parent: null,
				children: [],
				message: {
					id: "question",
					author: { role: "user", name: null, metadata: {} },
					create_time: 1700000000,
					update_time: null,
					content: { content_type: "text", parts: [`A question for ${title}`] },
					status: "finished_successfully",
					end_turn: null,
					weight: 1,
					metadata: {},
					recipient: "all",
					channel: null,
				},
			},
		},
	};
}

async function exportZip(...titles: string[]): Promise<Buffer> {
	const zip = new JSZip();
	zip.file("conversations.json", JSON.stringify(titles.map(exportEntry)));
	return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function importedConversations(
	page: Page,
): Promise<{ id: string; title: string }[]> {
	return page.evaluate(async (prefix) => {
		const response = await fetch("/api/conversations");
		const { conversations } = (await response.json()) as {
			conversations: { id: string; title: string }[];
		};
		return conversations
			.filter((conversation) => conversation.title.startsWith(prefix))
			.map(({ id, title }) => ({ id, title }));
	}, TITLE_PREFIX);
}

test.describe("importing from ChatGPT", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	// A worker keeps its database from one spec file to the next.
	test.afterEach(async ({ page }) => {
		for (const { id } of await importedConversations(page)) {
			await page.evaluate(
				(conversationId) =>
					fetch(`/api/conversations/${conversationId}`, { method: "DELETE" }),
				id,
			);
		}
	});

	test("brings over the conversations that are ticked, and only those", async ({
		page,
	}) => {
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		await page.getByRole("button", { name: "Choose a ZIP file…" }).click();

		const dialog = page.getByRole("dialog");
		await dialog.locator('input[type="file"]').setInputFiles({
			name: "chatgpt-export.zip",
			mimeType: "application/zip",
			buffer: await exportZip(KEEP_ONE, LEAVE_OUT, KEEP_TWO),
		});

		await expect(
			dialog.getByText("Select Conversations to Import"),
		).toBeVisible();
		await expect(dialog.getByText("3 conversations found")).toBeVisible();

		await dialog.getByLabel(new RegExp(LEAVE_OUT)).uncheck();
		await expect(dialog.getByText("· 2 selected")).toBeVisible();
		await dialog.getByRole("button", { name: "Next" }).click();

		await expect(
			dialog.getByText("2 conversations will be imported"),
		).toBeVisible();
		await dialog.getByRole("button", { name: "Import 2 selected" }).click();

		await expect(
			dialog.getByText("2 conversations imported successfully."),
		).toBeVisible({ timeout: 20_000 });

		const imported = await importedConversations(page);
		expect(imported.map(({ title }) => title).sort()).toEqual(
			[KEEP_ONE, KEEP_TWO].sort(),
		);
	});

	test("cannot go on while nothing is ticked", async ({ page }) => {
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		await page.getByRole("button", { name: "Choose a ZIP file…" }).click();

		const dialog = page.getByRole("dialog");
		await dialog.locator('input[type="file"]').setInputFiles({
			name: "chatgpt-export.zip",
			mimeType: "application/zip",
			buffer: await exportZip(KEEP_ONE, LEAVE_OUT),
		});

		await dialog.getByRole("button", { name: "Deselect all" }).click();
		await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();
		expect(await importedConversations(page)).toEqual([]);
	});
});
