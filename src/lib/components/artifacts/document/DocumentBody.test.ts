import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import type { DocumentAlfyActivity } from "./alfy-activity";

const {
	mockFetchArtifact,
	mockSaveArtifactBody,
	mockCreateDocumentCopy,
	mockSaveDocumentTabs,
	mockCreateArtifactComment,
	mockResolveArtifactComment,
	mockAskAlfyInComment,
	mockExportArtifactDocument,
	mockFetchArtifactVersions,
	mockRestoreArtifactVersion,
	mockFetchDocumentReviewState,
	mockAcknowledgeDocumentReviewBlocks,
} = vi.hoisted(() => ({
	mockFetchArtifact: vi.fn(),
	mockSaveArtifactBody: vi.fn(),
	mockCreateDocumentCopy: vi.fn(),
	mockSaveDocumentTabs: vi.fn(),
	mockCreateArtifactComment: vi.fn(),
	mockResolveArtifactComment: vi.fn(),
	mockAskAlfyInComment: vi.fn(),
	mockExportArtifactDocument: vi.fn(),
	// RV-1B: VersionsSheet.svelte's own two calls — previously unreachable
	// from DocumentBody (no toolbar action opened it), so this mock never
	// needed to exist here before.
	mockFetchArtifactVersions: vi.fn(),
	mockRestoreArtifactVersion: vi.fn(),
	// Ruling 61: defaults to "nothing pending" so every test that never cares
	// about this stays unaffected; the suite's own describe block overrides
	// these per test.
	mockFetchDocumentReviewState: vi.fn().mockResolvedValue([]),
	mockAcknowledgeDocumentReviewBlocks: vi.fn().mockResolvedValue([]),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: mockFetchArtifact,
	saveArtifactBody: mockSaveArtifactBody,
	createDocumentCopy: mockCreateDocumentCopy,
	saveDocumentTabs: mockSaveDocumentTabs,
	createArtifactComment: mockCreateArtifactComment,
	resolveArtifactComment: mockResolveArtifactComment,
	askAlfyInComment: mockAskAlfyInComment,
	fetchArtifactVersions: mockFetchArtifactVersions,
	restoreArtifactVersion: mockRestoreArtifactVersion,
	exportArtifactDocument: mockExportArtifactDocument,
	fetchDocumentReviewState: mockFetchDocumentReviewState,
	acknowledgeDocumentReviewBlocks: mockAcknowledgeDocumentReviewBlocks,
}));

// Wave 2.5 Step 8: jsdom's default `window.innerWidth` (1024) already means
// "not phone" for every OTHER test in this file, matching the real
// `isPhoneViewport()` this mock replaces — so this only changes behaviour in
// the one describe block below that flips `mockViewportState.isPhone` to
// drive the phone-sheet branch without a real resize.
const { mockViewportState } = vi.hoisted(() => ({
	mockViewportState: { isPhone: false },
}));
vi.mock("$lib/utils/viewport.svelte", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/utils/viewport.svelte")>();
	return {
		...actual,
		isPhoneViewport: () => mockViewportState.isPhone,
		watchPhoneViewport: () => () => {},
	};
});

const {
	mockCreateDocumentEditor,
	mockReadMarkdown,
	mockLoadMarkdown,
	mockReadSelectionAnchorContext,
	mockApplyAlfyChanges,
	mockKeepChange,
	mockUndoChange,
	mockRemarkChange,
	mockChangeDocRange,
	mockScrollToChange,
	mockSetChangePills,
	mockSummarizeRefusals,
	mockRefusalReasonI18nKey,
	mockSetActiveDocumentTab,
	mockAppendEmptyTabSection,
	mockSetCommentAnchors,
	mockScrollToCommentAnchor,
	mockSetAlfyWritingBlock,
	mockSetSelectionPending,
	mockSetRefusedLines,
	mockBlockRect,
	mockSelectAndScrollToBlock,
	editorInstances,
} = vi.hoisted(() => ({
	mockCreateDocumentEditor: vi.fn(),
	mockReadMarkdown: vi.fn(),
	mockLoadMarkdown: vi.fn(),
	mockReadSelectionAnchorContext: vi.fn(),
	mockApplyAlfyChanges: vi.fn(),
	mockKeepChange: vi.fn(),
	mockUndoChange: vi.fn(),
	// Wave 2.5 Step 10: the inline pill's own Redo / ruling 61's reload-restore
	// re-marking, and the pill's positioning fallback — no-ops against this
	// suite's fake editor, same reasoning as the comment-anchor mocks below.
	mockRemarkChange: vi.fn().mockReturnValue(true),
	mockChangeDocRange: vi.fn().mockReturnValue(null),
	mockScrollToChange: vi.fn(),
	mockSetChangePills: vi.fn(),
	mockSummarizeRefusals: vi.fn(),
	mockRefusalReasonI18nKey: vi.fn(),
	// Wave 2.5 Step 5: the tab-range visibility trigger (extensions.ts'
	// tabSectionPluginKey) — a no-op here, since these tests use a fake
	// editor with no real ProseMirror state to dispatch a transaction into.
	mockSetActiveDocumentTab: vi.fn(),
	// Review 2.5 (rd/review-2-5.md:191-197): mints a real anchor block for a
	// brand-new tab. Returns `null` by default (this suite's fake editor has
	// no real ProseMirror doc to mint against); a test that needs the
	// "minted a real id" branch sets a return value explicitly.
	mockAppendEmptyTabSection: vi.fn().mockReturnValue(null),
	// Wave 2.5 Step 7: the comment-anchor decoration's own write side — same
	// reasoning, a no-op against this suite's fake editor.
	mockSetCommentAnchors: vi.fn(),
	mockScrollToCommentAnchor: vi.fn(),
	// Wave 2.5 Step 9/11: the Ask-Alfy chain's own decoration write sides —
	// same reasoning, no-ops against this suite's fake editor.
	mockSetAlfyWritingBlock: vi.fn(),
	mockSetSelectionPending: vi.fn(),
	mockSetRefusedLines: vi.fn(),
	mockBlockRect: vi.fn().mockReturnValue(null),
	mockSelectAndScrollToBlock: vi.fn().mockReturnValue(true),
	editorInstances: [] as Array<{
		options: Record<string, unknown>;
		destroy: ReturnType<typeof vi.fn>;
		isActive: ReturnType<typeof vi.fn>;
		view: { focus: ReturnType<typeof vi.fn> };
	}>,
}));

vi.mock("./document-editor", () => ({
	createDocumentEditor: mockCreateDocumentEditor,
	readMarkdown: mockReadMarkdown,
	loadMarkdown: mockLoadMarkdown,
	readSelectionAnchorContext: mockReadSelectionAnchorContext,
	applyAlfyChanges: mockApplyAlfyChanges,
	keepChange: mockKeepChange,
	undoChange: mockUndoChange,
	remarkChange: mockRemarkChange,
	changeDocRange: mockChangeDocRange,
	scrollToChange: mockScrollToChange,
	setChangePills: mockSetChangePills,
	summarizeRefusals: mockSummarizeRefusals,
	refusalReasonI18nKey: mockRefusalReasonI18nKey,
	setActiveDocumentTab: mockSetActiveDocumentTab,
	appendEmptyTabSection: mockAppendEmptyTabSection,
	setCommentAnchors: mockSetCommentAnchors,
	scrollToCommentAnchor: mockScrollToCommentAnchor,
	setAlfyWritingBlock: mockSetAlfyWritingBlock,
	setSelectionPending: mockSetSelectionPending,
	setRefusedLines: mockSetRefusedLines,
	blockRect: mockBlockRect,
	selectAndScrollToBlock: mockSelectAndScrollToBlock,
}));

// A fake stands in for the real Tiptap editor: `document-editor.test.ts`
// already proves the real one round-trips canonical Markdown correctly
// (T7.5's named gate lives there), so this suite's own job is DocumentBody's
// half of the contract — dirty tracking, debounced canonical posting, and
// every named failure mode — none of which needs a real ProseMirror instance
// or jsdom contenteditable simulation, which would make these tests slow and
// flaky for no added proof.
function makeFakeEditor() {
	const chain: Record<string, ReturnType<typeof vi.fn>> = {};
	const chainMethodNames = [
		"focus",
		"toggleBold",
		"toggleItalic",
		"toggleStrike",
		"toggleHeading",
		"toggleBulletList",
		"toggleOrderedList",
		"toggleTaskList",
		"toggleBlockquote",
		"toggleCodeBlock",
		"insertTable",
		"toggleLink",
		"unsetLink",
		"undo",
		"redo",
		"run",
	];
	for (const name of chainMethodNames) {
		chain[name] = vi.fn(() => chain);
	}
	const isActive = vi.fn(() => false);
	const destroy = vi.fn();
	return {
		chain: vi.fn(() => chain),
		isActive,
		destroy,
		// Wave 2.5 Step 9: `updateSelectionBubble` reads the live selection's
		// own raw positions directly (`editor.state.selection.from`/`to`) for
		// the selection-pending highlight — a static stub is enough here,
		// since these tests never assert on the exact positions themselves.
		state: { selection: { from: 0, to: 5 } },
		// Review 2.5 (rd/review-2-5.md:198-207): `dismissSelectionBubble` calls
		// `editor.view.focus()` directly (never the `chain()`/`commands` path
		// above — Tiptap's own `commands.focus()` defers the real DOM focus,
		// see that function's own comment), so this fake needs its own stub.
		view: { focus: vi.fn() },
		_chain: chain,
	};
}

function setupCreateDocumentEditor() {
	mockCreateDocumentEditor.mockImplementation(
		(options: Record<string, unknown>) => {
			const fake = makeFakeEditor();
			editorInstances.push({
				options,
				destroy: fake.destroy,
				isActive: fake.isActive,
				view: fake.view,
			});
			return fake;
		},
	);
}

function latestEditor() {
	const entry = editorInstances[editorInstances.length - 1];
	if (!entry) throw new Error("no editor instance created yet");
	return entry;
}

/** Simulates "the user typed", through the SAME two callbacks the real editor fires. */
function simulateTyping(markdown: string) {
	mockReadMarkdown.mockReturnValue(markdown);
	const { options } = latestEditor();
	(options.onDirty as () => void)();
	(options.onUpdate as () => void)();
}

import DocumentBody from "./DocumentBody.svelte";

const ARTIFACT_DETAIL = (
	overrides: Record<string, unknown> = {},
	comments: unknown[] = [],
) => ({
	artifact: {
		id: "artifact-1",
		userId: "user-1",
		conversationId: "conv-1",
		kind: "document",
		title: "Trip plan",
		body: "<!--b:p1-->\nHello.",
		bodyHash: "h1",
		metadata: { artifactType: "document", title: "Trip plan" },
		versionNumber: 1,
		commentCount: 0,
		updatedAt: 1,
		...overrides,
	},
	versions: [],
	comments,
});

describe("DocumentBody", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		editorInstances.length = 0;
		mockViewportState.isPhone = false;
		setupCreateDocumentEditor();
		mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());
		mockSaveArtifactBody.mockResolvedValue({ ok: true, version: 2 });
		mockSaveDocumentTabs.mockResolvedValue({ ok: true, version: 2 });
		mockFetchArtifactVersions.mockResolvedValue([]);
		mockRestoreArtifactVersion.mockResolvedValue(2);
		mockReadSelectionAnchorContext.mockReturnValue(null);
		mockApplyAlfyChanges.mockReturnValue([]);
		mockSummarizeRefusals.mockReturnValue(null);
		mockRemarkChange.mockReturnValue(true);
		mockChangeDocRange.mockReturnValue(null);
		mockKeepChange.mockReturnValue(true);
		mockUndoChange.mockReturnValue(true);
		mockScrollToChange.mockReturnValue(true);
		// A real, always-resolvable key by default; the refusal-notice test
		// below overrides this to prove the CODE (not just presence) reaches
		// the rendered reason text.
		mockRefusalReasonI18nKey.mockReturnValue(
			"artifacts.document.refused.other",
		);
	});

	afterEach(() => {
		cleanup();
	});

	it("renders the editor host and the toolbar, and loads the editor module once across three re-renders", async () => {
		const { rerender } = render(DocumentBody, {
			artifactId: "artifact-1",
			kind: "document",
			title: "Trip plan",
			body: null,
		});

		await waitFor(() =>
			expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
		);
		// T11: the desktop and mobile toolbars are both in the DOM at once (CSS
		// alone decides which one is visible — jsdom applies no CSS, so both
		// `role="toolbar"` landmarks are present here; a real browser's
		// `display: none` also removes the hidden one from the accessibility
		// tree, which jsdom cannot verify).
		expect(screen.getAllByRole("toolbar", { name: "Document" })).toHaveLength(
			2,
		);

		await rerender({
			artifactId: "artifact-1",
			kind: "document",
			title: "Trip plan",
			body: null,
		});
		await rerender({
			artifactId: "artifact-1",
			kind: "document",
			title: "Trip plan",
			body: null,
		});

		// Re-rendering with the SAME artifactId must not reload or remount.
		expect(mockFetchArtifact).toHaveBeenCalledTimes(1);
		expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1);
	});

	it("marks the body dirty and posts the SERVER's canonical Markdown after the debounce, not a second canonicaliser", async () => {
		vi.useFakeTimers();
		try {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				// Ruling 51: the panel's own conversationId is a plain prop now —
				// this proves it reaches saveArtifactBody unchanged, so an
				// incognito conversation's own Document still resolves for its
				// owner.
				conversationId: "conv-1",
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			const rawFromBrowser = "<!--b:p1-->\n*   a loose bullet   ";
			simulateTyping(rawFromBrowser);

			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1),
			);

			const expectedCanonical = serializeDocument(
				parseDocument(rawFromBrowser).blocks,
			);
			expect(mockSaveArtifactBody).toHaveBeenCalledWith(
				"artifact-1",
				expectedCanonical,
				1,
				"conv-1",
				undefined,
				// RV-1B, coordinator item 6: `h1` is ARTIFACT_DETAIL()'s own
				// `bodyHash`, known from the load this autosave follows.
				{ baseHash: "h1" },
			);
			// A raw, non-canonical bullet marker actually got normalised — this
			// assertion would also pass on a no-op canonicaliser, so it is
			// meaningless on its own; the exact-match call above is the real
			// proof, this just documents WHY the two strings differ.
			expect(expectedCanonical).not.toBe(rawFromBrowser);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a version_conflict keeps the user's text and shows the conflict notice", async () => {
		vi.useFakeTimers();
		try {
			mockSaveArtifactBody.mockResolvedValue({
				ok: false,
				reason: "version_conflict",
			});
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			simulateTyping("<!--b:p1-->\nEdited.");
			vi.advanceTimersByTime(800);

			await vi.waitFor(() =>
				expect(
					screen.getByText(
						"This document changed elsewhere. Reload to see the current text.",
					),
				).toBeInTheDocument(),
			);
			// The text is never touched by DocumentBody on a conflict — the
			// editor host is still mounted and the fake editor was never destroyed.
			expect(latestEditor().destroy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// RV-1B, coordinator item 6: the route now refuses a save `stale` when its
	// `baseHash` no longer matches what is really stored — this is the SAME
	// user-visible outcome as `version_conflict` (the existing case above),
	// proved separately because `stale` is the NEW reason a real two-tab
	// clobber actually produces (ruling 47's coalescing lets both tabs'
	// `expectVersion` legally agree, so `version_conflict` alone never fires
	// for this scenario).
	it("a stale refusal (a second tab's save landed first) keeps the user's text and shows the conflict notice", async () => {
		vi.useFakeTimers();
		try {
			mockSaveArtifactBody.mockResolvedValue({
				ok: false,
				reason: "stale",
			});
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			simulateTyping("<!--b:p1-->\nEdited.");
			vi.advanceTimersByTime(800);

			await vi.waitFor(() =>
				expect(
					screen.getByText(
						"This document changed elsewhere. Reload to see the current text.",
					),
				).toBeInTheDocument(),
			);
			expect(latestEditor().destroy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// RV-1B, coordinator item 6: proves the GUARD actually moves, not just that
	// it is sent once. Without tracking the hash a successful save just wrote,
	// every later autosave would keep sending the load-time hash forever — the
	// route would refuse ITS OWN later saves as `stale` the moment anything
	// else touched the document even once, since baseHash would never catch up.
	it("sends the newly saved bodyHash as the NEXT autosave's baseHash, not the load-time one", async () => {
		vi.useFakeTimers();
		try {
			mockSaveArtifactBody.mockResolvedValueOnce({
				ok: true,
				version: 2,
				bodyHash: "h2-after-first-save",
			});
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			simulateTyping("<!--b:p1-->\nFirst edit.");
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1),
			);
			expect(mockSaveArtifactBody).toHaveBeenNthCalledWith(
				1,
				"artifact-1",
				expect.any(String),
				1,
				"conv-1",
				undefined,
				{ baseHash: "h1" },
			);

			mockSaveArtifactBody.mockResolvedValueOnce({ ok: true, version: 3 });
			simulateTyping("<!--b:p1-->\nSecond edit.");
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(mockSaveArtifactBody).toHaveBeenCalledTimes(2),
			);
			expect(mockSaveArtifactBody).toHaveBeenNthCalledWith(
				2,
				"artifact-1",
				expect.any(String),
				2,
				"conv-1",
				undefined,
				{ baseHash: "h2-after-first-save" },
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("offline (a thrown save) shows the offline notice, keeps retrying, and clears on the next successful save", async () => {
		vi.useFakeTimers();
		try {
			mockSaveArtifactBody.mockRejectedValueOnce(new Error("network down"));
			mockSaveArtifactBody.mockResolvedValueOnce({ ok: true, version: 2 });

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			simulateTyping("<!--b:p1-->\nFirst edit.");
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(
					screen.getByText(
						"Not saved yet — you are offline. Your text is safe here.",
					),
				).toBeInTheDocument(),
			);

			simulateTyping("<!--b:p1-->\nSecond edit.");
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(mockSaveArtifactBody).toHaveBeenCalledTimes(2),
			);
			// A state update (`saveNotice = null`) and Svelte's own DOM patch are
			// not the same microtask tick, so the disappearance check needs its
			// own `waitFor` too — the call-count check above only proves the
			// STATE changed, not yet that the DOM has caught up (mirrors the
			// "deleted" test's identical disappearance check below).
			await vi.waitFor(() =>
				expect(
					screen.queryByText(
						"Not saved yet — you are offline. Your text is safe here.",
					),
				).not.toBeInTheDocument(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a 404 on save stops autosave, keeps the text, and 'Save it as a new document' creates a fresh document and keeps saving against it", async () => {
		vi.useFakeTimers();
		try {
			mockSaveArtifactBody.mockResolvedValue({
				ok: false,
				reason: "not_found",
			});
			mockCreateDocumentCopy.mockResolvedValue({
				id: "artifact-2",
				userId: "user-1",
				conversationId: "conv-1",
				kind: "document",
				title: "Trip plan",
				body: "<!--b:p1-->\nStill here.",
				bodyHash: "h2",
				metadata: { artifactType: "document", title: "Trip plan" },
				versionNumber: 1,
				createdAt: 1,
				updatedAt: 1,
			});

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			simulateTyping("<!--b:p1-->\nStill here.");
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(
					screen.getByText(
						"This document was deleted while it was open. Your text is still here.",
					),
				).toBeInTheDocument(),
			);
			expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1);

			// Typing more must NOT resume the loop on its own — only saveCopy fixes a gone id.
			simulateTyping("<!--b:p1-->\nStill here, more.");
			vi.advanceTimersByTime(800);
			expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1);

			await fireEvent.click(
				screen.getByRole("button", { name: "Save it as a new document" }),
			);
			await vi.waitFor(() =>
				expect(mockCreateDocumentCopy).toHaveBeenCalledTimes(1),
			);
			expect(mockCreateDocumentCopy).toHaveBeenCalledWith(
				null,
				"Trip plan",
				expect.any(String),
			);
			await vi.waitFor(() =>
				expect(
					screen.queryByText(
						"This document was deleted while it was open. Your text is still here.",
					),
				).not.toBeInTheDocument(),
			);

			// The loop resumed, bound to the NEW artifact id.
			mockSaveArtifactBody.mockResolvedValue({ ok: true, version: 2 });
			simulateTyping("<!--b:p1-->\nAfter the copy.");
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(mockSaveArtifactBody).toHaveBeenCalledWith(
					"artifact-2",
					expect.any(String),
					1,
					null,
					undefined,
					// RV-1B, coordinator item 6: `h2` is the copy's own `bodyHash`,
					// bound by `handleSaveCopy` — the loop now guards against a
					// second tab on the NEW id too, not just the one it replaced.
					{ baseHash: "h2" },
				),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a 413 (too large) keeps the text, shows the notice, and stops the loop — no second request follows", async () => {
		vi.useFakeTimers();
		try {
			mockSaveArtifactBody.mockResolvedValue({
				ok: false,
				reason: "too_large",
			});

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			simulateTyping(`<!--b:p1-->\n${"word ".repeat(5000)}`);
			vi.advanceTimersByTime(800);
			await vi.waitFor(() =>
				expect(
					screen.getByText("This document is too long to save."),
				).toBeInTheDocument(),
			);
			expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1);

			// No further schedule fires a second request on its own.
			vi.advanceTimersByTime(5000);
			expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows 'not available' with no editor when the initial load 404s", async () => {
		const { ApiError } = await import("$lib/client/api/http");
		mockFetchArtifact.mockRejectedValue(
			new ApiError("not found", { status: 404 }),
		);

		render(DocumentBody, {
			artifactId: "artifact-missing",
			kind: "document",
			title: "Trip plan",
			body: null,
		});

		await waitFor(() =>
			expect(
				screen.getByText("This document is not available."),
			).toBeInTheDocument(),
		);
		expect(mockCreateDocumentEditor).not.toHaveBeenCalled();
	});

	it("shows a retry option when the initial load fails for a non-404 reason, and retrying loads it", async () => {
		mockFetchArtifact.mockRejectedValueOnce(new Error("500"));
		mockFetchArtifact.mockResolvedValueOnce(ARTIFACT_DETAIL());

		render(DocumentBody, {
			artifactId: "artifact-1",
			kind: "document",
			title: "Trip plan",
			body: null,
		});

		await waitFor(() =>
			expect(
				screen.getByText("The editor could not be loaded."),
			).toBeInTheDocument(),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() =>
			expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
		);
	});

	describe("tabs", () => {
		it("hides the strip for a document with one tab (or none)", async () => {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(screen.queryByTestId("document-tabs")).not.toBeInTheDocument();
			expect(screen.getByTestId("document-tabs-single")).toBeInTheDocument();
		});

		it("renders every tab from the artifact's metadata, first one active", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({
					metadata: {
						artifactType: "document",
						title: "Trip plan",
						tabs: [
							{ id: "tab-1", title: "Plan", startBlockId: "p1" },
							{ id: "tab-2", title: "Budget", startBlockId: "p2" },
						],
					},
				}),
			);
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			const tabButtons = screen.getAllByRole("tab");
			expect(tabButtons.map((el) => el.textContent?.trim())).toEqual([
				"Plan",
				"Budget",
			]);
			expect(tabButtons[0]).toHaveAttribute("aria-selected", "true");
		});

		it("switching the active tab does not reload the editor module or the document", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({
					metadata: {
						artifactType: "document",
						title: "Trip plan",
						tabs: [
							{ id: "tab-1", title: "Plan", startBlockId: "p1" },
							{ id: "tab-2", title: "Budget", startBlockId: "p2" },
						],
					},
				}),
			);
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await fireEvent.click(screen.getAllByRole("tab")[1]);

			expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1);
			const tabButtons = screen.getAllByRole("tab");
			expect(tabButtons[1]).toHaveAttribute("aria-selected", "true");
		});

		it("adding a tab persists the new list through the same body route the editor autosaves through", async () => {
			mockReadMarkdown.mockReturnValue("Hello.");
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Add a tab" }));

			await waitFor(() =>
				expect(mockSaveDocumentTabs).toHaveBeenCalledTimes(1),
			);
			const [artifactId, tabsArg, markdownArg] =
				mockSaveDocumentTabs.mock.calls[0];
			expect(artifactId).toBe("artifact-1");
			expect(tabsArg).toHaveLength(1);
			expect(tabsArg[0].title).toBe("New section");
			// A fresh `parseDocument("Hello.")` mints its OWN random block id, so
			// this asserts the canonical SHAPE (one marker, the exact text) rather
			// than an exact string two independent mints would rarely agree on.
			expect(markdownArg).toMatch(/^<!--b:[a-z0-9]+-->\nHello\.\n$/);
		});

		// Review 2.5 (rd/review-2-5.md:191-197): the new tab used to save with
		// `startBlockId: ""` — the anchor `appendEmptyTabSection` mints (a real
		// ProseMirror/markdown concern, covered against a real editor in
		// `document-editor.test.ts`) must overwrite it here before the save
		// this suite's own fake editor cannot exercise end to end.
		it("a newly minted anchor block's id becomes the new tab's startBlockId before it saves", async () => {
			mockReadMarkdown.mockReturnValue("Hello.");
			mockAppendEmptyTabSection.mockReturnValueOnce("p9k2m1");
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Add a tab" }));

			await waitFor(() =>
				expect(mockSaveDocumentTabs).toHaveBeenCalledTimes(1),
			);
			expect(mockAppendEmptyTabSection).toHaveBeenCalledTimes(1);
			const [, tabsArg] = mockSaveDocumentTabs.mock.calls[0];
			expect(tabsArg[0].startBlockId).toBe("p9k2m1");
		});
	});

	// The margin and the selection bubble (Slice 1, T10).
	describe("comments and @Alfy margin", () => {
		function commentFixture(overrides: Record<string, unknown> = {}) {
			return {
				id: "comment-1",
				artifactId: "artifact-1",
				parentId: null,
				anchor: {
					kind: "text",
					blockId: "p1",
					quote: "Hello",
					prefix: "",
					suffix: ".",
				},
				author: "user",
				body: "Too early?",
				status: "open",
				createdAt: 1,
				replies: [],
				...overrides,
			};
		}

		it("shows the margin's empty state with no comments", async () => {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(
				screen.getByText("No comments on this tab. Select text to start one."),
			).toBeInTheDocument();
		});

		it("renders a fetched comment in the margin", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({}, [commentFixture()]),
			);
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(screen.getByText("Too early?")).toBeInTheDocument(),
			);
		});

		it("shows the SelectionBubble once the editor reports a live selection", async () => {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(screen.queryByTestId("selection-bubble")).toBeNull();

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 10, left: 20, right: 40, bottom: 30 },
			});
			const { options } = latestEditor();
			(options.onSelectionUpdate as () => void)();

			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);
		});

		// Review 2.5 (rd/review-2-5.md:198-207): Escape while focus is still on
		// the pill's own button used to strand focus at `<body>` once that
		// button unmounted — refocusing the editor is what actually leaves the
		// selection "intact" (redesign §4.4) rather than just visually
		// abandoned. `editor.view.focus()` specifically (never the
		// `chain()`/`commands` path `makeFakeEditor`'s other stubs cover) — see
		// `dismissSelectionBubble`'s own comment for why.
		it("Escape while focus is on the pill's own button refocuses the editor", async () => {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 10, left: 20, right: 40, bottom: 30 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);

			const askButton = screen.getByRole("button", { name: "Ask Alfy" });
			askButton.focus();
			expect(askButton).toHaveFocus();

			await fireEvent.keyDown(document, { key: "Escape" });

			expect(latestEditor().view.focus).toHaveBeenCalled();
		});

		// Review 2.5 (rd/review-2-5.md:198-207): `onTabIntoSelectionPill` is the
		// callback `document-editor.ts`'s own ProseMirror `handleKeyDown` calls
		// on a plain Tab over a non-empty selection (covered there against a
		// real editor); this covers DocumentBody's own half of that contract —
		// the option is wired through, and it actually reaches into the
		// rendered bubble's first button.
		it("onTabIntoSelectionPill focuses the pill's first button while the bubble is showing", async () => {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 10, left: 20, right: 40, bottom: 30 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);

			const onTabIntoSelectionPill = latestEditor().options
				.onTabIntoSelectionPill as () => boolean;
			expect(onTabIntoSelectionPill).toBeTypeOf("function");
			expect(onTabIntoSelectionPill()).toBe(true);
			expect(screen.getByRole("button", { name: "Ask Alfy" })).toHaveFocus();
		});

		it("onTabIntoSelectionPill returns false when there is no selection bubble to focus", async () => {
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(screen.queryByTestId("selection-bubble")).toBeNull();

			const onTabIntoSelectionPill = latestEditor().options
				.onTabIntoSelectionPill as () => boolean;
			expect(onTabIntoSelectionPill()).toBe(false);
		});

		it("posts a comment from the bubble, with the live selection's anchor, and refreshes", async () => {
			mockCreateArtifactComment.mockResolvedValue(commentFixture());
			mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 10, left: 20, right: 40, bottom: 30 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Too early?" },
			});
			// Comment mode's own send button relabels to "Ask Alfy" only once the
			// draft mentions @Alfy (redesign §4.2's "@Alfy switch") — plain text
			// keeps the "Comment" label.
			await fireEvent.click(screen.getByRole("button", { name: "Comment" }));

			await waitFor(() =>
				expect(mockCreateArtifactComment).toHaveBeenCalledWith(
					"artifact-1",
					{
						kind: "text",
						blockId: "p1",
						quote: "Hello",
						prefix: "",
						suffix: ".",
					},
					"Too early?",
					undefined,
					"conv-1",
				),
			);
			// A plain comment never asks Alfy.
			expect(mockAskAlfyInComment).not.toHaveBeenCalled();
			// Refreshed at least once after the post (initial load + refresh).
			expect(mockFetchArtifact).toHaveBeenCalledTimes(2);
		});

		it("asks Alfy after posting a comment that mentions @Alfy", async () => {
			mockCreateArtifactComment.mockResolvedValue(
				commentFixture({ body: "@Alfy change it." }),
			);
			mockAskAlfyInComment.mockResolvedValue({
				outcome: "applied",
				applied: 1,
				refused: 0,
				version: 2,
				reply: commentFixture({
					id: "comment-2",
					author: "alfy",
					body: "Done.",
				}),
			});
			mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 0, left: 0, right: 0, bottom: 0 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
			const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
			await fireEvent.input(textbox, {
				target: { value: "change it." },
			});
			// Ask mode's own send button stays labelled "Ask Alfy" (redesign
			// §4.2 item 2) — it transparently prefixes the @Alfy mention on
			// submit, so the draft the user types (below) never has to spell it.
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));

			await waitFor(() =>
				expect(mockAskAlfyInComment).toHaveBeenCalledWith(
					"artifact-1",
					"comment-1",
					null,
				),
			);
		});

		it("reloads the editor's content once Alfy's reply bumps the version", async () => {
			mockCreateArtifactComment.mockResolvedValue(
				commentFixture({ body: "@Alfy change it." }),
			);
			mockAskAlfyInComment.mockResolvedValue({
				outcome: "applied",
				applied: 1,
				refused: 0,
				version: 2,
				reply: commentFixture({
					id: "comment-2",
					author: "alfy",
					body: "Done.",
				}),
			});
			mockFetchArtifact
				.mockResolvedValueOnce(ARTIFACT_DETAIL())
				.mockResolvedValueOnce(ARTIFACT_DETAIL())
				.mockResolvedValueOnce(
					ARTIFACT_DETAIL({ body: "<!--b:p1-->\nGoodbye.", versionNumber: 2 }),
				);

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 0, left: 0, right: 0, bottom: 0 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "change it." },
			});
			// Ask mode's own send button stays labelled "Ask Alfy" (redesign
			// §4.2 item 2) — it transparently prefixes the @Alfy mention on
			// submit, so the draft the user types (below) never has to spell it.
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));

			await waitFor(() =>
				expect(mockLoadMarkdown).toHaveBeenCalledWith(
					expect.anything(),
					"<!--b:p1-->\nGoodbye.",
				),
			);
		});

		it("marks the thread's own anchored block once an @Alfy reply applies (T8 live, the same marks path)", async () => {
			mockCreateArtifactComment.mockResolvedValue(
				commentFixture({ body: "@Alfy change it." }),
			);
			mockAskAlfyInComment.mockResolvedValue({
				outcome: "applied",
				applied: 1,
				refused: 0,
				version: 2,
				reply: commentFixture({
					id: "comment-2",
					author: "alfy",
					body: "Done.",
				}),
			});
			mockFetchArtifact
				.mockResolvedValueOnce(ARTIFACT_DETAIL())
				.mockResolvedValueOnce(ARTIFACT_DETAIL())
				.mockResolvedValueOnce(
					ARTIFACT_DETAIL({ body: "<!--b:p1-->\nGoodbye.", versionNumber: 2 }),
				);
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "alfy-comment-comment-1",
					blockId: "p1",
					blockLabel: "Hello.",
					previousMarkdown: "Hello.",
				},
			]);

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 0, left: 0, right: 0, bottom: 0 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "change it." },
			});
			// Ask mode's own send button stays labelled "Ask Alfy" (redesign
			// §4.2 item 2) — it transparently prefixes the @Alfy mention on
			// submit, so the draft the user types (below) never has to spell it.
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));

			await waitFor(() =>
				expect(mockApplyAlfyChanges).toHaveBeenCalledTimes(1),
			);
			// The comment's OWN anchored block (p1, from `commentFixture()`) is
			// what gets marked, as a whole-block `replaceBlock` — the browser is
			// never told which of the three op kinds the server actually ran.
			const [, reconstructed, patchSet] = mockApplyAlfyChanges.mock.calls[0];
			expect(patchSet.ops).toEqual([
				expect.objectContaining({ kind: "replaceBlock", blockId: "p1" }),
			]);
			expect(reconstructed.outcomes).toEqual([
				expect.objectContaining({ blockId: "p1", status: "applied" }),
			]);
			// Wave 2.5 Step 10: the pill is a ProseMirror widget decoration now,
			// pushed into the (mocked) editor through `setChangePills` rather than
			// rendered by DocumentBody's own template — `mockSetChangePills`'s own
			// most recent call is the pill's own source of truth here.
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({ status: "pending" }),
					]),
				),
			);
		});

		it("never asks for marks when the @Alfy reply only answered (nothing changed)", async () => {
			mockCreateArtifactComment.mockResolvedValue(
				commentFixture({ body: "@Alfy is this a good idea?" }),
			);
			mockAskAlfyInComment.mockResolvedValue({
				outcome: "answered",
				applied: 0,
				refused: 0,
				version: 1,
				reply: commentFixture({
					id: "comment-2",
					author: "alfy",
					body: "Yes, looks good.",
				}),
			});
			mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 0, left: 0, right: 0, bottom: 0 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "is this a good idea?" },
			});
			// Ask mode's own send button stays labelled "Ask Alfy" (redesign
			// §4.2 item 2) — it transparently prefixes the @Alfy mention on
			// submit, so the draft the user types (below) never has to spell it.
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));

			await waitFor(() =>
				expect(mockAskAlfyInComment).toHaveBeenCalledTimes(1),
			);
			expect(mockApplyAlfyChanges).not.toHaveBeenCalled();
			expect(mockSetChangePills).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.arrayContaining([expect.anything()]),
			);
		});

		it("shows 'Alfy is writing' in place on the target block for at least 600ms, even when the reply is instant", async () => {
			mockCreateArtifactComment.mockResolvedValue(
				commentFixture({ body: "@Alfy change it." }),
			);
			// Resolves on the very next microtask — the fastest a real call
			// could ever settle — so only the 600ms floor keeps it visible.
			mockAskAlfyInComment.mockResolvedValue({
				outcome: "answered",
				applied: 0,
				refused: 0,
				version: 1,
				reply: commentFixture({
					id: "comment-2",
					author: "alfy",
					body: "Done.",
				}),
			});
			mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());

			// Setup (mount, selection) runs under REAL timers — only the final
			// send is measured under fake ones, so `waitFor`'s own internal
			// polling never has to interact with faked time.
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			mockReadSelectionAnchorContext.mockReturnValue({
				blockId: "p1",
				quote: "Hello",
				prefix: "",
				suffix: ".",
				rect: { top: 0, left: 0, right: 0, bottom: 0 },
			});
			(latestEditor().options.onSelectionUpdate as () => void)();
			await waitFor(() =>
				expect(screen.getByTestId("selection-bubble")).toBeInTheDocument(),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "change it." },
			});

			vi.useFakeTimers();
			try {
				await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
				// Flushes the already-resolved mock promise chain
				// (postComment -> maybeAskAlfy -> askAlfyInComment ->
				// refreshAfterCommentChange) without advancing past the 600ms
				// floor itself.
				await vi.advanceTimersByTimeAsync(0);

				expect(mockSetAlfyWritingBlock).toHaveBeenCalledWith(
					expect.anything(),
					{ blockId: "p1", tagLabel: "Alfy is writing…" },
				);
				// The reply has already settled, but the in-place decoration must
				// still be showing — never cleared before the 600ms floor.
				expect(mockSetAlfyWritingBlock).not.toHaveBeenCalledWith(
					expect.anything(),
					null,
				);

				await vi.advanceTimersByTimeAsync(599);
				expect(mockSetAlfyWritingBlock).not.toHaveBeenCalledWith(
					expect.anything(),
					null,
				);

				await vi.advanceTimersByTimeAsync(1);
				expect(mockSetAlfyWritingBlock).toHaveBeenLastCalledWith(
					expect.anything(),
					null,
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("resolves a comment through the margin's own action", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({}, [commentFixture()]),
			);
			mockResolveArtifactComment.mockResolvedValue(undefined);

			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
			});
			await waitFor(() =>
				expect(screen.getByText("Too early?")).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

			await waitFor(() =>
				expect(mockResolveArtifactComment).toHaveBeenCalledWith(
					"artifact-1",
					"comment-1",
					true,
					"conv-1",
				),
			);
		});
	});

	// The download sheet (Slice 1, T12).
	describe("download", () => {
		// Wave 2.5 Step 3 moved the trigger off the toolbar and into the panel
		// header's own Download action — `registerPanelActions` is how that
		// header would call in; these tests invoke the captured function
		// directly rather than duplicating a header/fixture round trip
		// `DocumentWorkspace.test.ts` already covers.
		it("opens the download sheet, named after the document, from the panel header's Download action", async () => {
			let panelActions: { openDownload?: () => void } = {};
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
				registerPanelActions: (actions) => {
					panelActions = actions;
				},
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(screen.queryByRole("dialog")).toBeNull();

			panelActions.openDownload?.();

			expect(
				await screen.findByRole("dialog", { name: /Trip plan/ }),
			).toBeInTheDocument();
		});

		it("exports with the artifact's own id and conversation id", async () => {
			mockExportArtifactDocument.mockResolvedValue({
				ok: true,
				job: { id: "job-1" },
			});
			let panelActions: { openDownload?: () => void } = {};
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
				registerPanelActions: (actions) => {
					panelActions = actions;
				},
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			panelActions.openDownload?.();
			await fireEvent.click(await screen.findByRole("button", { name: "PDF" }));

			expect(mockExportArtifactDocument).toHaveBeenCalledWith(
				"artifact-1",
				"pdf",
				"conv-1",
			);
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		});
	});

	// RV-1B, T6: VersionsSheet.svelte (version history + restore) was built
	// and unit-tested on its own (`VersionsSheet.test.ts`), but nothing in the
	// app ever imported it or `fetchArtifactVersions`/`restoreArtifactVersion`
	// outside that one test file — no toolbar action opened it anywhere, on
	// either the desktop or mobile toolbar (both render from the same shared
	// `DOCUMENT_TOOLBAR_ACTIONS` list). A user had no way to see or restore a
	// Document's history at all. Wired a "History" action, mirroring exactly
	// how "download" already opens `DownloadSheet` — Wave 2.5 Step 3 then
	// moved BOTH triggers off the toolbar into the panel header's own version
	// button/Download action (`registerPanelActions`), which is how this test
	// now opens the sheet.
	describe("version history (T6)", () => {
		it("opens the versions sheet from the panel header's version button, and reloads the editor after a restore", async () => {
			mockFetchArtifactVersions.mockResolvedValue([
				{
					id: "v2",
					versionNumber: 2,
					author: "user",
					summary: "Current",
					createdAt: Date.now(),
				},
				{
					id: "v1",
					versionNumber: 1,
					author: "alfy",
					summary: "First draft",
					createdAt: Date.now() - 60_000,
				},
			]);
			let panelActions: { openVersions?: () => void } = {};
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
				registerPanelActions: (actions) => {
					panelActions = actions;
				},
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(screen.queryByRole("dialog")).toBeNull();

			panelActions.openVersions?.();

			const dialog = await screen.findByRole("dialog", { name: "Versions" });
			await waitFor(() =>
				expect(mockFetchArtifactVersions).toHaveBeenCalledWith(
					"artifact-1",
					"conv-1",
				),
			);
			expect(within(dialog).getByText("First draft")).toBeInTheDocument();

			// Restoring reloads the editor's own content — the same "the document
			// changed under us, reflect it" path a live Alfy edit uses — rather
			// than leaving stale text on screen after the restore.
			mockRestoreArtifactVersion.mockResolvedValue(3);
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({
					body: "<!--b:p1-->\nFirst draft.",
					versionNumber: 3,
				}),
			);
			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Restore" }),
			);
			// Wave 2.5 Step 8: the confirm is inline (never a modal) — the SAME
			// row's trigger button is replaced by its own "Restore v1? …" confirm,
			// which re-queries as the (now only) "Restore" button in the dialog.
			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Restore" }),
			);

			await waitFor(() =>
				expect(mockRestoreArtifactVersion).toHaveBeenCalledWith(
					"artifact-1",
					"v1",
					"conv-1",
				),
			);
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(2),
			);
		});
	});

	// Wave 2.5 Step 3: the panel header's version button and Download action
	// (redesign §5.2 — "there is one History entry … and it sits where the
	// version is") open the SAME two sheets the toolbar already knows how to
	// open, through the functions this body hands `DocumentWorkspace.svelte`
	// via `registerPanelActions`.
	describe("registerPanelActions (Wave 2.5 Step 3)", () => {
		it("hands the header working openVersions/openDownload triggers", async () => {
			mockFetchArtifactVersions.mockResolvedValue([]);
			const registerPanelActions = vi.fn();
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
				registerPanelActions,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await waitFor(() => expect(registerPanelActions).toHaveBeenCalled());

			const actions = registerPanelActions.mock.calls.at(-1)?.[0];
			expect(screen.queryByRole("dialog")).toBeNull();

			actions.openVersions();
			expect(
				await screen.findByRole("dialog", { name: "Versions" }),
			).toBeInTheDocument();
			await waitFor(() =>
				expect(mockFetchArtifactVersions).toHaveBeenCalledWith(
					"artifact-1",
					"conv-1",
				),
			);

			actions.openDownload();
			expect(
				await screen.findByRole("button", { name: "PDF" }),
			).toBeInTheDocument();
			expect(screen.queryByRole("dialog", { name: "Versions" })).toBeNull();
		});
	});

	// Wave 2.5 Step 8: comments away from the inline rail — the header's
	// Comments button (via `registerPanelActions`), a tapped highlight, and
	// the live open-thread count both flow through `CommentsSheet.svelte`.
	// The width-driven "narrow desktop panel" branch needs a real
	// ResizeObserver/layout, which jsdom does not have — that half is the
	// brief's own Playwright suite's job; this covers the phone-sheet branch
	// and the count callback, both reachable by mocking `isPhoneViewport`.
	describe("comments away from the rail (Wave 2.5 Step 8)", () => {
		it("hands the header an openComments trigger that opens the phone sheet", async () => {
			mockViewportState.isPhone = true;
			const registerPanelActions = vi.fn();
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
				registerPanelActions,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await waitFor(() => expect(registerPanelActions).toHaveBeenCalled());
			const actions = registerPanelActions.mock.calls.at(-1)?.[0];
			expect(screen.queryByRole("dialog")).toBeNull();

			actions.openComments();

			expect(
				await screen.findByRole("dialog", { name: "Comments" }),
			).toBeInTheDocument();
		});

		it("reports the open (non-resolved) comment count, across every tab", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({}, [
					{
						id: "c1",
						artifactId: "artifact-1",
						parentId: null,
						anchor: null,
						author: "user",
						body: "Open one",
						status: "open",
						createdAt: 1,
						replies: [],
					},
					{
						id: "c2",
						artifactId: "artifact-1",
						parentId: null,
						anchor: null,
						author: "user",
						body: "Resolved one",
						status: "resolved",
						createdAt: 1,
						replies: [],
					},
				]),
			);
			const onCommentCountChange = vi.fn();
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
				onCommentCountChange,
			});

			await waitFor(() =>
				expect(onCommentCountChange).toHaveBeenLastCalledWith(1),
			);
		});

		it("a tapped highlighted phrase opens the phone sheet at that thread too", async () => {
			mockViewportState.isPhone = true;
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({ body: "<!--b:p1-->\nOne proper concert." }, [
					{
						id: "c1",
						artifactId: "artifact-1",
						parentId: null,
						// The anchor's own resolution is irrelevant here — this test
						// only exercises the click→overlay wiring, not placement.
						anchor: null,
						author: "user",
						body: "Anna says it sells out early.",
						status: "open",
						createdAt: 1,
						replies: [],
					},
				]),
			);
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				conversationId: "conv-1",
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(screen.queryByRole("dialog")).toBeNull();

			// This suite's fake editor host has no real ProseMirror decorations to
			// click through, so the anchor-activate path is driven the same way
			// the existing T10 comment tests drive it elsewhere in this file: a
			// synthetic click on a `.comment-anchor[role="button"]` span, which is
			// all `handleEditorAnchorActivate`'s own DOM delegation reads.
			const editorHost = document.querySelector(".document-editor-host");
			const span = document.createElement("span");
			span.className = "comment-anchor";
			span.setAttribute("role", "button");
			span.setAttribute("data-comment-anchor-id", "c1");
			editorHost?.appendChild(span);
			await fireEvent.click(span);

			expect(
				await screen.findByRole("dialog", { name: "Comments" }),
			).toBeInTheDocument();
		});
	});

	describe("T8 live — Alfy's chat-turn edits appear in the open panel", () => {
		const TWO_BLOCK_BODY = "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond.";

		function runningActivity(
			overrides: Partial<DocumentAlfyActivity> = {},
		): DocumentAlfyActivity {
			return {
				key: "call-1",
				artifactId: "artifact-1",
				toolName: "edit_artifact",
				status: "running",
				label: "Add packing list",
				patches: [],
				refusedBlocks: [],
				appliedCount: 0,
				...overrides,
			};
		}

		beforeEach(() => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({ body: TWO_BLOCK_BODY }),
			);
		});

		it("shows 'Alfy is writing: {label}' while a matching edit_artifact call is running", async () => {
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: runningActivity(),
			});

			expect(
				screen.getByText("Alfy is writing: Add packing list"),
			).toBeInTheDocument();
		});

		it("never shows the shimmer for a call targeting a DIFFERENT artifact", async () => {
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: runningActivity({ artifactId: "some-other-artifact" }),
			});

			expect(screen.queryByText(/Alfy is writing/)).not.toBeInTheDocument();
		});

		it("clears the shimmer and applies change marks once a matching call lands applied", async () => {
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "call-2-0",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: runningActivity({ key: "call-2" }),
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(
				screen.getByText("Alfy is writing: Add packing list"),
			).toBeInTheDocument();

			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({
					body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond.",
					versionNumber: 2,
				}),
			);
			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					...runningActivity({ key: "call-2" }),
					status: "applied",
					patches: [
						{
							op: "replaceBlock",
							blockId: "p1",
							baseHash: "h1",
							text: "First, edited.",
						},
					],
					refusedBlocks: [],
					appliedCount: 1,
				},
			});

			await waitFor(() =>
				expect(screen.queryByText(/Alfy is writing/)).not.toBeInTheDocument(),
			);
			await waitFor(() =>
				expect(mockApplyAlfyChanges).toHaveBeenCalledTimes(1),
			);
			expect(mockLoadMarkdown).toHaveBeenCalledWith(
				expect.anything(),
				"<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond.",
			);
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({ status: "pending" }),
					]),
				),
			);
		});

		it("a call that settles before the lazy editor finishes loading still lands once the editor is ready (RV-1B)", async () => {
			// The live wiring races a REAL browser: a fast (or mocked) model can
			// resolve `edit_artifact` before `runLoad`'s own
			// `Promise.all([loadEditorModule(), fetchArtifact(...)])` settles —
			// `landAlfyActivity` silently no-ops while `editor`/`loadMarkdownFn`/
			// `applyAlfyChangesFn` are still null. The bug: the OLD effect set
			// `handledActivityKey` unconditionally, before checking readiness, so
			// once that guard was tripped the call was marked "handled" forever
			// and the marks/notice never appeared, even after the editor loaded —
			// reproduced live in `tests/e2e/artifact-document.spec.ts`'s "T8 live"
			// suite, intermittently, depending on exactly this race.
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "call-3-0",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			// Only the FIRST call (`runLoad`'s own initial load) is held open;
			// `landAlfyActivity` makes its OWN, second `fetchArtifact` call once
			// it runs, which must resolve normally or this test would be
			// asserting nothing about the real bug. A holder object (not a bare
			// reassigned `let`) so the closure assignment below cannot confuse
			// TypeScript's control-flow narrowing of the resolver's type.
			const fetchGate: {
				resolve: ((detail: ReturnType<typeof ARTIFACT_DETAIL>) => void) | null;
			} = { resolve: null };
			const editedDetail = ARTIFACT_DETAIL({
				body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond.",
				versionNumber: 2,
			});
			mockFetchArtifact.mockImplementationOnce(
				() =>
					new Promise<ReturnType<typeof ARTIFACT_DETAIL>>((resolve) => {
						fetchGate.resolve = resolve;
					}),
			);
			mockFetchArtifact.mockResolvedValue(editedDetail);

			// The activity is ALREADY settled at the very first render — never
			// "running" first — matching a call that finished before this body
			// even mounted its editor.
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					key: "call-3",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "applied",
					label: "Add packing list",
					patches: [
						{
							op: "replaceBlock",
							blockId: "p1",
							baseHash: "h1",
							text: "First, edited.",
						},
					],
					refusedBlocks: [],
					appliedCount: 1,
				},
			});

			// The editor has not loaded yet: the call must not be dropped.
			expect(mockCreateDocumentEditor).not.toHaveBeenCalled();
			expect(mockApplyAlfyChanges).not.toHaveBeenCalled();

			// The initial load now finishes...
			fetchGate.resolve?.(editedDetail);
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			// ...and the ALREADY-settled call must still land: it is not lost
			// just because it arrived before the editor was ready.
			await waitFor(() =>
				expect(mockApplyAlfyChanges).toHaveBeenCalledTimes(1),
			);
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({ status: "pending" }),
					]),
				),
			);
		});

		it("Keep clears the mark (after its own settle delay) and leaves the text; a second patch to the same block then applies", async () => {
			vi.useFakeTimers();
			try {
				mockApplyAlfyChanges.mockReturnValue([
					{
						changeId: "change-1",
						blockId: "p1",
						blockLabel: "First.",
						previousMarkdown: "First.",
					},
				]);
				const { rerender } = render(DocumentBody, {
					artifactId: "artifact-1",
					kind: "document",
					title: "Trip plan",
					body: null,
					alfyActivity: null,
				});
				await vi.waitFor(() =>
					expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
				);

				await rerender({
					artifactId: "artifact-1",
					kind: "document",
					title: "Trip plan",
					body: null,
					alfyActivity: {
						...runningActivity(),
						status: "applied",
						patches: [
							{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
						],
						appliedCount: 1,
					},
				});
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenCalledWith(
						expect.anything(),
						expect.arrayContaining([
							expect.objectContaining({
								changeId: "change-1",
								status: "pending",
							}),
						]),
					),
				);

				// The pill's own Keep button calls straight back into
				// `changePillCallbacks.onKeep` (`change-pill-decoration.ts`'s own
				// binding) — DocumentBody's own reaction to THAT firing is this
				// suite's job; `ChangeBar.test.ts`/`change-pill-decoration.test.ts`
				// already cover the button itself.
				const { onKeep } = latestEditor().options.changePillCallbacks as {
					onKeep: (changeId: string) => void;
				};
				onKeep("change-1");

				// Status flips to "kept" immediately (redesign §7.2 #13's own
				// "Kept" state) — the mark itself is NOT cleared yet.
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenCalledWith(
						expect.anything(),
						expect.arrayContaining([
							expect.objectContaining({ changeId: "change-1", status: "kept" }),
						]),
					),
				);
				expect(mockKeepChange).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(1400);
				expect(mockKeepChange).toHaveBeenCalledWith(
					expect.anything(),
					"change-1",
				);
				// Settled: removed from the pill list entirely.
				expect(mockSetChangePills).toHaveBeenLastCalledWith(
					expect.anything(),
					[],
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("Undo restores the previous text through undoChange and schedules an autosave", async () => {
			vi.useFakeTimers();
			try {
				mockApplyAlfyChanges.mockReturnValue([
					{
						changeId: "change-2",
						blockId: "p1",
						blockLabel: "First.",
						previousMarkdown: "First.",
					},
				]);
				const { rerender } = render(DocumentBody, {
					artifactId: "artifact-1",
					kind: "document",
					title: "Trip plan",
					body: null,
					alfyActivity: null,
				});
				await vi.waitFor(() =>
					expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
				);

				await rerender({
					artifactId: "artifact-1",
					kind: "document",
					title: "Trip plan",
					body: null,
					alfyActivity: {
						...runningActivity(),
						status: "applied",
						patches: [
							{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
						],
						appliedCount: 1,
					},
				});
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenCalledWith(
						expect.anything(),
						expect.arrayContaining([
							expect.objectContaining({
								changeId: "change-2",
								status: "pending",
							}),
						]),
					),
				);

				mockReadMarkdown.mockReturnValue(TWO_BLOCK_BODY);
				mockChangeDocRange.mockReturnValueOnce({ from: 0, to: 5 });
				const { onUndo } = latestEditor().options.changePillCallbacks as {
					onUndo: (changeId: string) => void;
				};
				onUndo("change-2");

				expect(mockUndoChange).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						blockId: "p1",
						previousMarkdown: "First.",
					}),
				);
				// Undo flips status immediately (its own mark is gone the instant
				// this runs — unlike Keep, there is no settle-delay for the text
				// change itself, only for the pill's own "Undone · Redo" window).
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenCalledWith(
						expect.anything(),
						expect.arrayContaining([
							expect.objectContaining({
								changeId: "change-2",
								status: "undone",
								fallbackPos: 5,
							}),
						]),
					),
				);

				vi.advanceTimersByTime(800);
				await vi.waitFor(() =>
					expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1),
				);

				// Settles after its own 5s window.
				vi.advanceTimersByTime(5000);
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenLastCalledWith(
						expect.anything(),
						[],
					),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("Redo cancels Undo's settle timer, restores the applied text, and re-marks the block as pending", async () => {
			vi.useFakeTimers();
			try {
				mockApplyAlfyChanges.mockReturnValue([
					{
						changeId: "change-3",
						blockId: "p1",
						blockLabel: "First.",
						previousMarkdown: "First.",
					},
				]);
				const { rerender } = render(DocumentBody, {
					artifactId: "artifact-1",
					kind: "document",
					title: "Trip plan",
					body: null,
					alfyActivity: null,
				});
				await vi.waitFor(() =>
					expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
				);
				await rerender({
					artifactId: "artifact-1",
					kind: "document",
					title: "Trip plan",
					body: null,
					alfyActivity: {
						...runningActivity(),
						status: "applied",
						patches: [
							{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
						],
						appliedCount: 1,
					},
				});
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenCalledWith(
						expect.anything(),
						expect.arrayContaining([
							expect.objectContaining({
								changeId: "change-3",
								status: "pending",
							}),
						]),
					),
				);

				mockReadMarkdown.mockReturnValue(TWO_BLOCK_BODY);
				const callbacks = latestEditor().options.changePillCallbacks as {
					onUndo: (changeId: string) => void;
					onRedo: (changeId: string) => void;
				};
				callbacks.onUndo("change-3");
				mockUndoChange.mockClear();

				callbacks.onRedo("change-3");
				// Redo reuses undoChange in reverse (marks.ts's own "generic set
				// this block's content" reasoning) — restoring the CAPTURED
				// applied text, then re-marking under the SAME changeId.
				expect(mockUndoChange).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({ blockId: "p1" }),
				);
				expect(mockRemarkChange).toHaveBeenCalledWith(
					expect.anything(),
					"change-3",
					"p1",
				);
				await vi.waitFor(() =>
					expect(mockSetChangePills).toHaveBeenCalledWith(
						expect.anything(),
						expect.arrayContaining([
							expect.objectContaining({
								changeId: "change-3",
								status: "pending",
							}),
						]),
					),
				);

				// The cancelled Undo timer never fires — Redo already returned
				// this to "pending", so a stray removal 5s later would be wrong.
				vi.advanceTimersByTime(5000);
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({
							changeId: "change-3",
							status: "pending",
						}),
					]),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("shows the refusal notice naming the block's label and reason, with a working 'See what Alfy did'", async () => {
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "change-applied",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			mockSummarizeRefusals.mockReturnValue({
				count: 1,
				items: [
					{ blockId: "p2", blockLabel: "Second.", code: "block_changed" },
				],
			});
			mockRefusalReasonI18nKey.mockImplementation((code: string) =>
				code === "block_changed"
					? "artifacts.document.refused.changed"
					: "artifacts.document.refused.other",
			);

			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					...runningActivity(),
					status: "refused",
					patches: [
						{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
						{ op: "replaceBlock", blockId: "p2", baseHash: "h2", text: "y" },
					],
					refusedBlocks: [{ blockId: "p2", reason: "block_changed" }],
					appliedCount: 1,
				},
			});

			await waitFor(() =>
				expect(screen.getByTestId("refusal-notice")).toBeInTheDocument(),
			);
			expect(screen.getByText("Second.")).toBeInTheDocument();
			// The reason is a trailing text node beside `<strong>{label}</strong>`
			// inside one `<li>` (`RefusalNotice.svelte`'s own markup) — matched
			// with a substring pattern rather than `<li>`'s own concatenated text.
			expect(
				screen.getByText(/you changed this after Alfy last read it/),
			).toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: "See what Alfy did" }),
			);
			expect(mockScrollToChange).toHaveBeenCalledWith(
				expect.anything(),
				"change-applied",
			);
		});

		it("the refusal card's Ask again re-selects the refused line and dismisses the card", async () => {
			mockApplyAlfyChanges.mockReturnValue([]);
			mockSummarizeRefusals.mockReturnValue({
				count: 1,
				items: [
					{ blockId: "p2", blockLabel: "Second.", code: "block_changed" },
				],
			});
			mockRefusalReasonI18nKey.mockReturnValue(
				"artifacts.document.refused.changed",
			);

			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					...runningActivity(),
					status: "refused",
					patches: [
						{ op: "replaceBlock", blockId: "p2", baseHash: "h2", text: "y" },
					],
					refusedBlocks: [{ blockId: "p2", reason: "block_changed" }],
					appliedCount: 0,
				},
			});

			await waitFor(() =>
				expect(screen.getByTestId("refusal-notice")).toBeInTheDocument(),
			);
			// The dashed gutter rule lands on the SAME refused block the card names.
			expect(mockSetRefusedLines).toHaveBeenCalledWith(expect.anything(), {
				blockIds: ["p2"],
			});

			await fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
			expect(mockSelectAndScrollToBlock).toHaveBeenCalledWith(
				expect.anything(),
				"p2",
			);
			expect(screen.queryByTestId("refusal-notice")).not.toBeInTheDocument();
		});

		it("the refusal card's Dismiss clears the card and its line's dashed rule", async () => {
			mockApplyAlfyChanges.mockReturnValue([]);
			mockSummarizeRefusals.mockReturnValue({
				count: 1,
				items: [
					{ blockId: "p2", blockLabel: "Second.", code: "block_changed" },
				],
			});
			mockRefusalReasonI18nKey.mockReturnValue(
				"artifacts.document.refused.changed",
			);

			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);

			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					...runningActivity(),
					status: "refused",
					patches: [
						{ op: "replaceBlock", blockId: "p2", baseHash: "h2", text: "y" },
					],
					refusedBlocks: [{ blockId: "p2", reason: "block_changed" }],
					appliedCount: 0,
				},
			});
			await waitFor(() =>
				expect(screen.getByTestId("refusal-notice")).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

			expect(screen.queryByTestId("refusal-notice")).not.toBeInTheDocument();
			expect(mockSetRefusedLines).toHaveBeenLastCalledWith(
				expect.anything(),
				null,
			);
		});

		it("a failed call clears the shimmer without leaving any notice behind", async () => {
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: runningActivity(),
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			expect(
				screen.getByText("Alfy is writing: Add packing list"),
			).toBeInTheDocument();

			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: { ...runningActivity(), status: "failed" },
			});

			await waitFor(() =>
				expect(screen.queryByText(/Alfy is writing/)).not.toBeInTheDocument(),
			);
			expect(screen.queryByTestId("refusal-notice")).not.toBeInTheDocument();
			expect(mockSetChangePills).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.arrayContaining([expect.anything()]),
			);
			expect(mockApplyAlfyChanges).not.toHaveBeenCalled();
		});
	});

	describe("ruling 61: a pending Alfy change survives a reload", () => {
		it("marks each block the server reports as pending, on load", async () => {
			mockFetchDocumentReviewState.mockResolvedValueOnce([
				{
					blockId: "p1",
					blockLabel: "Hello.",
					previousMarkdown: "Hi.",
					isNewBlock: false,
					alfyVersionNumber: 2,
				},
			]);
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await waitFor(() =>
				expect(mockFetchDocumentReviewState).toHaveBeenCalledWith(
					"artifact-1",
					null,
				),
			);
			await waitFor(() =>
				expect(mockRemarkChange).toHaveBeenCalledWith(
					expect.anything(),
					"p1",
					"p1",
				),
			);
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({
							changeId: "p1",
							blockId: "p1",
							status: "pending",
						}),
					]),
				),
			);
		});

		it("a failed review-state fetch reads as nothing pending, without crashing the load", async () => {
			mockFetchDocumentReviewState.mockRejectedValueOnce(new Error("network"));
			render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await waitFor(() =>
				expect(mockFetchDocumentReviewState).toHaveBeenCalledTimes(1),
			);
			expect(mockRemarkChange).not.toHaveBeenCalled();
		});

		it("acknowledges the block through the browser API on Keep", async () => {
			// `reconstructDocumentPatch` (the real function, not mocked) needs the
			// pre-edit block genuinely present to build its own inverse from.
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({ body: "<!--b:p1-->\nFirst." }),
			);
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "change-4",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					key: "call-ack",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "applied",
					label: null,
					patches: [
						{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
					],
					refusedBlocks: [],
					appliedCount: 1,
				},
			});
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({
							changeId: "change-4",
							status: "pending",
						}),
					]),
				),
			);

			const { onKeep } = latestEditor().options.changePillCallbacks as {
				onKeep: (changeId: string) => void;
			};
			onKeep("change-4");

			await waitFor(() =>
				expect(mockAcknowledgeDocumentReviewBlocks).toHaveBeenCalledWith(
					"artifact-1",
					["p1"],
					null,
				),
			);
		});

		// rd/review-2-5.md:141-148 — a user's own edit of a pending block did not
		// acknowledge it in the live session: the pill and the acknowledge call
		// only ever fired from an explicit Keep/Undo click, so typing over the
		// SAME block left it stuck "pending" (and a later Undo would have thrown
		// the user's own typing away, restoring Alfy's pre-edit text instead).
		it("the user's own edit of a pending block acknowledges it, the same as Keep", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({ body: "<!--b:p1-->\nFirst." }),
			);
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "change-5",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					key: "call-user-edit",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "applied",
					label: null,
					patches: [
						{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
					],
					refusedBlocks: [],
					appliedCount: 1,
				},
			});
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({ changeId: "change-5", status: "pending" }),
					]),
				),
			);

			// The user keeps typing in the SAME block — not a Keep/Undo click.
			simulateTyping("<!--b:p1-->\nFirst, edited by the user instead.");

			await waitFor(() =>
				expect(mockAcknowledgeDocumentReviewBlocks).toHaveBeenCalledWith(
					"artifact-1",
					["p1"],
					null,
				),
			);
			// The mark is cleared the same way Keep clears it (no lingering pill).
			expect(mockKeepChange).toHaveBeenCalledWith(expect.anything(), "change-5");
			expect(mockSetChangePills).toHaveBeenLastCalledWith(
				expect.anything(),
				[],
			);
		});

		it("does NOT acknowledge a pending block the user never touched", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({ body: "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond." }),
			);
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "change-6",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					key: "call-other-block-edit",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "applied",
					label: null,
					patches: [
						{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
					],
					refusedBlocks: [],
					appliedCount: 1,
				},
			});
			await waitFor(() =>
				expect(mockSetChangePills).toHaveBeenCalledWith(
					expect.anything(),
					expect.arrayContaining([
						expect.objectContaining({ changeId: "change-6", status: "pending" }),
					]),
				),
			);
			mockSetChangePills.mockClear();

			// Edits the OTHER block (p2) — p1's own pending change must survive.
			simulateTyping(
				"<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond, edited by the user.",
			);
			await waitFor(() => expect(mockReadMarkdown).toHaveBeenCalled());

			expect(mockAcknowledgeDocumentReviewBlocks).not.toHaveBeenCalled();
			expect(mockKeepChange).not.toHaveBeenCalled();
		});
	});

	describe("Wave 2.5 Step 10: the review bar", () => {
		beforeEach(() => {
			// `reconstructDocumentPatch` (the real function, not mocked) needs the
			// pre-edit block genuinely present to build its own inverse from.
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({ body: "<!--b:p1-->\nFirst." }),
			);
		});

		function applyOneChange() {
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "rb-change-1",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
			]);
			return {
				key: "rb-call",
				artifactId: "artifact-1",
				toolName: "edit_artifact" as const,
				status: "applied" as const,
				label: null,
				patches: [
					{
						op: "replaceBlock" as const,
						blockId: "p1",
						baseHash: "h1",
						text: "x",
					},
				],
				refusedBlocks: [],
				appliedCount: 1,
			};
		}

		/** `getByRole("status", …)` finds the bar itself — robust against the summary text sitting inside a nested `<span>` alongside the (absent, here) "Left N alone" link, unlike a bare `getByText`. */
		async function renderWithOnePending() {
			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: applyOneChange(),
			});
			await vi.waitFor(() =>
				expect(
					screen.getByRole("status", { name: "Changes from Alfy" }),
				).toHaveTextContent("Alfy changed 1 part."),
			);
		}

		it("shows the review bar with the pending count once a change lands, and empties the pending list once Keep all settles", async () => {
			vi.useFakeTimers();
			try {
				await renderWithOnePending();

				await fireEvent.click(screen.getByRole("button", { name: /Keep all/ }));
				// Status flips to "kept" immediately; the mark itself (and the
				// pill list emptying out) waits for its own 1.4s settle window.
				await vi.advanceTimersByTimeAsync(1400);
				expect(mockKeepChange).toHaveBeenCalledWith(
					expect.anything(),
					"rb-change-1",
				);
				// The data-level truth once settled — the bar's own OUT transition
				// (redesign §7.2 #12) is a real-animation-frame concern jsdom does
				// not emulate reliably; Playwright covers it seeing the bar leave.
				expect(mockSetChangePills).toHaveBeenLastCalledWith(
					expect.anything(),
					[],
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("Undo all calls undoChange for every pending change", async () => {
			await renderWithOnePending();

			await fireEvent.click(screen.getByRole("button", { name: /Undo all/ }));
			expect(mockUndoChange).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ blockId: "p1" }),
			);
		});

		it("the stepper's Next scrolls to the change through scrollToChange", async () => {
			await renderWithOnePending();

			await fireEvent.click(
				screen.getByRole("button", { name: "Next change" }),
			);
			expect(mockScrollToChange).toHaveBeenCalledWith(
				expect.anything(),
				"rb-change-1",
			);
		});

		// rd/review-2-5.md:122-129 — the stepper's Next/Previous never switched
		// tabs, so a pending change living in a tab other than the active one
		// was unreachable (its block sits in a `display:none` section).
		it("the stepper switches tabs first when the next change lives in a different tab", async () => {
			mockFetchArtifact.mockResolvedValue(
				ARTIFACT_DETAIL({
					body: "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond.",
					metadata: {
						artifactType: "document",
						title: "Trip plan",
						tabs: [
							{ id: "tab-1", title: "Plan", startBlockId: "p1" },
							{ id: "tab-2", title: "Budget", startBlockId: "p2" },
						],
					},
				}),
			);
			mockApplyAlfyChanges.mockReturnValue([
				{
					changeId: "rb-change-1",
					blockId: "p1",
					blockLabel: "First.",
					previousMarkdown: "First.",
				},
				{
					changeId: "rb-change-2",
					blockId: "p2",
					blockLabel: "Second.",
					previousMarkdown: "Second.",
				},
			]);

			const { rerender } = render(DocumentBody, {
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: null,
			});
			await vi.waitFor(() =>
				expect(mockCreateDocumentEditor).toHaveBeenCalledTimes(1),
			);
			// tab-1 (the first tab) is active by default — its own row's "Next"
			// stays on tab-1 until the stepper reaches p2's change, in tab-2.
			expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await rerender({
				artifactId: "artifact-1",
				kind: "document",
				title: "Trip plan",
				body: null,
				alfyActivity: {
					key: "rb-call-2tabs",
					artifactId: "artifact-1",
					toolName: "edit_artifact" as const,
					status: "applied" as const,
					label: null,
					patches: [
						{
							op: "replaceBlock" as const,
							blockId: "p1",
							baseHash: "h1",
							text: "x",
						},
						{
							op: "replaceBlock" as const,
							blockId: "p2",
							baseHash: "h1",
							text: "y",
						},
					],
					refusedBlocks: [],
					appliedCount: 2,
				},
			});
			await vi.waitFor(() =>
				expect(screen.getByRole("button", { name: "Next change" })),
			);

			// reviewIndex starts at 0 — the FIRST pending entry (p1, already in
			// the active tab-1). Advancing to the second (p2, tab-2) must switch
			// tabs before scrolling.
			await fireEvent.click(
				screen.getByRole("button", { name: "Next change" }),
			);
			expect(mockSetActiveDocumentTab).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"tab-2",
			);
			expect(mockScrollToChange).toHaveBeenCalledWith(
				expect.anything(),
				"rb-change-2",
			);
		});
	});
});
