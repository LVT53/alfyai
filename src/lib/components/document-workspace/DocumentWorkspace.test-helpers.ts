import { render } from "@testing-library/svelte";
import { vi } from "vitest";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import DocumentWorkspace from "./DocumentWorkspace.svelte";

type SelectDocumentCallback = (documentId: string) => void;
type OpenDocumentCallback = (document: DocumentWorkspaceItem) => void;
type CloseDocumentCallback = (documentId: string) => void;
type CloseWorkspaceCallback = () => void;
type JumpToSourceCallback = (document: DocumentWorkspaceItem) => void;
type PresentationChangeCallback = (presentation: "docked" | "expanded") => void;

type WorkspaceRenderOptions = {
	open?: boolean;
	presentation?: "docked" | "expanded";
	returnToDockedOnExpandedClose?: boolean;
	documents?: DocumentWorkspaceItem[];
	availableDocuments?: DocumentWorkspaceItem[];
	activeDocumentId?: string | null;
	onSelectDocument?: SelectDocumentCallback;
	onOpenDocument?: OpenDocumentCallback;
	onCloseDocument?: CloseDocumentCallback;
	onCloseWorkspace?: CloseWorkspaceCallback;
	onJumpToSource?: JumpToSourceCallback;
	onPresentationChange?: PresentationChangeCallback;
};

export function makeWorkspaceDocument(
	overrides: Partial<DocumentWorkspaceItem>,
): DocumentWorkspaceItem {
	return {
		id: "doc-1",
		source: "knowledge_artifact",
		filename: "document.pdf",
		title: "Document",
		mimeType: "application/pdf",
		artifactId: null,
		...overrides,
	};
}

export function renderWorkspace(options: WorkspaceRenderOptions = {}) {
	const onSelectDocument =
		options.onSelectDocument ?? vi.fn<SelectDocumentCallback>();
	const onOpenDocument =
		options.onOpenDocument ?? vi.fn<OpenDocumentCallback>();
	const onCloseDocument =
		options.onCloseDocument ?? vi.fn<CloseDocumentCallback>();
	const onCloseWorkspace =
		options.onCloseWorkspace ?? vi.fn<CloseWorkspaceCallback>();
	const onJumpToSource =
		options.onJumpToSource ?? vi.fn<JumpToSourceCallback>();
	const onPresentationChange =
		options.onPresentationChange ?? vi.fn<PresentationChangeCallback>();

	const result = render(DocumentWorkspace, {
		props: {
			open: true,
			documents: [],
			availableDocuments: [],
			activeDocumentId: null,
			...options,
			onSelectDocument,
			onOpenDocument,
			onCloseDocument,
			onCloseWorkspace,
			onJumpToSource,
			onPresentationChange,
		},
	});

	return {
		...result,
		onSelectDocument,
		onOpenDocument,
		onCloseDocument,
		onCloseWorkspace,
		onJumpToSource,
		onPresentationChange,
	};
}
