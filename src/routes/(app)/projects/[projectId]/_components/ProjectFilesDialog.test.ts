import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ProjectKnowledgeItem } from "$lib/server/services/knowledge";
import ProjectFilesDialog from "./ProjectFilesDialog.svelte";

// The dialog's two browser calls are not what these tests are about; the list
// it renders is a prop, owned by the route.
vi.mock("$lib/client/api/projects", () => ({
	linkProjectFiles: vi.fn(async () => []),
	unlinkProjectFile: vi.fn(async () => true),
}));

vi.mock("$lib/client/api/knowledge", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/knowledge")>()),
	recordDocumentWorkspaceOpen: vi.fn(),
	uploadKnowledgeAttachment: vi.fn(async () => ({})),
}));

function projectFile(
	overrides: Partial<ProjectKnowledgeItem> = {},
): ProjectKnowledgeItem {
	return {
		artifactId: "artifact-1",
		name: "Wien itinerary.pdf",
		mimeType: "application/pdf",
		type: "source_document",
		sizeBytes: 1024,
		linkedAt: 1_760_000_000,
		summary: null,
		...overrides,
	};
}

function open(files: ProjectKnowledgeItem[] | null) {
	return render(ProjectFilesDialog, {
		props: {
			open: true,
			projectId: "project-1",
			projectName: "Vienna trip",
			files,
			onRefresh: async () => undefined,
			onClose: () => undefined,
		},
	});
}

const search = () => screen.getByTestId("project-files-search");
const emptyState = () => screen.getByTestId("project-files-empty");
const loadingLine = () => screen.queryByTestId("project-files-loading");
const footerCount = () =>
	screen.getByTestId("project-files-footer").textContent?.trim();

describe("ProjectFilesDialog empty states", () => {
	it("says the project has no files when it has none", () => {
		open([]);

		expect(emptyState()).toHaveTextContent("No files yet.");
		expect(loadingLine()).toBeNull();
	});

	it("lists the files of a project that has some", () => {
		open([projectFile()]);

		expect(screen.getByTestId("project-file-name")).toHaveTextContent(
			"Wien itinerary.pdf",
		);
		expect(screen.queryByTestId("project-files-empty")).toBeNull();
		expect(loadingLine()).toBeNull();
		expect(footerCount()).toBe(
			"1 file · removing it here keeps it in your library",
		);
	});

	// The empty-paragraph slot has two different reasons to be on screen, and
	// they are not the same sentence: a project with no files, and a search
	// that matched none of the files it has. The second one shipped rendering
	// the search field's own label ("Search files in this project") — the
	// instruction the user just followed, printed back as if it were an answer.
	it("reads a search that matched nothing as a no-match line, not as the field's label", async () => {
		open([projectFile()]);

		await fireEvent.input(search(), {
			target: { value: "nothing matches this" },
		});

		expect(emptyState()).toHaveTextContent("No files match your search.");
		expect(emptyState()).not.toHaveTextContent("Search files in this project");
	});

	it("shows the file again when the query is cleared", async () => {
		open([projectFile()]);

		await fireEvent.input(search(), {
			target: { value: "nothing matches this" },
		});
		await fireEvent.input(search(), { target: { value: "" } });

		expect(screen.queryByTestId("project-files-empty")).toBeNull();
		expect(screen.getByTestId("project-file-name")).toHaveTextContent(
			"Wien itinerary.pdf",
		);
	});
});

// The route reads the project's files in the browser after the page mounts and
// hands the dialog `null` until that read lands. `null` is "not read yet", not
// "no files": opening the modal inside that window used to say "No files yet."
// about a project that has files.
describe("ProjectFilesDialog before the list has been read", () => {
	it("says it is loading, not that the project has no files", () => {
		open(null);

		expect(loadingLine()).toHaveTextContent("Loading…");
		expect(screen.queryByTestId("project-files-empty")).toBeNull();
		expect(screen.queryByTestId("project-file-row")).toBeNull();
		// Nor does the footer count a list nobody has read yet.
		expect(footerCount()).toBe("");
	});

	it("lists the files once the read lands", async () => {
		const { rerender } = open(null);

		await rerender({ files: [projectFile()] });

		expect(loadingLine()).toBeNull();
		expect(screen.getByTestId("project-file-name")).toHaveTextContent(
			"Wien itinerary.pdf",
		);
		expect(footerCount()).toBe(
			"1 file · removing it here keeps it in your library",
		);
	});

	it("says the project has no files once the read lands empty", async () => {
		const { rerender } = open(null);

		await rerender({ files: [] });

		expect(loadingLine()).toBeNull();
		expect(emptyState()).toHaveTextContent("No files yet.");
	});
});

// This box really does search the project's files, so it keeps the project's
// wording. The library picker's box used to borrow the same string; the two now
// have a key each, and this pins that the split left this one alone.
describe("ProjectFilesDialog search box", () => {
	it("names the project's files as what it searches", () => {
		open([]);

		expect(search()).toHaveAttribute(
			"placeholder",
			"Search files in this project",
		);
		expect(search()).toHaveAccessibleName("Search files in this project");
	});
});
