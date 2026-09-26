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
}));

const {
	mockCreateDocumentEditor,
	mockReadMarkdown,
	mockLoadMarkdown,
	mockReadSelectionAnchorContext,
	mockApplyAlfyChanges,
	mockKeepChange,
	mockUndoChange,
	mockChangeMarkRect,
	mockScrollToChange,
	mockSummarizeRefusals,
	mockRefusalReasonI18nKey,
	editorInstances,
} = vi.hoisted(() => ({
	mockCreateDocumentEditor: vi.fn(),
	mockReadMarkdown: vi.fn(),
	mockLoadMarkdown: vi.fn(),
	mockReadSelectionAnchorContext: vi.fn(),
	mockApplyAlfyChanges: vi.fn(),
	mockKeepChange: vi.fn(),
	mockUndoChange: vi.fn(),
	mockChangeMarkRect: vi.fn(),
	mockScrollToChange: vi.fn(),
	mockSummarizeRefusals: vi.fn(),
	mockRefusalReasonI18nKey: vi.fn(),
	editorInstances: [] as Array<{
		options: Record<string, unknown>;
		destroy: ReturnType<typeof vi.fn>;
		isActive: ReturnType<typeof vi.fn>;
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
	changeMarkRect: mockChangeMarkRect,
	scrollToChange: mockScrollToChange,
	summarizeRefusals: mockSummarizeRefusals,
	refusalReasonI18nKey: mockRefusalReasonI18nKey,
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
		setupCreateDocumentEditor();
		mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());
		mockSaveArtifactBody.mockResolvedValue({ ok: true, version: 2 });
		mockSaveDocumentTabs.mockResolvedValue({ ok: true, version: 2 });
		mockFetchArtifactVersions.mockResolvedValue([]);
		mockRestoreArtifactVersion.mockResolvedValue(2);
		mockReadSelectionAnchorContext.mockReturnValue(null);
		mockApplyAlfyChanges.mockReturnValue([]);
		mockSummarizeRefusals.mockReturnValue(null);
		mockChangeMarkRect.mockReturnValue(null);
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
			expect(screen.getByText("No comments yet.")).toBeInTheDocument();
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
			await fireEvent.click(screen.getByRole("button", { name: "Post" }));

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
				target: { value: "@Alfy change it." },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Post" }));

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
				target: { value: "@Alfy change it." },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Post" }));

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
				target: { value: "@Alfy change it." },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Post" }));

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
			await waitFor(() =>
				expect(screen.getByTestId("alfy-change-bar")).toBeInTheDocument(),
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
				target: { value: "@Alfy is this a good idea?" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Post" }));

			await waitFor(() =>
				expect(mockAskAlfyInComment).toHaveBeenCalledTimes(1),
			);
			expect(mockApplyAlfyChanges).not.toHaveBeenCalled();
			expect(screen.queryByTestId("alfy-change-bar")).not.toBeInTheDocument();
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
		it("opens the download sheet, named after the document, from the toolbar", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: "Download" }));

			expect(
				screen.getByRole("dialog", { name: /Trip plan/ }),
			).toBeInTheDocument();
		});

		it("exports with the artifact's own id and conversation id", async () => {
			mockExportArtifactDocument.mockResolvedValue({
				ok: true,
				job: { id: "job-1" },
			});
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

			await fireEvent.click(screen.getByRole("button", { name: "Download" }));
			await fireEvent.click(screen.getByRole("button", { name: "PDF" }));

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
	// how "download" already opens `DownloadSheet`.
	describe("version history (T6)", () => {
		it("opens the versions sheet from the toolbar, and reloads the editor after a restore", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: "History" }));

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
			// The confirm dialog's own confirm button — NOT scoped by role/name
			// (ConfirmDialog's title/confirm text are both "Restore" too, the
			// same as the row's own button), so this uses its fixed testid.
			await fireEvent.click(screen.getByTestId("confirm-delete"));

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
				expect(screen.getByTestId("alfy-change-bar")).toBeInTheDocument(),
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
				expect(screen.getByTestId("alfy-change-bar")).toBeInTheDocument(),
			);
		});

		it("Keep clears the mark and leaves the text; a second patch to the same block then applies", async () => {
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
					status: "applied",
					patches: [
						{ op: "replaceBlock", blockId: "p1", baseHash: "h1", text: "x" },
					],
					appliedCount: 1,
				},
			});
			await waitFor(() =>
				expect(screen.getByTestId("alfy-change-bar")).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByText("Keep"));

			expect(mockKeepChange).toHaveBeenCalledWith(
				expect.anything(),
				"change-1",
			);
			expect(screen.getByText("Kept.")).toBeInTheDocument();
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
					expect(screen.getByTestId("alfy-change-bar")).toBeInTheDocument(),
				);

				mockReadMarkdown.mockReturnValue(TWO_BLOCK_BODY);
				await fireEvent.click(screen.getByText("Undo"));

				expect(mockUndoChange).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						blockId: "p1",
						previousMarkdown: "First.",
					}),
				);
				expect(
					screen.getByText("Undone — your text is back."),
				).toBeInTheDocument();

				vi.advanceTimersByTime(800);
				await vi.waitFor(() =>
					expect(mockSaveArtifactBody).toHaveBeenCalledTimes(1),
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
			expect(screen.queryByTestId("alfy-change-bar")).not.toBeInTheDocument();
			expect(mockApplyAlfyChanges).not.toHaveBeenCalled();
		});
	});
});
