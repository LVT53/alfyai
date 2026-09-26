import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifacts, users } from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import { runReadArtifactTool } from "../../src/lib/server/services/normal-chat-tools/artifact-tools/read";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_EDIT_ARTIFACT_MARKER,
	AI_SMOKE_MODEL_ID,
	encodeEditArtifactScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { createConversation, login, sendMessage } from "./helpers";

// Slice 1's T8/T9/T11 surfaces: change marks, Keep/Undo and the refusal
// notice are unit-tested directly against a real Tiptap editor in
// `src/lib/components/artifacts/document/marks.test.ts`, `ChangeBar.test.ts`,
// `AlfyWriting.test.ts`, `RefusalNotice.test.ts` and `DocumentBody.test.ts`
// (the last with a fake editor module, proving DocumentBody's OWN reaction to
// `alfyActivity` — the shimmer, the reload, the marks, the notice). They also
// fire only in response to a real chat turn while an already-open panel is
// live, so "T8 live"'s own end-to-end proof is the
// `AI_SMOKE_EDIT_ARTIFACT_MARKER` scenario below (`openai-compatible-provider.ts`)
// driving a REAL `edit_artifact` call through the real `/api/chat/stream`
// path — never a seeded/pre-applied `PatchResult`, which would prove nothing
// about the live wiring (a mark is a purely in-session annotation, never part
// of the stored Markdown). The "Ask Alfy" / "Comment" selection bubble is
// T10's surface, covered by `tests/e2e/artifact-document-comments.spec.ts`.
//
// FIXED, formerly CRITICAL finding (not introduced by T8/T9/T11, found while
// writing this file, root-caused and fixed in `document-editor.ts`): against
// a REAL browser, any edit that reached `DocumentBody.svelte`'s
// `currentCanonicalMarkdown()` — typing a character, clicking "Add a tab",
// choosing a chip option — eventually threw `RangeError: Maximum call stack
// size exceeded` inside ProseMirror's `Fragment.nodesBetween`, reached either
// through `readMarkdown` → `EditorView.dispatch` → `@tiptap/extension-table`'s
// `fixTables` `appendTransaction`, or later through a plain
// `editor.isActive(...)` call in `updateActiveActionIds`. Neither of those was
// the actual cause: `readMarkdown`'s two throwaway marker-insert/-delete
// transactions dispatched without Tiptap's `preventUpdate` meta flag, so each
// one fired `Editor`'s `update` event, which is wired to
// `DocumentBody.svelte`'s `handleUpdate` — which calls
// `currentCanonicalMarkdown()`, which calls `readMarkdown` again, whose two
// dispatches fired `update` again, unboundedly, synchronously, until the call
// stack overflowed; whichever tree-walk (`fixTables`, `isActive`) happened to
// be running when the limit was hit is what the stack trace showed, not the
// cause. `document-editor.test.ts`'s own round-trip test (T7.5) never caught
// this because it calls `createDocumentEditor`/`loadMarkdown`/`readMarkdown`
// without wiring an `onUpdate` callback at all, so Tiptap's `update` event had
// nothing to re-enter. Fixed by marking every internal, non-user-edit
// dispatch in `document-editor.ts`/`extensions.ts` (`readMarkdown`'s two
// transactions, `ensureBlockIds`, `loadMarkdown`'s `setContent`) with
// `preventUpdate: true` / `emitUpdate: false`. Regression coverage: "sustained
// edits — typing, a table cell, adding a tab, and a chip change — never crash
// the editor" below drives all four triggers back to back in one open editor
// and asserts no `pageerror` fired.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

/** Seeds a real Document artifact (through the real service, not a raw insert) so its body is genuinely canonical Markdown with real block ids. */
async function seedDocument(params: {
	conversationId: string;
	title: string;
	markdown: string;
	tabs?: { id: string; title: string; startBlockId: string }[];
}): Promise<string> {
	const userId = await testUserId();
	const record = await createDocumentArtifact({
		userId,
		conversationId: params.conversationId,
		title: params.title,
		markdown: params.markdown,
		author: "user",
		summary: "Seeded for E2E",
	});
	if (params.tabs) {
		await db
			.update(artifacts)
			.set({
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: params.title,
					tabs: params.tabs,
				}),
			})
			.where(eq(artifacts.id, record.id));
	}
	return record.id;
}

/** The artifact's raw stored `content_text` — the ground truth an autosave/tab/chip write actually lands in. */
async function readStoredBody(artifactId: string): Promise<string> {
	const [row] = await db
		.select({ contentText: artifacts.contentText })
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.limit(1);
	return row?.contentText ?? "";
}

async function readStoredMetadata(artifactId: string): Promise<string> {
	const [row] = await db
		.select({ metadataJson: artifacts.metadataJson })
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.limit(1);
	return row?.metadataJson ?? "";
}

async function openChatAndReload(page: Page, conversationId: string) {
	// Mirrors artifacts-panel.spec.ts's own helper: the model backend is
	// unreachable in this environment, so the first send never completes and
	// leaves the "pending message" flag set; clearing it directly is more
	// reliable than racing the client-side consume-on-mount logic.
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/**
 * Below `md` the mobile backdrop shell renders a compact count button and a
 * distinct list id (`artifact-panel-list-mobile`), not the desktop aside's
 * `artifact-count-button` / `artifact-panel-list` — mirroring
 * `artifacts-panel.spec.ts`'s own 390×844 test, which the mobile-toolbar
 * tests below need too since they run at that width.
 */
async function openDocumentFromPanel(page: Page) {
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	const countButton = page.getByTestId(
		isMobile ? "artifact-count-button-compact" : "artifact-count-button",
	);
	await countButton.click();
	const list = page.getByTestId(
		isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
	);
	// A generous timeout absorbs the dev server's one-time compile of the
	// Document editor's module graph (Tiptap and everything it pulls in) on
	// the very first Document ever opened in a test run — every later open in
	// the same run is instant because Vite has already transformed it. The
	// workspace becoming visible is the SAME one-time cost (it waits on the
	// same lazy import), so it gets the same generous budget.
	await list.getByRole("button", { name: "Open" }).click({ timeout: 30_000 });
	// The desktop shell is a real `<aside>` (role="complementary" for free);
	// the mobile shell is a `<section>` with its own dedicated testid instead
	// — NOT the same role/name pair, on purpose. Both shells are always real
	// DOM nodes at every viewport (CSS, not a conditional, decides which one
	// is visible), and jsdom's component tests do not filter `getByRole` by
	// computed style the way a real browser's accessibility tree does; giving
	// the mobile shell the identical role/name broke dozens of desktop-only
	// component tests that (correctly, for a real browser) assume that pair
	// is unique. Distinct identifiers side-step that entirely.
	const shell = isMobile
		? page.getByTestId("document-workspace-mobile-shell")
		: page.getByRole("complementary", { name: "Document workspace" });
	await expect(shell).toBeVisible({ timeout: 30_000 });
	await expect(
		shell.getByTestId(
			isMobile ? "page-scroll-container-mobile" : "page-scroll-container",
		),
	).toBeVisible();
	return shell;
}

test.describe("the Document panel", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("opens a document from the panel and shows its content in the editor", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Vienna trip plan",
			markdown: "# Vienna trip\n\nBook the hotel by Friday.",
		});
		await openChatAndReload(page, conversationId);

		const shell = await openDocumentFromPanel(page);

		// "Vienna trip plan" (the title) and "Vienna trip" (the body's own
		// heading) both recur several times across the page shell (the
		// workspace header, a hidden breadcrumb/tooltip duplicate, …) — a
		// plain text match is not unique or reliably the VISIBLE one, so this
		// scopes to the workspace and asserts the actual body heading by role.
		await expect(
			shell.getByRole("heading", { name: "Vienna trip" }),
		).toBeVisible();
		await expect(page.getByText("Book the hotel by Friday.")).toBeVisible();
	});

	test("editing text autosaves through the body route, and the change survives a reload", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Plan a trip");
		const artifactId = await seedDocument({
			conversationId,
			title: "Notes",
			markdown: "Original text.",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const editor = page.locator(".document-editor-host .document-content");
		await editor.click();
		await editor.pressSequentially(" Added by the test.");

		// Polls the ACTUAL persisted row rather than racing a specific network
		// response: the 800ms autosave debounce means the PATCH lands some time
		// after the last keystroke, and the row is the real ground truth for
		// "did the save happen" regardless of exactly which request carried it.
		await expect
			.poll(() => readStoredBody(artifactId), { timeout: 15_000 })
			.toContain("Original text. Added by the test.");

		await page.reload({ waitUntil: "networkidle" });
		await expect(
			page.getByText("Original text. Added by the test."),
		).toBeVisible();
	});

	test("hides the tab strip for a single-tab document", async ({ page }) => {
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Notes",
			markdown: "Just one section.",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		await expect(page.getByRole("tab")).toHaveCount(0);
		// "Add a tab" stays reachable even with the strip hidden.
		await expect(page.getByRole("button", { name: "Add a tab" })).toBeVisible();
	});

	test("shows every tab from a multi-section document, first one active, and adding one persists", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Plan a trip");
		const artifactId = await seedDocument({
			conversationId,
			title: "Trip",
			markdown: "# Plan\n\nBook the hotel.\n\n# Budget\n\nEstimate: $500.",
			tabs: [
				{ id: "tab-plan", title: "Plan", startBlockId: "" },
				{ id: "tab-budget", title: "Budget", startBlockId: "" },
			],
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const tabs = page.getByRole("tab");
		await expect(tabs).toHaveCount(2);
		await expect(tabs.nth(0)).toHaveText("Plan");
		await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

		await page.getByRole("button", { name: "Add a tab" }).click();
		await expect(page.getByRole("tab")).toHaveCount(3);
		await expect(page.getByRole("tab").nth(2)).toHaveText("New section");

		// Confirms the write actually reached the stored row before reloading —
		// a reload racing an in-flight save would otherwise show 2 tabs again
		// and the test would look like a UI bug that is really just a race.
		await expect
			.poll(() => readStoredMetadata(artifactId), { timeout: 15_000 })
			.toContain("New section");

		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByRole("tab")).toHaveCount(3);
	});

	test("a status chip renders as a listbox with the localized label, and choosing another option writes the canonical token", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Plan a trip");
		const artifactId = await seedDocument({
			conversationId,
			title: "Trip",
			markdown: 'Hotel: [chip kind="status" value="Booked"]',
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const select = page.locator(".tracker-chip-select");
		await expect(select).toBeVisible();
		await expect(select).toHaveValue("Booked");

		await select.selectOption("To book");

		await expect
			.poll(() => readStoredBody(artifactId), { timeout: 15_000 })
			.toContain('value="To book"');
	});

	// Regression test for the header comment's crash: a sustained run of real
	// edits — several keystrokes, a table cell, "Add a tab", and a chip change
	// — each reaches `currentCanonicalMarkdown` → `readMarkdown`, which used to
	// re-enter `handleUpdate` through its own throwaway marker-insert/-delete
	// dispatches and recurse until the stack overflowed. No single assertion
	// above exercises all four triggers back to back in one still-open editor,
	// which is exactly the shape a real editing session has.
	test("sustained edits — typing, a table cell, adding a tab, and a chip change — never crash the editor", async ({
		page,
	}) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));

		const conversationId = await createConversation(page, "Plan a trip");
		const artifactId = await seedDocument({
			conversationId,
			title: "Trip",
			markdown: [
				"# Plan",
				"",
				"Some notes.",
				"",
				"| a | b |",
				"| - | - |",
				"| 1 | 2 |",
				"",
				'Hotel: [chip kind="status" value="Booked"]',
			].join("\n"),
			tabs: [{ id: "tab-plan", title: "Plan", startBlockId: "" }],
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const editor = page.locator(".document-editor-host .document-content");
		await editor.click();
		await editor.pressSequentially("Typed once. ");
		await editor.pressSequentially("Typed twice. ");
		await editor.pressSequentially("Typed a third time.");

		const cell = page.locator("table td").first();
		await cell.click();
		await page.keyboard.type("edited ");

		await page.getByRole("button", { name: "Add a tab" }).click();
		await expect(page.getByRole("tab")).toHaveCount(2);

		const select = page.locator(".tracker-chip-select");
		await select.selectOption("To book");
		await expect(select).toHaveValue("To book");

		// The ground truth that every trigger above actually reached the
		// server, not just the live DOM — the same poll-the-row pattern the
		// tests above use, now for the LAST edit in the sequence.
		await expect
			.poll(() => readStoredBody(artifactId), { timeout: 15_000 })
			.toContain("Typed a third time.");
		await expect
			.poll(() => readStoredBody(artifactId), { timeout: 15_000 })
			.toContain("edited");

		expect(pageErrors).toEqual([]);
	});
});

// FIXED, formerly SECOND FINDING (independent of the readMarkdown recursion
// above): opening a Document from the MOBILE panel list
// (`artifact-panel-list-mobile`) did not reach a visible
// `role="complementary" name="Document workspace"` within 30s, even though
// the identical click sequence (`openDocumentFromPanel`) worked reliably at
// desktop width and `artifacts-panel.spec.ts`'s own 390×844 test confirmed
// the mobile LIST itself opened correctly. Root cause, found by running this
// suite's own helper against the real DOM: `DocumentWorkspace.svelte` renders
// TWO real shells for the "a document is open" state — a mobile `<section>`
// and a desktop `<aside>` — always both in the DOM at once, with CSS
// (`display: none` outside each one's own breakpoint) deciding which is
// actually shown. The desktop `<aside>` gets `role="complementary"` for free
// from its tag; the mobile `<section>` had only an `aria-label`, which gives
// it the "region" role, never "complementary" — so `getByRole("complementary",
// ...)` could never match it, no matter how correctly the state transition
// itself worked. Separately, the desktop shell's inner
// `data-testid="page-scroll-container"` div had no mobile counterpart at all.
// Fixed by giving the mobile shell its own dedicated identifiers instead —
// `data-testid="document-workspace-mobile-shell"` on the section itself and
// `data-testid="page-scroll-container-mobile"` on its content div — rather
// than reusing the desktop's role/name pair or testid. Reusing them was the
// first fix tried here; it broke dozens of desktop-only component tests
// across `DocumentWorkspace.test.ts` and its dependents, because jsdom does
// not filter `getByRole`/`querySelectorAll` by computed style the way a real
// browser's accessibility tree does, so BOTH shells matched every query those
// tests assumed was uniquely the desktop one. `openDocumentFromPanel` (and
// `artifacts-panel.spec.ts`'s equivalent) now picks the right pair of
// identifiers by viewport instead.
test.describe("the Document mobile toolbar", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("at 390x844 the toolbar stays within its budget and the editor keeps most of the viewport", async ({
		page,
	}) => {
		// RV-1B: this used to measure 53px, 5px over the 48px budget, even
		// though MobileToolbar.svelte's own header comment computes 45px
		// (2×4px padding + 1px border + 36px button). The global mobile
		// stylesheet's "icon controls should meet the 44px target" rule
		// (`src/app.css`'s `@media (max-width: 767px)` block) applies to
		// every `.btn-icon-bare`, including this toolbar's, and its
		// `!important` 44px silently overrode the component's own 36px —
		// so the live DOM disagreed with the component's arithmetic by
		// exactly the 8px difference between 44px and 36px. Fixed by
		// opting this toolbar's buttons back out in `app.css`
		// (`.mobile-toolbar .btn-icon-bare`), which is now specific enough
		// to win over the general rule.
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Notes",
			markdown: "Some text to fill the editor.",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const toolbar = page.getByRole("toolbar", { name: "Document" });
		const box = await toolbar.boundingBox();
		expect(box).not.toBeNull();
		// The prototype's own toolbar was 226px/27% (fixed: 137px) of an 844px
		// viewport (Review Focus 7) — this budget is deliberately below both.
		expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48);

		const editorHost = page.locator(".document-editor-host");
		const editorBox = await editorHost.boundingBox();
		expect(editorBox).not.toBeNull();
		expect((editorBox?.height ?? 0) / 844).toBeGreaterThanOrEqual(0.6);
	});

	test("six primary actions are on the row and the rest open in a More sheet", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Notes",
			markdown: "Some text.",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const toolbar = page.getByRole("toolbar", { name: "Document" });
		// 6 primary actions + the "More" trigger.
		await expect(toolbar.getByRole("button")).toHaveCount(7);

		await toolbar.getByRole("button", { name: "More" }).click();
		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole("button", { name: "Table" })).toBeVisible();
	});

	test("the More sheet opens without scrolling the document, and Escape returns focus to its trigger", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Notes",
			markdown: "Some text.",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const editorHost = page.locator(".document-editor-host");
		const scrollBefore = await editorHost.evaluate((el) => el.scrollTop);

		const moreButton = page
			.getByRole("toolbar", { name: "Document" })
			.getByRole("button", {
				name: "More",
			});
		await moreButton.click();
		await expect(page.getByRole("dialog")).toBeVisible();

		const scrollAfter = await editorHost.evaluate((el) => el.scrollTop);
		expect(scrollAfter).toBe(scrollBefore);

		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).not.toBeVisible();
		await expect(moreButton).toBeFocused();
	});

	test("the toolbar is not pushed off-screen at 390x420, the viewport with a phone keyboard open", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 420 });
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Notes",
			markdown: "Some text.",
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);

		const toolbar = page.getByRole("toolbar", { name: "Document" });
		await expect(toolbar).toBeVisible();
		const box = await toolbar.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.y).toBeGreaterThanOrEqual(0);
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(420);
	});

	// RV-1B, hunt item 8: "no horizontal overflow at 390 px". Nothing tested
	// this for an OPEN document — `artifacts-panel.spec.ts`'s own 390x844
	// overflow check only covers the panel LIST, never a document with real
	// content (its own header comment says so explicitly). A wide table is
	// the one block kind actually likely to force this: verified this
	// currently holds because `.document-content`'s `overflow-y: auto`
	// computes `overflow-x` to `auto` too (the CSS spec's "if one axis is
	// visible and the other is not, visible becomes auto" rule), giving a
	// wide table its own horizontal scrollbar inside the content area rather
	// than leaking into the page — but that protection is implicit and
	// undocumented anywhere in the CSS, so a future refactor of that one
	// `overflow-y` declaration could silently reintroduce page-level
	// horizontal scroll with nothing to catch it. This test is that catch.
	test("a wide table does not force horizontal page scroll at 390x844", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createConversation(page, "Plan a trip");
		const wideTable = [
			"| Column Alpha | Column Beta | Column Gamma | Column Delta | Column Epsilon |",
			"| --- | --- | --- | --- | --- |",
			"| A rather long cell value here | Another long value | Yet more text in this cell | And even more content | The last column's long text |",
		].join("\n");
		await seedDocument({
			conversationId,
			title: "Wide table",
			markdown: wideTable,
		});
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		// The table itself, not just the shell, must be on screen before an
		// overflow reading means anything.
		await expect(page.locator(".document-editor-host table")).toBeVisible();

		const overflow = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
		}));
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
	});
});

// T9 steps 4/7: the panel list's own card preview (subtitle + tickable
// checklist), never requiring the document to be open — the card is built
// from the server's bounded preview (`ArtifactCardSummary.documentPreview`),
// not a full-body fetch. This never touches the Tiptap editor at all, so it
// is unaffected by this file's header-comment `readMarkdown` recursion bug.
test.describe("the Document card's checklist (T9 steps 4/7)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("shows the tab-count subtitle and the checklist, and ticking an item writes it through the same patch path", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Plan a trip");
		const artifactId = await seedDocument({
			conversationId,
			title: "Packing list",
			markdown: "# Packing\n\n- [ ] Charger\n\n- [ ] Passport",
		});
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button").click();
		const list = page.getByTestId("artifact-panel-list");
		// `artifacts.document.cardSubtitle`'s template is not plural-aware
		// ("Document · {count} tabs" always) — this is the literal rendered
		// text for the one default tab `createDocumentArtifact` gives a fresh
		// document.
		await expect(list.getByText("Document · 1 tabs")).toBeVisible();
		await expect(list.getByText("Charger")).toBeVisible();
		await expect(list.getByText("Passport")).toBeVisible();

		// Each tickable row is a `<label>` wrapping its own `<input>`, so the
		// checkbox's accessible name is exactly the task's text — scoping this
		// way (rather than an ancestor `<li>`, which also matches the OUTER
		// per-artifact row and so "contains" every task's text at once) finds
		// exactly one checkbox.
		const chargerCheckbox = list.getByRole("checkbox", { name: "Charger" });
		await expect(chargerCheckbox).not.toBeChecked();
		await chargerCheckbox.click();

		// The real ground truth: the stored Markdown itself, not just the
		// in-memory optimistic flip — proves the write actually landed through
		// applyPatchSet + saveArtifactBody, the SAME path the open editor uses.
		await expect
			.poll(() => readStoredBody(artifactId), { timeout: 10_000 })
			.toContain("[x] Charger");
		// The sibling task is untouched.
		await expect
			.poll(() => readStoredBody(artifactId))
			.toContain("[ ] Passport");

		// Persists after a reload — the checkbox reflects the SAVED state.
		await page.reload({ waitUntil: "networkidle" });
		await page.getByTestId("artifact-count-button").click();
		const listAfterReload = page.getByTestId("artifact-panel-list");
		await expect(
			listAfterReload.getByRole("checkbox", { name: "Charger" }),
		).toBeChecked();
	});

	test("a document with more than five task items shows '+N more'", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Plan a trip");
		await seedDocument({
			conversationId,
			title: "Big packing list",
			markdown: [
				"# Packing",
				"- [ ] One",
				"- [ ] Two",
				"- [ ] Three",
				"- [ ] Four",
				"- [ ] Five",
				"- [ ] Six",
				"- [ ] Seven",
			].join("\n\n"),
		});
		await openChatAndReload(page, conversationId);

		await page.getByTestId("artifact-count-button").click();
		const list = page.getByTestId("artifact-panel-list");
		await expect(list.getByText("One")).toBeVisible();
		await expect(list.getByText("Five")).toBeVisible();
		await expect(list.getByText("Six")).not.toBeVisible();
		await expect(list.getByText("+2 more")).toBeVisible();
	});
});

// T8 live: a REAL edit_artifact call, driven through the real /api/chat/stream
// path by the fake OpenAI-compatible provider harness (the mechanism
// instruction-suggestion-live.spec.ts already established for suggest_instruction)
// — never a seeded/pre-applied PatchResult, which would prove nothing about the
// live wiring (marks.ts's own header comment: the mark is a purely in-session
// annotation, never part of the stored Markdown). Establishes the
// "your words win" snapshot the same way a live read_artifact call would
// (runReadArtifactTool, called directly in test setup — the tool's own
// snapshot-writing behavior is exercised for real, just not through a second
// scripted model round trip this test does not need).
test.describe("T8 live — a real edit_artifact call reaches the open panel", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	test("marks the applied block and shows the refusal notice for the refused one", async ({
		page,
	}) => {
		// RV-1B: the file header's RangeError (readMarkdown/fixTables
		// recursion) is fixed — this test now exercises the real live wiring.
		// The verified persisted tool_call segment carries exactly the right
		// metadata ({ok:true, appliedCount:1, refusedBlocksJson:[{blockId,
		// reason: "block_changed"}]}), proving landAlfyActivity's own
		// `loadMarkdownFn(editor, newBody)` call lands correctly for a REAL
		// edit_artifact call in a real browser. This is the regression
		// coverage for T8 live's marks/refusal-notice wiring.
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let temporaryProvider: {
			providerId: string;
			selectedModel: string;
		} | null = null;

		try {
			const conversationId = await createConversation(page, "Plan a trip");
			const artifactId = await seedDocument({
				conversationId,
				title: "Trip plan",
				markdown: "Book the hotel.\n\nBook the flight.",
			});

			// The snapshot a live read_artifact call would have written — the
			// exact side effect `applyDocumentPatch`'s "your words win" guard
			// depends on (document-ops.ts's `readDocumentForAlfy`).
			const userId = await testUserId();
			const readResult = await runReadArtifactTool({
				userId,
				conversationId,
				artifactId,
				detail: "blocks",
				abortSignal: new AbortController().signal,
			});
			const blocks =
				readResult.modelPayload.success && "blocks" in readResult.modelPayload
					? (readResult.modelPayload.blocks as Array<{
							blockId: string;
							hash: string;
							text: string;
						}>)
					: [];
			const applyBlock = blocks.find((b) => b.text === "Book the hotel.");
			const refuseBlock = blocks.find((b) => b.text === "Book the flight.");
			expect(applyBlock, "the seeded 'Book the hotel.' block").toBeTruthy();
			expect(refuseBlock, "the seeded 'Book the flight.' block").toBeTruthy();

			temporaryProvider = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			await updateUserModelPreference(page, temporaryProvider.selectedModel);

			await openChatAndReload(page, conversationId);
			await openDocumentFromPanel(page);

			const markerMessage = `${AI_SMOKE_EDIT_ARTIFACT_MARKER} ${encodeEditArtifactScenarioPayload(
				{
					artifactId,
					applyBlockId: applyBlock?.blockId ?? "",
					applyBaseHash: applyBlock?.hash ?? "",
					refuseBlockId: refuseBlock?.blockId ?? "",
				},
			)}`;
			await sendMessage(page, markerMessage);

			await expect(
				page.getByText(AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });

			// Applied: the change is marked, with the inline Keep/Undo bar, and
			// the editor shows the new text.
			const editorContent = page.locator(
				".document-editor-host .document-content",
			);
			await expect(page.getByTestId("alfy-change-bar")).toBeVisible({
				timeout: 10_000,
			});
			await expect(
				editorContent.getByText("Book the hotel by Friday."),
			).toBeVisible();

			// Refused: the notice NAMES the untouched block (RefusalNotice's own
			// item list renders the block's label, which for this block is its
			// text — "Book the flight." — so this assertion is scoped to the
			// notice itself, not `page`, because the editor's own untouched
			// paragraph carries the identical text and a page-wide `getByText`
			// would be a strict-mode violation matching both), and the OTHER
			// block's text never changed in the document.
			const refusalNotice = page.getByTestId("refusal-notice");
			await expect(refusalNotice).toBeVisible();
			await expect(refusalNotice.getByText("Book the flight.")).toBeVisible();
			await expect(editorContent.getByText("Book the flight.")).toBeVisible();
			await expect(page.getByText("This should never land.")).toHaveCount(0);

			const storedBody = await readStoredBody(artifactId);
			expect(storedBody).toContain("Book the hotel by Friday.");
			expect(storedBody).toContain("Book the flight.");
			expect(storedBody).not.toContain("This should never land.");
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});
});

async function snapshotUserModelPreference(page: Page): Promise<string | null> {
	return page.evaluate(async () => {
		const response = await fetch("/api/settings");
		if (!response.ok) {
			throw new Error(`Failed to snapshot user settings: ${response.status}`);
		}
		const data = (await response.json()) as {
			preferences?: { preferredModel?: string | null };
		};
		return data.preferences?.preferredModel ?? null;
	});
}

async function updateUserModelPreference(
	page: Page,
	preferredModel: string | null,
): Promise<void> {
	const result = await page.evaluate(async (nextPreferredModel) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel: nextPreferredModel }),
		});
		return { ok: response.ok, status: response.status };
	}, preferredModel);
	expect(
		result.ok,
		`User model preference update failed with ${result.status}`,
	).toBe(true);
}

async function createTemporaryFakeProviderModel(
	page: Page,
	baseUrl: string,
): Promise<{ providerId: string; modelId: string; selectedModel: string }> {
	const result = await page.evaluate(
		async ({ apiKey, base, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `fake_edit_artifact_provider_${unique}`,
					displayName: `Fake Edit Artifact Provider ${unique}`,
					baseUrl: base,
					apiKey,
				}),
			});
			const providerBody = (await providerResponse.json()) as {
				provider?: { id: string };
				error?: string;
			};
			if (!providerResponse.ok || !providerBody.provider?.id) {
				return {
					ok: false as const,
					status: providerResponse.status,
					error: providerBody.error ?? "Provider creation failed",
				};
			}
			const modelResponse = await fetch(
				`/api/admin/providers/${providerBody.provider.id}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						models: [
							{
								name: modelName,
								displayName: "Fake Edit Artifact Provider Model",
								contextLength: 8192,
								supportsChat: true,
								supportsTools: true,
							},
						],
					}),
				},
			);
			const modelBody = (await modelResponse.json()) as {
				models?: Array<{ id: string }>;
				error?: string;
			};
			const modelId = modelBody.models?.[0]?.id;
			if (!modelResponse.ok || !modelId) {
				return {
					ok: false as const,
					status: modelResponse.status,
					error: modelBody.error ?? "Provider model creation failed",
					providerId: providerBody.provider.id,
				};
			}
			return {
				ok: true as const,
				providerId: providerBody.provider.id,
				modelId,
			};
		},
		{ apiKey: AI_SMOKE_API_KEY, base: baseUrl, modelName: AI_SMOKE_MODEL_ID },
	);

	expect(
		result.ok,
		`fake provider setup failed with ${
			"status" in result ? result.status : "unknown"
		}: ${"error" in result ? result.error : ""}`,
	).toBe(true);
	if (!("providerId" in result) || !("modelId" in result)) {
		throw new Error(
			"Fake provider setup did not return provider and model ids",
		);
	}
	return {
		providerId: result.providerId,
		modelId: result.modelId,
		selectedModel: `provider:${result.providerId}:${result.modelId}`,
	};
}

async function deleteTemporaryProvider(
	page: Page,
	providerId: string,
): Promise<void> {
	await page.evaluate(async (id) => {
		await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
	}, providerId);
}
