import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import KnowledgeLibraryModal from "./KnowledgeLibraryModal.svelte";

describe("KnowledgeLibraryModal", () => {
	it("opens binary previews with the display artifact instead of the normalized prompt artifact", async () => {
		const onOpenDocument = vi.fn();
		const onClose = vi.fn();
		const document: KnowledgeDocumentItem & { type: "source_document" } = {
			id: "doc-1",
			name: "Deck.pptx",
			type: "source_document",
			mimeType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			sizeBytes: 1024,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			displayArtifactId: "artifact-display",
			promptArtifactId: "artifact-prompt",
			familyArtifactIds: ["artifact-display", "artifact-prompt"],
			conversationId: null,
			summary: null,
			normalizedAvailable: true,
			documentOrigin: "uploaded",
		};

		render(KnowledgeLibraryModal, {
			props: {
				activeLibraryModal: "documents",
				documents: [document],
				pendingKnowledgeActionKey: null,
				deletingArtifactCount: 0,
				isKnowledgeActionPending: () => false,
				isDeletingArtifact: () => false,
				onClose,
				onOpenDocument,
				onRunKnowledgeAction: vi.fn(),
				onRemoveArtifact: vi.fn(),
			},
		});

		const row = screen.getByText("Deck.pptx").closest("tr");
		expect(row).toBeInTheDocument();
		if (!row) {
			throw new Error("Expected document row");
		}

		await fireEvent.click(row);

		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "artifact:artifact-display",
				artifactId: "artifact-display",
				filename: "Deck.pptx",
			}),
		);
		expect(onOpenDocument.mock.calls[0][0].previewUrl).toBeUndefined();
		expect(onOpenDocument).not.toHaveBeenCalledWith(
			expect.objectContaining({
				artifactId: "artifact-prompt",
			}),
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
