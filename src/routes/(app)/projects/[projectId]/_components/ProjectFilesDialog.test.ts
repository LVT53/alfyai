import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepArtifactToursFor } from "$lib/client/api/artifact-tours";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import type { ProjectKnowledgeItem } from "$lib/server/services/knowledge";
import { uiLanguage } from "$lib/stores/settings";
import ProjectFilesDialog from "./ProjectFilesDialog.svelte";

// The dialog's two browser calls are not what these tests are about; the list
// it renders is a prop, owned by the route.
vi.mock("$lib/client/api/projects", () => ({
	linkProjectFiles: vi.fn(async () => []),
	unlinkProjectFile: vi.fn(async () => true),
}));

// The panel asks which reader the tours' kept answers are for before it asks
// for a tour: a spy on that one call, everything else the real module.
vi.mock("$lib/client/api/artifact-tours", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("$lib/client/api/artifact-tours")>();
	return {
		...original,
		keepArtifactToursFor: vi.fn(original.keepArtifactToursFor),
	};
});

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

/** A Document, App or Canvas one of the project's chats made, as the bundle lists it. */
function madeItem(
	overrides: Partial<ProjectKnowledgeItem> = {},
): ProjectKnowledgeItem {
	return {
		artifactId: "doc-1",
		name: "Vienna notes",
		mimeType: null,
		type: "artifact",
		sizeBytes: null,
		linkedAt: 1_760_000_000,
		summary: null,
		artifactKind: "document",
		sourceConversationId: "chat-1",
		sourceConversationTitle: "Saturday plan",
		linked: false,
		...overrides,
	};
}

/**
 * The panel an item opened in: its desktop shell. A phone's overlay is its twin
 * in the markup and the stylesheet shows one of the two, so a role lookup alone
 * finds both here.
 */
async function findPanel(name: string): Promise<HTMLElement> {
	const shells = await screen.findAllByRole("dialog", { name });
	const desktop = shells.find((shell) => shell.tagName === "ASIDE");
	if (!desktop) throw new Error(`no desktop shell is named "${name}"`);
	return desktop;
}

function open(
	files: ProjectKnowledgeItem[] | null,
	options: {
		filesFailed?: boolean;
		onRefresh?: () => Promise<void>;
		onClose?: () => void;
		currentUser?: {
			id: string;
			displayName: string;
			profilePicture: string | null;
		} | null;
	} = {},
) {
	return render(ProjectFilesDialog, {
		props: {
			open: true,
			projectId: "project-1",
			projectName: "Vienna trip",
			files,
			filesFailed: options.filesFailed ?? false,
			onRefresh: options.onRefresh ?? (async () => undefined),
			onClose: options.onClose ?? (() => undefined),
			currentUser: options.currentUser ?? null,
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

		const shell = await findPanel("Wien itinerary.pdf, File");
		expect(within(shell).getByText("Wien itinerary.pdf")).toBeInTheDocument();
		// Two layers, one modal: the preview is the modal layer over the Files
		// dialog, which gives the claim up while the preview is open.
		expect(shell).toHaveAttribute("aria-modal", "true");
		expect(screen.getByRole("dialog", { name: "Files" })).toHaveAttribute(
			"aria-modal",
			"false",
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

// A project's bundle holds what its chats made beside its files (Slice 5b, T5).
// A made item is not a file: it says what it is and which chat made it, and its
// way in opens the panel on its own body.
describe("ProjectFilesDialog: what the chats made", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		ARTIFACT_BODIES.document = () =>
			import(
				"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
			);
	});

	afterEach(() => {
		delete ARTIFACT_BODIES.document;
		uiLanguage.set("en");
	});

	it("words an item by its kind and the file by its extension", () => {
		open([
			projectFile(),
			madeItem(),
			madeItem({
				artifactId: "app-1",
				name: "Cost splitter",
				artifactKind: "app",
			}),
			madeItem({
				artifactId: "board-1",
				name: "Trip board",
				artifactKind: "canvas",
			}),
		]);

		const pill = (name: string) =>
			within(
				screen
					.getAllByTestId("project-file-row")
					.find((row) => row.textContent?.includes(name)) as HTMLElement,
			).getByTestId("project-file-type");
		expect(pill("Wien itinerary.pdf")).toHaveTextContent("PDF");
		expect(pill("Vienna notes")).toHaveTextContent("Document");
		expect(pill("Cost splitter")).toHaveTextContent("App");
		expect(pill("Trip board")).toHaveTextContent("Canvas");
	});

	it("says which chat made an item, and says nothing of the kind about a file", () => {
		open([projectFile(), madeItem()]);

		const origins = screen.getAllByTestId("project-file-origin");
		expect(origins).toHaveLength(1);
		expect(origins[0]).toHaveTextContent("from “Saturday plan”");
	});

	it("never prints the engineers' word for what a chat made", () => {
		open([madeItem()]);

		expect(screen.getByTestId("project-file-row").textContent).not.toMatch(
			/artifact/i,
		);
		expect(
			screen.getByRole("button", { name: "Open Vienna notes" }),
		).toBeInTheDocument();
	});

	it("reads in Hungarian too", () => {
		uiLanguage.set("hu");
		open([
			madeItem(),
			madeItem({
				artifactId: "board-1",
				name: "Útiterv",
				artifactKind: "canvas",
			}),
			madeItem({ artifactId: "app-1", name: "Költségek", artifactKind: "app" }),
		]);

		const types = screen
			.getAllByTestId("project-file-type")
			.map((pill) => pill.textContent?.trim());
		expect(types).toEqual(["Dokumentum", "Tábla", "Alkalmazás"]);
		expect(screen.getAllByTestId("project-file-origin")[0]).toHaveTextContent(
			"„Saturday plan” beszélgetésből",
		);
		expect(
			screen.getByRole("button", { name: "Vienna notes megnyitása" }),
		).toBeInTheDocument();
	});

	it("opens a made item in the panel on its own kind, not in the file viewer", async () => {
		open([madeItem()]);

		await fireEvent.click(
			screen.getByRole("button", { name: "Open Vienna notes" }),
		);

		const shell = await findPanel("Vienna notes, Document");
		const body = await within(shell).findByTestId("fake-artifact-body");
		expect(body.dataset.kind).toBe("document");
		expect(body.dataset.artifactId).toBe("doc-1");
	});

	it("names the reader to the panel it opens an item in, so the tours' answers are theirs", async () => {
		open([madeItem()], {
			currentUser: {
				id: "reader-1",
				displayName: "Reader",
				profilePicture: null,
			},
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Open Vienna notes" }),
		);
		await findPanel("Vienna notes, Document");

		await vi.waitFor(() =>
			expect(keepArtifactToursFor).toHaveBeenCalledWith("reader-1"),
		);
	});

	// The panel sits above the dialog. It is a layer of the dialog stack while it
	// is open (RV-F, I-2), so one Escape closes it and the dialog answers the next.
	it("closes the panel on one Escape and leaves the dialog, which answers the next", async () => {
		const onClose = vi.fn();
		open([madeItem()], { onClose });
		await fireEvent.click(
			screen.getByRole("button", { name: "Open Vienna notes" }),
		);
		await findPanel("Vienna notes, Document");

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(onClose).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(
				screen.queryAllByRole("dialog", { name: "Vienna notes, Document" }),
			).toHaveLength(0),
		);
		expect(screen.getByRole("dialog", { name: "Files" })).toBeInTheDocument();

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// The panel is the modal layer to assistive technology while it is open
	// (RV-F follow-up): the dialog under it gives the claim up and takes it back.
	it("stops claiming to be modal while the panel is open over it, and claims it again once the panel is gone", async () => {
		open([madeItem()]);
		const files = screen.getByRole("dialog", { name: "Files" });
		expect(files).toHaveAttribute("aria-modal", "true");

		await fireEvent.click(
			screen.getByRole("button", { name: "Open Vienna notes" }),
		);
		const panel = await findPanel("Vienna notes, Document");
		expect(panel).toHaveAttribute("aria-modal", "true");
		expect(files).toHaveAttribute("aria-modal", "false");

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => expect(files).toHaveAttribute("aria-modal", "true"));
	});

	it("offers no unlink on an item that is here only through its chat, and one on a linked item", () => {
		open([
			madeItem({ linked: false }),
			madeItem({ artifactId: "doc-2", name: "Packing list", linked: true }),
			projectFile(),
		]);

		const unlinks = screen
			.getAllByTestId("project-file-unlink")
			.map((button) => button.getAttribute("aria-label"));
		expect(unlinks).toEqual([
			"Remove Packing list from this project",
			"Remove Wien itinerary.pdf from this project",
		]);
	});

	it("counts items once anything was made by a chat, and files while nothing was", async () => {
		const { rerender } = open([projectFile(), madeItem()]);
		expect(footerCount()).toBe(
			"2 items · removing one here keeps it in your library",
		);

		await rerender({ files: [madeItem({ linked: true })] });
		expect(footerCount()).toBe(
			"1 item · removing one here keeps it in your library",
		);

		await rerender({ files: [projectFile()] });
		expect(footerCount()).toBe(
			"1 file · removing it here keeps it in your library",
		);
	});

	// The footer's note is about the unlink on a row. A made item that is here
	// only through its chat has none, so a list of nothing else has nothing to
	// promise (RV-F, M-6): it counts and stops.
	it("promises removal only while a row on the list offers it", async () => {
		const { rerender } = open([
			madeItem(),
			madeItem({ artifactId: "app-1", name: "Cost splitter" }),
			madeItem({ artifactId: "board-1", name: "Trip board" }),
		]);
		expect(screen.queryAllByTestId("project-file-unlink")).toHaveLength(0);
		expect(footerCount()).toBe("3 items");

		await rerender({
			files: [madeItem(), madeItem({ artifactId: "doc-2", linked: true })],
		});
		expect(screen.getAllByTestId("project-file-unlink")).toHaveLength(1);
		expect(footerCount()).toBe(
			"2 items · removing one here keeps it in your library",
		);

		await rerender({ files: [madeItem()] });
		expect(footerCount()).toBe("1 item");
	});

	it("reads the same in Hungarian: the note goes with the row that could be removed", async () => {
		uiLanguage.set("hu");
		const { rerender } = open([madeItem(), madeItem({ artifactId: "app-1" })]);
		expect(footerCount()).toBe("2 elem");

		await rerender({
			files: [madeItem(), madeItem({ artifactId: "doc-2", linked: true })],
		});
		expect(footerCount()).toBe(
			"2 elem · az eltávolítás nem törli a könyvtárból",
		);
	});

	it("says nothing of removal about a list with nothing on it", () => {
		open([]);
		expect(footerCount()).toBe("");
	});

	it("finds an item by its title in the search box", async () => {
		open([projectFile(), madeItem()]);

		await fireEvent.input(search(), { target: { value: "vienna" } });

		expect(screen.getAllByTestId("project-file-row")).toHaveLength(1);
		expect(screen.getByTestId("project-file-name")).toHaveTextContent(
			"Vienna notes",
		);
	});
});
