import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { FileProductionJob } from "$lib/types";
import FileProductionCard from "./FileProductionCard.svelte";

const { prewarmDocumentPreviewMock } = vi.hoisted(() => ({
	prewarmDocumentPreviewMock: vi.fn(),
}));

vi.mock("$lib/client/document-preview-prewarm", () => ({
	prewarmDocumentPreview: prewarmDocumentPreviewMock,
}));

function makeJob(overrides: Partial<FileProductionJob>): FileProductionJob {
	return {
		id: "job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: "Quarterly report",
		status: "queued",
		stage: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		...overrides,
	};
}

describe("FileProductionCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
	});

	it("renders an active running job with title, elapsed, Producing label, progress bar and a Stop action", async () => {
		const onCancel = vi.fn();
		const created = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(created + 75_000);
		try {
			const { container, getByRole, getByText, queryByText } = render(
				FileProductionCard,
				{
					job: makeJob({ status: "running", createdAt: created }),
					onCancel,
				},
			);

			// Title is rendered from job.title (was previously hidden).
			expect(getByText("Quarterly report")).toBeInTheDocument();
			// Producing label is visible (not aria-only).
			expect(getByText("Producing")).toBeInTheDocument();
			// Elapsed timer formatted as m:ss (75s -> 1:15) with tabular-nums.
			expect(getByText("1:15")).toBeInTheDocument();
			// Animated gold sweep progress bar present.
			expect(
				container.querySelector(".producing-progress-sweep"),
			).toBeInTheDocument();
			// Card is still marked busy.
			expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
			// No resolved-only copy leaks through.
			expect(queryByText("No files yet")).toBeNull();
			expect(queryByText("Waiting for the file worker.")).toBeNull();

			// Cancel is a Stop (Square) icon button, not a dominant X.
			await fireEvent.click(
				getByRole("button", { name: "Stop file production" }),
			);
			expect(onCancel).toHaveBeenCalledWith("job-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders the stale honesty state (amber heading) for a running job older than 90s", () => {
		const created = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(created + 91_000);
		try {
			const { getByText, queryByText } = render(FileProductionCard, {
				job: makeJob({ status: "running", createdAt: created }),
			});

			expect(getByText("Still working… or stalled.")).toBeInTheDocument();
			expect(getByText("We’ll know in a moment.")).toBeInTheDocument();
			// Producing label is replaced by the stale honesty copy.
			expect(queryByText("Producing")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders a retryable failed job with its safe error and retry action", async () => {
		const onRetry = vi.fn();
		const { getByRole, getByText } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "renderer_timeout",
					message: "Renderer timed out.",
					retryable: true,
				},
			}),
			onRetry,
		});

		expect(getByText("Couldn’t produce this file")).toBeInTheDocument();
		expect(getByText("Document rendering timed out.")).toBeInTheDocument();

		await fireEvent.click(getByRole("button", { name: "Retry" }));

		expect(onRetry).toHaveBeenCalledWith("job-1");
	});

	it("renders a non-retryable failed job with Couldn't produce copy, the cause and a Dismiss action", async () => {
		const onDismiss = vi.fn();
		const { getByRole, getByText } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "sandbox_timeout",
					message: "Program execution timed out.",
					retryable: false,
				},
			}),
			onDismiss,
		});

		expect(getByText("Couldn’t produce this file")).toBeInTheDocument();
		expect(getByText("Program execution timed out.")).toBeInTheDocument();

		await fireEvent.click(
			getByRole("button", { name: "Dismiss file production" }),
		);

		expect(onDismiss).toHaveBeenCalledWith("job-1");
	});

	it("uses localized safe text for known limit errors instead of raw diagnostics", () => {
		const { getByText, queryByText } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "too_many_outputs",
					message: "limit=5 actual=6",
					retryable: false,
				},
			}),
		});

		expect(getByText("Too many outputs were requested.")).toBeInTheDocument();
		expect(queryByText("limit=5 actual=6")).toBeNull();
	});

	it("opens produced files with version and source fallbacks while background metadata sync catches up", async () => {
		const onOpenDocument = vi.fn();
		const { getByRole } = render(FileProductionCard, {
			job: makeJob({
				status: "succeeded",
				files: [
					{
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						downloadUrl: "/api/chat/files/file-1/download",
						previewUrl: "/api/chat/files/file-1/preview",
						versionNumber: null,
					},
				],
			}),
			onOpenDocument,
		});

		await fireEvent.click(getByRole("button", { name: "Preview report.pdf" }));

		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "file-1",
				source: "chat_generated_file",
				versionNumber: 1,
				originConversationId: "conv-1",
				originAssistantMessageId: "assistant-1",
				sourceChatFileId: "file-1",
			}),
		);
	});

	it("prewarms produced file previews on intent without opening until click", async () => {
		const onOpenDocument = vi.fn();
		const file = {
			id: "file-1",
			filename: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			downloadUrl: "/api/chat/files/file-1/download",
			previewUrl: "/api/chat/files/file-1/preview",
			versionNumber: null,
		};
		const { getByRole } = render(FileProductionCard, {
			job: makeJob({
				status: "succeeded",
				files: [file],
			}),
			onOpenDocument,
		});

		const previewButton = getByRole("button", { name: "Preview report.pdf" });

		await fireEvent.pointerEnter(previewButton);
		await fireEvent.focus(previewButton);
		await fireEvent.touchStart(previewButton);

		expect(prewarmDocumentPreviewMock).toHaveBeenCalledTimes(2);
		expect(prewarmDocumentPreviewMock).toHaveBeenCalledWith(file);
		expect(onOpenDocument).not.toHaveBeenCalled();

		await fireEvent.click(previewButton);
		expect(onOpenDocument).toHaveBeenCalledTimes(1);
	});

	it("uses Hungarian safe text for document render failures when the UI language is Hungarian", () => {
		uiLanguage.set("hu");
		const { getByText, queryByText, unmount } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "unsupported_pdf_block",
					message: "table details leaked",
					retryable: false,
				},
			}),
		});

		expect(
			getByText("Ez a PDF-renderelő még nem támogatja ezt a blokkot."),
		).toBeInTheDocument();
		expect(queryByText("table details leaked")).toBeNull();

		unmount();
		uiLanguage.set("en");
	});
});
