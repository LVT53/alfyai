import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	projectKnowledgeLinks,
} from "../../src/lib/server/db/schema";
import { login, waitForHydration } from "./helpers";

/**
 * A project's files (Workspaces Slice E, mockup §M5) — the Files modal, the
 * quiet line's files half and the library's linked token.
 *
 * The one claim every test in this file is written to defend: a project file is
 * an ordinary library document that the project *knows about*. Uploading into a
 * project adds the file to the library as well, and unlinking removes the
 * knowledge, never the file.
 *
 * Documents are created through the real upload endpoint rather than inserted
 * as rows: intake is what decides whether a file is prompt-ready, and a row
 * written by hand would let the preview test pass against a document the
 * product could never actually produce. `.txt` is the one type the extractor
 * settles inline, so the upload answer is also the extraction verdict.
 */

const UPLOAD_RAW_PATH = "/api/knowledge/upload/raw";

async function createProject(page: Page, name: string): Promise<string> {
	const response = await page.request.post("/api/projects", {
		data: { name },
	});
	expect(response.ok(), "creating a project must succeed").toBe(true);
	const project = (await response.json()) as { id: string };
	return project.id;
}

async function saveInstructions(
	page: Page,
	projectId: string,
	instructions: string,
): Promise<void> {
	const response = await page.request.patch(`/api/projects/${projectId}`, {
		data: { instructions },
	});
	expect(response.ok(), "saving instructions must succeed").toBe(true);
}

/** One ordinary library document, through the real (live) upload route. */
async function uploadLibraryDocument(
	page: Page,
	options: { name: string; body?: string },
): Promise<string> {
	const body = options.body ?? `Notes for ${options.name}\n`;
	const response = await page.request.post(UPLOAD_RAW_PATH, {
		headers: {
			"content-type": "text/plain",
			"x-alfyai-upload-name": encodeURIComponent(options.name),
			"x-alfyai-upload-size": String(Buffer.byteLength(body, "utf8")),
			"x-alfyai-upload-trace-id": `e2e-${randomUUID()}`,
		},
		data: body,
	});
	expect(response.ok(), `uploading ${options.name} must succeed`).toBe(true);
	const payload = (await response.json()) as { artifact: { id: string } };
	return payload.artifact.id;
}

async function linkArtifacts(
	page: Page,
	projectId: string,
	artifactIds: string[],
): Promise<void> {
	const response = await page.request.post(
		`/api/projects/${projectId}/knowledge`,
		{ data: { artifactIds } },
	);
	expect(response.ok(), "linking must succeed").toBe(true);
}

async function linkedCount(projectId: string): Promise<number> {
	const [row] = await db
		.select({ count: projectKnowledgeLinks.artifactId })
		.from(projectKnowledgeLinks)
		.where(eq(projectKnowledgeLinks.projectId, projectId));
	return row ? 1 : 0;
}

async function openProjectPage(page: Page, projectId: string) {
	await page.goto(`/projects/${projectId}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("project-greeting")).toBeVisible({
		timeout: 15000,
	});
	// The quiet line is server-rendered, so it is visible before the page can be
	// clicked: the chip's handler only exists once hydration has landed.
	await waitForHydration(page);
}

async function openFilesDialog(page: Page, projectId: string) {
	await openProjectPage(page, projectId);
	await page.getByTestId("project-files-button").click();
	const dialog = page.getByRole("dialog", { name: "Files" });
	await expect(dialog).toBeVisible({ timeout: 10000 });
	return dialog;
}

function fileRow(dialog: ReturnType<Page["getByRole"]>, name: string) {
	return dialog.getByTestId("project-file-row").filter({ hasText: name });
}

test.describe("Project files", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("opens the Files modal from the quiet line and lists the linked files", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const linked = await uploadLibraryDocument(page, {
			name: `Hotel Motto booking ${randomUUID().slice(0, 6)}.txt`,
		});
		await uploadLibraryDocument(page, {
			name: `Unlinked note ${randomUUID().slice(0, 6)}.txt`,
		});
		await linkArtifacts(page, projectId, [linked]);

		const dialog = await openFilesDialog(page, projectId);

		await expect(dialog.getByTestId("project-file-row")).toHaveCount(1);
		await expect(dialog.getByTestId("project-file-name")).toHaveText(
			/Hotel Motto booking/,
		);
		// The modal names the project it is filling, as a token rather than a
		// word in a sentence.
		await expect(dialog.getByTestId("scope-token")).toHaveText(projectName);
		// The footer is the one place the modal says what unlinking does.
		await expect(dialog.getByTestId("project-files-footer")).toHaveText(
			"1 file · removing it here keeps it in your library",
		);
	});

	test("unlinks a file and keeps it in the library", async ({ page }) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const documentName = `Railjet tickets ${randomUUID().slice(0, 6)}.txt`;
		const artifactId = await uploadLibraryDocument(page, {
			name: documentName,
		});
		await linkArtifacts(page, projectId, [artifactId]);

		const dialog = await openFilesDialog(page, projectId);
		const row = fileRow(dialog, documentName);
		await expect(row).toBeVisible();
		await row
			.getByRole("button", { name: `Remove ${documentName} from this project` })
			.click();

		await expect(dialog.getByTestId("project-file-row")).toHaveCount(0);
		await expect(dialog.getByTestId("project-files-empty")).toHaveText(
			"No files yet.",
		);
		expect(
			await linkedCount(projectId),
			"the link must be gone from the database",
		).toBe(0);

		// The file itself is untouched: the row the library reads still exists,
		// the library still lists it, and the library's own read is the proof
		// (not a cache the modal happened to hold).
		const [artifact] = await db
			.select({ id: artifacts.id, name: artifacts.name })
			.from(artifacts)
			.where(eq(artifacts.id, artifactId))
			.limit(1);
		expect(artifact?.name, "unlinking must not delete the document").toBe(
			documentName,
		);
		const library = await page.request.get("/api/knowledge");
		const payload = (await library.json()) as {
			documents?: { name: string }[];
		};
		expect(
			payload.documents?.some((document) => document.name === documentName),
			"the document must still be in the library",
		).toBe(true);

		// And the quiet line goes back to offering files rather than counting one.
		await expect(page.getByTestId("project-files-button")).toHaveText(
			"Add files",
		);
	});

	test("does not let a slow list read put back a file that was just removed", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const removedName = `Railjet tickets ${randomUUID().slice(0, 6)}.txt`;
		const keptName = `Hotel Motto ${randomUUID().slice(0, 6)}.txt`;
		const removedId = await uploadLibraryDocument(page, { name: removedName });
		const keptId = await uploadLibraryDocument(page, { name: keptName });
		await linkArtifacts(page, projectId, [removedId, keptId]);

		// The page's FIRST read of the file list is answered by the server while
		// both files are still linked, and handed to the browser only later — a
		// slow response overtaking a fast one. `route.fetch()` is what makes the
		// snapshot real: delaying `continue()` would send the request late and
		// fetch the post-removal answer instead, which is a different (and
		// harmless) scenario.
		let releaseStale = () => {};
		const staleHeld = new Promise<void>((resolve) => {
			releaseStale = resolve;
		});
		let staleAnswered = false;
		await page.route(
			`**/api/projects/${projectId}/knowledge`,
			async (route) => {
				if (route.request().method() !== "GET") {
					await route.continue();
					return;
				}
				if (staleAnswered) {
					await route.continue();
					return;
				}
				staleAnswered = true;
				const response = await route.fetch();
				await staleHeld;
				await route.fulfill({ response });
			},
		);

		const dialog = await openFilesDialog(page, projectId);
		const removedRow = fileRow(dialog, removedName);
		await expect(removedRow).toBeVisible();
		await removedRow
			.getByRole("button", { name: `Remove ${removedName} from this project` })
			.click();
		await expect(dialog.getByTestId("project-file-row")).toHaveCount(1);
		await expect(fileRow(dialog, keptName)).toBeVisible();

		// The stale read lands now, carrying the list as it was before the
		// removal. Nothing about it is newer than the list already on screen, so
		// it must lose.
		releaseStale();
		await expect(
			dialog.getByTestId("project-file-row"),
			"the stale read must not resurrect the removed file",
		).toHaveCount(1);
		await expect(fileRow(dialog, removedName)).toHaveCount(0);
		await expect(fileRow(dialog, keptName)).toBeVisible();

		const links = await db
			.select({ artifactId: projectKnowledgeLinks.artifactId })
			.from(projectKnowledgeLinks)
			.where(eq(projectKnowledgeLinks.projectId, projectId));
		expect(
			links.map((link) => link.artifactId),
			"the removal is the durable state; the slow read changed nothing",
		).toEqual([keptId]);
	});

	test("says it is loading, not that a project with files is empty, while the list is read", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const documentName = `Railjet tickets ${randomUUID().slice(0, 6)}.txt`;
		const artifactId = await uploadLibraryDocument(page, {
			name: documentName,
		});
		await linkArtifacts(page, projectId, [artifactId]);

		// Every read of the list is held until released, which keeps the modal
		// inside the window the page's mount-time read leaves open — the window
		// in which it used to say "No files yet." about this very file.
		let releaseReads = () => {};
		const readsHeld = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		await page.route(
			`**/api/projects/${projectId}/knowledge`,
			async (route) => {
				if (route.request().method() === "GET") await readsHeld;
				await route.continue();
			},
		);

		const dialog = await openFilesDialog(page, projectId);
		await expect(dialog.getByTestId("project-files-loading")).toHaveText(
			"Loading…",
		);
		await expect(dialog.getByTestId("project-files-empty")).toHaveCount(0);

		releaseReads();
		await expect(fileRow(dialog, documentName)).toBeVisible();
		await expect(dialog.getByTestId("project-files-loading")).toHaveCount(0);
		await expect(dialog.getByTestId("project-files-footer")).toHaveText(
			"1 file · removing it here keeps it in your library",
		);
	});

	test("uploads a file into the project, showing it in both the modal and the library", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const documentName = `Museum list ${randomUUID().slice(0, 6)}.txt`;

		const dialog = await openFilesDialog(page, projectId);
		await expect(dialog.getByTestId("project-files-empty")).toBeVisible();

		const [chooser] = await Promise.all([
			page.waitForEvent("filechooser"),
			dialog.getByRole("button", { name: "Upload" }).click(),
		]);
		await chooser.setFiles({
			name: documentName,
			mimeType: "text/plain",
			buffer: Buffer.from("Kunsthistorisches Museum, 10:00–18:00\n", "utf8"),
		});

		// The modal's own list is the first half of the claim: the upload was
		// started from inside the project, so the file arrives already linked.
		await expect(dialog.getByTestId("project-file-row")).toHaveCount(1, {
			timeout: 20000,
		});
		await expect(dialog.getByTestId("project-file-name")).toHaveText(
			documentName,
		);
		await expect(dialog.getByTestId("project-files-footer")).toHaveText(
			"1 file · removing it here keeps it in your library",
		);
		expect(await linkedCount(projectId)).toBe(1);

		// The second half: it is an ordinary library document, not a project-only
		// attachment.
		const library = await page.request.get("/api/knowledge");
		const payload = (await library.json()) as {
			documents?: { name: string }[];
		};
		expect(
			payload.documents?.some((document) => document.name === documentName),
		).toBe(true);

		await dialog.getByRole("button", { name: "Done" }).click();
		await expect(page.getByTestId("project-files-button")).toHaveText("1 file");
	});

	test("adds from the library, with already-added documents greyed out", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const alreadyName = `Already added ${randomUUID().slice(0, 6)}.txt`;
		const newName = `Not yet added ${randomUUID().slice(0, 6)}.txt`;
		const alreadyId = await uploadLibraryDocument(page, { name: alreadyName });
		await uploadLibraryDocument(page, { name: newName });
		await linkArtifacts(page, projectId, [alreadyId]);

		const dialog = await openFilesDialog(page, projectId);
		await dialog.getByRole("button", { name: "Add from library" }).click();
		const picker = page.getByRole("dialog", { name: "Add from library" });
		await expect(picker).toBeVisible({ timeout: 10000 });

		// A document the project already knows is offered, marked, and not
		// selectable — the alternative is a checkbox that silently does nothing.
		const alreadyRow = picker
			.getByTestId("add-from-library-row")
			.filter({ hasText: alreadyName });
		await expect(alreadyRow).toContainText("already added");
		await expect(
			alreadyRow.getByTestId("add-from-library-checkbox"),
		).toBeDisabled();

		const confirm = picker.getByTestId("add-from-library-confirm");
		await expect(confirm).toBeDisabled();
		await expect(confirm).toHaveText("Add 0 documents");

		const newRow = picker
			.getByTestId("add-from-library-row")
			.filter({ hasText: newName });
		await newRow.getByTestId("add-from-library-checkbox").check();
		await expect(confirm).toBeEnabled();
		await expect(confirm).toHaveText("Add 1 document");
		await confirm.click();

		await expect(picker).toHaveCount(0, { timeout: 10000 });
		await expect(dialog.getByTestId("project-file-row")).toHaveCount(2);
		await expect(dialog.getByTestId("project-files-footer")).toHaveText(
			"2 files · removing one here keeps it in your library",
		);
	});

	test("shows the asset count on the quiet line after linking", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const first = await uploadLibraryDocument(page, {
			name: `First ${randomUUID().slice(0, 6)}.txt`,
		});

		await openProjectPage(page, projectId);
		await expect(page.getByTestId("project-files-button")).toHaveText(
			"Add files",
		);

		await linkArtifacts(page, projectId, [first]);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("project-files-button")).toHaveText("1 file");

		const second = await uploadLibraryDocument(page, {
			name: `Second ${randomUUID().slice(0, 6)}.txt`,
		});
		await linkArtifacts(page, projectId, [second]);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("project-files-button")).toHaveText(
			"2 files",
		);
	});

	test("shows the empty line with Add instructions · Add files for a fresh project", async ({
		page,
	}) => {
		const projectName = `Fresh trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);

		await openProjectPage(page, projectId);
		await expect(page.getByTestId("project-instructions-button")).toHaveText(
			"Add instructions",
		);
		await expect(page.getByTestId("project-files-button")).toHaveText(
			"Add files",
		);
		// The middot separates the two halves only when there are two halves: an
		// empty project must not read "Add instructions · Add files" as if the
		// separator stood between two things it has.
		await expect(page.getByTestId("project-quiet-separator")).toHaveCount(0);

		await saveInstructions(page, projectId, "Only suggest trains.");
		const document = await uploadLibraryDocument(page, {
			name: `Ticket ${randomUUID().slice(0, 6)}.txt`,
		});
		await linkArtifacts(page, projectId, [document]);

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("project-instructions-button")).toHaveText(
			"Instructions",
		);
		await expect(page.getByTestId("project-files-button")).toHaveText("1 file");
		await expect(page.getByTestId("project-quiet-separator")).toHaveCount(1);
	});

	test("previews a file from a row without leaving the project page", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const documentName = `Museum hours ${randomUUID().slice(0, 6)}.txt`;
		const artifactId = await uploadLibraryDocument(page, {
			name: documentName,
		});
		await linkArtifacts(page, projectId, [artifactId]);

		const dialog = await openFilesDialog(page, projectId);
		await fileRow(dialog, documentName)
			.getByRole("button", { name: `Preview ${documentName}` })
			.click();

		// The shared workspace, over the modal, on the project's own URL: the
		// point of the preview action is that reading a file does not cost the
		// user their place.
		await expect(page.getByTestId("workspace-main")).toBeVisible({
			timeout: 15000,
		});
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
		await expect(page.getByTestId("workspace-main")).toContainText(
			documentName,
		);
	});

	test("shows the linked token on the Knowledge documents table", async ({
		page,
	}) => {
		const documentName = `Token document ${randomUUID().slice(0, 6)}.txt`;
		const artifactId = await uploadLibraryDocument(page, {
			name: documentName,
		});
		const single = await createProject(
			page,
			`One project ${randomUUID().slice(0, 6)}`,
		);
		await linkArtifacts(page, single, [artifactId]);
		// A second document in two projects proves the count counts projects, and
		// not the links that happen to resolve for the row.
		const sharedName = `Token shared ${randomUUID().slice(0, 6)}.txt`;
		const sharedId = await uploadLibraryDocument(page, { name: sharedName });
		await linkArtifacts(page, single, [sharedId]);
		await linkArtifacts(
			page,
			await createProject(page, `Two projects ${randomUUID().slice(0, 6)}`),
			[sharedId],
		);

		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "Knowledge Base" }),
		).toBeVisible();
		await waitForHydration(page);
		await page.getByRole("tab", { name: "Documents" }).click();

		const singleRow = page
			.locator("tbody tr")
			.filter({ hasText: documentName });
		await expect(singleRow.getByTestId("project-link-token")).toHaveText(
			"In 1 project",
		);

		const sharedRow = page.locator("tbody tr").filter({ hasText: sharedName });
		await expect(sharedRow.getByTestId("project-link-token")).toHaveText(
			"In 2 projects",
		);

		// A document no project knows has no token at all.
		const looseName = `Token loose ${randomUUID().slice(0, 6)}.txt`;
		await uploadLibraryDocument(page, { name: looseName });
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.getByRole("tab", { name: "Documents" }).click();
		const looseRow = page.locator("tbody tr").filter({ hasText: looseName });
		await expect(looseRow).toBeVisible({ timeout: 15000 });
		await expect(looseRow.getByTestId("project-link-token")).toHaveCount(0);
	});
});

/**
 * §M5 at 390×844 (slice-E.md's own visual check runs §M5 and §M8 at both
 * widths). The mockup draws six columns; a phone has room for the file and its
 * facts, so the row reflows rather than the page sliding sideways, and the
 * modal arrives as the app's sheet.
 */
test.describe("Project files — phone", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("reflows the file rows into the sheet instead of sliding sideways", async ({
		page,
	}) => {
		const projectName = `Vienna trip ${randomUUID().slice(0, 8)}`;
		const projectId = await createProject(page, projectName);
		const documentName = `Hotel Motto booking ${randomUUID().slice(0, 6)}.txt`;
		await linkArtifacts(page, projectId, [
			await uploadLibraryDocument(page, { name: documentName }),
		]);

		const dialog = await openFilesDialog(page, projectId);
		await expect(dialog).toHaveClass(/dialog-sheet/);
		await expect(page.getByTestId("dialog-sheet-grabber")).toBeVisible();

		const sheet = await dialog.boundingBox();
		expect(sheet?.width ?? 0).toBeLessThanOrEqual(390);
		// A sheet sits at the bottom of the screen it is a sheet of.
		expect(
			Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0)),
			"the sheet must reach the bottom of the viewport",
		).toBeGreaterThanOrEqual(840);

		// The page itself does not slide: the row reflows inside the sheet.
		const widths = await page.evaluate(() => ({
			scroll: document.documentElement.scrollWidth,
			client: document.documentElement.clientWidth,
		}));
		expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

		// Every fact of the file, and both row actions, are inside the sheet —
		// the six-column grid is what would push them out of it.
		const row = fileRow(dialog, documentName);
		await expect(row).toBeVisible();
		for (const cell of [
			row.getByTestId("project-file-name"),
			row.getByRole("button", { name: `Preview ${documentName}` }),
			row.getByRole("button", {
				name: `Remove ${documentName} from this project`,
			}),
		]) {
			const box = await cell.boundingBox();
			expect(box?.width ?? 0).toBeGreaterThan(0);
			expect(
				Math.round((box?.x ?? 0) + (box?.width ?? 0)),
				"nothing may sit past the right edge of a 390px screen",
			).toBeLessThanOrEqual(390);
		}

		// The footer keeps saying what unlinking does, and Done stays reachable.
		await expect(dialog.getByTestId("project-files-footer")).toContainText(
			"removing it here keeps it in your library",
		);
		await expect(dialog.getByRole("button", { name: "Done" })).toBeInViewport();

		// And the reflow is the reflow, not just "it fits": the column headings
		// are gone (they name a grid that no longer exists at this width) and the
		// file's three facts stack UNDER its name, in the name's own column. The
		// desktop grid puts them in cells of their own on the same line, which is
		// what a lost media query would restore.
		await expect(dialog.locator(".files-row--head")).toBeHidden();
		const nameBox = await row.getByTestId("project-file-name").boundingBox();
		for (const fact of [
			row.locator(".files-type"),
			row.locator(".files-size"),
			row.locator(".files-added"),
		]) {
			const box = await fact.boundingBox();
			expect(
				Math.round(box?.x ?? 0),
				"a fact belongs in the file-name column, under it",
			).toBe(Math.round(nameBox?.x ?? 0));
			expect(
				box?.y ?? 0,
				"a fact belongs below the file's name",
			).toBeGreaterThanOrEqual((nameBox?.y ?? 0) + (nameBox?.height ?? 0));
		}
	});
});
