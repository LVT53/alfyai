import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";

// The picker's one browser call. The list it renders is the library's own
// list, which is what these tests are about: which sentence an empty list
// shows, and why.
vi.mock("$lib/client/api/knowledge", () => ({
	fetchKnowledgeLibrary: vi.fn(),
}));

import { fetchKnowledgeLibrary } from "$lib/client/api/knowledge";
import AddFromLibraryDialog from "./AddFromLibraryDialog.svelte";

const library = vi.mocked(fetchKnowledgeLibrary);

function libraryDocument(
	overrides: Partial<KnowledgeDocumentItem> = {},
): KnowledgeDocumentItem {
	return {
		id: "document-1",
		displayArtifactId: "artifact-1",
		promptArtifactId: "artifact-1",
		familyArtifactIds: ["artifact-1"],
		name: "Wien itinerary.pdf",
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: null,
		summary: null,
		normalizedAvailable: true,
		createdAt: 1_760_000_000,
		updatedAt: 1_760_000_000,
		...overrides,
	};
}

function open(documents: KnowledgeDocumentItem[]) {
	library.mockResolvedValue({ documents, results: [], workflows: [] });
	return render(AddFromLibraryDialog, {
		props: {
			open: true,
			projectName: "Vienna trip",
			linkedArtifactIds: [],
			onLink: async () => undefined,
			onLinked: () => undefined,
			onClose: () => undefined,
		},
	});
}

const search = () => screen.getByTestId("add-from-library-search");

// Named by class rather than by a test id on purpose: the assertion must fail
// on the sentence the picker prints today, not on a hook the fix would have
// added. The paragraph is the one element that can carry three different
// sentences (loading, an empty library, a query that hid everything).
const emptyLine = () =>
	document.querySelector(".picker-list .picker-empty") as HTMLElement | null;

describe("AddFromLibraryDialog empty states", () => {
	beforeEach(() => {
		library.mockReset();
	});

	it("says the library has no documents when it has none", async () => {
		open([]);

		await waitFor(() => expect(emptyLine()).toHaveTextContent("No files yet."));
	});

	// The picker renders a *filtered* list. A query that matches nothing used to
	// print the same sentence as an empty library — "No files yet." — which
	// reads as "your documents are gone" to a user whose library is full.
	it("reads a query that matched none of the library's documents as a no-match line", async () => {
		open([libraryDocument()]);
		await screen.findByTestId("add-from-library-row");

		await fireEvent.input(search(), {
			target: { value: "nothing matches this" },
		});

		await waitFor(() =>
			expect(emptyLine()).toHaveTextContent("No files match your search."),
		);
		expect(emptyLine()).not.toHaveTextContent("No files yet.");
	});

	it("shows the document again when the query is cleared", async () => {
		open([libraryDocument()]);
		await screen.findByTestId("add-from-library-row");

		await fireEvent.input(search(), {
			target: { value: "nothing matches this" },
		});
		await fireEvent.input(search(), { target: { value: "" } });

		await waitFor(() => expect(emptyLine()).toBeNull());
		expect(screen.getByTestId("add-from-library-row")).toHaveTextContent(
			"Wien itinerary.pdf",
		);
	});
});
