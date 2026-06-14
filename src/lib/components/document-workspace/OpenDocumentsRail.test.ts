import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { DocumentWorkspaceItem } from "$lib/types";
import OpenDocumentsRail from "./OpenDocumentsRail.svelte";

function makeDocument(
	overrides: Partial<DocumentWorkspaceItem>,
): DocumentWorkspaceItem {
	return {
		id: "file-1",
		source: "chat_generated_file",
		filename: "report.pdf",
		title: "Report",
		mimeType: "application/pdf",
		versionNumber: null,
		...overrides,
	};
}

describe("OpenDocumentsRail", () => {
	it("shows a v1 badge for generated files while persisted version metadata is pending", () => {
		render(OpenDocumentsRail, {
			props: {
				documents: [
					makeDocument({
						id: "file-1",
						filename: "report.pdf",
						title: "Report",
					}),
					makeDocument({
						id: "file-2",
						filename: "slides.pptx",
						title: "Slides",
					}),
				],
				activeDocumentId: "file-1",
				onSelectDocument: vi.fn(),
				onCloseDocument: vi.fn(),
			},
		});

		expect(screen.getAllByText("v1")).toHaveLength(2);
	});

	it("renders AI provenance as a compact badge", () => {
		const { container } = render(OpenDocumentsRail, {
			props: {
				documents: [
					makeDocument({
						id: "file-1",
						filename: "report.pdf",
						title: "Report",
					}),
					makeDocument({
						id: "knowledge-1",
						source: "knowledge_artifact",
						filename: "notes.md",
						title: "Notes",
						mimeType: "text/markdown",
					}),
				],
				activeDocumentId: "file-1",
				onSelectDocument: vi.fn(),
				onCloseDocument: vi.fn(),
			},
		});

		expect(
			container.querySelector(".open-documents-rail-source-ai"),
		).toHaveTextContent("AI");
	});

	it("shows a source jump icon next to source-backed document titles", async () => {
		const onSelectDocument = vi.fn();
		const onJumpToSource = vi.fn();
		render(OpenDocumentsRail, {
			props: {
				documents: [
					makeDocument({
						id: "file-1",
						filename: "report.pdf",
						title: "Report",
						originConversationId: "conv-1",
						originAssistantMessageId: "assistant-1",
					}),
					makeDocument({
						id: "file-2",
						filename: "slides.pptx",
						title: "Slides",
					}),
				],
				activeDocumentId: "file-1",
				onSelectDocument,
				onJumpToSource,
				onCloseDocument: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByLabelText("View source message"));

		expect(onJumpToSource).toHaveBeenCalledWith(
			expect.objectContaining({ id: "file-1" }),
		);
		expect(onSelectDocument).not.toHaveBeenCalled();
	});
});
