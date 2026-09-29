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
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

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
		await expect(
			sheet.getByText("Anna says it sells out early."),
		).toBeVisible();

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
		expect(
			isOnTop,
			"the sheet must be the topmost element, not painted under the mobile shell's own backdrop",
		).toBe(true);

		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
		await expect(commentsButton).toBeFocused();

		// A tapped highlight opens the SAME sheet, scrolled to and focused on
		// that thread — the phone toolbar/rail never shows the highlight's
		// words otherwise, so this is the only way to see the thread again.
		const highlight = shell.locator(`[data-comment-anchor-id="${created.id}"]`);
		await expect(highlight).toBeVisible();
		await highlight.click();

		await expect(sheet).toBeVisible();
		await expect(
			sheet.getByText("Anna says it sells out early."),
		).toBeVisible();
	});

	// A panel too narrow for the comment column beside the text (under 720px:
	// the text keeps at least 480px, so the column needs 240px more) but a
	// viewport wide enough that every OTHER piece of chrome still reads as
	// "desktop" — above BOTH the chat page's own desktop-count-button
	// breakpoint (Tailwind's `lg`, 1024px) and the workspace's own
	// desktop-shell breakpoint (768px). The docked panel is 68% of what is
	// left beside the 48px sidebar rail, so a 1024px window gives ~695px.
	test("narrow desktop panel: the comments are a drawer inside the panel, below its header, toggled by the header's Comments button", async ({
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

		await page.setViewportSize({ width: 1024, height: 768 });
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const shell = desktopShell(page);
		await expect(shell).toBeVisible({ timeout: 30_000 });
		// No inline column: there is no room for it beside the text.
		await expect(shell.locator(".document-content-rail")).toHaveCount(0);

		const commentsButton = shell.getByTestId("artifact-comments-button");
		await expect(commentsButton).toHaveAttribute("aria-pressed", "false");
		await commentsButton.click();
		await expect(commentsButton).toHaveAttribute("aria-pressed", "true");

		const drawer = shell.getByTestId("comments-drawer");
		await expect(drawer).toBeVisible();
		await expect(
			drawer.getByText("Seeded for the narrow-panel drawer"),
		).toBeVisible();
		// One surface at a time: the drawer is the only comment list.
		await expect(page.getByTestId("margin-panel-list")).toHaveCount(1);

		// Inside the panel, below its header, tabs and toolbar: the drawer
		// starts where the text starts, so the header's own actions — the
		// Comments button that closes it — are never covered.
		await waitForStableBoundingBox(drawer);
		const textBox = await shell.locator(".document-content-text").boundingBox();
		const drawerBox = await drawer.boundingBox();
		const buttonBox = await commentsButton.boundingBox();
		expect(textBox && drawerBox && buttonBox).toBeTruthy();
		expect(drawerBox?.y ?? 0).toBeGreaterThanOrEqual((textBox?.y ?? 0) - 1);
		expect(drawerBox?.y ?? 0).toBeGreaterThanOrEqual(
			(buttonBox?.y ?? 0) + (buttonBox?.height ?? 0),
		);
		const buttonIsTopmost = await commentsButton.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return !!top && node.contains(top);
		});
		expect(
			buttonIsTopmost,
			"the header's Comments button stays uncovered",
		).toBe(true);

		// The same button closes it again — never a second way in.
		await commentsButton.click();
		await expect(drawer).toBeHidden();
		await expect(commentsButton).toHaveAttribute("aria-pressed", "false");

		// Escape closes it too, and returns focus to the button.
		await commentsButton.click();
		await expect(drawer).toBeVisible();
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

	// Review 2.5 Important finding (rd/review-2-5.md:168-175): in the
	// EXPANDED panel presentation the version button sits near the panel's
	// own left edge; right-aligning the popover to the trigger's right edge
	// (extending 340px further LEFT from there) ran the popover off the
	// left edge of the viewport entirely (x -138 in the review's own
	// evidence) — and in DOCKED mode the same right-anchoring bled the
	// popover out of the panel to the left, over the chat column.
	test("in the expanded panel, the Versions popover opens on-screen, anchored to the trigger's left edge, and topmost", async ({
		page,
	}) => {
		const conversationId = await createConversation(
			page,
			"Versions popover expanded",
		);
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

		await page.setViewportSize({ width: 1440, height: 900 });
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const shell = desktopShell(page);
		await shell
			.getByRole("button", { name: /Expand document workspace/ })
			.click();

		const expandedVersionButton = page
			.locator(".workspace-shell-expanded")
			.getByTestId("artifact-version-pill");
		await expect(expandedVersionButton).toBeVisible();
		await expandedVersionButton.click();

		const popover = page.getByRole("dialog", { name: "Versions" });
		await expect(popover).toBeVisible();
		// The version list loads async — a generous timeout absorbs that
		// fetch rather than racing it (the off-screen bug this test exists
		// for happens regardless of load state, but the LEFT-edge/topmost
		// checks below want the settled, final popover).
		await expect(popover.getByText("v2")).toBeVisible({ timeout: 15_000 });
		await waitForStableBoundingBox(popover);

		const popoverBox = await popover.boundingBox();
		expect(popoverBox, "the popover must have a bounding box").not.toBeNull();
		const box = popoverBox as { x: number; y: number; width: number };
		// Fully on-screen — the bug put it at a negative x.
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(1440 + 1);
		// Anchored to the LEFT edge of its trigger, not the right — its own
		// left edge starts at or after the button's own left edge, never
		// hundreds of pixels before it.
		const buttonBox = await expandedVersionButton.boundingBox();
		expect(buttonBox, "the trigger must have a bounding box").not.toBeNull();
		expect(box.x).toBeGreaterThanOrEqual((buttonBox as { x: number }).x - 20);

		// Topmost — not painted under the expanded panel's own tab strip or
		// any other chrome (the bug: `elementFromPoint` hit the tab strip).
		const isOnTop = await popover.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + 10,
			);
			return !!top && node.contains(top);
		});
		expect(
			isOnTop,
			"the popover must be the topmost element, not painted under the expanded panel",
		).toBe(true);
	});
});

// A long document with a comment on some of its paragraphs. History: Review
// 2.5's "one scroll" fix (rd/review-2-5.md:87-97) put the text and the comment
// rail in one shared scroller, with cards placed at their anchors' heights —
// then the owner's walk-through asked for the opposite ("the comments
// themselves should scroll with the viewport, not just the section title"):
// the text column is the one scroller, and the comment column beside it keeps
// its place, with a list that scrolls on its own and follows the reader.
async function seedLongDocumentWithComments(
	conversationId: string,
	targets: { index: number; quote: string; commentBody: string }[],
) {
	const userId = await testUserId();
	const paragraphs = Array.from({ length: 45 }, (_, i) => {
		const target = targets.find((t) => t.index === i);
		if (target) return target.quote;
		return `Filler paragraph number ${i} pads out the document with enough sentences of ordinary text that the editor's own scroll container has real height to scroll through before reaching the next marker.`;
	});
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: "Long document scroll",
		markdown: paragraphs.join("\n\n"),
		author: "user",
		summary: "Seeded for E2E",
	});
	const blocks = parseDocument(artifact.body ?? "", { mint: false }).blocks;
	expect(blocks.length, "every paragraph must parse to its own block").toBe(
		paragraphs.length,
	);
	const created: { commentId: string; blockId: string }[] = [];
	for (const target of targets) {
		const block = blocks[target.index];
		if (!block) throw new Error(`no block at index ${target.index}`);
		const comment = await createComment({
			userId,
			artifactId: artifact.id,
			anchor: anchorFor(block.id, block.markdown, target.quote),
			author: "user",
			body: target.commentBody,
		});
		if (!comment) throw new Error("the seeded comment must be created");
		created.push({ commentId: comment.id, blockId: block.id });
	}
	return { artifact, blocks, comments: created };
}

const LONG_DOCUMENT_TARGETS = [3, 8, 13, 18, 23, 28, 33, 40].map((index) => ({
	index,
	quote: `Marker ${index} keeps its place in the document.`,
	commentBody: `Comment on paragraph ${index}`,
}));

async function openLongDocument(page: Page, title: string) {
	await page.setViewportSize({ width: 1440, height: 900 });
	const conversationId = await createConversation(page, title);
	const seeded = await seedLongDocumentWithComments(
		conversationId,
		LONG_DOCUMENT_TARGETS,
	);
	await openChatAndReload(page, conversationId);
	await page.getByTestId("artifact-count-button").click();
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.click({ timeout: 30_000 });
	const shell = desktopShell(page);
	await expect(shell).toBeVisible();
	// Every paragraph must be in the DOM before measuring scroll heights — a
	// generous timeout absorbs the dev server's one-time compile of the
	// Document editor's module graph on the very first Document opened in a
	// test run (matches `artifact-document.spec.ts`'s own established pattern).
	await expect(
		shell
			.locator(".document-editor-host")
			.getByText("Marker 40 keeps its place in the document.", {
				exact: false,
			}),
	).toBeAttached({ timeout: 30_000 });
	await expect(shell.getByTestId("margin-comment")).toHaveCount(
		LONG_DOCUMENT_TARGETS.length,
	);
	return { shell, ...seeded };
}

test.describe("The comment column stays in view while the text scrolls (owner walk-through)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the text column is the one scroller: the row around it and the column beside it never scroll away", async ({
		page,
	}) => {
		const { shell } = await openLongDocument(page, "One scroller for the text");
		const text = shell.locator(".document-content-text");
		const row = shell.locator(".document-main > .document-content");
		const rail = shell.locator(".document-content-rail");
		await waitForStableBoundingBox(text);

		// The text column itself scrolls...
		expect(
			await text.evaluate((el) => el.scrollHeight - el.clientHeight),
		).toBeGreaterThan(50);
		// ...and nothing around or inside it does: the row that holds the text
		// and the comment column is not a scroller, and the editor does not
		// scroll on its own inside the column (Review 2.5's nested-scroller
		// bug must stay fixed).
		expect(
			await row.evaluate((el) => el.scrollHeight - el.clientHeight),
		).toBeLessThanOrEqual(1);
		expect(
			await shell
				.locator(".document-editor-host")
				.evaluate((el) => getComputedStyle(el).overflowY),
		).toBe("visible");

		// Scrolling the text moves the text, not the comment column.
		const railBefore = await rail.boundingBox();
		await text.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await waitForStableBoundingBox(rail);
		const railAfter = await rail.boundingBox();
		expect(railAfter?.y).toBeCloseTo(railBefore?.y ?? -1, 0);
		expect(railAfter?.height).toBeCloseTo(railBefore?.height ?? -1, 0);
		await expect(rail).toBeInViewport({ ratio: 0.9 });
	});

	test("the list keeps its place as the text scrolls, and follows the words the reader is on", async ({
		page,
	}) => {
		const { shell } = await openLongDocument(page, "List follows the text");
		const text = shell.locator(".document-content-text");
		const list = shell.getByTestId("margin-panel-list");
		await waitForStableBoundingBox(text);
		await waitForStableBoundingBox(list);

		const textBox = await text.boundingBox();
		expect(textBox).not.toBeNull();
		// A real wheel gesture over the TEXT, in several steps, down to the
		// last paragraphs — the way the owner scrolls.
		await page.mouse.move(
			(textBox?.x ?? 0) + (textBox?.width ?? 0) / 2,
			(textBox?.y ?? 0) + 120,
		);
		for (let step = 0; step < 8; step += 1) {
			await page.mouse.wheel(0, 700);
			await page.waitForTimeout(80);
		}

		// The active card is the one whose words are nearest the top of what is
		// on screen — computed independently here from the highlights' own
		// rectangles — and it is brought into view in the list.
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const scroller = document.querySelector(
							".document-content-text",
						) as HTMLElement;
						const bounds = scroller.getBoundingClientRect();
						let best: { id: string; top: number } | null = null;
						for (const span of document.querySelectorAll(
							".comment-anchor[data-comment-anchor-id]",
						)) {
							const rect = span.getBoundingClientRect();
							if (rect.height === 0) continue;
							if (rect.bottom <= bounds.top + 4 || rect.top >= bounds.bottom)
								continue;
							const top = Math.max(rect.top, bounds.top);
							if (!best || top < best.top) {
								best = {
									id: span.getAttribute("data-comment-anchor-id") ?? "",
									top,
								};
							}
						}
						const active = document.querySelector(
							"[data-testid='margin-comment'].is-active",
						);
						return {
							expected: best?.id ?? null,
							active: active?.getAttribute("data-comment-id") ?? null,
						};
					}),
				{ timeout: 10_000 },
			)
			.toMatchObject({ expected: expect.any(String) });
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const active = document.querySelector(
							"[data-testid='margin-comment'].is-active",
						) as HTMLElement | null;
						const listEl = document.querySelector(
							"[data-testid='margin-panel-list']",
						) as HTMLElement;
						if (!active) return "no active card";
						const card = active.getBoundingClientRect();
						const bounds = listEl.getBoundingClientRect();
						return card.top >= bounds.top - 1 &&
							card.bottom <= bounds.bottom + 1
							? "in view"
							: `out of view (${Math.round(card.top)}..${Math.round(card.bottom)} vs ${Math.round(bounds.top)}..${Math.round(bounds.bottom)})`;
					}),
				{ timeout: 10_000 },
			)
			.toBe("in view");
		const followed = await page.evaluate(() => {
			const active = document.querySelector(
				"[data-testid='margin-comment'].is-active",
			);
			return active?.textContent ?? "";
		});
		expect(followed).toMatch(/Comment on paragraph (3|8|13|18|23|28|33|40)/);
		// The list itself scrolled to get there (eight cards do not fit).
		expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		// And the column never moved: it is still where it was.
		await expect(shell.locator(".document-content-rail")).toBeInViewport({
			ratio: 0.9,
		});
	});

	test("does not fight the reader: with the pointer inside the list, the text scrolling leaves the list where it is", async ({
		page,
	}) => {
		const { shell } = await openLongDocument(page, "List does not fight");
		const text = shell.locator(".document-content-text");
		const list = shell.getByTestId("margin-panel-list");
		await waitForStableBoundingBox(list);
		const listBox = await list.boundingBox();
		await page.mouse.move(
			(listBox?.x ?? 0) + (listBox?.width ?? 0) / 2,
			(listBox?.y ?? 0) + 40,
		);
		const before = await list.evaluate((el) => el.scrollTop);

		await text.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		// Give the follow (one animation frame plus a smooth scroll, had it
		// been allowed) time to act.
		await page.waitForTimeout(900);

		expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
	});

	test("cards are stacked with even gaps, in the order their words appear", async ({
		page,
	}) => {
		const { shell } = await openLongDocument(page, "Even gaps");
		const cards = shell.getByTestId("margin-comment");
		await waitForStableBoundingBox(cards.first());
		const boxes: { y: number; height: number }[] = [];
		const bodies: string[] = [];
		for (let i = 0; i < LONG_DOCUMENT_TARGETS.length; i += 1) {
			const card = cards.nth(i);
			const box = await card.boundingBox();
			expect(box).not.toBeNull();
			boxes.push(box as { y: number; height: number });
			bodies.push((await card.textContent()) ?? "");
		}
		// Document order: paragraph 3 first, paragraph 40 last.
		LONG_DOCUMENT_TARGETS.forEach((target, i) => {
			expect(bodies[i]).toContain(`Comment on paragraph ${target.index}`);
		});
		// Even gaps: every gap between neighbours is the same, 8-12px.
		const gaps = boxes
			.slice(1)
			.map((box, i) => box.y - (boxes[i].y + boxes[i].height));
		for (const gap of gaps) {
			expect(gap).toBeGreaterThanOrEqual(8);
			expect(gap).toBeLessThanOrEqual(12);
			expect(gap).toBeCloseTo(gaps[0], 0);
		}
	});

	test("clicking a card takes the text to its words; clicking the words brings the card into view", async ({
		page,
	}) => {
		const { shell, comments } = await openLongDocument(page, "Two-way link");
		const text = shell.locator(".document-content-text");
		const lastComment = comments[comments.length - 1];
		const lastCard = shell
			.getByTestId("margin-comment")
			.filter({ hasText: "Comment on paragraph 40" });
		await lastCard.scrollIntoViewIfNeeded();
		const before = await text.evaluate((el) => el.scrollTop);
		await lastCard.getByText("Comment on paragraph 40").click();
		await expect
			.poll(async () => text.evaluate((el) => el.scrollTop), { timeout: 8_000 })
			.toBeGreaterThan(before + 500);
		await expect(
			shell.locator(`[data-comment-anchor-id="${lastComment?.commentId}"]`),
		).toBeInViewport();

		// And back: scroll the text to the top, click the words of comment 40
		// after scrolling to them, and the card is focused in the list.
		const firstCard = shell
			.getByTestId("margin-comment")
			.filter({ hasText: /Comment on paragraph 3(?!\d)/ });
		await text.evaluate((el) => {
			el.scrollTop = 0;
		});
		const firstHighlight = shell.locator(
			`[data-comment-anchor-id="${comments[0]?.commentId}"]`,
		);
		await expect(firstHighlight).toBeVisible();
		await firstHighlight.click();
		await expect(firstCard).toBeFocused();
		await expect(firstCard).toBeInViewport();
	});
});

// The header's Comments button is ONE toggle (the owner: "it looks like I can
// open comments 2 times ... it would be much better if that icon just closed
// and opened the already open comments sidebar").
test.describe("The header's Comments button toggles the column (owner walk-through)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("pressed while the column shows; pressing it hides the column and gives the text the width; remembered on this device", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Toggle the column");
		const { artifact, block } = await seedDocumentWithBlock(
			conversationId,
			"Book the flight to Vienna.",
		);
		await createComment({
			userId: await testUserId(),
			artifactId: artifact.id,
			anchor: anchorFor(block.id, block.markdown, "flight"),
			author: "user",
			body: "Toggle me",
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.click({ timeout: 30_000 });

		const shell = desktopShell(page);
		const button = shell.getByTestId("artifact-comments-button");
		const rail = shell.locator(".document-content-rail");
		const text = shell.locator(".document-content-text");
		await expect(rail).toBeVisible({ timeout: 30_000 });
		await expect(button).toHaveAttribute("aria-pressed", "true");
		await waitForStableBoundingBox(text);
		const widthWithColumn = (await text.boundingBox())?.width ?? 0;

		await button.click();
		await expect(rail).toHaveCount(0);
		await expect(button).toHaveAttribute("aria-pressed", "false");
		// Never a second copy of the comments while it is off.
		await expect(page.getByTestId("comments-drawer")).toHaveCount(0);
		await expect(page.getByTestId("margin-panel-list")).toHaveCount(0);
		await waitForStableBoundingBox(text);
		const widthWithout = (await text.boundingBox())?.width ?? 0;
		expect(widthWithout).toBeGreaterThan(widthWithColumn + 250);

		// Remembered per device: still off after a reload.
		await openChatAndReload(page, conversationId);
		// The panel may come back on its own, already on the document (the
		// chat remembers what was open): only open it when it did not.
		const countButton = page.getByTestId("artifact-count-button");
		await expect(countButton).toBeVisible({ timeout: 20_000 });
		if ((await countButton.getAttribute("aria-pressed")) !== "true") {
			await countButton.click();
		}
		const row = page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row");
		await expect(
			row.or(shell.getByTestId("artifact-comments-button")),
		).toBeVisible({ timeout: 30_000 });
		if (await row.count()) await row.click();
		await expect(shell.getByTestId("artifact-comments-button")).toHaveAttribute(
			"aria-pressed",
			"false",
			{ timeout: 30_000 },
		);
		await expect(shell.locator(".document-content-rail")).toHaveCount(0);

		// And back on.
		await shell.getByTestId("artifact-comments-button").click();
		await expect(shell.locator(".document-content-rail")).toBeVisible();
		await expect(shell.getByText("Toggle me")).toBeVisible();
	});
});

// Laptop fit (the owner: "it doesn't really fit properly on my laptop's
// screen"): with the chat and the panel side by side — and with the panel
// expanded — the text keeps a comfortable reading width and the column
// narrows (300 -> 240px) before the text does.
for (const [width, height] of [
	[1280, 800],
	[1366, 768],
	[1440, 900],
	[1512, 982],
] as const) {
	test.describe(`Laptop fit at ${width}x${height} (owner walk-through)`, () => {
		test.beforeEach(async ({ page }) => {
			await login(page);
		});

		test("the text column keeps its reading width beside the chat, and expanded", async ({
			page,
		}) => {
			const conversationId = await createConversation(
				page,
				`Laptop fit ${width}`,
			);
			const { artifact, block } = await seedDocumentWithBlock(
				conversationId,
				"Book the flight to Vienna. It leaves early in the morning and lands before lunch.",
			);
			await createComment({
				userId: await testUserId(),
				artifactId: artifact.id,
				anchor: anchorFor(block.id, block.markdown, "flight"),
				author: "user",
				body: "Laptop fit comment",
			});
			await page.setViewportSize({ width, height });
			await openChatAndReload(page, conversationId);
			await page.getByTestId("artifact-count-button").click();
			await page
				.getByTestId("artifact-panel-list")
				.getByTestId("artifact-row")
				.click({ timeout: 30_000 });
			const shell = desktopShell(page);
			const rail = shell.locator(".document-content-rail");
			const text = shell.locator(".document-content-text");
			const prose = shell.locator(".document-editor-host .document-content");
			await expect(rail).toBeVisible({ timeout: 30_000 });

			async function widths() {
				await waitForStableBoundingBox(text);
				await waitForStableBoundingBox(rail);
				await waitForStableBoundingBox(prose);
				return {
					text: (await text.boundingBox())?.width ?? 0,
					rail: (await rail.boundingBox())?.width ?? 0,
					prose: (await prose.boundingBox())?.width ?? 0,
				};
			}

			const docked = await widths();
			// The text column keeps at least 480px (440px of words a line) and
			// the column is 240-300px, whichever the panel has room for.
			expect(docked.text).toBeGreaterThanOrEqual(480);
			expect(docked.prose).toBeGreaterThanOrEqual(440);
			expect(docked.rail).toBeGreaterThanOrEqual(240);
			expect(docked.rail).toBeLessThanOrEqual(300);
			await expect(shell.getByText("Laptop fit comment")).toBeVisible();

			await shell.locator(".workspace-expand-button").click();
			await expect(shell).toHaveClass(/workspace-shell-expanded/);
			const expanded = await widths();
			expect(expanded.text).toBeGreaterThanOrEqual(480);
			expect(expanded.prose).toBeGreaterThanOrEqual(440);
			expect(expanded.rail).toBeGreaterThanOrEqual(240);
			expect(expanded.rail).toBeLessThanOrEqual(300);
			// (Reported for the record; the assertions above are the contract.)
			test.info().annotations.push({
				type: "measured",
				description: `docked text ${Math.round(docked.text)} rail ${Math.round(docked.rail)} prose ${Math.round(docked.prose)}; expanded text ${Math.round(expanded.text)} rail ${Math.round(expanded.rail)} prose ${Math.round(expanded.prose)}`,
			});
		});
	});
}
