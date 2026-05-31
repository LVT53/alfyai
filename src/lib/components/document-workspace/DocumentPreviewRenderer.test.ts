import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocumentPreviewRenderer from "./DocumentPreviewRenderer.svelte";

const pdfMocks = vi.hoisted(() => ({
	renderCancel: vi.fn(),
	render: vi.fn(),
	getPage: vi.fn(),
	getDocument: vi.fn(),
}));

const officeMocks = vi.hoisted(() => ({
	renderOfficePreview: vi.fn(),
}));

const markdownMocks = vi.hoisted(() => ({
	renderHighlightedText: vi.fn(
		async (content: string, language: string | undefined) =>
			`<pre><code data-language="${language ?? ""}">${content}</code></pre>`,
	),
	renderMarkdown: vi.fn(
		async (content: string) =>
			`<article><h1>${content.replace(/^#\s*/, "")}</h1></article>`,
	),
}));

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: {
		workerSrc: "",
	},
	VerbosityLevel: {
		ERRORS: 0,
	},
	setVerbosityLevel: vi.fn(),
	getDocument: pdfMocks.getDocument,
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
	default: "/mock-pdf-worker.mjs",
}));

vi.mock("$lib/utils/markdown-loader", () => markdownMocks);

vi.mock("./preview-runtime/office", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./preview-runtime/office")>();
	return {
		...actual,
		renderOfficePreview: officeMocks.renderOfficePreview,
	};
});

function openPreview(
	overrides: Partial<{
		open: boolean;
		artifactId: string | null;
		previewUrl: string | null;
		filename: string;
		mimeType: string | null;
		onClose: () => void;
	}> = {},
) {
	return render(DocumentPreviewRenderer, {
		props: {
			open: true,
			artifactId: "test-123",
			filename: "document.pdf",
			mimeType: "application/pdf",
			onClose: vi.fn(),
			...overrides,
		},
	});
}

function mockFetchBlob(blob: Blob) {
	(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: true,
		status: 200,
		blob: () => Promise.resolve(blob),
	});
}

function mockPendingFetch() {
	(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
		() => new Promise(() => undefined),
	);
}

function deferredPreviewResponse(content: string, type = "text/plain") {
	let resolveResponse!: (response: {
		ok: boolean;
		status: number;
		blob: () => Promise<Blob>;
	}) => void;
	const blob = vi.fn(() => Promise.resolve(new Blob([content], { type })));
	const responsePromise = new Promise<{
		ok: boolean;
		status: number;
		blob: () => Promise<Blob>;
	}>((resolve) => {
		resolveResponse = resolve;
	});

	return {
		blob,
		responsePromise,
		resolve: () =>
			resolveResponse({
				ok: true,
				status: 200,
				blob,
			}),
	};
}

describe("DocumentPreviewRenderer", () => {
	const mockOnClose = vi.fn();
	const createObjectURL = vi.fn(() => "blob:preview-url");
	const revokeObjectURL = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn();
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
			() => undefined,
		);
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: createObjectURL,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: revokeObjectURL,
		});
		pdfMocks.render.mockImplementation(() => ({
			promise: Promise.resolve(),
			cancel: pdfMocks.renderCancel,
		}));
		pdfMocks.getPage.mockImplementation(async () => ({
			getViewport: vi.fn(({ scale }: { scale: number }) => ({
				width: 640 * scale,
				height: 480 * scale,
			})),
			render: pdfMocks.render,
		}));
		pdfMocks.getDocument.mockImplementation(() => ({
			promise: Promise.resolve({
				numPages: 1,
				getPage: pdfMocks.getPage,
			}),
			destroy: vi.fn(() => Promise.resolve()),
		}));
		officeMocks.renderOfficePreview.mockImplementation(
			async (adapter: { kind: string }) => {
				switch (adapter.kind) {
					case "docx":
						return {
							status: "ready",
							kind: "docx",
							html: "<p>Mock DOCX content</p>",
						};
					case "xlsx":
						return {
							status: "ready",
							kind: "xlsx",
							html: '<div class="xlsx-container"><table class="xlsx-table"><tr><td>Total</td><td>225</td></tr></table></div>',
						};
					case "pptx":
						return {
							status: "ready",
							kind: "pptx",
							totalPages: 2,
							currentPage: 1,
							html: `
								<div class="pptx-container">
									<div class="pptx-slide"><img src="data:image/png;base64,one" alt="Slide 1" class="pptx-slide-image" /><div class="pptx-slide-badge">Slide 1 / 2</div></div>
									<div class="pptx-slide-separator" aria-hidden="true"></div>
									<div class="pptx-slide"><img src="data:image/png;base64,two" alt="Slide 2" class="pptx-slide-image" /><div class="pptx-slide-badge">Slide 2 / 2</div></div>
								</div>`,
						};
					case "odt":
						return {
							status: "ready",
							kind: "odt",
							html: '<div class="odt-preview"><h1>ODT Title</h1><p>Hello from ODT preview</p></div>',
						};
					default:
						return {
							status: "error",
							kind: adapter.kind,
							error: "Failed to render office file",
						};
				}
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders nothing when closed", () => {
		const { container } = openPreview({
			open: false,
			onClose: mockOnClose,
		});

		expect(container.innerHTML.trim()).toBe("<!---->");
	});

	it("shows loading state while the runtime fetch is pending", () => {
		mockPendingFetch();

		openPreview({ onClose: mockOnClose });

		expect(screen.getByText("Loading preview...")).toBeInTheDocument();
		expect(document.querySelector(".spinner")).toBeInTheDocument();
	});

	it("shows runtime errors and retries through the same preview source", async () => {
		(global.fetch as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				blob: () =>
					Promise.resolve(
						new Blob(["const answer = 42;"], { type: "text/plain" }),
					),
			});

		openPreview({
			filename: "notes.ts",
			mimeType: "text/plain",
			onClose: mockOnClose,
		});

		expect(await screen.findByText("Network error")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("Retry"));

		await waitFor(() => {
			expect(screen.getByText("const answer = 42;")).toBeInTheDocument();
		});
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it("keeps the selected document preview when an older load finishes late", async () => {
		const first = deferredPreviewResponse("first document");
		const second = deferredPreviewResponse("second document");
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			(url: string) => {
				if (url.includes("first-artifact")) return first.responsePromise;
				if (url.includes("second-artifact")) return second.responsePromise;
				throw new Error(`Unexpected preview URL: ${url}`);
			},
		);

		const { rerender } = openPreview({
			artifactId: "first-artifact",
			filename: "first.txt",
			mimeType: "text/plain",
			onClose: mockOnClose,
		});

		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				"/api/knowledge/first-artifact/preview",
			);
		});

		await rerender({
			artifactId: "second-artifact",
			filename: "second.txt",
			mimeType: "text/plain",
		});
		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				"/api/knowledge/second-artifact/preview",
			);
		});

		second.resolve();
		expect(await screen.findByText("second document")).toBeInTheDocument();

		first.resolve();
		await waitFor(() => expect(first.blob).toHaveBeenCalled());
		expect(screen.getByText("second document")).toBeInTheDocument();
		expect(screen.queryByText("first document")).not.toBeInTheDocument();
	});

	it("maps missing files to the existing not-found state", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 404,
		});

		openPreview({ onClose: mockOnClose });

		expect(await screen.findByText("File not found")).toBeInTheDocument();
	});

	it("shows unavailable preview state without fetching when no preview source exists", () => {
		openPreview({
			artifactId: null,
			previewUrl: null,
			filename: "source-less.pdf",
			mimeType: "application/pdf",
			onClose: mockOnClose,
		});

		expect(screen.getByText("Preview not available")).toBeInTheDocument();
		expect(
			screen.queryByText("Preview not available for this file type"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /retry/i }),
		).not.toBeInTheDocument();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("treats whitespace-only explicit preview URLs as a missing preview source", () => {
		openPreview({
			artifactId: null,
			previewUrl: "   ",
			filename: "source-less.pdf",
			mimeType: "application/pdf",
			onClose: mockOnClose,
		});

		expect(screen.getByText("Preview not available")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /retry/i }),
		).not.toBeInTheDocument();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("renders as an embedded preview region without standalone modal chrome", () => {
		mockPendingFetch();

		openPreview({
			filename: "embedded.pdf",
			onClose: mockOnClose,
		});

		expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(
			screen.getByRole("region", { name: "embedded.pdf" }),
		).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Close file preview"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("File Preview")).not.toBeInTheDocument();
	});

	it("does not close on Escape because the workspace shell owns closing", async () => {
		mockPendingFetch();

		openPreview({ onClose: mockOnClose });
		await fireEvent.keyDown(window, { key: "Escape" });

		expect(mockOnClose).not.toHaveBeenCalled();
	});

	it("shows unsupported-file messaging with the local download fallback", async () => {
		mockFetchBlob(new Blob(["content"], { type: "application/octet-stream" }));

		openPreview({
			filename: "archive.unknown",
			mimeType: "application/octet-stream",
			onClose: mockOnClose,
		});

		expect(
			await screen.findByText("Preview not available for this file type"),
		).toBeInTheDocument();
		await fireEvent.click(
			screen.getByRole("button", { name: /download file/i }),
		);
		expect(createObjectURL).toHaveBeenCalled();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-url");
	});

	it("leaves supported-file downloads to the workspace shell", async () => {
		mockFetchBlob(new Blob(["PDF content"], { type: "application/pdf" }));

		openPreview({ onClose: mockOnClose });

		expect(await screen.findByTestId("pdf-preview")).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Download document.pdf"),
		).not.toBeInTheDocument();
	});

	it("renders PDFs through the preview runtime PDF adapter", async () => {
		mockFetchBlob(new Blob(["%PDF-1.7 content"], { type: "application/pdf" }));

		openPreview({
			filename: "document.pdf",
			mimeType: "application/pdf",
			onClose: mockOnClose,
		});

		expect(await screen.findByTestId("pdf-preview")).toBeInTheDocument();
		expect(await screen.findByTestId("preview-page-input")).toHaveDisplayValue(
			"1",
		);
		expect(screen.getByText("of 1")).toBeInTheDocument();
	});

	it("renders images through the preview runtime image adapter", async () => {
		mockFetchBlob(new Blob(["image data"], { type: "image/png" }));

		openPreview({
			filename: "image.png",
			mimeType: "image/png",
			onClose: mockOnClose,
		});

		expect(
			await screen.findByTestId("image-preview-stage"),
		).toBeInTheDocument();
		expect(screen.getByAltText("image.png")).toHaveAttribute(
			"src",
			"blob:preview-url",
		);
	});

	it("renders highlighted source text from the text adapter", async () => {
		mockFetchBlob(new Blob(["const answer = 42;"], { type: "text/plain" }));

		openPreview({
			filename: "notes.ts",
			mimeType: "text/plain",
			onClose: mockOnClose,
		});

		expect(await screen.findByText("const answer = 42;")).toBeInTheDocument();
		expect(document.querySelector(".file-text-preview code")).toHaveAttribute(
			"data-language",
			"typescript",
		);
	});

	it("renders CSV through the text adapter table surface", async () => {
		mockFetchBlob(new Blob(["Name,Total\nAlfy,225"], { type: "text/csv" }));

		openPreview({
			filename: "metrics.csv",
			mimeType: "text/csv",
			onClose: mockOnClose,
		});

		expect(await screen.findByText("Name")).toBeInTheDocument();
		expect(screen.getByText("225")).toBeInTheDocument();
		expect(document.querySelector(".csv-table")).toBeInTheDocument();
	});

	it("renders Markdown through the text adapter document surface", async () => {
		mockFetchBlob(new Blob(["# Project Notes"], { type: "text/markdown" }));

		openPreview({
			filename: "notes.md",
			mimeType: "text/markdown",
			onClose: mockOnClose,
		});

		expect(
			await screen.findByRole("heading", { name: "Project Notes" }),
		).toBeInTheDocument();
		expect(
			document.querySelector(".markdown-document-preview"),
		).toBeInTheDocument();
		expect(
			document.querySelector(".file-text-preview"),
		).not.toBeInTheDocument();
	});

	it("renders HTML through a sandboxed static iframe", async () => {
		mockFetchBlob(
			new Blob(
				[
					"<main><h1>Website Export</h1></main><script>document.body.dataset.executed = 'yes'</script>",
				],
				{ type: "text/html" },
			),
		);

		openPreview({
			filename: "site.html",
			mimeType: "text/html",
			onClose: mockOnClose,
		});

		const frame = await screen.findByTitle("site.html preview");
		expect(frame).toHaveAttribute("sandbox", "");
		expect(frame).toHaveAttribute(
			"srcdoc",
			expect.stringContaining("Website Export"),
		);
		expect(frame.getAttribute("srcdoc")).not.toContain("<script>");
		expect(document.body.dataset.executed).toBeUndefined();
	});

	it("renders DOCX through the office adapter surface", async () => {
		mockFetchBlob(
			new Blob(["docx content"], {
				type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			}),
		);

		openPreview({
			filename: "document.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			onClose: mockOnClose,
		});

		expect(await screen.findByText("Mock DOCX content")).toBeInTheDocument();
		expect(officeMocks.renderOfficePreview).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "docx" }),
		);
	});

	it("renders XLSX through the office adapter surface", async () => {
		mockFetchBlob(
			new Blob(["xlsx content"], {
				type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		);

		openPreview({
			filename: "spreadsheet.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			onClose: mockOnClose,
		});

		expect(await screen.findByText("Total")).toBeInTheDocument();
		expect(screen.getByText("225")).toBeInTheDocument();
		expect(document.querySelector(".xlsx-table")).toBeInTheDocument();
	});

	it("renders PPTX slide navigation and keeps coordinator-owned slide jumps", async () => {
		mockFetchBlob(
			new Blob(["pptx content"], {
				type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			}),
		);

		openPreview({
			filename: "slides.pptx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			onClose: mockOnClose,
		});

		const slideTwoImage = await screen.findByAltText("Slide 2");
		const slideTwo = slideTwoImage.closest(".pptx-slide") as HTMLElement;
		const scrollIntoView = vi.fn();
		slideTwo.scrollIntoView = scrollIntoView;

		expect(screen.getByLabelText("Next slide")).toBeInTheDocument();
		expect(screen.getAllByText("Slide 1 / 2").length).toBeGreaterThan(0);

		await fireEvent.click(screen.getByLabelText("Next slide"));

		expect(scrollIntoView).toHaveBeenCalledWith({
			behavior: "smooth",
			block: "start",
		});
	});

	it("renders ODT through the office adapter surface", async () => {
		mockFetchBlob(
			new Blob(["odt content"], {
				type: "application/vnd.oasis.opendocument.text",
			}),
		);

		openPreview({
			filename: "document.odt",
			mimeType: "application/vnd.oasis.opendocument.text",
			onClose: mockOnClose,
		});

		expect(await screen.findByText("ODT Title")).toBeInTheDocument();
		expect(screen.getByText("Hello from ODT preview")).toBeInTheDocument();
	});
});
