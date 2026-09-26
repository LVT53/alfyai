import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockExportArtifactDocument } = vi.hoisted(() => ({
	mockExportArtifactDocument: vi.fn(),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	exportArtifactDocument: mockExportArtifactDocument,
}));

import DownloadSheet from "./DownloadSheet.svelte";

describe("DownloadSheet", () => {
	afterEach(() => {
		cleanup();
		mockExportArtifactDocument.mockReset();
	});

	it("names the document, never the word Artifact", () => {
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Vienna, 10–12 October",
			conversationId: "conv-1",
			onClose: vi.fn(),
		});
		expect(
			screen.getByRole("dialog", { name: /Vienna, 10–12 October/ }),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/artifact/i);
	});

	it("offers PDF, Word and Markdown", () => {
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose: vi.fn(),
		});
		expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Word" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Markdown" }),
		).toBeInTheDocument();
	});

	it("exports the chosen format with the artifact's own conversation id, then closes", async () => {
		mockExportArtifactDocument.mockResolvedValue({
			ok: true,
			job: { id: "job-1" },
		});
		const onClose = vi.fn();
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose,
		});

		await fireEvent.click(screen.getByRole("button", { name: "PDF" }));

		expect(mockExportArtifactDocument).toHaveBeenCalledWith(
			"artifact-1",
			"pdf",
			"conv-1",
		);
		expect(onClose).toHaveBeenCalled();
	});

	it("shows the too-large notice for a source_too_large refusal, without closing", async () => {
		mockExportArtifactDocument.mockResolvedValue({
			ok: false,
			reason: "source_too_large",
		});
		const onClose = vi.fn();
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Word" }));

		expect(
			screen.getByText("This document is too long to export."),
		).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("shows the no-conversation notice for a no_conversation refusal", async () => {
		mockExportArtifactDocument.mockResolvedValue({
			ok: false,
			reason: "no_conversation",
		});
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: null,
			onClose: vi.fn(),
		});

		await fireEvent.click(screen.getByRole("button", { name: "Markdown" }));

		expect(
			screen.getByText(
				"This document isn't in a conversation yet, so it can't be exported.",
			),
		).toBeInTheDocument();
	});

	it("shows the generic failed notice for any other refusal, and Try again resets it", async () => {
		mockExportArtifactDocument.mockResolvedValue({
			ok: false,
			reason: "unexpected_error",
		});
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose: vi.fn(),
		});

		await fireEvent.click(screen.getByRole("button", { name: "PDF" }));
		expect(screen.getByText("Could not create this file.")).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();
	});

	it("closes on the close button without exporting anything", async () => {
		const onClose = vi.fn();
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));

		expect(onClose).toHaveBeenCalled();
		expect(mockExportArtifactDocument).not.toHaveBeenCalled();
	});
});
