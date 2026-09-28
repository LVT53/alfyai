import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	createComment,
	createDocumentArtifact,
} from "../../src/lib/server/services/artifacts";
import { parseDocument } from "../../src/lib/shared/artifact-document/blocks";
import type { Anchor } from "../../src/lib/shared/artifacts/anchor";
import { createConversation, login } from "./helpers";

// Comments, anchoring and the @Alfy hook (Feature 2 · Artifacts, Slice 1,
// Task T10) — the real routes, the real service, the real DB. Deliberately
// NOT exercising a live model call here (no model backend is configured in
// this environment; `comments.test.ts`'s mocked-model suite already proves
// the three @Alfy outcomes). What this spec proves the unit suites cannot:
// the routes, `requireApiUser`, ownership scoping and the margin's own
// rendering all agree with each other over a real HTTP round trip.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

/** A one-block Document, its real (minted) block id, and a valid text anchor onto it. */
async function seedDocumentWithBlock(conversationId: string, markdown: string) {
	const userId = await testUserId();
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: "Trip notes",
		markdown,
		author: "user",
		summary: "Created",
	});
	const block = parseDocument(artifact.body ?? "", { mint: false }).blocks[0];
	if (!block) throw new Error("the seeded document must parse to a block");
	return { userId, artifact, block };
}

function anchorFor(blockId: string, markdown: string, quote: string): Anchor {
	const idx = markdown.indexOf(quote);
	expect(
		idx,
		`fixture quote "${quote}" must appear in "${markdown}"`,
	).toBeGreaterThanOrEqual(0);
	return {
		kind: "text",
		blockId,
		quote,
		prefix: markdown.slice(0, idx),
		suffix: markdown.slice(idx + quote.length),
	};
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

test.describe("Document comments and @Alfy — the real routes and service", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("posts a comment, lists it, resolves it, and ignores a client-supplied author", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Comments on a document",
		);
		const markdown = "Book the flight to Vienna.";
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			markdown,
		);
		const anchor = anchorFor(block.id, block.markdown, "flight");

		const created = await page.request.post(
			`/api/artifacts/${artifact.id}/comments?conversationId=${conversationId}`,
			{ data: { anchor, body: "Too early?" } },
		);
		expect(created.status()).toBe(200);
		const createdBody = await created.json();
		expect(createdBody).toMatchObject({
			ok: true,
			comment: { author: "user", body: "Too early?", status: "open" },
		});
		const commentId: string = createdBody.comment.id;

		// T10.7: a client cannot author as "alfy" — the server ignores it.
		const spoofed = await page.request.post(
			`/api/artifacts/${artifact.id}/comments?conversationId=${conversationId}`,
			{ data: { anchor, body: "Sneaky.", author: "alfy" } },
		);
		expect((await spoofed.json()).comment.author).toBe("user");

		const detail = await page.request.get(
			`/api/artifacts/${artifact.id}?conversationId=${conversationId}`,
		);
		const detailBody = await detail.json();
		expect(detailBody.comments.map((c: { body: string }) => c.body)).toContain(
			"Too early?",
		);

		const resolved = await page.request.post(
			`/api/artifacts/${artifact.id}/comments/${commentId}/resolve?conversationId=${conversationId}`,
			{ data: { resolved: true } },
		);
		expect(resolved.status()).toBe(200);
		expect(await resolved.json()).toEqual({ ok: true });
	});

	test("404s a comment route for an artifact id that does not exist", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Missing artifact");
		const response = await page.request.post(
			`/api/artifacts/does-not-exist/comments?conversationId=${conversationId}`,
			{
				data: {
					anchor: {
						kind: "text",
						blockId: "p1",
						quote: "x",
						prefix: "a",
						suffix: "b",
					},
					body: "Should not land",
				},
			},
		);
		expect(response.status()).toBe(404);
		expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
	});

	// Deterministic and model-free: an orphaned anchor is refused BEFORE any
	// model call (comments.ts's own short-circuit), so this exercises the
	// real @Alfy route end to end without depending on a configured model.
	test("the @Alfy hook refuses an orphaned anchor without a model, and the refusal lands as a reply", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Alfy on a document");
		const markdown = "Book the flight to Vienna.";
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			markdown,
		);
		// Anchors a quote that is NOT present in the current block — orphaned.
		const orphanedAnchor: Anchor = {
			kind: "text",
			blockId: block.id,
			quote: "a phrase that was never here",
			prefix: "before ",
			suffix: " after",
		};
		const created = await createComment({
			userId: await testUserId(),
			artifactId: artifact.id,
			anchor: orphanedAnchor,
			author: "user",
			body: "@Alfy fix this.",
		});
		if (!created) throw new Error("the seeded comment must be created");

		const response = await page.request.post(
			`/api/artifacts/${artifact.id}/comments/${created.id}/alfy?conversationId=${conversationId}`,
		);
		expect(response.status()).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.outcome).toBe("refused");
		expect(body.reply.author).toBe("alfy");
		expect(body.reply.parentId).toBe(created.id);

		const detail = await page.request.get(
			`/api/artifacts/${artifact.id}?conversationId=${conversationId}`,
		);
		const thread = (await detail.json()).comments.find(
			(c: { id: string }) => c.id === created.id,
		);
		expect(thread.replies).toHaveLength(1);
	});

	test("shows a seeded comment in the margin when the document opens", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Margin rendering");
		const markdown = "Book the flight to Vienna.";
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			markdown,
		);
		const anchor = anchorFor(block.id, block.markdown, "flight");
		const created = await createComment({
			userId: await testUserId(),
			artifactId: artifact.id,
			anchor,
			author: "user",
			body: "Seeded margin comment",
		});
		expect(created).toBeTruthy();

		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		// Each row is an ArtifactCard (chrome="full"): the title is plain text,
		// and Open is the row's one clickable affordance (artifacts-panel.spec.ts).
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click();

		const shell = page.getByRole("complementary", {
			name: "Document workspace",
		});
		await expect(shell).toBeVisible();
		await expect(shell.getByText("Seeded margin comment")).toBeVisible();
	});

	// Margin placement follow-up ("the margin shows it against the right
	// block"): two comments on two DIFFERENT blocks, seeded in the OPPOSITE
	// order from how they read in the document, must still appear in
	// DOCUMENT order and never overlap on screen — and a third comment whose
	// anchor no longer exists must land in its own, separately labelled
	// group rather than among the two live ones.
	test("places two comments in document order without overlapping, and puts an orphaned one in its own group", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Margin placement");
		const markdown =
			"Book the hotel by Friday.\n\nConfirm the flight to Vienna.";
		const userId = await testUserId();
		const artifact = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Trip notes",
			markdown,
			author: "user",
			summary: "Created",
		});
		const [firstBlock, secondBlock] = parseDocument(artifact.body ?? "", {
			mint: false,
		}).blocks;
		if (!firstBlock || !secondBlock) {
			throw new Error("the seeded document must parse to two blocks");
		}

		// Seeded SECOND block first, on purpose: placement must follow the
		// DOCUMENT'S order, never comment creation order.
		await createComment({
			userId,
			artifactId: artifact.id,
			anchor: anchorFor(secondBlock.id, secondBlock.markdown, "flight"),
			author: "user",
			body: "On the second block",
		});
		await createComment({
			userId,
			artifactId: artifact.id,
			anchor: anchorFor(firstBlock.id, firstBlock.markdown, "hotel"),
			author: "user",
			body: "On the first block",
		});
		await createComment({
			userId,
			artifactId: artifact.id,
			anchor: {
				kind: "text",
				blockId: firstBlock.id,
				quote: "a phrase that was never here",
				prefix: "before ",
				suffix: " after",
			},
			author: "user",
			body: "This anchor is gone",
		});

		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click();

		const shell = page.getByRole("complementary", {
			name: "Document workspace",
		});
		await expect(shell).toBeVisible();

		const items = shell.getByTestId("margin-comment");
		await expect(items).toHaveCount(2);
		const firstItem = shell
			.getByTestId("margin-comment")
			.filter({ hasText: "On the first block" });
		const secondItem = shell
			.getByTestId("margin-comment")
			.filter({ hasText: "On the second block" });
		await expect(firstItem).toBeVisible();
		await expect(secondItem).toBeVisible();

		const firstBox = await firstItem.boundingBox();
		const secondBox = await secondItem.boundingBox();
		expect(firstBox).not.toBeNull();
		expect(secondBox).not.toBeNull();
		// Document order: the first block's comment sits above the second
		// block's comment.
		expect(firstBox?.y ?? 0).toBeLessThan(secondBox?.y ?? 0);
		// Never overlapping: the first one's box ends before the second one's
		// box begins.
		expect((firstBox?.y ?? 0) + (firstBox?.height ?? 0)).toBeLessThanOrEqual(
			secondBox?.y ?? 0,
		);

		// The orphaned comment is grouped separately, not among the two
		// position-synced ones above — folded by default (redesign §3.2's own
		// motion #21), so its own text is not rendered until the group opens.
		const orphanedGroup = shell.getByTestId("margin-orphaned-group");
		await expect(orphanedGroup).toBeVisible();
		await expect(
			orphanedGroup.getByText("This anchor is gone"),
		).not.toBeAttached();
		await orphanedGroup.getByRole("button", { name: /removed/i }).click();
		await expect(orphanedGroup.getByText("This anchor is gone")).toBeVisible();
		await expect(
			orphanedGroup.getByText("On the first block"),
		).not.toBeAttached();
	});
});

// Both the mobile-shell and desktop-shell headers are real DOM nodes at
// every viewport (CSS alone decides which is visible — `artifact-document
// .spec.ts`'s own `openDocumentFromPanel` established this pattern), so
// every header-button lookup below is scoped to ONE shell rather than
// `page.getByTestId(...)`, which would strict-mode-fail on the other, hidden
// copy.
function mobileShell(page: Page) {
	return page.getByTestId("document-workspace-mobile-shell");
}
function desktopShell(page: Page) {
	return page.getByRole("complementary", { name: "Document workspace" });
}

// Wave 2.5 Step 8: comments away from the inline rail — the header's
// Comments button (a bottom sheet on phones, a drawer on a narrow desktop
// panel) and a tapped highlight, both landing on the same MarginPanel
// content DocumentBody already renders inline at full width.
test.describe("Comments away from the rail (Wave 2.5 Step 8)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("phone: the header's Comments button opens a bottom sheet, and a tapped highlight opens the same sheet at that thread", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Phone comments");
		const markdown = "Book the flight to Vienna.";
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			markdown,
		);
		const created = await createComment({
			userId: await testUserId(),
			artifactId: artifact.id,
			anchor: anchorFor(block.id, block.markdown, "flight"),
			author: "user",
			body: "Anna says it sells out early.",
		});
		if (!created) throw new Error("the seeded comment must be created");

		await page.setViewportSize({ width: 390, height: 844 });
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button-compact").click();
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const shell = mobileShell(page);
		const commentsButton = shell.getByTestId("artifact-comments-button");
		await expect(commentsButton).toBeVisible({ timeout: 30_000 });
		await commentsButton.click();

		const sheet = page.getByRole("dialog", { name: "Comments" });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByText("Anna says it sells out early.")).toBeVisible();

		// `toBeVisible` only checks the DOM/CSS, never actual paint order — the
		// mobile shell's own full-screen `.workspace-mobile-backdrop` sits at
		// z-index 95, and this sheet genuinely passed the checks above while
		// still painting BEHIND it (z-50) before its own zIndexClass fix.
		// `elementFromPoint` catches exactly that class of regression: it
		// returns whatever is actually topmost at that pixel.
		const isOnTop = await sheet.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + 10,
			);
			return !!top && node.contains(top);
		});
		expect(isOnTop, "the sheet must be the topmost element, not painted under the mobile shell's own backdrop").toBe(true);

		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
		await expect(commentsButton).toBeFocused();

		// A tapped highlight opens the SAME sheet, scrolled to and focused on
		// that thread — the phone toolbar/rail never shows the highlight's
		// words otherwise, so this is the only way to see the thread again.
		const highlight = shell.locator(
			`[data-comment-anchor-id="${created.id}"]`,
		);
		await expect(highlight).toBeVisible();
		await highlight.click();

		await expect(sheet).toBeVisible();
		await expect(sheet.getByText("Anna says it sells out early.")).toBeVisible();
	});

	// A panel width below 820px but a viewport width above BOTH the chat
	// page's own desktop-count-button breakpoint (Tailwind's `lg`, 1024px)
	// and the workspace's own desktop-shell breakpoint (768px) — the docked
	// panel is `min(68vw, 950px)`, so 1100px viewport width gives a 748px
	// panel: too narrow for the inline rail, wide enough that every OTHER
	// piece of chrome still reads as "desktop".
	test("narrow desktop panel: the rail becomes a drawer, toggled by the header's Comments button", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Narrow panel");
		const markdown = "Book the flight to Vienna.";
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			markdown,
		);
		await createComment({
			userId: await testUserId(),
			artifactId: artifact.id,
			anchor: anchorFor(block.id, block.markdown, "flight"),
			author: "user",
			body: "Seeded for the narrow-panel drawer",
		});

		await page.setViewportSize({ width: 1100, height: 800 });
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const shell = desktopShell(page);
		await expect(shell).toBeVisible({ timeout: 30_000 });
		// The inline rail is the redesign's own `.document-content-rail` —
		// `display: none` below the container's 820px threshold.
		await expect(shell.locator(".document-content-rail")).not.toBeVisible();

		const commentsButton = shell.getByTestId("artifact-comments-button");
		await commentsButton.click();

		const drawer = page.getByTestId("comments-drawer");
		await expect(drawer).toBeVisible();
		await expect(
			drawer.getByText("Seeded for the narrow-panel drawer"),
		).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(drawer).toBeHidden();
		await expect(commentsButton).toBeFocused();
	});
});

// Wave 2.5 Step 8: Versions and Download become popovers anchored to their
// own header buttons on desktop, sheets on phones.
test.describe("Versions and Download popovers (Wave 2.5 Step 8)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	/** Bumps the document's body through the real save route (never a raw DB write) so the popover's own version list is genuine, server-ordered data. */
	async function saveNewVersion(
		page: Page,
		artifactId: string,
		conversationId: string,
		expectVersion: number,
		body: string,
	): Promise<void> {
		const response = await page.request.fetch(
			`/api/artifacts/${artifactId}/body?conversationId=${conversationId}`,
			{
				method: "PATCH",
				data: { body, expectVersion, coalesce: false },
			},
		);
		expect(response.status(), await response.text()).toBe(200);
	}

	test("at a narrow desktop panel width, the Versions popover opens anchored near the version button atop an already-open Comments drawer, and Escape closes only the popover", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Versions popover");
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			"Book the flight to Vienna.",
		);
		await createComment({
			userId: await testUserId(),
			artifactId: artifact.id,
			anchor: anchorFor(block.id, block.markdown, "flight"),
			author: "user",
			body: "Still open while Versions is on top",
		});
		await saveNewVersion(
			page,
			artifact.id,
			conversationId,
			1,
			"<!--b:p1-->\nBook the flight to Vienna, confirmed.",
		);

		await page.setViewportSize({ width: 1100, height: 800 });
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const shell = desktopShell(page);
		await shell.getByTestId("artifact-comments-button").click();
		const drawer = page.getByTestId("comments-drawer");
		await expect(drawer).toBeVisible({ timeout: 30_000 });

		const versionButton = shell.getByTestId("artifact-version-pill");
		await versionButton.click();
		const popover = page.getByRole("dialog", { name: "Versions" });
		await expect(popover).toBeVisible();
		await expect(popover.getByText("v2")).toBeVisible();

		// Anchored near its own trigger, not the corner of the panel: within a
		// generous distance of the version button's own row, not off in some
		// unrelated corner.
		const buttonBox = await versionButton.boundingBox();
		const popoverBox = await popover.boundingBox();
		expect(buttonBox).not.toBeNull();
		expect(popoverBox).not.toBeNull();
		expect(Math.abs((popoverBox?.y ?? 0) - (buttonBox?.y ?? 0))).toBeLessThan(
			200,
		);

		// Escape closes only the TOPMOST layer (Versions) — the Comments
		// drawer underneath stays open.
		await page.keyboard.press("Escape");
		await expect(popover).toBeHidden();
		await expect(drawer).toBeVisible();
		await expect(versionButton).toBeFocused();
	});

	test("restores a version from the Versions popover with an inline confirm, closes, and offers Undo", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Versions restore");
		const { artifact } = await seedDocumentWithBlock(
			conversationId,
			"Book the flight to Vienna.",
		);
		await saveNewVersion(
			page,
			artifact.id,
			conversationId,
			1,
			"<!--b:p1-->\nBook the flight to Vienna, confirmed.",
		);

		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		await desktopShell(page).getByTestId("artifact-version-pill").click();
		const popover = page.getByRole("dialog", { name: "Versions" });
		await expect(popover).toBeVisible();

		await popover.getByRole("button", { name: "Restore" }).click();
		await expect(
			popover.getByText(/Restore v1\? Your current text stays as a version\./),
		).toBeVisible();
		// Never a modal — the confirm is the SAME popover's own content.
		await expect(page.getByTestId("confirm-delete")).toHaveCount(0);

		await popover.getByRole("button", { name: "Restore" }).click();
		await expect(popover).toBeHidden();

		const toast = page.getByTestId("toast-entry").filter({ hasText: "v1" });
		await expect(toast).toBeVisible();
		await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
	});

	test("the Download popover opens from the header's Download button and offers PDF, Word and Markdown", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Download popover");
		await seedDocumentWithBlock(conversationId, "Book the flight to Vienna.");

		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const downloadButton = desktopShell(page).getByTestId(
			"artifact-download-button",
		);
		await downloadButton.click();

		const popover = page.getByTestId("document-download-popover");
		await expect(popover).toBeVisible();
		await expect(popover.getByRole("button", { name: "PDF" })).toBeVisible();
		await expect(popover.getByRole("button", { name: "Word" })).toBeVisible();
		await expect(
			popover.getByRole("button", { name: "Markdown" }),
		).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(popover).toBeHidden();
		await expect(downloadButton).toBeFocused();
	});
});
