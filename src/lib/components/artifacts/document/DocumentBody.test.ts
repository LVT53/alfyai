import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";

const { mockFetchArtifact, mockSaveArtifactBody, mockCreateDocumentCopy } =
	vi.hoisted(() => ({
		mockFetchArtifact: vi.fn(),
		mockSaveArtifactBody: vi.fn(),
		mockCreateDocumentCopy: vi.fn(),
	}));

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: mockFetchArtifact,
	saveArtifactBody: mockSaveArtifactBody,
	createDocumentCopy: mockCreateDocumentCopy,
}));

const { mockCreateDocumentEditor, mockReadMarkdown, editorInstances } =
	vi.hoisted(() => ({
		mockCreateDocumentEditor: vi.fn(),
		mockReadMarkdown: vi.fn(),
		editorInstances: [] as Array<{
			options: Record<string, unknown>;
			destroy: ReturnType<typeof vi.fn>;
			isActive: ReturnType<typeof vi.fn>;
		}>,
	}));

vi.mock("./document-editor", () => ({
	createDocumentEditor: mockCreateDocumentEditor,
	readMarkdown: mockReadMarkdown,
	loadMarkdown: vi.fn(),
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

const ARTIFACT_DETAIL = (overrides: Record<string, unknown> = {}) => ({
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
	comments: [],
});

describe("DocumentBody", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		editorInstances.length = 0;
		setupCreateDocumentEditor();
		mockFetchArtifact.mockResolvedValue(ARTIFACT_DETAIL());
		mockSaveArtifactBody.mockResolvedValue({ ok: true, version: 2 });
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
		expect(
			screen.getByRole("toolbar", { name: "Document" }),
		).toBeInTheDocument();

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
				// No context provider is mounted in this bare render, so the
				// conversationId getter falls back to null — this is the strict,
				// no-incognito-widening default (`document-context.ts`).
				null,
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
});
