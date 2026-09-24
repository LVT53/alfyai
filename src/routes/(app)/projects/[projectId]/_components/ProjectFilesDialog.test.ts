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

function open(files: ProjectKnowledgeItem[]) {
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

describe("ProjectFilesDialog empty states", () => {
	it("says the project has no files when it has none", () => {
		open([]);

		expect(emptyState()).toHaveTextContent("No files yet.");
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
