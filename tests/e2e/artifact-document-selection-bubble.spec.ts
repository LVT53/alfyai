import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import { createConversation, login } from "./helpers";

// The Document editor's selection bubble ("Ask Alfy" / "Comment", T10.1) must
// land right next to the live text selection, inside the visible page —
// never off in space. Owner report: "the overlay ... is always off screen,
// not by the cursor."
//
// Two independent bugs in `DocumentBody.svelte`'s `updateSelectionBubble`
// conspired to cause this: (1) `context.rect.top - hostRect.top` (viewport
// coordinates minus the scroll container's own viewport offset) never added
// the container's OWN `scrollTop`/`scrollLeft` back in, so any selection made
// after scrolling `.document-content` landed exactly `scrollTop` px too high
// — the more you scroll, the further off; (2) there was no "flip below when
// there's no room above" logic, so a selection near the container's own
// visible top edge placed the bubble (anchored via
// `transform: translate(-50%, -100%)`, i.e. always ABOVE the point) above the
// container's own clipped top edge — invisible even at scrollTop 0.
//
// `document-editor.ts`'s own header comment notes `coordsAtPos` throws under
// jsdom (a zeroed rect is substituted), so no unit test can see either bug —
// this drives a REAL double-click selection in a REAL browser, both before
// and after scrolling a long document, at desktop and mobile widths, and
// checks the bubble's actual screen position against the browser's OWN
// `Selection.getRangeAt(0).getBoundingClientRect()` — never the component's
// own reported position, which would just test the bug against itself.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

// Deliberately short and single-line, even inside the mobile 390px editor
// column: a marker paragraph that wraps to two lines would put the paragraph
// locator's bounding-box CENTER (where a plain `.dblclick()` lands) in the
// gap between the two wrapped lines rather than on a glyph, which does not
// reliably produce a real word selection.
const TOP_TEXT = "Topmarker begins here.";
const BOTTOM_TEXT = "Bottommarker sits far below.";

/** A document long enough that `.document-content` must scroll at both 900px and 844px viewport heights, with a uniquely-worded paragraph near the top and one far down. */
async function seedScrollingDocument(conversationId: string): Promise<string> {
	const userId = await testUserId();
	const filler = Array.from(
		{ length: 40 },
		(_, i) =>
			`Filler paragraph number ${i} pads out the document with enough sentences of ordinary text that the editor's own scroll container has real height to scroll through before reaching the next marker.`,
	);
	const markdown = [TOP_TEXT, ...filler, BOTTOM_TEXT].join("\n\n");
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: "Selection bubble regression",
		markdown,
		author: "user",
		summary: "Seeded for E2E",
	});
	return artifact.id;
}

async function openChatAndReload(page: Page, conversationId: string) {
	// Mirrors artifact-document.spec.ts's own helper: the model backend is
	// unreachable in this environment, so the first send never completes and
	// leaves the "pending message" flag set.
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** Mirrors artifact-document.spec.ts's own helper (file-local there, not exported). */
async function openDocumentFromPanel(page: Page): Promise<Locator> {
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	const countButton = page.getByTestId(
		isMobile ? "artifact-count-button-compact" : "artifact-count-button",
	);
	await countButton.click();
	const list = page.getByTestId(
		isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
	);
	await list.getByRole("button", { name: "Open" }).click({ timeout: 30_000 });
	const shell = isMobile
		? page.getByTestId("document-workspace-mobile-shell")
		: page.getByRole("complementary", { name: "Document workspace" });
	await expect(shell).toBeVisible({ timeout: 30_000 });
	return shell;
}

interface ScreenRect {
	top: number;
	left: number;
	right: number;
	bottom: number;
}

type Box = { x: number; y: number; width: number; height: number };

/** The browser's OWN idea of where the live selection sits on screen — ground truth, independent of anything the component computed. */
async function liveSelectionRect(page: Page): Promise<ScreenRect> {
	const rect = await page.evaluate(() => {
		const sel = window.getSelection();
		const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (!range) return null;
		const r = range.getBoundingClientRect();
		return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
	});
	expect(rect, "a live DOM selection must exist").not.toBeNull();
	return rect as ScreenRect;
}

/**
 * Asserts the bubble sits inside the browser viewport, inside the Document
 * scroll pane's own visible bounds (a selection bubble that is technically
 * within the browser viewport but above `.document-content`'s own clipped
 * top edge is still invisible to the user — `overflow-y: auto` hides it),
 * horizontally over the selection (or pinned to an edge), and within ~48px
 * above or below it vertically.
 */
function assertBubbleNearSelection(
	bubbleBox: Box,
	selectionRect: ScreenRect,
	viewport: { width: number; height: number },
	containerBox: Box,
) {
	// Inside the browser viewport.
	expect(bubbleBox.x).toBeGreaterThanOrEqual(0);
	expect(bubbleBox.y).toBeGreaterThanOrEqual(0);
	expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(viewport.width + 1);
	expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(
		viewport.height + 1,
	);

	// Inside the scroll pane's own visible box — not clipped by its overflow.
	expect(bubbleBox.y).toBeGreaterThanOrEqual(containerBox.y - 2);
	expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(
		containerBox.y + containerBox.height + 2,
	);
	expect(bubbleBox.x).toBeGreaterThanOrEqual(containerBox.x - 2);
	expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(
		containerBox.x + containerBox.width + 2,
	);

	// Horizontally over the selection, or pinned against a viewport edge.
	const overlapsHorizontally =
		bubbleBox.x <= selectionRect.right &&
		bubbleBox.x + bubbleBox.width >= selectionRect.left;
	const pinnedToEdge =
		bubbleBox.x <= 1 || bubbleBox.x + bubbleBox.width >= viewport.width - 1;
	expect(overlapsHorizontally || pinnedToEdge).toBe(true);

	// Within ~48px above or below the selection (0 if they visually overlap).
	let verticalGap = 0;
	if (bubbleBox.y + bubbleBox.height <= selectionRect.top) {
		verticalGap = selectionRect.top - (bubbleBox.y + bubbleBox.height);
	} else if (bubbleBox.y >= selectionRect.bottom) {
		verticalGap = bubbleBox.y - selectionRect.bottom;
	}
	expect(verticalGap).toBeLessThanOrEqual(48);
}

async function selectWordAndReadBubble(
	page: Page,
	shell: Locator,
	paragraphText: string,
): Promise<{ bubbleBox: Box; selectionRect: ScreenRect }> {
	const paragraph = shell
		.locator(".document-editor-host")
		.getByText(paragraphText, { exact: true });
	// Playwright's own actionability scrolls `.document-content` (the only
	// scrollable ancestor here — the app shell does not scroll the body) to
	// reach this paragraph before clicking it, exactly the "scroll down, then
	// select" step a real user performs. The click only needs to focus the
	// editor inside this paragraph; a native double-click's word-boundary
	// hit-testing (and, worse, this editor's own `Home`/`End` handling, which
	// turned out to jump to document start/end rather than line start/end)
	// are both unpredictable this close to a scroll pane's edge. A
	// programmatic Range over this exact paragraph's own text node, set right
	// after the click, gives a precise and deterministic non-empty selection
	// — real enough that ProseMirror's own `selectionchange` listener (it
	// must react to selections made outside its own mouse/keyboard handlers,
	// e.g. "Select All" or find-in-page) picks it up exactly as it would a
	// real drag-selection.
	await paragraph.click();
	await page.evaluate((text) => {
		const root = document.querySelector(".document-editor-host");
		if (!root) throw new Error("editor host not found");
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node: Text | null = null;
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.textContent === text) {
				node = n as Text;
				break;
			}
		}
		if (!node) throw new Error(`paragraph text node not found: ${text}`);
		const range = document.createRange();
		range.setStart(node, 0);
		range.setEnd(node, Math.min(9, node.textContent?.length ?? 0));
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
	}, paragraphText);
	const bubble = page.getByTestId("selection-bubble");
	await expect(bubble).toBeVisible();
	const selectionRect = await liveSelectionRect(page);
	const bubbleBox = await bubble.boundingBox();
	expect(bubbleBox, "the bubble must have a bounding box").not.toBeNull();
	return { bubbleBox: bubbleBox as Box, selectionRect };
}

test.describe("the Document selection bubble follows the live selection", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	for (const viewport of [
		{ width: 1440, height: 900, label: "desktop, beside the chat" },
		{ width: 390, height: 844, label: "mobile, full-screen shell" },
	]) {
		test(`stays next to the selection before and after scrolling (${viewport.label})`, async ({
			page,
		}) => {
			await page.setViewportSize({
				width: viewport.width,
				height: viewport.height,
			});
			const conversationId = await createConversation(
				page,
				"Selection bubble regression",
			);
			await seedScrollingDocument(conversationId);
			await openChatAndReload(page, conversationId);
			const shell = await openDocumentFromPanel(page);

			// `.document-content` appears twice in the DOM — DocumentBody.svelte's
			// own scroll-container wrapper (a direct child of `.document-main`)
			// and, nested inside `.document-editor-host`, Tiptap's own
			// contenteditable root (also classed `.document-content` — see that
			// file's `.document-editor-host :global(.document-content)` rule). The
			// direct-child selector picks only the outer, actually-scrolling one.
			const containerBox = await page
				.locator(".document-main > .document-content")
				.boundingBox();
			expect(
				containerBox,
				"the document scroll pane must be visible",
			).not.toBeNull();

			// Near the top, unscrolled.
			const top = await selectWordAndReadBubble(page, shell, TOP_TEXT);
			assertBubbleNearSelection(
				top.bubbleBox,
				top.selectionRect,
				viewport,
				containerBox as Box,
			);

			// Scrolled: reaching this paragraph forces a real scroll of
			// `.document-content` first.
			const bottom = await selectWordAndReadBubble(page, shell, BOTTOM_TEXT);
			assertBubbleNearSelection(
				bottom.bubbleBox,
				bottom.selectionRect,
				viewport,
				containerBox as Box,
			);
		});
	}
});
