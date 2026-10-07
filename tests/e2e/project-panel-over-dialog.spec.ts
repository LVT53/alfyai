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
	waitForMotionToSettle,
	waitForStableBoundingBox,
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
	projectId: string | null,
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

	// RV-F, M-11: "This chat", a button back to a list the dialog does not have.
	test("opens an item with no breadcrumb back to a chat's list", async ({
		page,
	}) => {
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		await openButton(dialog, names.document).click();
		const panel = panelShell(page);
		await expect(panel.getByTestId("artifact-panel-title")).toHaveText(
			names.document,
		);

		await expect(panel.getByRole("button", { name: /this chat/i })).toHaveCount(
			0,
		);
		// What the header does have is where it always was.
		await expect(panel.getByTestId("artifact-download-button")).toBeVisible();
		await expect(
			panel.getByRole("button", { name: "Close document workspace" }),
		).toBeVisible();
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

	test("closing the panel with its own Close button leaves the dialog and gives focus back to the row too", async ({
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

		await panel
			.getByRole("button", { name: "Close document workspace" })
			.click();

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

test.describe("The Files dialog's footer", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	// RV-F, M-6: "3 items · removing one here keeps it in your library" under a
	// list none of whose rows has a way to remove it.
	test("promises removal only while a row on the list offers it", async ({
		page,
	}) => {
		const userId = await testUserId();
		const { projectId } = await seedMadeProject(userId);
		const dialog = await openFilesDialog(page, projectId);
		const footer = dialog.getByTestId("project-files-footer");

		await expect(dialog.getByTestId("project-file-row")).toHaveCount(3);
		await expect(dialog.getByTestId("project-file-unlink")).toHaveCount(0);
		await expect(footer).toHaveText("3 items");

		// A Document made in a chat outside the project and linked from the
		// library is the one kind of row here that can be removed.
		const outsideChat = await seedProjectChat(userId, null, "Packing chat");
		const packing = await createDocumentArtifact({
			userId,
			conversationId: outsideChat,
			title: `Packing list ${randomUUID().slice(0, 6)}`,
			markdown: "## Packing\n\nPassport, charger.",
			author: "alfy",
			summary: "Seeded for E2E",
		});
		const linked = await page.request.post(
			`/api/projects/${projectId}/knowledge`,
			{ data: { artifactIds: [packing.id] } },
		);
		expect(linked.ok(), "linking must succeed").toBe(true);
		await dialog.getByRole("button", { name: "Done" }).click();
		await expect(dialog).toHaveCount(0);

		const reopened = await openFilesDialogHere(page);
		await expect(reopened.getByTestId("project-file-row")).toHaveCount(4);
		await expect(reopened.getByTestId("project-file-unlink")).toHaveCount(1);
		await expect(reopened.getByTestId("project-files-footer")).toHaveText(
			"4 items · removing one here keeps it in your library",
		);
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

/**
 * A press outside the expanded panel while it sits over the Files dialog
 * (FX-B2, 1). The panel leaves a ring of the dialog's own scrim around itself
 * (20 px, more on a wide window), and a press there is a press on the dialog
 * as far as the browser goes: the panel closes on it, and the same press's
 * click then reached the dialog's scrim, which closed the dialog too. A press
 * closes the layer that was on top when it began and no other, which is what
 * one Escape does.
 */

/**
 * A layer is still there once whatever was fading out has finished: a dialog
 * that is closing stays "visible" to a bare `toBeVisible()` for the length of
 * its fade, so the answer is asked after the motion has settled.
 */
async function expectLayerStays(page: Page, layer: Locator, message: string) {
	await waitForMotionToSettle(page);
	await expect(layer, message).toHaveCount(1);
	await expect(layer, message).toBeVisible();
}

/** A real press on the dialog's scrim, in the ring the expanded panel leaves round itself. */
async function pressRing(page: Page, panel: Locator) {
	await waitForStableBoundingBox(panel);
	await waitForMotionToSettle(page);
	const box = await panel.boundingBox();
	if (!box) throw new Error("the panel has no box to leave a ring round");
	expect(box.x, "the panel leaves a ring on its left").toBeGreaterThan(4);
	await page.mouse.click(box.x / 2, box.y + box.height / 2);
}

test.describe("A press outside the panel over a project's Files dialog", () => {
	for (const width of [1440, 1920]) {
		test(`closes the panel and not the dialog under it (${width} px wide)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 1000 });
			await login(page);
			const { projectId, names } = await seedMadeProject(await testUserId());
			const dialog = await openFilesDialog(page, projectId);
			await openButton(dialog, names.document).click();
			const panel = panelShell(page);
			await expect(panel.getByTestId("artifact-panel-title")).toBeVisible({
				timeout: 30_000,
			});

			await pressRing(page, panel);

			await expect(panel).toHaveCount(0);
			await expectLayerStays(page, dialog, "the dialog is still there");

			// The dialog is the topmost layer again, and answers the keys as its own.
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(page.getByTestId("project-files-button")).toBeFocused();
		});
	}

	test("hands focus back to the row that opened the panel, not to the scrim that was pressed (RC-F MIN-4)", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		const row = openButton(dialog, names.document);
		await row.click();
		const panel = panelShell(page);
		await expect(panel.getByTestId("artifact-panel-title")).toBeVisible({
			timeout: 30_000,
		});

		await pressRing(page, panel);
		await expect(panel).toHaveCount(0);

		// Chrome focuses a button that is pressed: the scrim is one, and a person
		// who pressed beside the panel to put it away is where they were before it.
		await expect(
			row,
			"focus is on the row that opened the panel",
		).toBeFocused();
		await expect(dialog).toHaveCount(1);

		// And Escape, now that the dialog is on top again, closes the dialog as its own.
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});

	test("with the Download popover open, closes the popover only; the next closes the panel, the next the dialog", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		await openButton(dialog, names.document).click();
		const panel = panelShell(page);
		const download = panel.getByTestId("artifact-download-button");
		await expect(download).toBeVisible({ timeout: 30_000 });
		await download.click();
		const popover = page.getByTestId("document-download-popover");
		await expect(popover).toBeVisible();

		await pressRing(page, panel);
		await expect(popover).toHaveCount(0);
		await expectLayerStays(page, panel, "the panel is still there");
		await expectLayerStays(page, dialog, "the dialog is still there");

		await pressRing(page, panel);
		await expect(panel).toHaveCount(0);
		await expectLayerStays(page, dialog, "the dialog is still there");

		await page.mouse.click(8, 500);
		await expect(dialog).toHaveCount(0);
	});

	test("inside the panel's own popover leaves the panel open", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		await openButton(dialog, names.document).click();
		const panel = panelShell(page);
		const download = panel.getByTestId("artifact-download-button");
		await expect(download).toBeVisible({ timeout: 30_000 });
		await download.click();
		const popover = page.getByTestId("document-download-popover");
		await expect(popover).toBeVisible();
		const box = await popover.boundingBox();
		if (!box) throw new Error("the popover has no box");

		// The popover is a layer of its own, painted outside the panel's markup:
		// a press on its heading is a press on the popover, not outside the panel.
		await page.mouse.click(box.x + 40, box.y + 20);

		await expectLayerStays(page, panel, "the panel is still there");
		await expect(popover).toBeVisible();
		await expectLayerStays(page, dialog, "the dialog is still there");
	});
});

/**
 * What assistive technology is told about the layers (FX-B2, 2). The Files
 * dialog is an `aria-modal` dialog, and the panel is an `aside` that stays where
 * its page put it, so it is not even later in the document than the dialog (a
 * dialog is moved to the end of <body> when it opens). A screen reader that
 * limits itself to the modal layer would have been left in the dialog with the
 * panel hidden from it. While the panel sits over the dialog it is the one
 * modal layer, and the dialog stops claiming to be one until the panel is gone.
 *
 * Asked of the browser's own accessibility tree (what the platform's screen
 * readers are given), not only of the markup.
 */

type AxNode = {
	ignored?: boolean;
	name?: { value?: string };
	properties?: { name: string; value?: { value?: unknown } }[];
};

/** The names of the layers the browser's accessibility tree says are modal. */
async function modalLayers(page: Page): Promise<string[]> {
	const client = await page.context().newCDPSession(page);
	try {
		await client.send("Accessibility.enable");
		const { nodes } = (await client.send("Accessibility.getFullAXTree")) as {
			nodes: AxNode[];
		};
		return nodes
			.filter(
				(node) =>
					!node.ignored &&
					node.properties?.some(
						(property) =>
							property.name === "modal" && property.value?.value === true,
					),
			)
			.map((node) => node.name?.value ?? "");
	} finally {
		await client.detach();
	}
}

test.describe("The panel as the modal layer over a project's Files dialog", () => {
	test("is the one modal layer while it sits over the dialog, and the dialog is again once it is gone", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		await expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(await modalLayers(page)).toEqual(["Files"]);

		await openButton(dialog, names.document).click();
		const panel = page.getByRole("dialog", {
			name: `${names.document}, Document`,
		});
		await expect(panel).toBeVisible({ timeout: 30_000 });
		await expect(panel).toHaveAttribute("aria-modal", "true");

		// One modal layer in the markup that is shown (the panel's twin for the
		// other viewport is not rendered) and in the browser's own tree: the panel.
		await expect(page.locator('[aria-modal="true"]:visible')).toHaveCount(1);
		await expect(dialog).toHaveAttribute("aria-modal", "false");
		await expect
			.poll(() => modalLayers(page))
			.toEqual([`${names.document}, Document`]);
		// Nothing above the panel hides it from assistive technology.
		expect(
			await panel.evaluate(
				(node) => node.closest('[aria-hidden="true"], [inert]') === null,
			),
		).toBe(true);

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(dialog).toHaveAttribute("aria-modal", "true");
		await expect(page.locator('[aria-modal="true"]:visible')).toHaveCount(1);
		await expect.poll(() => modalLayers(page)).toEqual(["Files"]);
	});
});

test.describe("The panel as the modal layer over the Files sheet — phone", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test("is the one modal layer on a phone too", async ({ page }) => {
		await login(page);
		const { projectId, names } = await seedMadeProject(await testUserId());
		const dialog = await openFilesDialog(page, projectId);
		expect(await modalLayers(page)).toEqual(["Files"]);

		await openButton(dialog, names.document).tap();
		const panel = page.getByRole("dialog", {
			name: `${names.document}, Document`,
		});
		await expect(panel).toBeVisible({ timeout: 30_000 });

		await expect(page.locator('[aria-modal="true"]:visible')).toHaveCount(1);
		await expect(dialog).toHaveAttribute("aria-modal", "false");
		await expect
			.poll(() => modalLayers(page))
			.toEqual([`${names.document}, Document`]);

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(dialog).toHaveAttribute("aria-modal", "true");
		await expect.poll(() => modalLayers(page)).toEqual(["Files"]);
	});
});

/**
 * The page's scroll lock (FX-B2, 3). The Files dialog locks the page while it is
 * open and releases it when the last layer on the dialog stack is gone. With the
 * panel open over it, a browser Back takes the whole page away under both: the
 * dialog was torn down first, found the panel still on the stack and left the
 * lock, and nothing released it after the panel had gone too.
 */
const pageScrollLock = (page: Page) =>
	page.evaluate(() => document.body.style.overflow);

test.describe("The page's scroll lock under a project's Files dialog", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
	});

	test("is held while a layer is open and released when the last one closes", async ({
		page,
	}) => {
		await login(page);
		const { projectId, names } = await seedMadeProject(await testUserId());
		await openProjectPage(page, projectId);
		expect(await pageScrollLock(page)).toBe("");

		const dialog = await openFilesDialogHere(page);
		expect(await pageScrollLock(page)).toBe("hidden");

		await openButton(dialog, names.document).click();
		const panel = panelShell(page);
		await expect(panel.getByTestId("artifact-panel-title")).toBeVisible({
			timeout: 30_000,
		});
		expect(await pageScrollLock(page)).toBe("hidden");

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(dialog).toBeVisible();
		expect(await pageScrollLock(page)).toBe("hidden");

		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => pageScrollLock(page)).toBe("");
	});

	test("is released when browser Back takes the page away under the dialog and the panel", async ({
		page,
	}) => {
		const { projectId, projectName, names } = await seedMadeProject(
			await testUserId(),
		);
		await login(page);
		// In through the app, so that Back is the app's own navigation and the
		// tab keeps the page it has (a reload would start a page with no lock).
		await ensureSidebarExpanded(page);
		const row = page
			.getByTestId("project-drop-target")
			.filter({ hasText: projectName });
		await row.hover();
		await row.getByRole("button", { name: `Open ${projectName}` }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
		await waitForHydration(page);
		const dialog = await openFilesDialogHere(page);
		await openButton(dialog, names.document).click();
		await expect(
			panelShell(page).getByTestId("artifact-panel-title"),
		).toBeVisible({ timeout: 30_000 });
		expect(await pageScrollLock(page)).toBe("hidden");
		// A mark on the page the tab holds: Back must not be a reload, which
		// would start a page with no lock whatever the dialog did.
		await page.evaluate(() => {
			(window as unknown as { __sameDocument: boolean }).__sameDocument = true;
		});

		await page.goBack();

		await expect(page).toHaveURL("/");
		await expect(page.getByTestId("message-input")).toBeVisible();
		await expect(dialog).toHaveCount(0);
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __sameDocument?: boolean }).__sameDocument,
			),
			"Back was the app's own navigation, not a reload",
		).toBe(true);
		await expect.poll(() => pageScrollLock(page)).toBe("");
	});
});
