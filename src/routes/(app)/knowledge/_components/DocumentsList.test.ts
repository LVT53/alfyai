import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocumentsList from "./DocumentsList.svelte";

const { prewarmDocumentPreviewMock } = vi.hoisted(() => ({
	prewarmDocumentPreviewMock: vi.fn(),
}));

vi.mock("$lib/client/document-preview-prewarm", () => ({
	prewarmDocumentPreview: prewarmDocumentPreviewMock,
}));

const mockUploadedDocument = {
	id: "doc-1",
	name: "Budget.pdf",
	type: "source_document",
	mimeType: "application/pdf",
	sizeBytes: 1024 * 1024 * 2.5,
	createdAt: Date.now() - 86400000,
};

const mockGeneratedDocument = {
	id: "doc-2",
	name: "Report.docx",
	type: "generated_output",
	mimeType:
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	sizeBytes: 512 * 1024,
	createdAt: Date.now() - 172800000,
	conversationId: "conv-1",
};

const mockDocuments = [
	mockUploadedDocument,
	mockGeneratedDocument,
	{
		id: "doc-3",
		name: "Analysis.xlsx",
		type: "source_document",
		mimeType:
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		sizeBytes: 1024 * 1024,
		createdAt: Date.now() - 259200000,
	},
	{
		id: "doc-4",
		name: "Summary.txt",
		type: "generated_output",
		mimeType: "text/plain",
		sizeBytes: 1024,
		createdAt: Date.now() - 345600000,
		conversationId: "conv-2",
	},
];

const manyDocuments = Array.from({ length: 150 }, (_, i) => ({
	id: `doc-${i}`,
	name: `File-${i}.pdf`,
	type: i % 2 === 0 ? "source_document" : "generated_output",
	mimeType: "application/pdf",
	sizeBytes: 1024,
	createdAt: Date.now() - i * 1000,
}));

describe("DocumentsList", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Empty State", () => {
		it("renders empty state when no documents provided", () => {
			render(DocumentsList, {
				props: {
					documents: [],
				},
			});

			expect(screen.getByText(/no documents/i)).toBeInTheDocument();
			expect(
				screen.getByText(/upload or generate documents/i),
			).toBeInTheDocument();
		});

		it("opens file picker when clicking empty state", async () => {
			render(DocumentsList, {
				props: {
					documents: [],
					onUpload: vi.fn(),
				},
			});

			const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
			const clickSpy = vi.spyOn(fileInput, "click");

			const emptyStateButton = screen.getByRole("button", { name: /upload/i });
			await fireEvent.click(emptyStateButton);

			expect(clickSpy).toHaveBeenCalledTimes(1);
		});

		it("renders empty state message when search has no matches", async () => {
			render(DocumentsList, {
				props: {
					documents: [mockGeneratedDocument],
				},
			});

			const searchInput = screen.getByRole("searchbox", {
				name: /search documents/i,
			});
			await fireEvent.input(searchInput, { target: { value: "no-hit-query" } });

			expect(
				screen.getByText(/no documents match your search/i),
			).toBeInTheDocument();
		});
	});

	describe("Upload Interactions", () => {
		it("accepts mobile image formats including HEIC/HEIF in the file input", () => {
			render(DocumentsList, {
				props: {
					documents: [mockUploadedDocument],
					onUpload: vi.fn(),
				},
			});

			const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
			expect(fileInput.getAttribute("accept")).toContain(".heic");
			expect(fileInput.getAttribute("accept")).toContain(".heif");
			expect(fileInput.getAttribute("accept")).toContain(".avif");
		});

		it("supports drag and drop uploads when documents already exist", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);

			render(DocumentsList, {
				props: {
					documents: [mockUploadedDocument],
					onUpload,
				},
			});

			const dropSurface = screen.getByRole("region", {
				name: /documents/i,
			});
			const file = new File(["hello"], "new-upload.pdf", {
				type: "application/pdf",
			});

			await fireEvent.dragEnter(dropSurface, {
				dataTransfer: {
					types: ["Files"],
				},
			});

			expect(screen.getByTestId("drop-zone-overlay")).toBeInTheDocument();

			await fireEvent.drop(dropSurface, {
				dataTransfer: {
					files: [file],
					types: ["Files"],
				},
			});

			expect(onUpload).toHaveBeenCalledTimes(1);
			expect(onUpload).toHaveBeenCalledWith([
				expect.objectContaining({ name: "new-upload.pdf" }),
			]);
		});
	});

	describe("List Rendering", () => {
		it("exposes compact mobile row semantics with selection, metadata, and row actions", async () => {
			const onSelect = vi.fn();
			const onDownload = vi.fn();
			const onDelete = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onSelect,
					onDownload,
					onDelete,
				},
			});

			const budgetRow = screen.getByText("Budget.pdf").closest("tr");
			expect.assert(budgetRow !== null);
			expect(budgetRow).toHaveClass("document-list-item");
			expect(
				budgetRow?.querySelector('[data-mobile-label="Type"]'),
			).not.toBeNull();
			expect(
				budgetRow?.querySelector('[data-mobile-label="Size"]'),
			).not.toBeNull();
			expect(
				budgetRow?.querySelector('[data-mobile-label="Date"]'),
			).not.toBeNull();
			expect(budgetRow).toHaveTextContent("PDF");
			expect(budgetRow).toHaveTextContent("2.5 MB");

			const selectCheckbox = screen.getByRole("checkbox", {
				name: /select budget\.pdf/i,
			});
			await fireEvent.click(selectCheckbox);
			expect(budgetRow).toHaveClass("selected");

			await fireEvent.click(budgetRow);
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({ id: "doc-1" }),
			);

			const rowButtons = budgetRow.querySelectorAll("button");
			await fireEvent.click(rowButtons[0]);
			expect(onDownload).toHaveBeenCalledWith("doc-1");
			await fireEvent.click(rowButtons[1]);
			expect(onDelete).toHaveBeenCalledWith("doc-1");
		});

		it("renders list of documents with correct columns", () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			expect(screen.getByText(/name/i)).toBeInTheDocument();
			expect(screen.getByText(/type/i)).toBeInTheDocument();
			expect(screen.getByText(/size/i)).toBeInTheDocument();
			expect(screen.getByText(/date/i)).toBeInTheDocument();
			expect(screen.getByText(/actions/i)).toBeInTheDocument();
		});

		it("renders document names correctly", () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			expect(screen.getByText("Budget.pdf")).toBeInTheDocument();
			expect(screen.getByText("Report.docx")).toBeInTheDocument();
			expect(screen.getByText("Analysis.xlsx")).toBeInTheDocument();
			expect(screen.getByText("Summary.txt")).toBeInTheDocument();
		});

		it("renders type badges correctly", () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			expect(screen.getAllByText(/PDF|XLSX/i).length).toBeGreaterThan(0);
			expect(screen.getAllByText(/generated/i).length).toBeGreaterThan(0);
		});

		it("renders Skill Notes as a distinct type badge", () => {
			render(DocumentsList, {
				props: {
					documents: [
						{
							id: "note-1",
							name: "Research notes",
							type: "skill_note",
							documentOrigin: "skill_note",
							mimeType: "text/markdown",
							sizeBytes: 1024,
							createdAt: Date.now(),
						},
					],
				},
			});

			expect(screen.getByText("Skill Note")).toBeInTheDocument();
		});

		it("renders file sizes in human-readable format", () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			expect(screen.getByText("2.5 MB")).toBeInTheDocument();
			expect(screen.getByText("512 KB")).toBeInTheDocument();
			expect(screen.getByText("1 MB")).toBeInTheDocument();
			expect(screen.getByText("1 KB")).toBeInTheDocument();
		});

		it("renders formatted dates", () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			const dateCells = screen.getAllByRole("cell").filter((cell) => {
				const text = cell.textContent || "";
				return (
					/\d{1,2}/.test(text) &&
					(text.includes(",") || text.includes("/") || text.includes("-"))
				);
			});

			expect(dateCells.length).toBeGreaterThan(0);
		});

		it("renders file icons based on mime type", () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			const icons = screen.getAllByTestId("file-icon");
			expect(icons.length).toBe(mockDocuments.length);
		});
	});

	describe("Search And Sorting", () => {
		it("filters documents by search query", async () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			const searchInput = screen.getByRole("searchbox", {
				name: /search documents/i,
			});
			await fireEvent.input(searchInput, { target: { value: "report" } });

			expect(screen.getByText("Report.docx")).toBeInTheDocument();
			expect(screen.queryByText("Budget.pdf")).toBeNull();
			expect(screen.queryByText("Analysis.xlsx")).toBeNull();
		});

		it("sorts by name when name header is clicked", async () => {
			render(DocumentsList, {
				props: {
					documents: mockDocuments,
				},
			});

			const nameSortButton = screen.getByRole("button", { name: /name/i });
			await fireEvent.click(nameSortButton);

			const rows = screen.getAllByRole("row").slice(1);
			expect(rows[0]?.textContent).toContain("Analysis.xlsx");
			expect(rows[1]?.textContent).toContain("Budget.pdf");
		});

		it("uses extension fallback for icon mapping when mime type is missing", () => {
			const docsWithMissingMime = [
				...mockDocuments,
				{
					id: "doc-ext-fallback",
					name: "Deck.pptx",
					type: "source_document",
					mimeType: null,
					sizeBytes: 1024,
					createdAt: Date.now(),
				},
			];

			render(DocumentsList, {
				props: {
					documents: docsWithMissingMime,
				},
			});

			const deckRow = screen.getByText("Deck.pptx").closest("tr");
			expect(deckRow).not.toBeNull();
			const iconCell = deckRow?.querySelector('[data-testid="file-icon"]');
			expect(iconCell).not.toBeNull();
			expect(iconCell?.textContent?.trim().length ?? 0).toBe(0);
			expect(iconCell?.innerHTML.length ?? 0).toBeGreaterThan(20);
		});
	});

	describe("Pagination", () => {
		it("shows pagination controls when documents exceed limit", () => {
			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 20,
				},
			});

			expect(
				screen.getByRole("navigation", { name: /pagination/i }),
			).toBeInTheDocument();
			expect(screen.getByText(/page 1 of/i)).toBeInTheDocument();
		});

		it("pagination limit 20 shows only 20 documents per page", () => {
			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 20,
				},
			});

			const rows = screen.getAllByRole("row").slice(1);
			expect(rows.length).toBe(20);
		});

		it("pagination limit 50 shows only 50 documents per page", () => {
			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 50,
				},
			});

			const rows = screen.getAllByRole("row").slice(1);
			expect(rows.length).toBe(50);
		});

		it("pagination limit 100 shows only 100 documents per page", () => {
			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 100,
				},
			});

			const rows = screen.getAllByRole("row").slice(1);
			expect(rows.length).toBe(100);
		});

		it("emits pagination limit change event", async () => {
			const onPaginationLimitChange = vi.fn();

			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 20,
					onPaginationLimitChange,
				},
			});

			const limitSelector = screen.getByRole("combobox", {
				name: /items per page/i,
			});
			await fireEvent.change(limitSelector, { target: { value: "50" } });

			expect(onPaginationLimitChange).toHaveBeenCalledWith(50);
		});

		it("navigates to next page when next button clicked", async () => {
			const onPageChange = vi.fn();

			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 20,
					currentPage: 1,
					onPageChange,
				},
			});

			const nextButton = screen.getByRole("button", { name: /next page/i });
			await fireEvent.click(nextButton);

			expect(onPageChange).toHaveBeenCalledWith(2);
		});

		it("navigates to previous page when previous button clicked", async () => {
			const onPageChange = vi.fn();

			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 20,
					currentPage: 2,
					onPageChange,
				},
			});

			const prevButton = screen.getByRole("button", { name: /previous page/i });
			await fireEvent.click(prevButton);

			expect(onPageChange).toHaveBeenCalledWith(1);
		});
	});

	describe("Click Events", () => {
		it("prewarms a document preview on intent without selecting until click", async () => {
			const onSelect = vi.fn();
			const document = {
				...mockUploadedDocument,
				displayArtifactId: "display-artifact-1",
				sizeBytes: 1024,
			};

			render(DocumentsList, {
				props: {
					documents: [document],
					onSelect,
				},
			});

			const row = screen.getByText("Budget.pdf").closest("tr");
			expect.assert(row !== null);

			await fireEvent.pointerEnter(row);
			await fireEvent.focus(row);
			await fireEvent.touchStart(row);

			expect(prewarmDocumentPreviewMock).toHaveBeenCalledTimes(2);
			expect(prewarmDocumentPreviewMock).toHaveBeenCalledWith(document);
			expect(onSelect).not.toHaveBeenCalled();

			await fireEvent.click(row);
			expect(onSelect).toHaveBeenCalledWith(document);
		});

		it("emits select event with document data when row is clicked", async () => {
			const onSelect = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onSelect,
				},
			});

			const row = screen.getByText("Budget.pdf").closest("tr");
			expect.assert(row !== null);
			await fireEvent.click(row);

			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "doc-1",
					name: "Budget.pdf",
					type: "source_document",
				}),
			);
		});

		it("emits select event for generated documents", async () => {
			const onSelect = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onSelect,
				},
			});

			const row = screen.getByText("Report.docx").closest("tr");
			expect.assert(row !== null);
			await fireEvent.click(row);

			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "doc-2",
					name: "Report.docx",
					type: "generated_output",
				}),
			);
		});
	});

	describe("Delete Events", () => {
		it("emits delete event with correct document ID when delete button clicked", async () => {
			const onDelete = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onDelete,
				},
			});

			const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
			await fireEvent.click(deleteButtons[0]);

			expect(onDelete).toHaveBeenCalledWith("doc-1");
		});

		it("emits delete event for generated documents", async () => {
			const onDelete = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onDelete,
				},
			});

			const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
			await fireEvent.click(deleteButtons[1]);

			expect(onDelete).toHaveBeenCalledWith("doc-2");
		});

		it("prevents row click when delete button is clicked", async () => {
			const onSelect = vi.fn();
			const onDelete = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onSelect,
					onDelete,
				},
			});

			const deleteButton = screen.getAllByRole("button", {
				name: /delete/i,
			})[0];
			await fireEvent.click(deleteButton);

			expect(onSelect).not.toHaveBeenCalled();
			expect(onDelete).toHaveBeenCalledWith("doc-1");
		});
	});

	describe("Download Events", () => {
		it("emits download event with correct document ID when download button clicked", async () => {
			const onDownload = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onDownload,
				},
			});

			const downloadButtons = screen.getAllByRole("button", {
				name: /download/i,
			});
			await fireEvent.click(downloadButtons[0]);

			expect(onDownload).toHaveBeenCalledWith("doc-1");
		});

		it("emits download event for generated documents", async () => {
			const onDownload = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onDownload,
				},
			});

			const downloadButtons = screen.getAllByRole("button", {
				name: /download/i,
			});
			await fireEvent.click(downloadButtons[1]);

			expect(onDownload).toHaveBeenCalledWith("doc-2");
		});

		it("prevents row click when download button is clicked", async () => {
			const onSelect = vi.fn();
			const onDownload = vi.fn();

			render(DocumentsList, {
				props: {
					documents: mockDocuments,
					onSelect,
					onDownload,
				},
			});

			const downloadButton = screen.getAllByRole("button", {
				name: /download/i,
			})[0];
			await fireEvent.click(downloadButton);

			expect(onSelect).not.toHaveBeenCalled();
			expect(onDownload).toHaveBeenCalledWith("doc-1");
		});
	});

	describe("Normalized Document Filtering", () => {
		it("hides normalized_document type items from the document list", () => {
			render(DocumentsList, {
				props: {
					documents: [
						mockUploadedDocument,
						{
							id: "norm-1",
							name: "Budget.md",
							type: "normalized_document",
							displayArtifactId: "norm-1",
							promptArtifactId: "norm-1",
							familyArtifactIds: ["doc-1", "norm-1"],
							mimeType: "text/markdown",
							sizeBytes: 1024,
							createdAt: Date.now(),
							normalizedAvailable: true,
							documentOrigin: undefined,
						},
					],
				},
			});

			// The source document should still be visible
			expect(screen.getByText("Budget.pdf")).toBeInTheDocument();
			// The normalized .md file should NOT be shown as a standalone row
			expect(screen.queryByText("Budget.md")).toBeNull();
		});

		it("shows expand toggle on rows where normalizedAvailable is true", async () => {
			render(DocumentsList, {
				props: {
					documents: [
						{
							...mockUploadedDocument,
							normalizedAvailable: true,
							promptArtifactId: "prompt-1",
						},
					],
				},
			});

			expect(
				screen.getByRole("button", { name: /view ai version/i }),
			).toBeInTheDocument();
		});

		it("does not show expand toggle when normalizedAvailable is false", () => {
			render(DocumentsList, {
				props: {
					documents: [
						{
							...mockUploadedDocument,
							normalizedAvailable: false,
							promptArtifactId: null,
						},
					],
				},
			});

			expect(
				screen.queryByRole("button", { name: /view ai version/i }),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: /hide ai version/i }),
			).toBeNull();
		});

		it("toggles AI-facing version panel", async () => {
			render(DocumentsList, {
				props: {
					documents: [
						{
							...mockUploadedDocument,
							normalizedAvailable: true,
							promptArtifactId: "prompt-1",
						},
					],
				},
			});

			const toggleButton = screen.getByRole("button", {
				name: /view ai version/i,
			});
			await fireEvent.click(toggleButton);

			expect(
				screen.getByRole("button", { name: /hide ai version/i }),
			).toBeInTheDocument();

			await fireEvent.click(toggleButton);

			expect(
				screen.getByRole("button", { name: /view ai version/i }),
			).toBeInTheDocument();
		});

		it("shows no type badge for normalized documents with null documentOrigin", () => {
			render(DocumentsList, {
				props: {
					documents: [
						{
							id: "doc-norm",
							name: "Normalized report.md",
							type: "normalized_document",
							displayArtifactId: "doc-norm",
							promptArtifactId: "doc-norm",
							familyArtifactIds: ["doc-norm"],
							mimeType: "text/markdown",
							sizeBytes: 1024,
							createdAt: Date.now(),
							normalizedAvailable: true,
							documentOrigin: undefined,
						},
					],
				},
			});

			// The row shouldn't appear at all since normalized_document are filtered
			expect(screen.queryByText("Normalized report.md")).toBeNull();
		});
	});

	describe("Combined Interactions", () => {
		it("maintains pagination change behavior", async () => {
			const onPaginationLimitChange = vi.fn();

			render(DocumentsList, {
				props: {
					documents: manyDocuments,
					paginationLimit: 20,
					onPaginationLimitChange,
				},
			});

			const limitSelector = screen.getByRole("combobox", {
				name: /items per page/i,
			});
			await fireEvent.change(limitSelector, { target: { value: "50" } });

			expect(onPaginationLimitChange).toHaveBeenCalledWith(50);
		});
	});
});
