import { randomUUID } from "node:crypto";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	conversations,
	fileProductionJobs,
	users,
} from "../../src/lib/server/db/schema";
import {
	buildGeneratedDocumentSource,
	createDocumentArtifact,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import { parseDocument } from "../../src/lib/shared/artifact-document/blocks";
import { formatByteSize } from "../../src/lib/utils/format";
import {
	APP_HTML,
	APP_TITLE,
	bytesOf,
	cleanUpConversation,
	jobDto,
	seedApp,
	seedDocument,
	seedSucceededAppJob,
	TITLE,
} from "./artifact-download-helpers";
import { login, TEST_EMAIL, waitForHydration } from "./helpers";

/**
 * The page opens on Documents (friction audit F23, ruling 77); the Memory
 * Profile is its first tab and one real click away.
 */
async function openMemoryProfile(page: Page) {
	await page.getByRole("tab", { name: "Memory Profile" }).click();
	await expect(page).toHaveURL(/tab=memory/);
	await expect(
		page.getByRole("heading", { name: "About You", exact: true }),
	).toBeVisible();
}

/**
 * A source-first PDF the way `produce_file` makes one for a reply (the produce route,
 * a normal job): the library lists it as a generated row. An EXPORT is not a way to
 * get one any more (FB-8: a Download is delivery, it makes no row of the library).
 * Resolves with the job's file once it has been made.
 */
async function produceGeneratedPdf(
	request: APIRequestContext,
	conversationId: string,
	title: string,
): Promise<{ id: string; sizeBytes: number }> {
	const produced = await request.post("/api/chat/files/produce", {
		data: {
			conversationId,
			idempotencyKey: randomUUID(),
			requestTitle: title,
			sourceMode: "document_source",
			documentSource: buildGeneratedDocumentSource({
				title,
				blocks: parseDocument("Book the hotel. Then the museum.", {
					mint: false,
				}).blocks,
			}),
			requestedOutputs: [{ type: "pdf" }],
		},
	});
	expect(produced.status()).toBe(202);
	const { job } = (await produced.json()) as { job: { id: string } };
	let file: { id: string; sizeBytes: number } | null = null;
	await expect
		.poll(
			async () => {
				const read = await request.get(`/api/chat/files/jobs/${job.id}`);
				const body = (await read.json()) as {
					job: {
						status: string;
						files: { id: string; sizeBytes: number }[];
					};
				};
				file =
					body.job.status === "succeeded" ? (body.job.files[0] ?? null) : null;
				return file?.sizeBytes ?? null;
			},
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(1_000);
	if (!file) throw new Error("the produced PDF is missing");
	return file;
}

test.describe("Knowledge page", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "Knowledge Base" }),
		).toBeVisible();
		await waitForHydration(page);
	});

	test("opens on Documents, and the Memory Profile is one click away and reopens on a reload", {
		tag: "@smoke",
	}, async ({ page }) => {
		const documentsTab = page.getByRole("tab", { name: "Documents" });
		const memoryTab = page.getByRole("tab", { name: "Memory Profile" });
		await expect(documentsTab).toHaveAttribute("aria-selected", "true");
		await expect(memoryTab).toHaveAttribute("aria-selected", "false");
		await expect(page.getByRole("region", { name: "Documents" })).toBeVisible();
		await expect(page).not.toHaveURL(/[?&]tab=/);

		await memoryTab.click();
		await expect(page).toHaveURL(/tab=memory/);
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toBeVisible();

		// The URL is the page's own state: the reload opens where the reader was.
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await expect(memoryTab).toHaveAttribute("aria-selected", "true");

		await documentsTab.click();
		await expect(documentsTab).toHaveAttribute("aria-selected", "true");
		await expect(page).not.toHaveURL(/[?&]tab=/);
	});

	test("documents section is visible", { tag: "@smoke" }, async ({ page }) => {
		await page.getByRole("tab", { name: "Documents" }).click();
		await expect(
			page.getByRole("heading", { name: "Documents" }),
		).toBeVisible();
		await expect(page.getByRole("region", { name: "Documents" })).toBeVisible();
		const searchbox = page.getByRole("searchbox", { name: "Search documents" });
		if ((await searchbox.count()) > 0) {
			await expect(searchbox).toBeVisible();
		} else {
			// Exact: Step 14 gave the zero-count Documents chip its own "No
			// documents yet" reason (`title`/`aria-describedby`), which a loose
			// match against this empty-state heading would also catch.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
		}
	});

	test("memory profile section is visible", async ({ page }) => {
		await openMemoryProfile(page);
		await expect(
			page.getByRole("tab", { name: "Memory Profile" }),
		).toBeVisible();
		// exact: true — the persona summary card heading ("What I remember about
		// you") otherwise also matches the "About You" substring.
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Preferences", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Goals & Ongoing Work", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", {
				name: "Constraints & Boundaries",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /refresh|reload/i }),
		).toHaveCount(0);
		await expect(
			page.getByText(/Focus Continuity|task memory|raw/i),
		).toHaveCount(0);
	});

	test("document list does not render filter pills", async ({ page }) => {
		await page.getByRole("tab", { name: "Documents" }).click();
		await expect(
			page.getByRole("radiogroup", { name: "Document filter" }),
		).toHaveCount(0);
		const filterOptionInputs = page.locator(
			'input[type="radio"][name="document-filter"]',
		);
		await expect(filterOptionInputs).toHaveCount(0);
	});

	test("opening a knowledge document does not trigger runtime page errors", async ({
		page,
	}) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => {
			pageErrors.push(error.message);
		});

		await page.getByRole("tab", { name: "Documents" }).click();
		const firstDocumentRow = page.locator("tbody tr").first();
		if ((await firstDocumentRow.count()) === 0) {
			// Exact: see the note in "documents section is visible" above.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
			expect(pageErrors).toEqual([]);
			return;
		}
		await expect(firstDocumentRow).toBeVisible();
		await firstDocumentRow.click();
		// Opening a row requests the document workspace. Whether the preview
		// surface actually mounts depends on the document's retrievable content
		// (uploads without served preview content will not), so treat the
		// workspace as best-effort — the assertion under test is that opening a
		// document does not throw a runtime page error.
		await page
			.getByTestId("workspace-main")
			.waitFor({ state: "visible", timeout: 10000 })
			.catch(() => {});

		expect(pageErrors).toEqual([]);
	});

	test("the page title is the shared serif size", async ({ page }) => {
		const size = await page
			.getByRole("heading", { name: "Knowledge Base" })
			.evaluate((node) => getComputedStyle(node).fontSize);
		// 1.75rem against a 16px root.
		expect(size).toBe("28px");
	});

	test("each memory category states its own total", async ({ page }) => {
		await openMemoryProfile(page);
		const counts = page.getByTestId("memory-category-count");
		await expect(counts.first()).toBeVisible();
		// "N remembered · showing M" — never a bare list length.
		await expect(counts.first()).toHaveText(/remembered/);
	});

	test("the memory filter narrows every category at once", async ({ page }) => {
		await openMemoryProfile(page);
		const filter = page.getByRole("searchbox", { name: "Filter memories" });
		await expect(filter).toBeVisible();

		await filter.fill("zzz-no-such-memory-xyz");
		// With nothing matching anywhere, the card says so once rather than
		// leaving four silently short lists.
		await expect(page.getByTestId("memory-filter-no-matches")).toBeVisible();

		await filter.fill("");
		await expect(page.getByTestId("memory-filter-no-matches")).toHaveCount(0);
	});

	test("the filter chips carry a count and narrow to one category", async ({
		page,
	}) => {
		await openMemoryProfile(page);
		const chips = page.getByTestId("memory-filter-chip");
		await expect(chips.first()).toBeVisible();
		// All, plus one per category.
		expect(await chips.count()).toBe(5);

		await chips.nth(2).click();
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toHaveCount(0);

		await chips.nth(0).click();
		await expect(
			page.getByRole("heading", { name: "About You", exact: true }),
		).toBeVisible();
	});

	test("the rail explains how to read a row and how to reach the settings", async ({
		page,
	}) => {
		await openMemoryProfile(page);
		// "Reading a row" is a tooltip on the portrait title now, not a card at
		// the bottom of the rail: nothing on the page until it is asked for.
		await expect(page.getByText("Reading a row")).toHaveCount(0);
		await page.getByRole("button", { name: "Reading a row" }).focus();
		const legend = page.getByRole("tooltip");
		await expect(legend).toBeVisible();
		await expect(legend).toContainText("Reading a row");
		await expect(legend).toContainText("you said it");

		// Scoped to the card: an empty category's hint also links to memory
		// settings, so the bare name matches several links on this page.
		const aboutCard = page
			.getByRole("heading", { name: "What this is for" })
			.locator("xpath=ancestor::section[1]");
		await expect(aboutCard).toBeVisible();
		await expect(
			aboutCard.getByRole("link", { name: "Memory settings" }),
		).toBeVisible();
		await expect(
			aboutCard.getByRole("link", { name: /Clear memory and knowledge/ }),
		).toBeVisible();
	});

	test("documents give version and status columns of their own", async ({
		page,
	}) => {
		await page.getByRole("tab", { name: "Documents" }).click();

		const table = page.locator("table.documents-table");
		if ((await table.count()) === 0) {
			// No documents seeded in this run; the table is not drawn at all.
			// Exact: see the note in "documents section is visible" above.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
			return;
		}

		const headers = await table
			.locator("thead th")
			.evaluateAll((nodes) =>
				nodes.map((node) =>
					(node.textContent ?? "").replace(/[\u2195\u2191\u2193]/g, "").trim(),
				),
			);
		expect(headers.slice(2)).toEqual([
			"Name",
			"Version",
			"Type",
			"Status",
			"Size",
			"Date",
			"Actions",
		]);
	});

	test("documents keep their sort control, direction and drop zone", async ({
		page,
	}) => {
		await page.getByRole("tab", { name: "Documents" }).click();

		const sortSelect = page.getByLabel("Sort documents by");
		if ((await sortSelect.count()) === 0) {
			// Exact: see the note in "documents section is visible" above.
			await expect(
				page.getByText("No documents", { exact: true }),
			).toBeVisible();
			return;
		}
		await expect(sortSelect).toBeVisible();
		// The hint row is gone; the limit rides on the Upload button, which
		// sits at the right end of the toolbar beside Sort.
		await expect(page.getByTestId("drop-hint")).toHaveCount(0);
		// exact: true — the Documents-tab filter chip row (Slice 7) renders
		// before this toolbar in DOM order once rows exist, and its "Uploaded"
		// chip's accessible name ("Filter: Uploaded, N items") otherwise also
		// matches "Upload" as a substring, so a non-exact `.first()` can
		// resolve to the chip instead of the real upload button.
		const upload = page.getByRole("button", { name: "Upload", exact: true });
		await expect(upload).toHaveAttribute("title", /100 MB/);

		// The direction toggle actually re-sorts: the server-managed list
		// carries the direction in the URL.
		await page.getByTestId("sort-direction").click();
		await expect(page).toHaveURL(/dir=asc/);
	});

	test("the memory filter keeps what you type", async ({ page }) => {
		await openMemoryProfile(page);
		const filter = page.getByRole("searchbox", { name: "Filter memories" });
		await filter.fill("nextcloud");
		await expect(filter).toHaveValue("nextcloud");
	});

	// Ruling 69: Slides is shelved, so the type chips are the kinds that can
	// exist. Production offers no filter for something it cannot make.
	test("offers a chip for each kind that can be made, and none for Slides", async ({
		page,
	}) => {
		await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.getByRole("tab", { name: "Documents" }).click();

		const chips = page.getByTestId("documents-filter-chips");
		await expect(chips).toBeVisible();
		await expect(chips.getByRole("button")).toHaveText([
			/^\s*All/,
			/^\s*Documents/,
			/^\s*Canvas/,
			/^\s*Apps/,
			/^\s*Files/,
		]);
		await expect(page.getByTestId("documents-filter-chip-slides")).toHaveCount(
			0,
		);
		await expect(chips.getByText(/Slides/)).toHaveCount(0);
	});

	// Slice 7 (Feature 2, ADR-0066): the artifact family (Document/App/Canvas/
	// Slides) joins the Documents tab. Neither this spec nor any other seeded
	// a document/generated-file/artifact row before this slice, so this is
	// real end-to-end pipeline coverage, not a fixture that only proves the
	// seed worked — direct db writes, matching the repo's existing E2E
	// seeding convention (see conversation-title-refresh.spec.ts).
	test("shows a seeded artifact-family row with its chip, type pill, Open and no download action", {
		tag: "@smoke",
	}, async ({ page }) => {
		// A bare conversation row, seeded directly like several other E2E specs
		// already do (see conversation-title-refresh.spec.ts) — no messages, no
		// live chat round trip, just an id for the artifact's ownership scope.
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-canvas-conv-${Date.now()}`;
		const artifactId = `e2e-canvas-${Date.now()}`;
		const artifactName = "Vienna trip board (e2e)";
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the Documents tab e2e case",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(artifacts).values({
			id: artifactId,
			userId: user.id,
			conversationId,
			type: "artifact",
			retrievalClass: "durable",
			name: artifactName,
			metadataJson: JSON.stringify({
				artifactType: "canvas",
				title: artifactName,
			}),
			createdAt: now,
			updatedAt: now,
		});

		try {
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page.getByRole("tab", { name: "Documents" }).click();

			const row = page.locator("tbody tr", { hasText: artifactName });
			await expect(row).toBeVisible();
			await expect(row.locator(".col-type")).toHaveText("Canvas");

			// The "Canvas 1" chip narrows the list down to this row.
			const canvasChip = page.getByTestId("documents-filter-chip-canvas");
			await expect(canvasChip).toBeVisible();
			await canvasChip.click();
			await expect(page).toHaveURL(/type=canvas/);
			await expect(row).toBeVisible();

			// Actions column: Open and Delete, no Download (a board's picture is
			// drawn by the open board, which Open reaches).
			await expect(
				row.getByRole("button", { name: `Open ${artifactName}` }),
			).toBeVisible();
			await expect(row.getByRole("button", { name: /download/i })).toHaveCount(
				0,
			);
			await expect(row.getByRole("button", { name: /delete/i })).toBeVisible();
		} finally {
			await db.delete(artifacts).where(eq(artifacts.id, artifactId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	// Friction audit F23: every size read "0 B", the 364 KB PDF included. A
	// generated file's row says how big the file it downloads is; a Document, a
	// Canvas and an App have no size of their own, and say so with a dash.
	test("a generated file's row shows the size of its file, and a Document's row shows no size at all", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-sizes-conv-${Date.now()}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the sizes case",
			createdAt: now,
			updatedAt: now,
		});
		const title = `Sizes walk ${Date.now()}`;
		await createDocumentArtifact({
			userId: user.id,
			conversationId,
			title,
			markdown: "Book the hotel. Then the museum.",
			author: "user",
			summary: "Seeded for E2E",
		});

		try {
			// A real PDF, made the way produce_file makes one for a reply.
			await produceGeneratedPdf(page.request, conversationId, title);
			const [file] = await db
				.select({ sizeBytes: chatGeneratedFiles.sizeBytes })
				.from(chatGeneratedFiles)
				.where(eq(chatGeneratedFiles.conversationId, conversationId));
			const expected = formatByteSize(file.sizeBytes, {
				trimWholeUnits: true,
			});
			expect(expected).not.toBe("0 B");

			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);

			const generatedRow = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-generated") });
			await expect(generatedRow).toHaveCount(1);
			await expect(generatedRow.locator(".col-size")).toHaveText(expected);

			// The Document itself is live-edited: no size, and no "0 B" claiming one.
			const documentRow = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-artifact") });
			await expect(documentRow).toHaveCount(1);
			await expect(documentRow.locator(".col-size")).toHaveText("—");
		} finally {
			await db
				.delete(fileProductionJobs)
				.where(eq(fileProductionJobs.conversationId, conversationId));
			await db
				.delete(chatGeneratedFiles)
				.where(eq(chatGeneratedFiles.conversationId, conversationId));
			await db
				.delete(artifacts)
				.where(eq(artifacts.conversationId, conversationId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	// FB-8 (FB-1's concern 2): a Download is delivery, not something the chat made.
	// Each press used to leave a "Generated" row in the library, one per press, under
	// the Document's own name (which already has its own Download).
	test("a Document's exports are no rows of the library, whatever the format and however often it is pressed", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-exports-conv-${Date.now()}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the exports case",
			createdAt: now,
			updatedAt: now,
		});
		const title = `Exports walk ${Date.now()}`;
		const created = await createDocumentArtifact({
			userId: user.id,
			conversationId,
			title,
			markdown: "Book the hotel. Then the museum.",
			author: "user",
			summary: "Seeded for E2E",
		});

		try {
			for (const format of ["pdf", "docx", "markdown", "pdf"]) {
				const exported = await page.request.post(
					`/api/artifacts/${created.id}/export`,
					{ data: { format } },
				);
				expect(exported.status()).toBe(202);
				const { job } = (await exported.json()) as { job: { id: string } };
				await expect
					.poll(
						async () => {
							const read = await page.request.get(
								`/api/chat/files/jobs/${job.id}`,
							);
							return ((await read.json()) as { job: { status: string } }).job
								.status;
						},
						{ timeout: 30_000 },
					)
					.toBe("succeeded");
			}

			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await expect(
				page
					.locator("tbody tr", { hasText: title })
					.filter({ has: page.locator(".col-type .type-artifact") }),
			).toHaveCount(1);
			// Nothing else of that name: no generated row, whatever the file.
			await expect(page.locator("tbody tr", { hasText: title })).toHaveCount(1);
		} finally {
			await db
				.delete(fileProductionJobs)
				.where(eq(fileProductionJobs.conversationId, conversationId));
			await db
				.delete(chatGeneratedFiles)
				.where(eq(chatGeneratedFiles.conversationId, conversationId));
			await db
				.delete(artifacts)
				.where(eq(artifacts.conversationId, conversationId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	// FB-8 (FB-1's finding 3): a source-first generated row is listed as the source
	// document it was rendered from, and opening it said "Preview not available for
	// this file type" for a PDF that downloads fine. It opens the file it downloads.
	test("a source-first generated row opens a preview of its file, not 'Preview not available'", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-preview-conv-${Date.now()}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the preview case",
			createdAt: now,
			updatedAt: now,
		});
		const title = `Preview walk ${Date.now()}`;

		try {
			await produceGeneratedPdf(page.request, conversationId, title);
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);

			const generatedRow = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-generated") });
			await expect(generatedRow).toHaveCount(1);
			await generatedRow.getByText(title).first().click();

			await expect(page.locator(".pdf-canvas").first()).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.getByText(/Preview not available/)).toHaveCount(0);
		} finally {
			await db
				.delete(fileProductionJobs)
				.where(eq(fileProductionJobs.conversationId, conversationId));
			await db
				.delete(chatGeneratedFiles)
				.where(eq(chatGeneratedFiles.conversationId, conversationId));
			await db
				.delete(artifacts)
				.where(eq(artifacts.conversationId, conversationId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	// Friction audit F23: a Document, a Canvas and an App had a trash can and
	// nothing else, while a generated file's row had its actions. The row opens the
	// item by a button of its own, and the kinds that have a file to hand over
	// download it the way the panel's Download does.
	test("a Document's row opens it and downloads it in the format asked for", async ({
		page,
	}) => {
		const { conversationId, title } = await seedDocument({
			title: `${TITLE} ${Date.now()}`,
		});
		try {
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			const row = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-artifact") });
			await expect(row).toHaveCount(1);

			await row.getByTestId("artifact-row-download").click();
			// Painted in <body>, so the table cannot cut it off.
			const menu = page.getByTestId("artifact-row-download-menu");
			await expect(menu.getByRole("menuitem")).toHaveText([
				"PDF",
				"Word",
				"Markdown",
			]);
			const downloaded = page.waitForEvent("download", { timeout: 20_000 });
			await menu.getByRole("menuitem", { name: "Markdown" }).click();
			const download = await downloaded;
			expect(download.suggestedFilename().normalize("NFC")).toBe(
				`${title}.md`.normalize("NFC"),
			);
			expect((await bytesOf(download)).toString("utf8")).toContain(
				"Szombat: Naschmarkt",
			);

			// Its own Open, by name, opens the Document in the panel.
			await row.getByRole("button", { name: `Open ${title}` }).click();
			await expect(
				page.locator('[data-testid="artifact-panel-title"]:visible'),
			).toHaveText(title, { timeout: 15_000 });
		} finally {
			await cleanUpConversation(conversationId);
		}
	});

	test("a Document that cannot be exported says why in the page's own banner, and nothing downloads", async ({
		page,
	}) => {
		const { conversationId, title } = await seedDocument({
			title: `${TITLE} ${Date.now()}`,
		});
		try {
			// The server refuses it (a source past the export limit).
			await page.route("**/api/artifacts/*/export*", async (route) => {
				await route.fulfill({
					status: 413,
					json: { ok: false, reason: "source_too_large" },
				});
			});
			let downloadStarted = false;
			page.on("download", () => {
				downloadStarted = true;
			});
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			const row = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-artifact") });
			await row.getByTestId("artifact-row-download").click();
			await page
				.getByTestId("artifact-row-download-menu")
				.getByRole("menuitem", { name: "PDF" })
				.click();

			await expect(
				page.getByText("This document is too long to export."),
			).toBeVisible();
			expect(downloadStarted).toBe(false);
		} finally {
			await cleanUpConversation(conversationId);
		}
	});

	test("an App's row downloads its .html file in one press, with the file the job made", async ({
		page,
	}) => {
		const { conversationId, title } = await seedApp({
			title: `${APP_TITLE} ${Date.now()}`,
		});
		const { job } = await seedSucceededAppJob(conversationId);
		try {
			await page.route("**/api/artifacts/*/app/download", async (route) => {
				await route.fulfill({
					status: 202,
					json: { ok: true, job, reused: false },
				});
			});
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			const row = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-artifact") });
			await expect(row).toHaveCount(1);

			const downloaded = page.waitForEvent("download", { timeout: 20_000 });
			await row.getByTestId("artifact-row-download").click();
			const download = await downloaded;

			expect(download.suggestedFilename()).toBe("app.html");
			expect((await bytesOf(download)).toString("utf8")).toBe(APP_HTML);
		} finally {
			await cleanUpConversation(conversationId);
		}
	});

	test("an App whose sandbox run failed says so in the page's banner", async ({
		page,
	}) => {
		const { conversationId, title } = await seedApp({
			title: `${APP_TITLE} ${Date.now()}`,
		});
		try {
			await page.route("**/api/artifacts/*/app/download", async (route) => {
				await route.fulfill({
					status: 202,
					json: {
						ok: true,
						job: jobDto("job-failed", conversationId, "failed"),
						reused: false,
					},
				});
			});
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page
				.locator("tbody tr", { hasText: title })
				.getByTestId("artifact-row-download")
				.click();

			await expect(
				page.getByText("Could not prepare this app for download."),
			).toBeVisible();
		} finally {
			await cleanUpConversation(conversationId);
		}
	});

	// RV-V M-3: History is the only way to an item's versions, and its button exists
	// when the panel can say what changed last. An item opened from the library carried
	// no latest moment, so it had no History button at all.
	test("a Document opened from the library has its History button, and History opens", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const conversationId = `e2e-history-conv-${Date.now()}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the library History case",
			createdAt: now,
			updatedAt: now,
		});
		const title = `Library history walk ${Date.now()}`;
		const created = await createDocumentArtifact({
			userId: user.id,
			conversationId,
			title,
			markdown: "Book the hotel.",
			author: "user",
			summary: "Seeded for E2E",
		});
		await updateArtifactBody({
			userId: user.id,
			artifactId: created.id,
			conversationId,
			body: "Book the hotel. Late checkout.",
			author: "alfy",
			summary: "Added a late checkout",
		});

		try {
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page.getByRole("tab", { name: "Documents" }).click();
			await page.locator("tbody tr", { hasText: title }).click();

			const historyButton = page
				.locator('[data-testid="artifact-history-button"]:visible')
				.first();
			await expect(historyButton).toBeVisible({ timeout: 15_000 });
			await expect(historyButton).toContainText("Changed by Alfy");
			await historyButton.click();
			const region = page.getByRole("region", {
				name: `History of ${title}`,
			});
			await expect(region.getByRole("option")).toHaveCount(2);
		} finally {
			await db.delete(artifacts).where(eq(artifacts.id, created.id));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});

	// Ruling 60: the Documents tab's second-tier file-family filter, live only
	// under Files. Real end-to-end pipeline coverage of the actual registry ->
	// store -> route -> UI chain, like the artifact-family case above — no
	// earlier spec seeds this mix of real file types.
	test("Files -> PDF narrows to the PDF row, switching to Documents hides the second row, and 390px wraps without horizontal overflow", async ({
		page,
	}) => {
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const stamp = Date.now();
		const conversationId = `e2e-file-family-conv-${stamp}`;
		const now = new Date();
		const pdfName = `Q1 report ${stamp}.pdf`;
		const docxName = `Meeting notes ${stamp}.docx`;
		const documentArtifactName = `Trip plan ${stamp}`;

		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the file-family e2e case",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(artifacts).values([
			{
				id: `e2e-ff-pdf-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: pdfName,
				mimeType: "application/pdf",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-docx-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: docxName,
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-xlsx-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: `Budget ${stamp}.xlsx`,
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-image-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: `Photo ${stamp}.png`,
				mimeType: "image/png",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-md-${stamp}`,
				userId: user.id,
				conversationId,
				type: "source_document",
				retrievalClass: "durable",
				name: `Ideas ${stamp}.md`,
				mimeType: "text/markdown",
				sizeBytes: 100,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: `e2e-ff-document-${stamp}`,
				userId: user.id,
				conversationId,
				type: "artifact",
				retrievalClass: "durable",
				name: documentArtifactName,
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: documentArtifactName,
				}),
				createdAt: now,
				updatedAt: now,
			},
		]);

		try {
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page.getByRole("tab", { name: "Documents" }).click();

			const filesChip = page.getByTestId("documents-filter-chip-uploaded");
			await expect(filesChip).toContainText("Files");
			await filesChip.click();
			await expect(page).toHaveURL(/type=uploaded/);

			await expect(
				page.getByTestId("documents-file-family-chips"),
			).toBeVisible();
			const pdfChip = page.getByTestId("documents-file-family-chip-pdf");
			await expect(pdfChip).toBeVisible();
			await pdfChip.click();
			await expect(page).toHaveURL(/family=pdf/);

			await expect(
				page.locator("tbody tr", { hasText: pdfName }),
			).toBeVisible();
			// The other seeded Files rows narrow OUT once PDF is the active family.
			await expect(page.locator("tbody tr", { hasText: docxName })).toHaveCount(
				0,
			);

			// Switching to a non-Files kind chip hides the second row entirely
			// and drops `family` from the URL in the same navigation.
			await page.getByTestId("documents-filter-chip-document").click();
			await expect(page).toHaveURL(/type=document/);
			await expect(page).not.toHaveURL(/family=/);
			await expect(page.getByTestId("documents-file-family-chips")).toHaveCount(
				0,
			);
			await expect(
				page.locator("tbody tr", { hasText: documentArtifactName }),
			).toBeVisible();

			// 390px: the two-tier chip row must wrap onto more lines, never
			// force the page to scroll horizontally.
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByTestId("documents-filter-chip-uploaded").click();
			await expect(
				page.getByTestId("documents-file-family-chips"),
			).toBeVisible();
			const hasHorizontalOverflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth >
					document.documentElement.clientWidth,
			);
			expect(hasHorizontalOverflow).toBe(false);
		} finally {
			await db
				.delete(artifacts)
				.where(eq(artifacts.conversationId, conversationId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
		}
	});
});
