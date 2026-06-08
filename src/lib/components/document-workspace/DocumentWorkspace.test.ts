import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocumentWorkspace from "./DocumentWorkspace.svelte";

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
		const { container } = render(DocumentWorkspace, {
			props: {
				open: true,
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
				availableDocuments: [],
				activeDocumentId: "generated-file-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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

		render(DocumentWorkspace, {
			props: {
				open: true,
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
				availableDocuments: [],
				activeDocumentId: "generated-file-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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

		const { rerender } = render(DocumentWorkspace, {
			props: {
				open: true,
				documents: [sourceLessDocument],
				availableDocuments: [],
				activeDocumentId: "source-less-document",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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

		render(DocumentWorkspace, {
			props: {
				open: true,
				presentation: "docked",
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
				onPresentationChange,
			},
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

		const { rerender } = render(DocumentWorkspace, {
			props: {
				open: true,
				documents: [documents[0]],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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

		render(DocumentWorkspace, {
			props: {
				open: true,
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
				availableDocuments: [],
				activeDocumentId: "generated-doc",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onJumpToSource,
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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
		render(DocumentWorkspace, {
			props: {
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
			},
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

		const { rerender } = render(DocumentWorkspace, {
			props: {
				open: true,
				documents,
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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
		render(DocumentWorkspace, {
			props: {
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
			},
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

		render(DocumentWorkspace, {
			props: {
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
			},
		});

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("closes an expanded workspace when pressing outside the desktop shell", async () => {
		const onCloseWorkspace = vi.fn();

		render(DocumentWorkspace, {
			props: {
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
			},
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

		render(DocumentWorkspace, {
			props: {
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
			},
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

		render(DocumentWorkspace, {
			props: {
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
			},
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

		const { rerender } = render(DocumentWorkspace, {
			props: {
				open: true,
				presentation: "expanded",
				documents,
				availableDocuments: [],
				activeDocumentId: "knowledge-docx",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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

		const { rerender } = render(DocumentWorkspace, {
			props: {
				open: true,
				presentation: "docked",
				documents: [chatImage],
				availableDocuments: [],
				activeDocumentId: "chat-image",
				onSelectDocument: vi.fn(),
				onOpenDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
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
			render(DocumentWorkspace, {
				props: {
					open: true,
					documents: [
						{
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
						},
					],
					availableDocuments: [],
					activeDocumentId: "doc-pdf",
					onSelectDocument: vi.fn(),
					onOpenDocument: vi.fn(),
					onCloseDocument: vi.fn(),
					onCloseWorkspace: vi.fn(),
				},
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

			render(DocumentWorkspace, {
				props: {
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
				},
			});

			const desktopWorkspace = screen.getByRole("complementary", {
				name: /document workspace/i,
			});

			expect(desktopWorkspace.style.width).toBe("950px");
		});

		it("can be dragged to resize to a new width", async () => {
			render(DocumentWorkspace, {
				props: {
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
				},
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
			render(DocumentWorkspace, {
				props: {
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
				},
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
			render(DocumentWorkspace, {
				props: {
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
				},
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
			render(DocumentWorkspace, {
				props: {
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
				},
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
			const { rerender } = render(DocumentWorkspace, {
				props: {
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
				},
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
			const { rerender } = render(DocumentWorkspace, {
				props: {
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
				},
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

		render(DocumentWorkspace, {
			props: {
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
			},
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

		render(DocumentWorkspace, {
			props: {
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
			},
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

		render(DocumentWorkspace, {
			props: {
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
			},
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

		render(DocumentWorkspace, {
			props: {
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
			},
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
		const { container } = render(DocumentWorkspace, {
			props: {
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
			},
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
});
