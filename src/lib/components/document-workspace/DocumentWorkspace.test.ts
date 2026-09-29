import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { MOTION_EASING } from "$lib/utils/motion";
import {
	makeWorkspaceDocument,
	renderWorkspace,
} from "./DocumentWorkspace.test-helpers";

vi.mock("$lib/services/markdown", () => ({
	renderHighlightedText: vi.fn(
		async (content: string) => `<pre><code>${content}</code></pre>`,
	),
}));

describe("DocumentWorkspace", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
	});

	it("renders a single desktop preview body for one open document", async () => {
		const { container } = renderWorkspace({
			documents: [
				{
					id: "generated-file-1",
					source: "chat_generated_file",
					filename: "generated.txt",
					title: "Generated notes",
					mimeType: "text/plain",
					artifactId: null,
					previewUrl: "/api/chat/files/generated-file-1/preview",
				},
			],
			activeDocumentId: "generated-file-1",
		});

		await waitFor(() => {
			expect(
				container.querySelectorAll('[data-testid="page-scroll-container"]'),
			).toHaveLength(1);
		});
	});

	it("loads one embedded preview for the active workspace document", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			blob: () =>
				Promise.resolve(new Blob(["workspace notes"], { type: "text/plain" })),
		});

		renderWorkspace({
			documents: [
				{
					id: "generated-file-1",
					source: "chat_generated_file",
					filename: "workspace-notes.txt",
					title: "Workspace notes",
					mimeType: "text/plain",
					artifactId: null,
					previewUrl: "/api/chat/files/generated-file-1/preview",
				},
			],
			activeDocumentId: "generated-file-1",
		});

		await waitFor(() => {
			expect(screen.getByText("workspace notes")).toBeInTheDocument();
		});

		expect(
			screen.getAllByRole("region", { name: "workspace-notes.txt" }),
		).toHaveLength(1);
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(global.fetch).toHaveBeenCalledWith(
			"/api/chat/files/generated-file-1/preview",
		);
	});

	it("reopens a source-less workspace document without stale preview fetches", async () => {
		const sourceLessDocument = {
			id: "source-less-document",
			source: "chat_generated_file" as const,
			filename: "source-less.pdf",
			title: "Source-less PDF",
			mimeType: "application/pdf",
			artifactId: null,
			previewUrl: null,
		};

		const { rerender } = renderWorkspace({
			documents: [sourceLessDocument],
			activeDocumentId: "source-less-document",
		});

		await waitFor(() => {
			expect(screen.getAllByText("Preview not available")).toHaveLength(1);
		});
		expect(global.fetch).not.toHaveBeenCalled();

		await rerender({ open: false, documents: [], activeDocumentId: null });
		expect(screen.queryByText("Preview not available")).not.toBeInTheDocument();

		await rerender({
			open: true,
			documents: [sourceLessDocument],
			activeDocumentId: "source-less-document",
		});

		await waitFor(() => {
			expect(screen.getAllByText("Preview not available")).toHaveLength(1);
		});
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("requests expanded presentation instead of opening a separate viewer", async () => {
		const onPresentationChange = vi.fn();

		renderWorkspace({
			presentation: "docked",
			documents: [makeWorkspaceDocument({})],
			activeDocumentId: "doc-1",
			onPresentationChange,
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		await fireEvent.click(
			within(desktopWorkspace).getByRole("button", {
				name: /expand document workspace/i,
			}),
		);

		expect(onPresentationChange).toHaveBeenCalledWith("expanded");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("shows a readable open documents rail only when multiple working documents are open", async () => {
		const documents = [
			{
				id: "doc-1",
				source: "chat_generated_file" as const,
				filename: "short.md",
				title: "Short note",
				mimeType: "text/markdown",
				artifactId: null,
				previewUrl: "/api/chat/files/doc-1/preview",
			},
			{
				id: "doc-2",
				source: "knowledge_artifact" as const,
				filename: "very-long-research-brief-with-readable-name.md",
				title: "Very long research brief with readable name",
				documentRole: "research_brief",
				versionNumber: 2,
				mimeType: "text/markdown",
				artifactId: "artifact-2",
			},
		];

		const { rerender } = renderWorkspace({
			documents: [documents[0]],
			activeDocumentId: "doc-1",
		});

		expect(screen.queryByTestId("open-documents-rail")).not.toBeInTheDocument();

		await rerender({
			documents,
			activeDocumentId: "doc-2",
		});

		const rail = screen.getByTestId("open-documents-rail");
		expect(rail).toBeInTheDocument();
		expect(rail).toHaveAttribute("role", "tablist");
		expect(
			within(rail).getByRole("tab", {
				name: /very long research brief with readable name/i,
			}),
		).toBeInTheDocument();
		expect(within(rail).getByText("v2")).toHaveClass(
			"open-documents-rail-version",
		);
		expect(within(rail).getByText("Knowledge Base")).toBeInTheDocument();
		expect(
			within(rail).getByText(/text • research brief/i),
		).toBeInTheDocument();
		expect(within(rail).getByText("AI")).toBeInTheDocument();
		expect(
			rail.querySelector(".open-documents-rail-source-ai svg"),
		).toBeInTheDocument();
		expect(within(rail).getByText("2")).toHaveAccessibleName("2 open");
		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		const main = within(desktopWorkspace).getByTestId("workspace-main");
		expect(main).toContainElement(rail);
		expect(main).toContainElement(
			within(desktopWorkspace).getByTestId("workspace-document-column"),
		);
	});

	it("uses the document title as the source jump and keeps version metadata out of the header", async () => {
		const onJumpToSource = vi.fn();

		renderWorkspace({
			documents: [
				{
					id: "generated-doc",
					source: "chat_generated_file",
					filename: "brief.pdf",
					title: "Generated Brief",
					documentRole: "brief",
					versionNumber: 1,
					mimeType: "application/pdf",
					artifactId: null,
					previewUrl: "/api/chat/files/generated-doc/preview",
					originConversationId: "conversation-1",
					originAssistantMessageId: "message-1",
				},
			],
			activeDocumentId: "generated-doc",
			onJumpToSource,
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		expect(
			within(desktopWorkspace).getByText("Active document"),
		).toBeInTheDocument();
		expect(
			within(desktopWorkspace).queryByText(/from assistant message/i),
		).not.toBeInTheDocument();
		expect(within(desktopWorkspace).queryByText("v1")).not.toBeInTheDocument();
		expect(within(desktopWorkspace).getByText("AI")).toBeInTheDocument();
		expect(
			desktopWorkspace.querySelector(".workspace-source-pill-ai svg"),
		).toBeInTheDocument();
		expect(
			desktopWorkspace.querySelector(
				".workspace-title-row .workspace-header-actions",
			),
		).toBeInTheDocument();

		const sourceTitle = desktopWorkspace.querySelector(
			".workspace-title-link",
		) as HTMLElement;
		await fireEvent.click(sourceTitle);

		expect(onJumpToSource).toHaveBeenCalledWith(
			expect.objectContaining({ id: "generated-doc" }),
		);
	});

	it("uses a mobile documents sheet instead of the desktop rail in the mobile workspace", async () => {
		const onSelectDocument = vi.fn();
		const onCloseDocument = vi.fn();
		renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-1",
					source: "knowledge_artifact",
					filename: "first.md",
					title: "First document",
					mimeType: "text/markdown",
					artifactId: "artifact-1",
				},
				{
					id: "doc-2",
					source: "knowledge_artifact",
					filename: "second.md",
					title: "Second document",
					mimeType: "text/markdown",
					artifactId: "artifact-2",
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument,
			onOpenDocument: vi.fn(),
			onCloseDocument,
			onCloseWorkspace: vi.fn(),
		});

		const mobileWorkspace = document.querySelector(
			".workspace-shell-mobile",
		) as HTMLElement;
		expect(
			within(mobileWorkspace).queryByTestId("open-documents-rail"),
		).not.toBeInTheDocument();

		await fireEvent.click(
			within(mobileWorkspace).getByRole("button", { name: /documents/i }),
		);

		const sheet = within(mobileWorkspace).getByTestId("mobile-documents-sheet");
		await fireEvent.click(
			within(sheet).getByRole("button", { name: /^second document$/i }),
		);
		expect(onSelectDocument).toHaveBeenCalledWith("doc-2");

		await fireEvent.click(
			within(mobileWorkspace).getByRole("button", { name: /documents/i }),
		);
		const reopenedSheet = within(mobileWorkspace).getByTestId(
			"mobile-documents-sheet",
		);
		await fireEvent.click(
			within(reopenedSheet).getByLabelText(/close second document/i),
		);
		expect(onCloseDocument).toHaveBeenCalledWith("doc-2");
	});

	it("does not replay the shell entrance animation when switching active documents", async () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const documents = [
			{
				id: "doc-1",
				source: "knowledge_artifact" as const,
				filename: "first.md",
				title: "First document",
				mimeType: "text/markdown",
				artifactId: "artifact-1",
			},
			{
				id: "doc-2",
				source: "knowledge_artifact" as const,
				filename: "second.md",
				title: "Second document",
				mimeType: "text/markdown",
				artifactId: "artifact-2",
			},
		];

		const { rerender } = renderWorkspace({
			open: true,
			documents,
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});
		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		frames.shift()?.(0);
		await tick();
		expect(desktopWorkspace.style.opacity).toBe("1");

		await rerender({ activeDocumentId: "doc-2" });
		await tick();

		expect(desktopWorkspace.style.opacity).toBe("1");
	});

	it("uses an expanded workspace layout with rail and preview column sharing the extra width", async () => {
		renderWorkspace({
			open: true,
			presentation: "expanded",
			documents: [
				{
					id: "doc-1",
					source: "knowledge_artifact",
					filename: "first.pdf",
					title: "First document",
					mimeType: "application/pdf",
					artifactId: "artifact-1",
				},
				{
					id: "doc-2",
					source: "knowledge_artifact",
					filename: "second.pdf",
					title: "Second document",
					mimeType: "application/pdf",
					artifactId: "artifact-2",
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		const main = within(desktopWorkspace).getByTestId("workspace-main");

		expect(desktopWorkspace).toHaveClass("workspace-shell-expanded");
		expect(main).toHaveAttribute("data-presentation", "expanded");
		expect(main).toHaveAttribute("data-layout", "rail-and-preview");
		expect(desktopWorkspace.style.transform).toContain("scale");
		expect(
			within(desktopWorkspace).queryByRole("button", {
				name: /return .* docked workspace/i,
			}),
		).not.toBeInTheDocument();
		expect(
			within(main).getByTestId("workspace-document-column"),
		).toBeInTheDocument();
	});

	it("closes an expanded workspace when Escape is pressed", async () => {
		const onCloseWorkspace = vi.fn();

		renderWorkspace({
			open: true,
			presentation: "expanded",
			returnToDockedOnExpandedClose: false,
			documents: [
				{
					id: "doc-1",
					source: "knowledge_artifact",
					filename: "document.pdf",
					title: "Document",
					mimeType: "application/pdf",
					artifactId: "artifact-1",
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace,
		});

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("closes an expanded workspace when pressing outside the desktop shell", async () => {
		const onCloseWorkspace = vi.fn();

		renderWorkspace({
			open: true,
			presentation: "expanded",
			returnToDockedOnExpandedClose: false,
			documents: [
				{
					id: "doc-1",
					source: "knowledge_artifact",
					filename: "document.pdf",
					title: "Document",
					mimeType: "application/pdf",
					artifactId: "artifact-1",
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace,
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});

		await fireEvent.pointerDown(desktopWorkspace);
		expect(onCloseWorkspace).not.toHaveBeenCalled();

		document.body.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true }),
		);

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("keeps an expanded mobile workspace open when pressing inside the mobile shell", async () => {
		const onCloseWorkspace = vi.fn();

		renderWorkspace({
			open: true,
			presentation: "expanded",
			returnToDockedOnExpandedClose: false,
			documents: [
				{
					id: "doc-1",
					source: "knowledge_artifact",
					filename: "document.pdf",
					title: "Document",
					mimeType: "application/pdf",
					artifactId: "artifact-1",
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace,
		});

		const mobileWorkspace = document.querySelector(
			".workspace-shell-mobile",
		) as HTMLElement;

		await fireEvent.pointerDown(mobileWorkspace);

		expect(onCloseWorkspace).not.toHaveBeenCalled();
	});

	it("opens chat-generated PPTX files through the shared docked workspace renderer", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise(() => undefined),
		);

		renderWorkspace({
			open: true,
			presentation: "docked",
			documents: [
				{
					id: "chat-pptx",
					source: "chat_generated_file",
					filename: "slides.pptx",
					title: "Slides",
					mimeType:
						"application/vnd.openxmlformats-officedocument.presentationml.presentation",
					artifactId: null,
					previewUrl: "/api/chat/files/chat-pptx/preview",
				},
			],
			availableDocuments: [],
			activeDocumentId: "chat-pptx",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				"/api/chat/files/chat-pptx/preview",
			);
		});
		expect(
			screen.getAllByRole("region", { name: "slides.pptx" }).length,
		).toBeGreaterThan(0);
		expect(
			screen.getByRole("complementary", { name: /document workspace/i }),
		).toHaveClass("workspace-shell-desktop");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("opens Knowledge DOCX and XLSX files through the expanded shared workspace renderer", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise(() => undefined),
		);

		const documents = [
			{
				id: "knowledge-docx",
				source: "knowledge_artifact" as const,
				filename: "brief.docx",
				title: "Brief",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				artifactId: "artifact-docx",
			},
			{
				id: "knowledge-xlsx",
				source: "knowledge_artifact" as const,
				filename: "spreadsheet.xlsx",
				title: "Spreadsheet",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				artifactId: "artifact-xlsx",
			},
		];

		const { rerender } = renderWorkspace({
			open: true,
			presentation: "expanded",
			documents,
			availableDocuments: [],
			activeDocumentId: "knowledge-docx",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				"/api/knowledge/artifact-docx/preview",
			);
		});
		expect(
			screen.getAllByRole("region", { name: "brief.docx" }).length,
		).toBeGreaterThan(0);

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		await rerender({ activeDocumentId: "knowledge-xlsx" });

		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				"/api/knowledge/artifact-xlsx/preview",
			);
		});
		expect(
			screen.getAllByRole("region", { name: "spreadsheet.xlsx" }).length,
		).toBeGreaterThan(0);
		expect(desktopWorkspace).toHaveClass("workspace-shell-expanded");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("opens image previews in docked Chat, expanded Chat, and expanded Knowledge workspace layouts", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			blob: () =>
				Promise.resolve(new Blob(["image data"], { type: "image/png" })),
		});
		const chatImage = {
			id: "chat-image",
			source: "chat_generated_file" as const,
			filename: "chart.png",
			title: "Chart",
			mimeType: "image/png",
			artifactId: null,
			previewUrl: "/api/chat/files/chat-image/preview",
		};
		const knowledgeImage = {
			id: "knowledge-image",
			source: "knowledge_artifact" as const,
			filename: "scan.png",
			title: "Scan",
			mimeType: "image/png",
			artifactId: "artifact-image",
		};

		const { rerender } = renderWorkspace({
			open: true,
			presentation: "docked",
			documents: [chatImage],
			availableDocuments: [],
			activeDocumentId: "chat-image",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		await waitFor(() => {
			expect(screen.getAllByAltText("chart.png").length).toBeGreaterThan(0);
		});
		expect(global.fetch).toHaveBeenCalledWith(
			"/api/chat/files/chat-image/preview",
		);
		let desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		expect(desktopWorkspace).not.toHaveClass("workspace-shell-expanded");

		await rerender({ presentation: "expanded" });
		desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		expect(desktopWorkspace).toHaveClass("workspace-shell-expanded");
		expect(screen.getAllByAltText("chart.png").length).toBeGreaterThan(0);

		await rerender({
			documents: [knowledgeImage],
			activeDocumentId: "knowledge-image",
			presentation: "expanded",
		});
		await waitFor(() => {
			expect(screen.getAllByAltText("scan.png").length).toBeGreaterThan(0);
		});
		expect(global.fetch).toHaveBeenCalledWith(
			"/api/knowledge/artifact-image/preview",
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	describe("Multi-page document navigation", () => {
		it("renders scrollable page container for multi-page documents", async () => {
			const pdfDocument: DocumentWorkspaceItem & {
				totalPages: number;
				currentPage: number;
			} = {
				id: "doc-pdf",
				source: "knowledge_artifact",
				filename: "report.pdf",
				title: "Annual Report",
				documentFamilyId: "family-report",
				documentLabel: "Annual Report",
				documentRole: "report",
				versionNumber: 1,
				mimeType: "application/pdf",
				artifactId: "artifact-pdf",
				totalPages: 10,
				currentPage: 1,
			};

			renderWorkspace({
				open: true,
				documents: [pdfDocument],
				availableDocuments: [],
				activeDocumentId: "doc-pdf",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});

			expect(
				within(desktopWorkspace).queryByTestId("page-scroll-container"),
			).toBeInTheDocument();

			const prevArrow =
				within(desktopWorkspace).queryByLabelText(/previous page/i);
			const nextArrow = within(desktopWorkspace).queryByLabelText(/next page/i);
			expect(prevArrow).not.toBeInTheDocument();
			expect(nextArrow).not.toBeInTheDocument();
			expect(
				within(desktopWorkspace).queryByTestId("page-input"),
			).not.toBeInTheDocument();
		});
	});

	describe("Resizable panel", () => {
		it("opens generated document previews at a wider PDF-friendly default width", async () => {
			Object.defineProperty(window, "innerWidth", {
				value: 1600,
				configurable: true,
			});

			renderWorkspace({
				open: true,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});

			expect(desktopWorkspace.style.width).toBe("950px");
		});

		it("can be dragged to resize to a new width", async () => {
			renderWorkspace({
				open: true,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});
			const resizeHandle =
				within(desktopWorkspace).getByTestId("resize-handle");

			Object.defineProperty(desktopWorkspace, "offsetWidth", {
				value: 500,
				configurable: true,
			});

			await fireEvent.mouseDown(resizeHandle, { clientX: 500 });
			document.dispatchEvent(
				new MouseEvent("mousemove", { clientX: 400, bubbles: true }),
			);
			await tick();
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			await tick();

			expect(desktopWorkspace.style.width).toMatch(/\d+px/);
		});

		it("resets the docked workspace width when the resize handle is double-clicked", async () => {
			renderWorkspace({
				open: true,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});
			const resizeHandle =
				within(desktopWorkspace).getByTestId("resize-handle");

			Object.defineProperty(desktopWorkspace, "offsetWidth", {
				value: 500,
				configurable: true,
			});

			await fireEvent.mouseDown(resizeHandle, { clientX: 500 });
			document.dispatchEvent(
				new MouseEvent("mousemove", { clientX: 400, bubbles: true }),
			);
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			await tick();
			expect(desktopWorkspace.style.width).not.toBe("950px");

			await fireEvent.dblClick(resizeHandle);
			await tick();

			expect(desktopWorkspace.style.width).toBe("950px");
		});

		it("respects minimum width constraint during resize", async () => {
			renderWorkspace({
				open: true,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});
			const resizeHandle =
				within(desktopWorkspace).getByTestId("resize-handle");

			Object.defineProperty(desktopWorkspace, "offsetWidth", {
				value: 500,
				configurable: true,
			});

			await fireEvent.mouseDown(resizeHandle, { clientX: 500 });
			document.dispatchEvent(
				new MouseEvent("mousemove", { clientX: 1000, bubbles: true }),
			);
			await tick();
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			await tick();

			const width = parseInt(desktopWorkspace.style.width, 10);
			expect(width).toBeGreaterThanOrEqual(620);
		});

		it("respects maximum width constraint during resize", async () => {
			renderWorkspace({
				open: true,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});
			const resizeHandle =
				within(desktopWorkspace).getByTestId("resize-handle");

			Object.defineProperty(desktopWorkspace, "offsetWidth", {
				value: 500,
				configurable: true,
			});

			await fireEvent.mouseDown(resizeHandle, { clientX: 500 });
			document.dispatchEvent(
				new MouseEvent("mousemove", { clientX: 0, bubbles: true }),
			);
			await tick();
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			await tick();

			const width = parseInt(desktopWorkspace.style.width, 10);
			const maxWidth = window.innerWidth * 0.68;
			expect(width).toBeLessThanOrEqual(Math.ceil(maxWidth));
		});
	});

	describe("Fade animation", () => {
		it("has transition class for opacity/transform when opening/closing", async () => {
			const { rerender } = renderWorkspace({
				open: false,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

			await rerender({ open: true });

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});

			const classList = desktopWorkspace.className;
			const hasTransition =
				classList.includes("transition") ||
				classList.includes("fade") ||
				classList.includes("opacity");
			expect(hasTransition).toBe(true);
		});

		it("applies fade-in animation when opening", async () => {
			const { rerender } = renderWorkspace({
				open: false,
				documents: [
					{
						id: "doc-1",
						source: "knowledge_artifact",
						filename: "document.pdf",
						title: "Document",
						mimeType: "application/pdf",
						artifactId: null,
					},
				],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			});

			await rerender({ open: true });

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});

			const style = window.getComputedStyle(desktopWorkspace);
			expect(style.transition).toMatch(/opacity|transform/);
		});
	});

	// Existing tests below...
	it("shows version history for the active document family and switches to an open version", async () => {
		const onSelectDocument = vi.fn();
		const onOpenDocument = vi.fn();

		renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-v2",
					source: "knowledge_artifact",
					filename: "brief-v2.pdf",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentFamilyStatus: "historical",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 2,
					mimeType: "application/pdf",
					artifactId: null,
				},
				{
					id: "doc-v1",
					source: "knowledge_artifact",
					filename: "brief-v1.pdf",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 1,
					mimeType: "application/pdf",
					artifactId: null,
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-v2",
			onSelectDocument,
			onOpenDocument,
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		expect(
			within(desktopWorkspace).getByText("Version History"),
		).toBeInTheDocument();
		expect(
			within(desktopWorkspace).getByTestId("document-version-control"),
		).toBeInTheDocument();
		expect(
			desktopWorkspace.querySelector(".workspace-history-item"),
		).not.toBeInTheDocument();
		const versionBadges = within(desktopWorkspace).getAllByTestId(
			"document-version-badge",
		);
		expect(versionBadges).toHaveLength(2);
		expect(versionBadges[0]).toHaveClass("workspace-version-badge");
		expect(
			within(desktopWorkspace).getAllByText("Brief").length,
		).toBeGreaterThan(0);
		expect(
			within(desktopWorkspace).getAllByText("Historical").length,
		).toBeGreaterThan(0);
		expect(within(desktopWorkspace).getByText("Latest")).toBeInTheDocument();
		expect(
			within(desktopWorkspace).queryByText("Current"),
		).not.toBeInTheDocument();
		expect(
			versionBadges[0].querySelector(".workspace-history-version"),
		).toHaveClass("workspace-history-version-current");

		await fireEvent.click(
			within(desktopWorkspace).getByRole("button", { name: /v1/i }),
		);

		expect(onSelectDocument).toHaveBeenCalledWith("doc-v1");
		expect(onOpenDocument).not.toHaveBeenCalled();
	});

	it("selects a related family version without opening a new workspace document", async () => {
		const onSelectDocument = vi.fn();
		const onOpenDocument = vi.fn();

		renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-v2",
					source: "knowledge_artifact",
					filename: "brief-v2.pdf",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 2,
					mimeType: "application/pdf",
					artifactId: null,
				},
			],
			availableDocuments: [
				{
					id: "doc-v3",
					source: "knowledge_artifact",
					filename: "brief-v3.pdf",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 3,
					mimeType: "application/pdf",
					artifactId: "artifact-v3",
				},
			],
			activeDocumentId: "doc-v2",
			onSelectDocument,
			onOpenDocument,
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		expect(
			within(desktopWorkspace).queryByTestId("open-documents-rail"),
		).not.toBeInTheDocument();
		await fireEvent.click(
			within(desktopWorkspace).getByRole("button", { name: /v3/i }),
		);

		expect(onSelectDocument).toHaveBeenCalledWith("doc-v3");
		expect(onOpenDocument).not.toHaveBeenCalled();
	});

	it("uses the header document title as the source-message affordance for origin metadata", async () => {
		const onJumpToSource = vi.fn();

		renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-v2",
					source: "knowledge_artifact",
					filename: "brief-v2.pdf",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 2,
					originConversationId: "conv-1",
					originAssistantMessageId: "assistant-1",
					mimeType: "application/pdf",
					artifactId: null,
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-v2",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onJumpToSource,
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		expect(
			within(desktopWorkspace).queryByRole("button", {
				name: /compare versions/i,
			}),
		).not.toBeInTheDocument();
		expect(
			within(desktopWorkspace).queryByText(/from assistant message/i),
		).not.toBeInTheDocument();
		expect(
			within(desktopWorkspace).getByText("Knowledge Base"),
		).toBeInTheDocument();
		expect(
			within(
				within(desktopWorkspace).getByTestId("document-provenance"),
			).queryByRole("button"),
		).not.toBeInTheDocument();
		const sourceTitle = desktopWorkspace.querySelector(
			".workspace-title-link",
		) as HTMLElement;
		await fireEvent.click(sourceTitle);

		expect(onJumpToSource).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "doc-v2",
				originConversationId: "conv-1",
				originAssistantMessageId: "assistant-1",
			}),
		);
	});

	it("renders compare mode for text family documents and loads both versions", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			async (input: string | URL | Request) => {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;
				if (url.includes("artifact-v2")) {
					return {
						ok: true,
						text: () => Promise.resolve("Title\nCurrent draft\nShared ending"),
					};
				}
				if (url.includes("artifact-v1")) {
					return {
						ok: true,
						text: () => Promise.resolve("Title\nPrevious draft\nShared ending"),
					};
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

		renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-v2",
					source: "knowledge_artifact",
					filename: "brief-v2.md",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 2,
					mimeType: "text/markdown",
					artifactId: "artifact-v2",
				},
			],
			availableDocuments: [
				{
					id: "doc-v1",
					source: "knowledge_artifact",
					filename: "brief-v1.md",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 1,
					mimeType: "text/markdown",
					artifactId: "artifact-v1",
				},
			],
			activeDocumentId: "doc-v2",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		const desktopWorkspace = screen.getByRole("complementary", {
			name: /document workspace/i,
		});
		await fireEvent.click(
			within(desktopWorkspace).getByRole("button", {
				name: /compare versions/i,
			}),
		);

		await waitFor(() => {
			expect(
				within(desktopWorkspace).getByText("Compare Versions"),
			).toBeInTheDocument();
			expect(
				within(desktopWorkspace).getByText(/1 changed/i),
			).toBeInTheDocument();
			expect(
				within(desktopWorkspace).getAllByText("Current").length,
			).toBeGreaterThan(0);
			expect(
				within(desktopWorkspace).getByText("Compared"),
			).toBeInTheDocument();
		});

		const currentPanel = within(desktopWorkspace)
			.getByText("Current")
			.closest(".workspace-compare-panel") as HTMLElement;
		const comparedPanel = within(desktopWorkspace)
			.getByText("Compared")
			.closest(".workspace-compare-panel") as HTMLElement;
		expect(
			currentPanel.querySelector(".workspace-diff-line-added"),
		).toHaveTextContent("+Current draft");
		expect(
			comparedPanel.querySelector(".workspace-diff-line-removed"),
		).toHaveTextContent("-Previous draft");
		expect(
			currentPanel.querySelector(".workspace-diff-line-unchanged"),
		).toHaveTextContent("Title");

		expect(global.fetch).toHaveBeenCalledWith(
			"/api/knowledge/artifact-v2/preview",
		);
		expect(global.fetch).toHaveBeenCalledWith(
			"/api/knowledge/artifact-v1/preview",
		);
	});

	it("keeps mobile workspace taps inside the workspace and only closes on backdrop taps", async () => {
		const onCloseWorkspace = vi.fn();
		const { container } = renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-1",
					source: "knowledge_artifact",
					filename: "notes.txt",
					title: "Notes",
					mimeType: "text/plain",
					artifactId: null,
				},
			],
			availableDocuments: [],
			activeDocumentId: "doc-1",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace,
		});

		const mobileBackdrop = container.querySelector(
			".workspace-mobile-backdrop",
		);
		const mobileWorkspace = container.querySelector(".workspace-shell-mobile");

		expect(mobileBackdrop).toBeInTheDocument();
		expect(mobileWorkspace).toBeInTheDocument();

		if (!mobileBackdrop || !mobileWorkspace) {
			throw new Error("Expected mobile workspace overlay");
		}

		await fireEvent.click(mobileWorkspace);
		expect(onCloseWorkspace).not.toHaveBeenCalled();

		await fireEvent.click(mobileBackdrop);
		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("renders exactly one panel body per section in the mobile compare view (no duplicated compared content)", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			async (input: string | URL | Request) => {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;
				if (url.includes("artifact-v2")) {
					return {
						ok: true,
						text: () => Promise.resolve("Title\nCurrent draft\nShared ending"),
					};
				}
				if (url.includes("artifact-v1")) {
					return {
						ok: true,
						text: () => Promise.resolve("Title\nPrevious draft\nShared ending"),
					};
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
		);

		renderWorkspace({
			open: true,
			documents: [
				{
					id: "doc-v2",
					source: "knowledge_artifact",
					filename: "brief-v2.md",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 2,
					mimeType: "text/markdown",
					artifactId: "artifact-v2",
				},
			],
			availableDocuments: [
				{
					id: "doc-v1",
					source: "knowledge_artifact",
					filename: "brief-v1.md",
					title: "Client Brief",
					documentFamilyId: "family-brief",
					documentLabel: "Client Brief",
					documentRole: "brief",
					versionNumber: 1,
					mimeType: "text/markdown",
					artifactId: "artifact-v1",
				},
			],
			activeDocumentId: "doc-v2",
			onSelectDocument: vi.fn(),
			onOpenDocument: vi.fn(),
			onCloseDocument: vi.fn(),
			onCloseWorkspace: vi.fn(),
		});

		const mobileWorkspace = document.querySelector(
			".workspace-shell-mobile",
		) as HTMLElement;
		expect(mobileWorkspace).toBeInTheDocument();

		await fireEvent.click(
			within(mobileWorkspace).getByRole("button", {
				name: /compare versions/i,
			}),
		);

		await waitFor(() => {
			expect(
				within(mobileWorkspace).getByText("Compare Versions"),
			).toBeInTheDocument();
		});

		// Direct selector: one body per section (current + compared) = 2, not 3.
		const bodies = mobileWorkspace.querySelectorAll(
			".workspace-compare-panel-body",
		);
		expect(bodies).toHaveLength(2);

		// Each section must contain exactly one body.
		const sections = mobileWorkspace.querySelectorAll(
			".workspace-compare-panel",
		);
		expect(sections).toHaveLength(2);
		sections.forEach((section) => {
			expect(
				section.querySelectorAll(".workspace-compare-panel-body"),
			).toHaveLength(1);
		});

		// The compared content must appear exactly once.
		expect(
			mobileWorkspace.querySelectorAll(".workspace-diff-line-removed"),
		).toHaveLength(1);
	});
});

// Slice 0 Task S5: the panel becomes type-aware. The registry ships empty
// (no real kind body exists yet), so these tests prove the DISPATCH
// mechanism with a fixture loader rather than a real editor.
describe("DocumentWorkspace artifact-kind dispatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
	});

	afterEach(() => {
		delete ARTIFACT_BODIES.document;
	});

	it("renders today's preview stack for an item with no kind, unchanged", async () => {
		const { container } = renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "generated-file-1",
					source: "chat_generated_file",
					filename: "generated.txt",
					title: "Generated notes",
					mimeType: "text/plain",
					previewUrl: "/api/chat/files/generated-file-1/preview",
				}),
			],
			activeDocumentId: "generated-file-1",
		});

		await waitFor(() => {
			expect(
				container.querySelectorAll('[data-testid="page-scroll-container"]'),
			).toHaveLength(1);
		});
		expect(screen.queryByTestId("fake-artifact-body")).not.toBeInTheDocument();
	});

	it("renders the loaded component for a kind with a registered loader, and loads it once across two re-renders", async () => {
		const loader = vi.fn(
			() => import("./__fixtures__/FakeArtifactBody.svelte"),
		);
		ARTIFACT_BODIES.document = loader;

		const { rerender } = renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					kind: "document",
					title: "My Document",
					mimeType: null,
				}),
			],
			activeDocumentId: "doc-1",
		});

		const body = await screen.findByTestId("fake-artifact-body");
		expect(body).toHaveTextContent("My Document");
		expect(loader).toHaveBeenCalledTimes(1);

		await rerender({ activeDocumentId: "doc-1" });
		await tick();

		expect(await screen.findByTestId("fake-artifact-body")).toBeInTheDocument();
		expect(loader).toHaveBeenCalledTimes(1);
	});

	// An artifact made inside an incognito conversation only resolves for its
	// owner when the read names that conversation (fetchArtifact's
	// conversationId widens ownership scope). The panel does not know the
	// conversation on its own, so it must forward its own conversationId prop
	// into the body so a body that calls fetchArtifact can pass it through.
	it("passes the panel's conversationId prop through to the body", async () => {
		const loader = vi.fn(
			() => import("./__fixtures__/FakeArtifactBody.svelte"),
		);
		ARTIFACT_BODIES.document = loader;

		renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					kind: "document",
					title: "My Document",
					mimeType: null,
				}),
			],
			activeDocumentId: "doc-1",
			conversationId: "c-1",
		});

		const body = await screen.findByTestId("fake-artifact-body");
		expect(body).toHaveAttribute("data-conversation-id", "c-1");
	});

	it("passes null to the body when the panel has no conversationId", async () => {
		const loader = vi.fn(
			() => import("./__fixtures__/FakeArtifactBody.svelte"),
		);
		ARTIFACT_BODIES.document = loader;

		renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					kind: "document",
					title: "My Document",
					mimeType: null,
				}),
			],
			activeDocumentId: "doc-1",
		});

		const body = await screen.findByTestId("fake-artifact-body");
		expect(body).toHaveAttribute("data-conversation-id", "null");
	});

	it("renders today's preview stack for a kind with no registered loader", async () => {
		const { container } = renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "app-1",
					kind: "app",
					title: "My App",
					mimeType: null,
				}),
			],
			activeDocumentId: "app-1",
		});

		await waitFor(() => {
			expect(
				container.querySelectorAll('[data-testid="page-scroll-container"]'),
			).toHaveLength(1);
		});
		expect(screen.queryByTestId("fake-artifact-body")).not.toBeInTheDocument();
	});

	it("does not crash when the active id matches nothing", async () => {
		const { container } = renderWorkspace({
			documents: [
				makeWorkspaceDocument({ id: "doc-1", title: "Only Document" }),
			],
			activeDocumentId: "does-not-exist",
		});

		await waitFor(() => {
			expect(
				container.querySelectorAll('[data-testid="page-scroll-container"]'),
			).toHaveLength(1);
		});
	});
});

// Wave 2.5 Step 3 (redesign §5.1/§5.2/§8): ArtifactPanelHeader replaces the
// old "ACTIVE DOCUMENT" eyebrow, source pill, and disabled History
// placeholder for an item that declares an artifact kind; an item with no
// kind (a plain uploaded/library document, or a search-result open) keeps
// today's header exactly as it was.
describe("DocumentWorkspace panel header (Wave 2.5 Step 3)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
	});

	afterEach(() => {
		delete ARTIFACT_BODIES.document;
	});

	function withDocumentLoader() {
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeArtifactBody.svelte");
	}

	it("renders the shared header for an artifact-kind item, not the legacy eyebrow/source pill", async () => {
		withDocumentLoader();
		renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					kind: "document",
					title: "Vienna trip plan",
					versionNumber: 6,
					mimeType: null,
				}),
			],
			activeDocumentId: "doc-1",
		});

		await screen.findByTestId("fake-artifact-body");
		const shell = screen.getAllByRole("complementary", {
			name: "Document workspace",
		})[0];

		expect(
			within(shell).getByRole("heading", { name: "Vienna trip plan" }),
		).toBeInTheDocument();
		// The kind label appears once, plainly, with its version alongside it
		// — never the old duplicated "ACTIVE DOCUMENT" eyebrow or a source
		// pill. The fixture body never calls registerPanelActions, so the
		// version renders as plain text here (no onVersions handler yet) —
		// DocumentBody.test.ts covers the real, button-shaped case.
		expect(within(shell).getByText("Document")).toBeInTheDocument();
		expect(within(shell).getByText("v6")).toBeInTheDocument();
		expect(
			within(shell).queryByText("Active document"),
		).not.toBeInTheDocument();
		expect(
			within(shell).queryByTestId("document-provenance"),
		).not.toBeInTheDocument();
		// The disabled History placeholder is gone outright (redesign §5.2:
		// "no disabled placeholders").
		expect(
			within(shell).queryByRole("button", { name: "History" }),
		).not.toBeInTheDocument();
	});

	// Wave 2.5 polish G1-B (one version number everywhere): the open item now
	// arrives as a NEW object whenever its version number moves. The body
	// registers its panel actions once, when it mounts, so the workspace must
	// reset them only when a DIFFERENT item is open — never because the same
	// item's number changed, which would turn the version button back into
	// plain text for good.
	it("keeps the version button a button when the open item's own version number changes", async () => {
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeVersionedArtifactBody.svelte");
		const doc = (versionNumber: number) =>
			makeWorkspaceDocument({
				id: "doc-1",
				kind: "document",
				title: "Vienna trip plan",
				versionNumber,
				mimeType: null,
			});
		const { rerender } = renderWorkspace({
			documents: [doc(1)],
			activeDocumentId: "doc-1",
		});
		await screen.findByTestId("fake-versioned-artifact-body");
		const shell = screen.getAllByRole("complementary", {
			name: "Document workspace",
		})[0];
		await waitFor(() => {
			expect(
				within(shell).getByRole("button", { name: "Version 1" }),
			).toBeInTheDocument();
		});

		await rerender({ documents: [doc(4)], activeDocumentId: "doc-1" });

		await waitFor(() => {
			expect(
				within(shell).getByTestId("artifact-version-pill"),
			).toHaveTextContent("v4");
		});
		expect(
			within(shell).getByRole("button", { name: "Version 4" }),
		).toBeInTheDocument();
	});

	it("moves focus to the panel title when a document opens (redesign §5.4, Wave 2.5 review F2)", async () => {
		// The review's own finding: opening the panel did not move focus to
		// the title/first row, so a screen-reader user got no announcement of
		// what just appeared. `data-testid="artifact-panel-title"` carries
		// `tabindex="-1"` specifically so it is a valid focus target here.
		withDocumentLoader();
		renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					kind: "document",
					title: "Vienna trip plan",
				}),
			],
			activeDocumentId: "doc-1",
		});

		await screen.findByTestId("fake-artifact-body");
		await waitFor(() => {
			expect(document.activeElement).toHaveAttribute(
				"data-testid",
				"artifact-panel-title",
			);
		});
		expect(document.activeElement).toHaveTextContent("Vienna trip plan");
	});

	// Wave 2.5 review (F2, 294-296): "header meta" — "Document · v3 · just
	// now" was missing the mockup's own authorship ("You and Alfy · edited
	// {when}", index.html's editedWhen string).
	it("shows the mockup's 'You and Alfy · edited …' authorship in the header meta", async () => {
		withDocumentLoader();
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					kind: "document",
					title: "Vienna trip plan",
					updatedAt: fiveMinutesAgo,
				}),
			],
			activeDocumentId: "doc-1",
		});

		await screen.findByTestId("fake-artifact-body");
		const shell = screen.getAllByRole("complementary", {
			name: "Document workspace",
		})[0];
		expect(
			within(shell).getByText("You and Alfy · edited 5 min ago"),
		).toBeInTheDocument();
	});

	it("keeps the legacy header, unchanged, for an item with no kind", async () => {
		renderWorkspace({
			documents: [
				makeWorkspaceDocument({
					id: "doc-1",
					title: "Uploaded receipt.pdf",
				}),
			],
			activeDocumentId: "doc-1",
		});

		const shell = await screen.findByRole("complementary", {
			name: "Document workspace",
		});
		expect(within(shell).getByText("Active document")).toBeInTheDocument();
		expect(
			within(shell).getByTestId("document-provenance"),
		).toBeInTheDocument();
	});

	it("the breadcrumb returns to the list without closing the whole panel", async () => {
		withDocumentLoader();
		const { onListOpenChange, onCloseWorkspace } = renderWorkspace({
			documents: [
				makeWorkspaceDocument({ id: "doc-1", kind: "document", title: "Plan" }),
			],
			activeDocumentId: "doc-1",
		});

		await screen.findByTestId("fake-artifact-body");
		const shell = screen.getAllByRole("complementary", {
			name: "Document workspace",
		})[0];
		await fireEvent.click(
			within(shell).getByRole("button", { name: "This chat" }),
		);

		expect(onListOpenChange).toHaveBeenCalledWith(true);
		expect(onCloseWorkspace).not.toHaveBeenCalled();
	});

	it("closes the workspace from the header's Close action", async () => {
		withDocumentLoader();
		const { onCloseWorkspace } = renderWorkspace({
			documents: [
				makeWorkspaceDocument({ id: "doc-1", kind: "document", title: "Plan" }),
			],
			activeDocumentId: "doc-1",
		});

		await screen.findByTestId("fake-artifact-body");
		const shell = screen.getAllByRole("complementary", {
			name: "Document workspace",
		})[0];
		await fireEvent.click(
			within(shell).getByRole("button", { name: "Close document workspace" }),
		);

		expect(onCloseWorkspace).toHaveBeenCalledOnce();
	});

	// OpenDocumentsRail only ever draws itself with 2+ open tabs, so both
	// cases below open two.
	it("hides the open-documents rail for an artifact-kind item", async () => {
		withDocumentLoader();
		renderWorkspace({
			documents: [
				makeWorkspaceDocument({ id: "doc-1", kind: "document", title: "Plan" }),
				makeWorkspaceDocument({
					id: "doc-1b",
					kind: "document",
					title: "Budget",
				}),
			],
			activeDocumentId: "doc-1",
		});
		await screen.findByTestId("fake-artifact-body");
		expect(screen.queryByTestId("open-documents-rail")).not.toBeInTheDocument();
	});

	it("keeps showing the open-documents rail for a legacy item", async () => {
		renderWorkspace({
			documents: [
				makeWorkspaceDocument({ id: "doc-2", title: "Legacy PDF" }),
				makeWorkspaceDocument({ id: "doc-2b", title: "Legacy PDF 2" }),
			],
			activeDocumentId: "doc-2",
		});
		expect(
			await screen.findByTestId("open-documents-rail"),
		).toBeInTheDocument();
	});
});

// Wave 2.5 Step 4 (redesign §7.2 #1/#3/#4): the panel's own open motion and
// list↔item push, both through `reducedMotionAnimate` — jsdom has no WAAPI,
// so `Element.prototype.animate` is stubbed per test, mirroring
// `motion.test.ts`'s own pattern.
describe("DocumentWorkspace panel motion (Wave 2.5 Step 4)", () => {
	let animateSpy: ReturnType<typeof vi.fn>;

	function stubMatchMedia(matches: boolean) {
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				matches,
				media: query,
				onchange: null,
				addListener: () => undefined,
				removeListener: () => undefined,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
				dispatchEvent: () => false,
			})),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
		stubMatchMedia(false);
		animateSpy = vi.fn(() => ({
			finished: Promise.resolve(),
			cancel: vi.fn(),
		}));
		HTMLElement.prototype.animate =
			animateSpy as unknown as typeof HTMLElement.prototype.animate;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("enters the content from the right, 60ms after the panel's own first open", async () => {
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
		});
		await tick();

		expect(animateSpy).toHaveBeenCalledWith(
			[
				{ opacity: 0, transform: "translateX(32px)" },
				{ opacity: 1, transform: "translateX(0)" },
			],
			expect.objectContaining({ delay: 60 }),
		);
	});

	it("plays no WAAPI animation under reduced motion", async () => {
		stubMatchMedia(true);
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
		});
		await tick();

		expect(animateSpy).not.toHaveBeenCalled();
	});

	// DocumentWorkspace is a controlled component: clicking a row only fires
	// `onSelectDocument`/`onListOpenChange`, so the test plays the parent's
	// own part (as the real chat/knowledge pages do) by re-rendering with the
	// props those callbacks would cause, then checks the entrance the newly
	// mounted item content plays.
	it("pushes the item in from the right, immediately, when a list row is opened", async () => {
		const listItem = makeWorkspaceDocument({
			id: "list-item-1",
			title: "Vienna itinerary",
			kind: "file",
		});
		const { rerender, onSelectDocument, onListOpenChange } = renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
			list: { open: true, items: [listItem] },
		});
		await tick();
		animateSpy.mockClear();

		const list = await screen.findByTestId("artifact-panel-list");
		await fireEvent.click(
			within(list).getByRole("button", { name: /Vienna itinerary/ }),
		);
		expect(onSelectDocument).toHaveBeenCalledWith("list-item-1");
		expect(onListOpenChange).toHaveBeenCalledWith(false);

		await rerender({
			documents: [
				makeWorkspaceDocument({ id: "doc-1", title: "Doc" }),
				listItem,
			],
			activeDocumentId: "list-item-1",
			list: { open: false, items: [listItem] },
		});
		await tick();

		expect(animateSpy).toHaveBeenCalledWith(
			[
				{ opacity: 0, transform: "translateX(32px)" },
				{ opacity: 1, transform: "translateX(0)" },
			],
			expect.objectContaining({ delay: 0 }),
		);
	});

	it("pulls the list in from the left, immediately, from the header's breadcrumb", async () => {
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeArtifactBody.svelte");
		try {
			const doc = makeWorkspaceDocument({
				id: "doc-1",
				kind: "document",
				title: "Plan",
			});
			const { rerender, onListOpenChange } = renderWorkspace({
				documents: [doc],
				activeDocumentId: "doc-1",
				list: { open: false, items: [doc] },
			});
			await screen.findByTestId("fake-artifact-body");
			await tick();
			animateSpy.mockClear();

			const shell = screen.getAllByRole("complementary", {
				name: "Document workspace",
			})[0];
			await fireEvent.click(
				within(shell).getByRole("button", { name: /This chat/ }),
			);
			expect(onListOpenChange).toHaveBeenCalledWith(true);

			await rerender({
				documents: [doc],
				activeDocumentId: "doc-1",
				list: { open: true, items: [doc] },
			});
			await tick();

			expect(animateSpy).toHaveBeenCalledWith(
				[
					{ opacity: 0, transform: "translateX(-32px)" },
					{ opacity: 1, transform: "translateX(0)" },
				],
				expect.objectContaining({ delay: 0 }),
			);
		} finally {
			delete ARTIFACT_BODIES.document;
		}
	});

	it("fades the content out, standard duration, when the panel closes", async () => {
		const { rerender } = renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
		});
		await tick();
		animateSpy.mockClear();

		await rerender({
			open: false,
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
		});
		await tick();

		expect(animateSpy).toHaveBeenCalledWith(
			[{ opacity: 1 }, { opacity: 0 }],
			expect.objectContaining({ easing: MOTION_EASING.in }),
		);
	});
});

describe("DocumentWorkspace 'what this chat made' list", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
	});

	function listItem(
		overrides: Partial<DocumentWorkspaceItem> = {},
	): DocumentWorkspaceItem {
		return makeWorkspaceDocument({
			id: "list-item-1",
			title: "Vienna itinerary",
			kind: "file",
			...overrides,
		});
	}

	it("renders one row per list item, and the given title", async () => {
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
			list: {
				open: true,
				items: [
					listItem({ id: "list-item-1", title: "Vienna itinerary" }),
					listItem({ id: "list-item-2", title: "Budget sheet" }),
				],
				title: "What this chat made",
			},
		});

		// Scoped to the desktop landmark: the mobile and desktop shells both
		// exist in jsdom at once (no media query), so an unscoped query would
		// see the header twice, exactly like every other panel test here.
		const shell = await screen.findByRole("complementary", {
			name: "Document workspace",
		});
		expect(within(shell).getByText("What this chat made")).toBeInTheDocument();

		const list = await screen.findByTestId("artifact-panel-list");
		expect(within(list).getByText("Vienna itinerary")).toBeInTheDocument();
		expect(within(list).getByText("Budget sheet")).toBeInTheDocument();
	});

	// Redesign §5.2 shows a bare relative time on every row's right-hand side
	// ("just now", "12 min ago", …), never the "made by Alfy …" sentence the
	// in-chat card renders — that is what tells a "newest first" list apart
	// without repeating "Alfy" on every single row (§5.1 problem 4).
	it("shows each row's bare relative time", async () => {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
			list: {
				open: true,
				items: [
					listItem({
						id: "list-item-1",
						title: "Vienna itinerary",
						updatedAt: fiveMinutesAgo,
					}),
				],
			},
		});

		const list = await screen.findByTestId("artifact-panel-list");
		expect(within(list).getByText("5 min ago")).toBeInTheDocument();
		expect(within(list).queryByText(/made by Alfy/)).not.toBeInTheDocument();
	});

	it("selects a row's document and closes the list", async () => {
		const { onSelectDocument, onListOpenChange } = renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
			list: {
				open: true,
				items: [listItem({ id: "list-item-1", title: "Vienna itinerary" })],
			},
		});

		const list = await screen.findByTestId("artifact-panel-list");
		// Each row is an ArtifactCard (chrome="row", redesign §5.2): the whole
		// row is the one clickable affordance, named after its title.
		await fireEvent.click(
			within(list).getByRole("button", { name: /Vienna itinerary/ }),
		);

		expect(onSelectDocument).toHaveBeenCalledWith("list-item-1");
		expect(onListOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes the list on Escape before the panel's own Escape behaviour runs", async () => {
		const { onCloseWorkspace, onListOpenChange } = renderWorkspace({
			presentation: "expanded",
			documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
			activeDocumentId: "doc-1",
			list: {
				open: true,
				items: [listItem()],
			},
		});

		await screen.findByTestId("artifact-panel-list");

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(onListOpenChange).toHaveBeenCalledWith(false);
		expect(onCloseWorkspace).not.toHaveBeenCalled();
		// The panel itself is still open, showing the document.
		expect(
			screen.getAllByRole("complementary", {
				name: "Document workspace",
			}).length,
		).toBeGreaterThan(0);
	});

	// T9 steps 4/7, revised by the redesign (§5.1 problem 4/§5.2): a Document
	// row's server preview still feeds the row's subtitle through
	// documentArtifactCardViewFromPreview — the SAME builder/data the in-chat
	// card uses, never a full-body fetch — but the row itself never shows the
	// checklist inline any more; ticking a task is something the OPEN
	// document does, not the list.
	describe("a Document row's preview (T9 steps 4/7, redesign §5.2)", () => {
		it("shows the tab-count subtitle, never the checklist itself", async () => {
			renderWorkspace({
				documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
				activeDocumentId: "doc-1",
				list: {
					open: true,
					items: [
						listItem({
							id: "doc-1",
							title: "Packing list",
							kind: "document",
							documentPreview: {
								tabCount: 3,
								tasks: [
									{ blockId: "b1", text: "Passport", checked: true },
									{ blockId: "b2", text: "Charger", checked: false },
								],
								totalTaskCount: 7,
							},
						}),
					],
				},
			});

			const list = await screen.findByTestId("artifact-panel-list");
			expect(within(list).getByText("Document · 3 tabs")).toBeInTheDocument();
			expect(within(list).queryByText("Passport")).not.toBeInTheDocument();
			expect(within(list).queryByText("Charger")).not.toBeInTheDocument();
			expect(within(list).queryByText("+2 more")).not.toBeInTheDocument();
		});

		it("never exposes a per-task checkbox on the row, even with a preview", async () => {
			const onToggleDocumentTask = vi.fn();
			renderWorkspace({
				documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
				activeDocumentId: "doc-1",
				onToggleDocumentTask,
				list: {
					open: true,
					items: [
						listItem({
							id: "doc-1",
							title: "Packing list",
							kind: "document",
							documentPreview: {
								tabCount: 1,
								tasks: [{ blockId: "b1", text: "Passport", checked: false }],
								totalTaskCount: 1,
							},
						}),
					],
				},
			});

			const list = await screen.findByTestId("artifact-panel-list");
			expect(within(list).queryByRole("checkbox")).not.toBeInTheDocument();
			expect(onToggleDocumentTask).not.toHaveBeenCalled();
		});

		it("falls back to the plain card for a Document row with no preview", async () => {
			renderWorkspace({
				documents: [makeWorkspaceDocument({ id: "doc-1", title: "Doc" })],
				activeDocumentId: "doc-1",
				list: {
					open: true,
					items: [
						listItem({
							id: "doc-1",
							title: "Old cached row",
							kind: "document",
						}),
					],
				},
			});

			const list = await screen.findByTestId("artifact-panel-list");
			expect(within(list).getByText("Old cached row")).toBeInTheDocument();
			expect(within(list).queryByRole("checkbox")).not.toBeInTheDocument();
		});
	});
});

// Polish G2-A: Delete for whatever is open in the panel — from the header, and
// from each list row's overflow. The workspace only asks and reports (the
// page deletes); a finished delete goes back to the list, or closes the panel
// when nothing is left to list.
describe("DocumentWorkspace Delete (polish G2-A)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeArtifactBody.svelte");
	});

	afterEach(() => {
		delete ARTIFACT_BODIES.document;
	});

	const document1 = () =>
		makeWorkspaceDocument({
			id: "artifact:doc-1",
			artifactId: "doc-1",
			kind: "document",
			title: "Vienna trip plan",
			versionNumber: 2,
			mimeType: null,
		});

	async function desktopShell() {
		return (
			await screen.findAllByRole("complementary", {
				name: "Document workspace",
			})
		)[0];
	}

	it("offers Delete in the header of an open item, only when the page can delete", async () => {
		renderWorkspace({
			documents: [document1()],
			activeDocumentId: "artifact:doc-1",
		});
		await screen.findByTestId("fake-artifact-body");
		const shell = await desktopShell();
		expect(
			within(shell).queryByRole("button", { name: "Delete document" }),
		).not.toBeInTheDocument();
	});

	it("asks first, then deletes the open item and goes back to the list", async () => {
		const onDeleteArtifact = vi.fn(async () => {});
		const onListOpenChange = vi.fn();
		const item = document1();
		renderWorkspace({
			documents: [item],
			activeDocumentId: item.id,
			list: {
				open: false,
				items: [
					item,
					makeWorkspaceDocument({
						id: "artifact:doc-2",
						artifactId: "doc-2",
						kind: "document",
						title: "Other",
					}),
				],
			},
			onDeleteArtifact,
			onListOpenChange,
		});
		await screen.findByTestId("fake-artifact-body");
		const shell = await desktopShell();

		await fireEvent.click(
			within(shell).getByRole("button", { name: "Delete document" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Delete this document?",
		});
		expect(onDeleteArtifact).not.toHaveBeenCalled();

		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		await waitFor(() => expect(onDeleteArtifact).toHaveBeenCalledWith(item));
		await waitFor(() => expect(onListOpenChange).toHaveBeenCalledWith(true));
	});

	it("closes the panel instead when the deleted item was the last one", async () => {
		const onDeleteArtifact = vi.fn(async () => {});
		const onListOpenChange = vi.fn();
		const onCloseWorkspace = vi.fn();
		const item = document1();
		renderWorkspace({
			documents: [item],
			activeDocumentId: item.id,
			// The page has already dropped the deleted row by the time the
			// delete resolves: nothing is left to list.
			list: { open: false, items: [] },
			onDeleteArtifact,
			onListOpenChange,
			onCloseWorkspace,
		});
		await screen.findByTestId("fake-artifact-body");
		const shell = await desktopShell();

		await fireEvent.click(
			within(shell).getByRole("button", { name: "Delete document" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Delete this document?",
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		await waitFor(() => expect(onCloseWorkspace).toHaveBeenCalled());
		expect(onListOpenChange).not.toHaveBeenCalledWith(true);
	});

	it("keeps the item when the delete fails, and says so", async () => {
		const onDeleteArtifact = vi.fn(async () => {
			throw new Error("boom");
		});
		const onCloseWorkspace = vi.fn();
		renderWorkspace({
			documents: [document1()],
			activeDocumentId: "artifact:doc-1",
			list: { open: false, items: [document1()] },
			onDeleteArtifact,
			onCloseWorkspace,
		});
		await screen.findByTestId("fake-artifact-body");
		const shell = await desktopShell();

		await fireEvent.click(
			within(shell).getByRole("button", { name: "Delete document" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Delete this document?",
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"Couldn't delete this. Try again.",
		);
		expect(onCloseWorkspace).not.toHaveBeenCalled();
	});

	it("gives each list row an overflow that leads to the same confirm, for that row's item", async () => {
		const onDeleteArtifact = vi.fn(async () => {});
		const rows = [
			makeWorkspaceDocument({
				id: "artifact:doc-1",
				artifactId: "doc-1",
				kind: "document",
				title: "Vienna itinerary",
			}),
			makeWorkspaceDocument({
				id: "artifact:app-1",
				artifactId: "app-1",
				kind: "app",
				title: "Trip budget",
			}),
		];
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-x", title: "Doc" })],
			activeDocumentId: "doc-x",
			list: { open: true, items: rows },
			onDeleteArtifact,
		});
		const list = await screen.findByTestId("artifact-panel-list");

		await fireEvent.click(
			within(list).getByRole("button", {
				name: "More actions for Trip budget",
			}),
		);
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Delete app" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Delete this app?",
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		await waitFor(() => expect(onDeleteArtifact).toHaveBeenCalledWith(rows[1]));
		expect(onDeleteArtifact).toHaveBeenCalledTimes(1);
	});

	it("closes the panel when the row just deleted was the last one, instead of leaving an empty list", async () => {
		const onDeleteArtifact = vi.fn(async () => {});
		const onCloseWorkspace = vi.fn();
		const only = makeWorkspaceDocument({
			id: "artifact:doc-1",
			artifactId: "doc-1",
			kind: "document",
			title: "Vienna itinerary",
		});
		// The page has already dropped the deleted row by the time the delete
		// resolves; the workspace is shown the list as it is then.
		const { rerender } = renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-x", title: "Doc" })],
			activeDocumentId: "doc-x",
			list: { open: true, items: [only] },
			onDeleteArtifact: vi.fn(async (item) => {
				await onDeleteArtifact(item);
				await rerender({
					list: { open: true, items: [] },
				});
			}),
			onCloseWorkspace,
		});
		const list = await screen.findByTestId("artifact-panel-list");
		await fireEvent.click(
			within(list).getByRole("button", {
				name: "More actions for Vienna itinerary",
			}),
		);
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Delete document" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Delete this document?",
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		await waitFor(() => expect(onCloseWorkspace).toHaveBeenCalled());
	});

	// A produced file is deleted through the same route (the family's delete
	// takes it through its own store), so the File kind gets the same controls.
	it("offers a produced file's row the same overflow, in the file's own words", async () => {
		const onDeleteArtifact = vi.fn(async () => {});
		const fileRow = makeWorkspaceDocument({
			id: "chat-file-1",
			artifactId: "file-artifact-1",
			kind: "file",
			title: "Trip summary.pdf",
		});
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-x", title: "Doc" })],
			activeDocumentId: "doc-x",
			list: { open: true, items: [fileRow] },
			onDeleteArtifact,
		});
		const list = await screen.findByTestId("artifact-panel-list");

		await fireEvent.click(
			within(list).getByRole("button", {
				name: "More actions for Trip summary.pdf",
			}),
		);
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Delete file" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Delete this file?",
		});
		await fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete" }),
		);

		await waitFor(() => expect(onDeleteArtifact).toHaveBeenCalledWith(fileRow));
	});

	it("draws no overflow when the page cannot delete", async () => {
		renderWorkspace({
			documents: [makeWorkspaceDocument({ id: "doc-x", title: "Doc" })],
			activeDocumentId: "doc-x",
			list: {
				open: true,
				items: [
					makeWorkspaceDocument({
						id: "artifact:doc-1",
						artifactId: "doc-1",
						kind: "document",
						title: "Vienna itinerary",
					}),
				],
			},
		});
		const list = await screen.findByTestId("artifact-panel-list");
		expect(
			within(list).queryByRole("button", { name: /More actions/ }),
		).not.toBeInTheDocument();
	});
});
