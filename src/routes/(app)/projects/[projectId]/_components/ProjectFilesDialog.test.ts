import { fireEvent, render, screen, within } from "@testing-library/svelte";
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

function open(
	files: ProjectKnowledgeItem[] | null,
	options: { filesFailed?: boolean; onRefresh?: () => Promise<void> } = {},
) {
	return render(ProjectFilesDialog, {
		props: {
			open: true,
			projectId: "project-1",
			projectName: "Vienna trip",
			files,
			filesFailed: options.filesFailed ?? false,
			onRefresh: options.onRefresh ?? (async () => undefined),
			onClose: () => undefined,
		},
	});
}

const search = () => screen.getByTestId("project-files-search");
const emptyState = () => screen.getByTestId("project-files-empty");
const loadingLine = () => screen.queryByTestId("project-files-loading");
const errorState = () => screen.queryByTestId("project-files-error");
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

// The dialog is one of the document workspace's three live callers (with
// chat and Knowledge). Slice 0's type-aware rebuild of
// DocumentWorkspace.svelte must not regress this one, so this pins today's
// behaviour before that work: previewing a project file opens the shared
// expanded workspace with the file's own name, and it is not a second modal
// (AGENTS.md: the shell stays the only viewer).
describe("ProjectFilesDialog document workspace", () => {
	it("opens a previewed file into the expanded document workspace", async () => {
		open([projectFile()]);

		await fireEvent.click(screen.getByTestId("project-file-preview"));

		const shell = await screen.findByRole("complementary", {
			name: "Document workspace",
		});
		expect(within(shell).getByText("Wien itinerary.pdf")).toBeInTheDocument();
		// The Files modal itself is the one dialog; the preview does not draw a
		// second, competing modal on top of it.
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
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

// A first read that never succeeds is not "still loading" — `files` stays
// `null` exactly as it does while genuinely loading, so the page hands the
// dialog a second signal for "and it is not coming" rather than leaving the
// loading line on screen forever.
describe("ProjectFilesDialog when the first read fails for good", () => {
	it("says the read failed instead of loading forever, with no rows and no empty state", () => {
		open(null, { filesFailed: true });

		expect(errorState()).toHaveTextContent(
			"Could not load this project's files.",
		);
		expect(loadingLine()).toBeNull();
		expect(screen.queryByTestId("project-files-empty")).toBeNull();
		expect(screen.queryByTestId("project-file-row")).toBeNull();
	});

	it("retries through the page's own refresh when Retry is pressed", async () => {
		const onRefresh = vi.fn(async () => undefined);
		open(null, { filesFailed: true, onRefresh });

		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("stops showing the failure once a read lands, empty or not", async () => {
		const { rerender } = open(null, { filesFailed: true });

		await rerender({ files: [projectFile()], filesFailed: false });

		expect(errorState()).toBeNull();
		expect(screen.getByTestId("project-file-name")).toHaveTextContent(
			"Wien itinerary.pdf",
		);
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
