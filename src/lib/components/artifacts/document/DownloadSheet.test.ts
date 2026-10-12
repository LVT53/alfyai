import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockExportArtifactDocument,
	mockDownloadAppAsHtml,
	mockDownloadProducedFile,
} = vi.hoisted(() => ({
	mockExportArtifactDocument: vi.fn(),
	mockDownloadAppAsHtml: vi.fn(),
	mockDownloadProducedFile: vi.fn(),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	exportArtifactDocument: mockExportArtifactDocument,
	downloadAppAsHtml: mockDownloadAppAsHtml,
}));

// `downloadProducedFile` (follow the job, start the browser's download) has its
// own tests in `client/downloads.test.ts`; here it runs the sheet's `start` and
// answers what it would have answered once the file was ready.
vi.mock("$lib/client/downloads", () => ({
	downloadProducedFile: mockDownloadProducedFile,
}));

const A_JOB = { id: "job-1", status: "queued" };

/** The file is ready as soon as the job has started. */
function fileIsReady() {
	mockDownloadProducedFile.mockImplementation(
		async (start: () => Promise<{ ok: boolean; reason?: string }>) => {
			const started = await start();
			return started.ok
				? { ok: true, filename: "trip-plan.pdf" }
				: { ok: false, reason: started.reason };
		},
	);
}

import DownloadSheet from "./DownloadSheet.svelte";

// jsdom's default `window.innerWidth` (1024) is above the phone threshold
// (`isPhoneViewport`, 640px), so every test here exercises the DESKTOP
// popover branch — the same assumption `VersionsSheet.test.ts` and
// `AppBody.test.ts`'s own regenerate-popover suite make. The phone
// `DialogShell` sheet branch reuses the same `downloadOptions` snippet and is
// covered by `DialogShell.test.ts` plus the Playwright suite.
describe("DownloadSheet", () => {
	beforeEach(() => {
		fileIsReady();
	});

	afterEach(() => {
		cleanup();
		mockExportArtifactDocument.mockReset();
		mockDownloadAppAsHtml.mockReset();
		mockDownloadProducedFile.mockReset();
	});

	it("names the document, never the word Artifact, and is portaled onto <body>", () => {
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Vienna, 10–12 October",
			conversationId: "conv-1",
			onClose: vi.fn(),
		});
		const dialog = screen.getByRole("dialog", {
			name: /Vienna, 10–12 October/,
		});
		expect(dialog).toBeInTheDocument();
		expect(dialog.parentElement).toBe(document.body);
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
		mockExportArtifactDocument.mockResolvedValue({ ok: true, job: A_JOB });
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
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	// F1: the popover used to close on the job's 202 and leave the reader with
	// nothing. It says the file is being made until the download has started.
	it("says it is preparing the file until the download has started, and only then closes", async () => {
		let startDownload!: () => void;
		mockDownloadProducedFile.mockImplementation(
			() =>
				new Promise((resolve) => {
					startDownload = () => resolve({ ok: true, filename: "plan.pdf" });
				}),
		);
		const onClose = vi.fn();
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose,
		});

		await fireEvent.click(screen.getByRole("button", { name: "PDF" }));

		expect(screen.getByRole("status")).toHaveTextContent(
			"Preparing your file…",
		);
		expect(screen.getByRole("button", { name: "PDF" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Word" })).toBeDisabled();
		expect(onClose).not.toHaveBeenCalled();

		startDownload();
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("says so when the file could not be made, and nothing closes", async () => {
		mockDownloadProducedFile.mockResolvedValue({
			ok: false,
			reason: "job_failed",
		});
		const onClose = vi.fn();
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Markdown" }));

		expect(
			await screen.findByText("Could not create this file."),
		).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("says so when the file was still being made when the wait ran out", async () => {
		mockDownloadProducedFile.mockResolvedValue({
			ok: false,
			reason: "timeout",
		});
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose: vi.fn(),
		});

		await fireEvent.click(screen.getByRole("button", { name: "PDF" }));

		expect(
			await screen.findByText(
				"This is taking longer than expected. Try again in a moment.",
			),
		).toBeInTheDocument();
	});

	describe("an App", () => {
		it("offers its one .html file, not the Document's formats", () => {
			render(DownloadSheet, {
				kind: "app",
				artifactId: "app-1",
				title: "Tip calculator",
				conversationId: "conv-1",
				onClose: vi.fn(),
			});
			expect(
				screen.getByRole("button", { name: "HTML file" }),
			).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "PDF" })).toBeNull();
			expect(
				screen.getByRole("dialog", { name: /Tip calculator/ }),
			).toHaveAttribute("data-testid", "app-download-popover");
		});

		it("starts the App's download with the panel's conversation id, then closes", async () => {
			mockDownloadAppAsHtml.mockResolvedValue({
				ok: true,
				job: A_JOB,
				reused: false,
			});
			const onClose = vi.fn();
			render(DownloadSheet, {
				kind: "app",
				artifactId: "app-1",
				title: "Tip calculator",
				conversationId: "panel-conv",
				onClose,
			});

			await fireEvent.click(screen.getByRole("button", { name: "HTML file" }));

			expect(mockDownloadAppAsHtml).toHaveBeenCalledWith("app-1", "panel-conv");
			expect(mockExportArtifactDocument).not.toHaveBeenCalled();
			await waitFor(() => expect(onClose).toHaveBeenCalled());
		});

		it("says the App's own sentences when it fails or has no conversation", async () => {
			mockDownloadAppAsHtml.mockResolvedValue({
				ok: false,
				reason: "conversation_required",
			});
			render(DownloadSheet, {
				kind: "app",
				artifactId: "app-1",
				title: "Tip calculator",
				conversationId: null,
				onClose: vi.fn(),
			});

			await fireEvent.click(screen.getByRole("button", { name: "HTML file" }));
			expect(
				await screen.findByText(
					"This app is not in a chat, so it cannot be saved as a file.",
				),
			).toBeInTheDocument();

			await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
			mockDownloadAppAsHtml.mockResolvedValue({
				ok: false,
				reason: "rate_limited",
			});
			await fireEvent.click(screen.getByRole("button", { name: "HTML file" }));
			expect(
				await screen.findByText("Could not prepare this app for download."),
			).toBeInTheDocument();
		});
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
			await screen.findByText("This document is too long to export."),
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
			await screen.findByText(
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
		expect(
			await screen.findByText("Could not create this file."),
		).toBeInTheDocument();

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

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		render(DownloadSheet, {
			artifactId: "artifact-1",
			title: "Trip plan",
			conversationId: "conv-1",
			onClose,
		});

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});
});
