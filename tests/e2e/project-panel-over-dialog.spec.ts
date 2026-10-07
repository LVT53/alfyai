import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { conversations } from "../../src/lib/server/db/schema";
import {
	createArtifact,
	createDocumentArtifact,
} from "../../src/lib/server/services/artifacts";
import { createProject } from "../../src/lib/server/services/projects";
import {
	boardJson,
	emptyCanvasBody,
} from "../../src/lib/shared/artifacts/canvas-body";
import { testUserId } from "./artifact-canvas-helpers";
import {
	createTourUser,
	finishTour,
	panelShell,
	tourCard,
	tourRows,
	watchTourRequests,
} from "./artifact-tours-helpers";
import {
	ensureSidebarExpanded,
	login,
	logout,
	waitForHydration,
} from "./helpers";

/**
 * The expanded panel over a project's Files dialog (final review RV-F, I-2).
 *
 * A Document, an App or a Canvas the project's chats made opens from the Files
 * dialog in the shared panel, which then sits above the dialog. The dialog is
 * an `aria-modal` layer of the one dialog stack; the panel has to be a layer of
 * that stack too while it is over it, or the dialog behind it answers the keys:
 * Tab walks into controls nobody can see, and Escape (the editors' and the
 * board's "cancel" key) closes the panel and the dialog together.
 *
 * Everything is driven the way a person at a keyboard drives it: the real
 * clicks that open the dialog and the item, then real key presses. Nothing is
 * set through the page's own state.
 */

const APP_HTML =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cost splitter</title></head><body><h1>Cost splitter</h1></body></html>';

/** A chat of the user's inside the project, with the title a row will quote. */
async function seedProjectChat(
	userId: string,
	projectId: string,
	title: string,
): Promise<string> {
	const id = randomUUID();
	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId,
		title,
		projectId,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

/** A project whose chat made a Document, an App and a Canvas, and nothing else: no file, no link. */
async function seedMadeProject(userId: string) {
	const tag = randomUUID().slice(0, 6);
	const projectName = `Vienna trip ${tag}`;
	const { id: projectId } = await createProject(userId, projectName);
	const chatId = await seedProjectChat(
		userId,
		projectId,
		`Saturday plan ${tag}`,
	);
	const names = {
		document: `Vienna notes ${tag}`,
		app: `Cost splitter ${tag}`,
		canvas: `Trip board ${tag}`,
	};
	const document = await createDocumentArtifact({
		userId,
		conversationId: chatId,
		title: names.document,
		markdown: `## ${names.document}\n\nSaturday: Naschmarkt, then the Albertina.`,
		author: "alfy",
		summary: "Seeded for E2E",
	});
	for (const [kind, body] of [
		["app", APP_HTML],
		["canvas", boardJson(emptyCanvasBody())],
	] as const) {
		const result = await createArtifact({
			userId,
			conversationId: chatId,
			kind,
			title: names[kind],
			body,
		});
		if (!result.ok) throw new Error(`could not seed ${kind}: ${result.reason}`);
	}
	return { projectId, projectName, names, ids: { document: document.id } };
}

async function openProjectPage(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("project-greeting")).toBeVisible({
		timeout: 15_000,
	});
	// The page is server-rendered before it can be clicked: the chip's handler
	// only exists once hydration has landed.
	await waitForHydration(page);
}

/** The Files dialog of the project page the tab is on. */
async function openFilesDialogHere(page: Page) {
	await page.getByTestId("project-files-button").click();
	const dialog = page.getByRole("dialog", { name: "Files" });
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	return dialog;
}

async function openFilesDialog(page: Page, projectId: string) {
	await openProjectPage(page, projectId);
	return openFilesDialogHere(page);
}

function openButton(dialog: Locator, name: string): Locator {
	return dialog
		.getByTestId("project-file-row")
		.filter({ hasText: name })
		.getByRole("button", { name: `Open ${name}` });
}

/**
 * Presses `key` `presses` times, and after every press asks where focus is:
 * on something inside the panel, never on anything of the dialog behind it.
 */
async function pressInsidePanel(
	page: Page,
	panel: Locator,
	dialog: Locator,
	key: "Tab" | "Shift+Tab",
	presses: number,
) {
	for (let press = 1; press <= presses; press++) {
		await page.keyboard.press(key);
		await expect(
			panel.locator(":focus"),
			`${key} #${press}: focus must still be inside the panel`,
		).toHaveCount(1);
		await expect(
			dialog.locator(":focus"),
			`${key} #${press}: focus must not be on the dialog behind the panel`,
		).toHaveCount(0);
	}
}

test.describe("The panel over a project's Files dialog", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("Tab and Shift+Tab stay inside a Document's panel, from the editor", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		await openButton(dialog, names.document).click();
		const editor = page.locator(".document-editor-host .ProseMirror");
		await expect(editor).toBeVisible({ timeout: 30_000 });
		await editor.click();

		const panel = panelShell(page);
		await pressInsidePanel(page, panel, dialog, "Tab", 8);
		await pressInsidePanel(page, panel, dialog, "Shift+Tab", 8);
	});

	test("Tab and Shift+Tab stay inside a Canvas's panel, from the board's controls", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		await openButton(dialog, names.canvas).click();
		await expect(page.getByTestId("canvas-board")).toBeVisible({
			timeout: 30_000,
		});

		const panel = panelShell(page);
		await pressInsidePanel(page, panel, dialog, "Tab", 16);
		await pressInsidePanel(page, panel, dialog, "Shift+Tab", 16);
	});

	test("one Escape closes the panel and not the dialog under it, and gives focus back to the row", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		const open = openButton(dialog, names.document);
		await open.click();
		const editor = page.locator(".document-editor-host .ProseMirror");
		await expect(editor).toBeVisible({ timeout: 30_000 });
		await editor.click();
		const panel = panelShell(page);

		await page.keyboard.press("Escape");

		await expect(panel).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(
			open,
			"focus goes back to the row that opened it",
		).toBeFocused();

		// The dialog is the topmost layer again: its own Escape closes it, and
		// focus goes back to the chip that opened it.
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("project-files-button")).toBeFocused();
	});

	test("Escape from a Canvas's controls closes the panel and not the dialog under it", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		const open = openButton(dialog, names.canvas);
		await open.click();
		await expect(page.getByTestId("canvas-board")).toBeVisible({
			timeout: 30_000,
		});
		const panel = panelShell(page);
		// A control of the panel has focus, the way a keyboard reader gets there.
		await pressInsidePanel(page, panel, dialog, "Tab", 2);

		await page.keyboard.press("Escape");

		await expect(panel).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(open).toBeFocused();
	});

	test("the layers close one at a time, the topmost first: the Download popover, the panel, the dialog", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		const open = openButton(dialog, names.document);
		await open.click();
		const panel = panelShell(page);
		const download = panel.getByTestId("artifact-download-button");
		await expect(download).toBeVisible({ timeout: 30_000 });
		await download.click();
		const popover = page.getByTestId("document-download-popover");
		await expect(popover).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(popover).toHaveCount(0);
		await expect(panel).toHaveCount(1);
		await expect(dialog).toBeVisible();
		await expect(download, "the popover hands focus back").toBeFocused();

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(open).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});
});

test.describe("The panel over a project's Files dialog — phone", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("a tap opens the item over the sheet, Tab stays in the phone panel and one Escape closes only it", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		const open = openButton(dialog, names.document);
		await open.tap();
		const editor = page.locator(".document-editor-host .ProseMirror");
		await expect(editor).toBeVisible({ timeout: 30_000 });
		await editor.tap();

		const panel = panelShell(page);
		await expect(panel).toBeVisible();
		await pressInsidePanel(page, panel, dialog, "Tab", 6);
		await pressInsidePanel(page, panel, dialog, "Shift+Tab", 6);

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(open).toBeFocused();
	});
});

/**
 * The first-open tours' reader (RV-F, I-3). What the server said about a kind's
 * tour is kept for the life of the page, and signing out and in are
 * client-side navigations, so one tab outlives its readers: the panel has to
 * say whose answers it holds wherever it is hosted, and the sign-out has to
 * drop them. The project's Files dialog is the host that named no one.
 */
test.describe("The tours' reader, where the panel sits over the Files dialog", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
	});

	test("an in-tab sign-out and sign-in gives the next reader their own first tour", async ({
		page,
	}) => {
		const reader = await createTourUser();
		const nextReader = await createTourUser();
		const readers = {
			first: await seedMadeProject(reader.id),
			next: await seedMadeProject(nextReader.id),
		};

		// The first reader opens their first Canvas from the Files dialog and
		// finishes its tour: the page now holds "seen" for Canvas.
		await login(page, reader.email, reader.password);
		const dialog = await openFilesDialog(page, readers.first.projectId);
		await openButton(dialog, readers.first.names.canvas).click();
		await finishTour(page);
		await expect
			.poll(async () => (await tourRows(reader.id)).map((row) => row.status))
			.toEqual(["completed"]);
		await page.keyboard.press("Escape");
		await expect(panelShell(page)).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		// They sign out through the sidebar and the next reader signs in through
		// the form, on the same tab: no reload, so the page's memory is the same.
		await logout(page);
		await page.fill('input[name="email"]', nextReader.email);
		await page.fill('input[type="password"]', nextReader.password);
		await page.click('button[type="submit"]');
		await expect(page).toHaveURL("/", { timeout: 15_000 });
		await expect(page.getByTestId("message-input")).toBeVisible();

		// They go in-app to their own project and open their first Canvas ever.
		const requests = watchTourRequests(page);
		await ensureSidebarExpanded(page);
		const row = page
			.getByTestId("project-drop-target")
			.filter({ hasText: readers.next.projectName });
		await row.hover();
		await row
			.getByRole("button", { name: `Open ${readers.next.projectName}` })
			.click();
		await expect(page).toHaveURL(
			new RegExp(`/projects/${readers.next.projectId}$`),
		);
		const nextDialog = await openFilesDialogHere(page);
		await openButton(nextDialog, readers.next.names.canvas).click();

		// Their own tour, from their own answer: not the first reader's "seen".
		await expect(tourCard(page).last()).toBeVisible({ timeout: 20_000 });
		expect(requests.gets().map((entry) => entry.url)).toEqual([
			"/api/artifact-tours/canvas",
		]);
		expect(await tourRows(nextReader.id)).toHaveLength(0);
	});

	test("the first-open card is the innermost layer: one Escape skips it, the next closes the panel, the next the dialog", async ({
		page,
	}) => {
		const reader = await createTourUser();
		const seeded = await seedMadeProject(reader.id);
		await login(page, reader.email, reader.password);
		const dialog = await openFilesDialog(page, seeded.projectId);
		await openButton(dialog, seeded.names.canvas).click();
		const card = tourCard(page).last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		const panel = panelShell(page);

		await page.keyboard.press("Escape");
		await expect(card).toHaveCount(0);
		await expect(panel).toHaveCount(1);
		await expect(dialog).toBeVisible();
		await expect
			.poll(async () => (await tourRows(reader.id)).map((row) => row.status))
			.toEqual(["dismissed"]);

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(dialog).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});
});
