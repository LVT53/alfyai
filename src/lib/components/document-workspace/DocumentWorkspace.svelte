<script lang="ts">
import { browser } from "$app/environment";
import { determinePreviewFileType } from "$lib/utils/file-preview";
import {
	computeSideBySideDiff,
	summarizeTextComparison,
} from "$lib/utils/text-compare";
import type { DocumentWorkspaceItem } from "$lib/types";
import { t } from "$lib/i18n";
import { fetchDocumentPreviewText } from "$lib/client/api/knowledge";
import OpenDocumentsRail from "./OpenDocumentsRail.svelte";
import MobileDocumentsSheet from "./MobileDocumentsSheet.svelte";
import {
	ArrowUpRight,
	List,
	Download,
	FileText,
	Maximize2,
	X,
	Sparkles,
	ArrowLeftRight,
	Link,
} from "@lucide/svelte";

type DocumentPreviewRendererModule =
	typeof import("$lib/components/document-workspace/DocumentPreviewRenderer.svelte");

type WorkspaceDocument = DocumentWorkspaceItem & {
	currentPage?: number;
	totalPages?: number;
};

let {
	open = false,
	presentation = "docked",
	returnToDockedOnExpandedClose = true,
	showPresentationToggle = true,
	documents = [],
	availableDocuments = [],
	activeDocumentId = null,
	onSelectDocument,
	onOpenDocument = undefined,
	onJumpToSource = undefined,
	onCloseDocument,
	onCloseWorkspace,
	onPresentationChange = undefined,
}: {
	open?: boolean;
	presentation?: "docked" | "expanded";
	returnToDockedOnExpandedClose?: boolean;
	showPresentationToggle?: boolean;
	documents?: DocumentWorkspaceItem[];
	availableDocuments?: DocumentWorkspaceItem[];
	activeDocumentId?: string | null;
	onSelectDocument: (documentId: string) => void;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onJumpToSource?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onCloseDocument: (documentId: string) => void;
	onCloseWorkspace: () => void;
	onPresentationChange?:
		| ((presentation: "docked" | "expanded") => void)
		| undefined;
} = $props();

let activeDocument: WorkspaceDocument | null = $derived.by(() => {
	if (documents.length === 0 && availableDocuments.length === 0) return null;
	return (
		documents.find((document) => document.id === activeDocumentId) ??
		availableDocuments.find((document) => document.id === activeDocumentId) ??
		documents[0] ??
		null
	);
});
let compareMode = $state(false);
let mobileDocumentsSheetOpen = $state(false);
let compareDocumentId: string | null = $state(null);
let compareCurrentTextHtml: string | null = $state(null);
let compareOtherTextHtml: string | null = $state(null);
let compareSummary: ReturnType<typeof summarizeTextComparison> | null =
	$state(null);
let compareLoading = $state(false);
let compareError: string | null = $state(null);
let syncScrollEnabled = $state(false);
let expandedDownloadMenuOpen = $state(false);
let leftPanelBody: HTMLDivElement | null = $state(null);
let rightPanelBody: HTMLDivElement | null = $state(null);
let isSyncingScroll = false;
let documentPreviewRendererModulePromise: Promise<DocumentPreviewRendererModule> | null =
	null;
let desktopShellElement: HTMLElement | null = $state(null);
let mobileShellElement: HTMLElement | null = $state(null);
// Fade animation state
let isVisible = $state(false);
let shouldRender = $state(false);
let closeAnimationTimer: ReturnType<typeof setTimeout> | null = null;
let shouldShowWorkspaceShell = $derived(open && documents.length > 0);
let lastPresentation: "docked" | "expanded" | null = null;

// Page navigation state
let currentPage = $state(1);
let currentTotalPages = $state(1);
let lastDocumentId: string | null = $state(null);

// Resize state
let isResizing = $state(false);
let resizeStartX = $state(0);
let resizeStartWidth = $state(950);
const DEFAULT_WORKSPACE_WIDTH = 950;
const MIN_WIDTH = 620;
const MAX_WIDTH_RATIO = 0.68;
const LEGACY_NARROW_WIDTH_THRESHOLD = 700;
const WORKSPACE_WIDTH_STORAGE_KEY = "document-workspace-width";
// NOTE(ADR 0043 slice 0): intentionally kept separate from the shared
// $lib/utils/viewport.svelte helper. This query selects the *document preview
// renderer surface* (desktop vs mobile rendering of an embedded document), not
// the app-wide viewport tier, and its 768px threshold is a renderer-specific
// concern. Do not consolidate without a separate affordance review.
const DESKTOP_PREVIEW_MEDIA_QUERY = "(min-width: 768px)";

let workspaceWidth = $state(getInitialWorkspaceWidth());
let previewRendererSurface: "desktop" | "mobile" = $state(
	getInitialPreviewRendererSurface(),
);
let shouldRenderMobilePreview = $derived(previewRendererSurface === "mobile");
let shouldRenderDesktopPreview = $derived(previewRendererSurface === "desktop");

// Persist workspace width when it changes
$effect(() => {
	if (!browser) return;
	localStorage.setItem(WORKSPACE_WIDTH_STORAGE_KEY, String(workspaceWidth));
});

$effect(() => {
	if (activeDocument && activeDocument.id !== lastDocumentId) {
		lastDocumentId = activeDocument.id;
		currentPage = activeDocument.currentPage ?? 1;
		currentTotalPages = activeDocument.totalPages ?? 1;
	}
});

$effect(() => {
	if (shouldShowWorkspaceShell) {
		if (closeAnimationTimer) {
			clearTimeout(closeAnimationTimer);
			closeAnimationTimer = null;
		}

		shouldRender = true;
		isVisible = false;
		const frame = requestAnimationFrame(() => {
			isVisible = true;
		});

		return () => cancelAnimationFrame(frame);
	}

	isVisible = false;
	if (shouldRender && !closeAnimationTimer) {
		closeAnimationTimer = setTimeout(() => {
			shouldRender = false;
			closeAnimationTimer = null;
		}, 150);
	}
});

$effect(() => {
	if (!shouldShowWorkspaceShell) {
		lastPresentation = presentation;
		return;
	}

	if (lastPresentation === null) {
		lastPresentation = presentation;
		return;
	}

	if (presentation === lastPresentation) return;
	lastPresentation = presentation;

	isVisible = false;
	const frame = requestAnimationFrame(() => {
		isVisible = true;
	});

	return () => {
		cancelAnimationFrame(frame);
	};
});

let desktopShellTransform = $derived(
	presentation === "expanded"
		? isVisible
			? "translateY(0) scale(1)"
			: "translateY(0.45rem) scale(0.985)"
		: isVisible
			? "translateX(0)"
			: "translateX(-20px)",
);

function startResize(event: MouseEvent) {
	isResizing = true;
	resizeStartX = event.clientX ?? 0;
	const desktopShell = document.querySelector(
		".workspace-shell-desktop",
	) as HTMLElement;
	if (desktopShell) {
		resizeStartWidth = desktopShell.offsetWidth;
	}
}

function handleResizeMove(event: MouseEvent) {
	if (!isResizing) return;

	const clientX = event.clientX ?? 0;
	const deltaX = resizeStartX - clientX;
	workspaceWidth = clampWorkspaceWidth(resizeStartWidth + deltaX);
}

function stopResize() {
	isResizing = false;
}

function resetWorkspaceWidth() {
	workspaceWidth = clampWorkspaceWidth(DEFAULT_WORKSPACE_WIDTH);
}

function clampWorkspaceWidth(nextWidth: number): number {
	const viewportMax = browser
		? window.innerWidth * MAX_WIDTH_RATIO
		: DEFAULT_WORKSPACE_WIDTH;
	return Math.max(
		Math.min(MIN_WIDTH, viewportMax),
		Math.min(nextWidth, viewportMax),
	);
}

function getInitialWorkspaceWidth(): number {
	if (!browser) return DEFAULT_WORKSPACE_WIDTH;
	const storedValue = localStorage.getItem(WORKSPACE_WIDTH_STORAGE_KEY);
	const parsedStoredValue = storedValue ? Number.parseFloat(storedValue) : NaN;
	const shouldUseStoredWidth =
		Number.isFinite(parsedStoredValue) &&
		parsedStoredValue > LEGACY_NARROW_WIDTH_THRESHOLD;
	return clampWorkspaceWidth(
		shouldUseStoredWidth ? parsedStoredValue : DEFAULT_WORKSPACE_WIDTH,
	);
}

function getInitialPreviewRendererSurface(): "desktop" | "mobile" {
	if (!browser || typeof window.matchMedia !== "function") return "desktop";
	return window.matchMedia(DESKTOP_PREVIEW_MEDIA_QUERY).matches
		? "desktop"
		: "mobile";
}

$effect(() => {
	if (!browser || typeof window.matchMedia !== "function") {
		previewRendererSurface = "desktop";
		return;
	}

	const desktopPreviewQuery = window.matchMedia(DESKTOP_PREVIEW_MEDIA_QUERY);
	function syncPreviewRendererSurface() {
		previewRendererSurface = desktopPreviewQuery.matches ? "desktop" : "mobile";
	}

	syncPreviewRendererSurface();
	desktopPreviewQuery.addEventListener("change", syncPreviewRendererSurface);

	return () => {
		desktopPreviewQuery.removeEventListener(
			"change",
			syncPreviewRendererSurface,
		);
	};
});

function handleResizeKeyDown(event: KeyboardEvent) {
	if (!browser) return;
	const step = event.shiftKey ? 40 : 20;
	if (event.key === "ArrowLeft") {
		event.preventDefault();
		workspaceWidth = clampWorkspaceWidth(workspaceWidth + step);
		return;
	}
	if (event.key === "ArrowRight") {
		event.preventDefault();
		workspaceWidth = clampWorkspaceWidth(workspaceWidth - step);
		return;
	}
	if (event.key === "Home") {
		event.preventDefault();
		workspaceWidth = MIN_WIDTH;
		return;
	}
	if (event.key === "End") {
		event.preventDefault();
		workspaceWidth = clampWorkspaceWidth(Number.POSITIVE_INFINITY);
	}
}

$effect(() => {
	if (!browser || !isResizing) return;

	function onMouseMove(event: MouseEvent) {
		handleResizeMove(event);
	}

	function onMouseUp() {
		stopResize();
	}

	document.addEventListener("mousemove", onMouseMove);
	document.addEventListener("mouseup", onMouseUp);

	return () => {
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
	};
});

function formatRoleLabel(role: string | null | undefined): string | null {
	if (!role) return null;
	const normalized = role.trim();
	if (!normalized) return null;
	return normalized
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function getDocumentTitle(document: DocumentWorkspaceItem): string {
	return document.documentLabel ?? document.title ?? document.filename;
}

function getDocumentVersionLabel(
	document: DocumentWorkspaceItem,
): string | null {
	const versionNumber =
		document.versionNumber && document.versionNumber > 0
			? document.versionNumber
			: document.source === "chat_generated_file"
				? 1
				: null;
	return versionNumber ? `v${versionNumber}` : null;
}

function getDocumentSubtitle(document: DocumentWorkspaceItem): string | null {
	const roleLabel = formatRoleLabel(document.documentRole);
	return roleLabel || null;
}

function getDocumentLifecycleLabel(
	document: DocumentWorkspaceItem,
): string | null {
	return document.documentFamilyStatus === "historical"
		? $t("documentWorkspace.historical")
		: null;
}

function isAiGeneratedDocument(document: DocumentWorkspaceItem): boolean {
	return document.source === "chat_generated_file";
}

function getDocumentSourceLabel(document: DocumentWorkspaceItem): string {
	return isAiGeneratedDocument(document)
		? $t("documentWorkspace.aiSource")
		: $t("documentWorkspace.fromKnowledgeBase");
}

let familyDocuments: DocumentWorkspaceItem[] = $state([]);

$effect(() => {
	const activeDoc = activeDocument;
	if (!activeDoc?.documentFamilyId) {
		familyDocuments = [];
		return;
	}

	const currentAvailable = availableDocuments;
	const currentDocuments = documents;

	const mergedById = new Map<string, DocumentWorkspaceItem>();
	for (const document of [...currentAvailable, ...currentDocuments]) {
		if (document.documentFamilyId !== activeDoc.documentFamilyId) continue;
		const existing = mergedById.get(document.id);
		mergedById.set(
			document.id,
			existing ? { ...existing, ...document } : document,
		);
	}

	familyDocuments = Array.from(mergedById.values()).sort((left, right) => {
		const leftVersion = left.versionNumber ?? 0;
		const rightVersion = right.versionNumber ?? 0;
		if (rightVersion !== leftVersion) return rightVersion - leftVersion;
		if (left.id === activeDoc.id) return -1;
		if (right.id === activeDoc.id) return 1;
		return getDocumentTitle(left).localeCompare(getDocumentTitle(right));
	});
});

function isCurrentFamilyDocument(document: DocumentWorkspaceItem): boolean {
	return document.id === activeDocument?.id;
}

function isLatestFamilyDocument(document: DocumentWorkspaceItem): boolean {
	return familyDocuments[0]?.id === document.id;
}

function handleFamilyDocumentOpen(document: DocumentWorkspaceItem) {
	onSelectDocument(document.id);
}

function canJumpToSource(document: DocumentWorkspaceItem): boolean {
	return Boolean(
		document.originConversationId && document.originAssistantMessageId,
	);
}

function isTextDocument(document: DocumentWorkspaceItem): boolean {
	return (
		determinePreviewFileType(document.mimeType, document.filename) === "text"
	);
}

function getDefaultCompareDocumentId(
	documentsInFamily: DocumentWorkspaceItem[],
): string | null {
	if (!(activeDocument && documentsInFamily.length > 1)) return null;
	const currentIndex = documentsInFamily.findIndex(
		(document) => document.id === activeDocument.id,
	);
	if (currentIndex === -1) return documentsInFamily[0]?.id ?? null;
	if (currentIndex === 0) return documentsInFamily[1]?.id ?? null;
	return documentsInFamily[currentIndex - 1]?.id ?? null;
}

let canCompareActiveDocument = $derived(
	Boolean(
		activeDocument &&
			isTextDocument(activeDocument) &&
			familyDocuments.length > 1,
	),
);
let comparedDocument = $derived(
	compareDocumentId
		? (familyDocuments.find((document) => document.id === compareDocumentId) ??
				null)
		: null,
);

$effect(() => {
	if (!canCompareActiveDocument) {
		compareMode = false;
		compareDocumentId = null;
		return;
	}

	const nextCompareId = getDefaultCompareDocumentId(familyDocuments);
	if (
		!compareDocumentId ||
		!familyDocuments.some((document) => document.id === compareDocumentId)
	) {
		compareDocumentId = nextCompareId;
	}
});

function getDocumentPreviewUrl(document: DocumentWorkspaceItem): string | null {
	if (document.previewUrl) return document.previewUrl;
	if (document.artifactId)
		return `/api/knowledge/${document.artifactId}/preview`;
	return null;
}

function getDocumentDownloadUrl(
	document: DocumentWorkspaceItem,
): string | null {
	if (document.downloadUrl) return document.downloadUrl;
	if (document.source === "knowledge_artifact" && document.artifactId) {
		return `/api/knowledge/${document.artifactId}/download`;
	}
	return null;
}

type AtlasOutputDocument = DocumentWorkspaceItem & {
	atlasHtmlChatGeneratedFileId?: string | null;
	atlasPdfChatGeneratedFileId?: string | null;
	atlasMarkdownChatGeneratedFileId?: string | null;
};

type AtlasDownloadOption = {
	key: "html" | "pdf" | "markdown";
	label: string;
	url: string;
};

function isAtlasOutputDocument(
	document: DocumentWorkspaceItem,
): document is AtlasOutputDocument {
	return (
		document.source === "chat_generated_file" &&
		"atlasHtmlChatGeneratedFileId" in document &&
		Boolean(document.atlasHtmlChatGeneratedFileId)
	);
}

function getAtlasDownloadOptions(
	document: AtlasOutputDocument,
): AtlasDownloadOption[] {
	const options: AtlasDownloadOption[] = [];
	const htmlId = document.atlasHtmlChatGeneratedFileId;
	const pdfId = document.atlasPdfChatGeneratedFileId;
	const markdownId = document.atlasMarkdownChatGeneratedFileId;
	if (htmlId) {
		options.push({
			key: "html",
			label: $t("atlas.action.downloadHtml"),
			url: `/api/chat/files/${htmlId}/download`,
		});
	}
	if (pdfId) {
		options.push({
			key: "pdf",
			label: $t("atlas.action.downloadPdf"),
			url: `/api/chat/files/${pdfId}/download`,
		});
	}
	if (markdownId) {
		options.push({
			key: "markdown",
			label: $t("atlas.action.downloadMarkdown"),
			url: `/api/chat/files/${markdownId}/download`,
		});
	}
	return options;
}

function toggleExpandedDownloadMenu() {
	expandedDownloadMenuOpen = !expandedDownloadMenuOpen;
}

function requestExpandedPresentation() {
	onPresentationChange?.("expanded");
}

function requestDockedPresentation() {
	onPresentationChange?.("docked");
}

function handleCloseWorkspace() {
	if (presentation === "expanded" && returnToDockedOnExpandedClose) {
		requestDockedPresentation();
		return;
	}
	onCloseWorkspace();
}

function handleMobileBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) {
		handleCloseWorkspace();
	}
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (
		event.key !== "Escape" ||
		event.defaultPrevented ||
		!shouldShowWorkspaceShell ||
		presentation !== "expanded"
	) {
		return;
	}

	handleCloseWorkspace();
}

function handleDocumentPointerdown(event: PointerEvent) {
	if (
		!shouldShowWorkspaceShell ||
		presentation !== "expanded" ||
		!desktopShellElement
	) {
		return;
	}

	const target = event.target;
	if (target instanceof Node && desktopShellElement.contains(target)) {
		return;
	}
	if (target instanceof Node && mobileShellElement?.contains(target)) {
		return;
	}

	handleCloseWorkspace();
}

async function loadComparePreview(
	document: DocumentWorkspaceItem,
): Promise<string> {
	const previewUrl = getDocumentPreviewUrl(document);
	if (!previewUrl) {
		throw new Error("Preview not available for comparison");
	}

	return fetchDocumentPreviewText(previewUrl);
}

async function ensureDocumentPreviewRendererModule() {
	if (!documentPreviewRendererModulePromise) {
		documentPreviewRendererModulePromise = import(
			"$lib/components/document-workspace/DocumentPreviewRenderer.svelte"
		);
	}

	return documentPreviewRendererModulePromise;
}

$effect(() => {
	if (!browser) return;
	if (shouldShowWorkspaceShell) {
		void ensureDocumentPreviewRendererModule().catch(() => {
			documentPreviewRendererModulePromise = null;
		});
	}
});

function renderHighlightedCompareText(
	currentText: string,
	comparedText: string,
	side: "current" | "compared",
) {
	return renderTextComparisonHtml(currentText, comparedText, side);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderTextComparisonHtml(
	currentText: string,
	comparedText: string,
	side: "current" | "compared",
): string {
	const diff = computeSideBySideDiff(currentText, comparedText);
	const lines = side === "current" ? diff.leftLines : diff.rightLines;
	const renderedLines: string[] = [];

	for (const line of lines) {
		const cssState =
			line.type === "add"
				? "added"
				: line.type === "remove"
					? "removed"
					: "unchanged";
		const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
		renderedLines.push(
			`<span class="workspace-diff-line workspace-diff-line-${cssState}"><span class="workspace-diff-gutter">${sign}</span><span class="workspace-diff-content">${escapeHtml(line.text) || "&nbsp;"}</span></span>`,
		);
	}

	return `<pre class="workspace-diff"><code>${renderedLines.join("\n")}</code></pre>`;
}

$effect(() => {
	if (
		!(
			browser &&
			compareMode &&
			activeDocument &&
			comparedDocument &&
			canCompareActiveDocument
		)
	) {
		compareCurrentTextHtml = null;
		compareOtherTextHtml = null;
		compareSummary = null;
		compareLoading = false;
		compareError = null;
		return;
	}

	let cancelled = false;
	compareLoading = true;
	compareError = null;
	compareCurrentTextHtml = null;
	compareOtherTextHtml = null;
	compareSummary = null;

	void (async () => {
		try {
			const [currentText, otherText] = await Promise.all([
				loadComparePreview(activeDocument),
				loadComparePreview(comparedDocument),
			]);
			const currentHtml = renderHighlightedCompareText(
				currentText,
				otherText,
				"current",
			);
			const otherHtml = renderHighlightedCompareText(
				currentText,
				otherText,
				"compared",
			);

			if (cancelled) return;
			compareCurrentTextHtml = currentHtml;
			compareOtherTextHtml = otherHtml;
			compareSummary = summarizeTextComparison(currentText, otherText);
		} catch (error) {
			if (cancelled) return;
			compareError =
				error instanceof Error
					? error.message
					: "Failed to load comparison preview";
		} finally {
			if (!cancelled) {
				compareLoading = false;
			}
		}
	})();

	return () => {
		cancelled = true;
	};
});

function syncScroll(
	source: HTMLDivElement | null | undefined,
	target: HTMLDivElement | null | undefined,
) {
	if (!syncScrollEnabled || isSyncingScroll || !target) return;
	isSyncingScroll = true;
	target.scrollTop = source?.scrollTop ?? 0;
	requestAnimationFrame(() => {
		isSyncingScroll = false;
	});
}

function toggleSyncScroll() {
	syncScrollEnabled = !syncScrollEnabled;
}

function clickOutside(node: HTMLElement, handler: () => void) {
	function handleMouseDown(event: MouseEvent) {
		if (node && !node.contains(event.target as Node)) {
			handler();
		}
	}

	document.addEventListener("mousedown", handleMouseDown);
	return {
		destroy() {
			document.removeEventListener("mousedown", handleMouseDown);
		},
	};
}
</script>

<svelte:window onkeydown={handleWindowKeydown} />
<svelte:document onpointerdown={handleDocumentPointerdown} />

{#if shouldRender && activeDocument}
	{#snippet atlasDownloadControl(document: DocumentWorkspaceItem)}
		{#if isAtlasOutputDocument(document)}
			{@const options = getAtlasDownloadOptions(document)}
			{#if options.length > 0}
				<div
					class="workspace-download-dropdown"
					use:clickOutside={() => {
						expandedDownloadMenuOpen = false;
					}}
				>
					<button
						type="button"
						class="btn-icon-bare workspace-download-button"
						onclick={toggleExpandedDownloadMenu}
						aria-label={$t('atlas.action.download')}
						title={$t('atlas.action.download')}
						aria-haspopup="menu"
						aria-expanded={expandedDownloadMenuOpen}
					>
						<Download size={18} strokeWidth={2} aria-hidden="true" />
					</button>
					{#if expandedDownloadMenuOpen}
						<div
							class="workspace-download-menu"
							role="menu"
							aria-label={$t('atlas.action.download')}
						>
							{#each options as option}
								<a
									class="workspace-download-option"
									href={option.url}
									role="menuitem"
									target="_blank"
									rel="noopener noreferrer"
									onclick={() => {
										expandedDownloadMenuOpen = false;
									}}
								>
									{#if option.key === 'markdown'}
										<FileText size={14} strokeWidth={2} aria-hidden="true" />
									{:else}
										<Download size={14} strokeWidth={2} aria-hidden="true" />
									{/if}
									<span>{option.label}</span>
								</a>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{:else if getDocumentDownloadUrl(document)}
			<a
				class="btn-icon-bare workspace-download-button"
				href={getDocumentDownloadUrl(document)}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={$t('filePreview.download', { filename: document.filename })}
				title={$t('filePreview.download', { filename: document.filename })}
			>
				<Download size={18} strokeWidth={2} aria-hidden="true" />
			</a>
		{/if}
	{/snippet}

	<!-- Mobile overlay -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="workspace-mobile-backdrop md:hidden"
		role="presentation"
		onclick={handleMobileBackdropClick}
	>
		<section
			bind:this={mobileShellElement}
			class="workspace-shell workspace-shell-mobile"
			aria-label={$t('documentWorkspace.documentWorkspace')}
		>
			<div class="workspace-header">
				<div class="workspace-heading">
					<div class="workspace-eyebrow">{$t('documentWorkspace.workingDocument')}</div>
					<div class="workspace-title-row">
						{#if canJumpToSource(activeDocument)}
							<button
								type="button"
								class="workspace-title workspace-title-link"
								onclick={() => onJumpToSource?.(activeDocument)}
								title={$t('documentWorkspace.viewSourceMessage')}
							>
							<span>{getDocumentTitle(activeDocument)}</span>
							<span class="workspace-title-source-icon">
								<ArrowUpRight size={14} strokeWidth={2.1} aria-hidden="true" />
							</span>
							</button>
						{:else}
							<div class="workspace-title">
								<span>{getDocumentTitle(activeDocument)}</span>
							</div>
						{/if}
						<div class="workspace-header-actions">
							{#if documents.length > 1}
								<button
									type="button"
									class="btn-icon-bare workspace-mobile-documents-button"
									onclick={() => {
										mobileDocumentsSheetOpen = !mobileDocumentsSheetOpen;
									}}
									aria-label={$t('documentWorkspace.openDocuments')}
									aria-expanded={mobileDocumentsSheetOpen}
									title={$t('documentWorkspace.openDocuments')}
									data-testid="mobile-documents-button"
								>
								<List size={18} strokeWidth={2.1} aria-hidden="true" />
									<span aria-hidden="true">{documents.length}</span>
								</button>
							{/if}
							{@render atlasDownloadControl(activeDocument)}
							{#if showPresentationToggle}
								<button
									type="button"
									class="btn-icon-bare workspace-expand-button"
									onclick={requestExpandedPresentation}
									aria-label={$t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
									title={$t('documentWorkspace.expandWorkspace')}
								>
									<Maximize2 size={18} strokeWidth={2} aria-hidden="true" />
								</button>
							{/if}
							<button
								type="button"
								class="btn-icon-bare workspace-close-button"
								onclick={handleCloseWorkspace}
								aria-label={$t('documentWorkspace.closeWorkspace')}
							>
								<X size={18} strokeWidth={2.1} aria-hidden="true" />
							</button>
						</div>
					</div>
					{#if getDocumentSubtitle(activeDocument)}
						<div class="workspace-subtitle">{getDocumentSubtitle(activeDocument)}</div>
					{/if}
					<div class="workspace-meta-row" data-testid="document-provenance">
						<span class="workspace-source-pill" class:workspace-source-pill-ai={isAiGeneratedDocument(activeDocument)}>
						{#if isAiGeneratedDocument(activeDocument)}
							<span class="workspace-source-sparkle">
								<Sparkles size={13} strokeWidth={2.1} aria-hidden="true" />
							</span>
						{/if}
							<span>{getDocumentSourceLabel(activeDocument)}</span>
						</span>
						{#if canCompareActiveDocument}
							<button
								type="button"
								class="workspace-compare-toggle"
								class:workspace-compare-toggle-active={compareMode}
								onclick={() => {
									compareMode = !compareMode;
								}}
								aria-label={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
								title={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
								aria-pressed={compareMode}
							>
								<ArrowLeftRight size={13} strokeWidth={2.1} aria-hidden="true" />
							</button>
						{/if}
						{#if getDocumentLifecycleLabel(activeDocument)}
							<span class="workspace-status-badge">
								{getDocumentLifecycleLabel(activeDocument)}
							</span>
						{/if}
					</div>
				</div>
			</div>

			<MobileDocumentsSheet
				{documents}
				activeDocumentId={activeDocument.id}
				open={mobileDocumentsSheetOpen}
				onOpenChange={(open) => {
					mobileDocumentsSheetOpen = open;
				}}
				{onSelectDocument}
				{onCloseDocument}
			/>

			{#if familyDocuments.length > 1}
				 <div class="workspace-history" data-testid="document-version-control" aria-label={$t('documentWorkspace.versionHistory')}>
					<div class="workspace-history-label">{$t('documentWorkspace.versionHistory')}</div>
					<div class="workspace-history-list">
						{#each familyDocuments as document (document.id)}
							<button
								type="button"
								class="workspace-history-chip workspace-version-badge"
								class:workspace-history-chip-current={isCurrentFamilyDocument(document)}
								data-testid="document-version-badge"
								onclick={() => handleFamilyDocumentOpen(document)}
							>
								<div class="workspace-history-topline">
									<span
										class="workspace-history-version"
										class:workspace-history-version-current={isCurrentFamilyDocument(document)}
									>
										{getDocumentVersionLabel(document) ?? $t('documentWorkspace.version')}
									</span>
									{#if isLatestFamilyDocument(document)}
										<span class="workspace-history-badge">{$t('documentWorkspace.latest')}</span>
									{/if}
								</div>
								<div class="workspace-history-title">{getDocumentTitle(document)}</div>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<div class="workspace-body">
				{#if compareMode && comparedDocument}
					<div class="workspace-compare">
					<div class="workspace-compare-header">
						<div class="workspace-compare-header-left">
							<div>
								<div class="workspace-compare-title">{$t('documentWorkspace.compareVersionsTitle')}</div>
								{#if compareSummary}
									<div class="workspace-compare-summary">
										{$t('documentWorkspace.compareSummary', { changed: compareSummary.changedLines, added: compareSummary.addedLines, removed: compareSummary.removedLines })}
									</div>
								{/if}
							</div>
							<button
								type="button"
								class="btn-icon-bare workspace-sync-scroll-button"
								class:workspace-sync-scroll-active={syncScrollEnabled}
								onclick={toggleSyncScroll}
								aria-label={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
								title={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
								aria-pressed={syncScrollEnabled}
							>
							<Link size={16} strokeWidth={2} aria-hidden="true" />
							</button>
						</div>
						<label class="workspace-compare-select-wrap">
							<span class="workspace-compare-select-label">{$t('documentWorkspace.against')}</span>
							<select
								class="workspace-compare-select"
								bind:value={compareDocumentId}
							>
								{#each familyDocuments.filter((document) => document.id !== activeDocument.id) as document (document.id)}
									<option value={document.id}>
										{getDocumentVersionLabel(document) ?? getDocumentTitle(document)}
									</option>
								{/each}
							</select>
						</label>
					</div>

						{#if compareLoading}
							<div class="workspace-compare-state">{$t('documentWorkspace.loadingComparison')}</div>
						{:else if compareError}
							<div class="workspace-compare-state workspace-compare-state-error">{compareError}</div>
						{:else if compareCurrentTextHtml && compareOtherTextHtml}
							<div class="workspace-compare-grid">
								<section class="workspace-compare-panel">
									<div class="workspace-compare-panel-head">
										<span class="workspace-compare-panel-label">{$t('documentWorkspace.current')}</span>
										<span class="workspace-compare-panel-meta">{getDocumentTitle(activeDocument)} {getDocumentVersionLabel(activeDocument) ?? ''}</span>
									</div>
									<div class="workspace-compare-panel-body" bind:this={leftPanelBody} onscroll={() => syncScroll(leftPanelBody, rightPanelBody)}>
										{@html compareCurrentTextHtml}
									</div>
								</section>
								<section class="workspace-compare-panel">
									<div class="workspace-compare-panel-head">
										<span class="workspace-compare-panel-label">{$t('documentWorkspace.compared')}</span>
										<span class="workspace-compare-panel-meta">{getDocumentTitle(comparedDocument)} {getDocumentVersionLabel(comparedDocument) ?? ''}</span>
									</div>
									<div class="workspace-compare-panel-body" bind:this={rightPanelBody} onscroll={() => syncScroll(rightPanelBody, leftPanelBody)}>
										{@html compareOtherTextHtml}
									</div>
								</section>
							</div>
						{/if}
					</div>
				{:else}
					{#if shouldRenderMobilePreview}
						{#await ensureDocumentPreviewRendererModule() then { default: DocumentPreviewRendererComponent }}
							<DocumentPreviewRendererComponent
								open={true}
								artifactId={activeDocument.artifactId ?? null}
								previewUrl={activeDocument.previewUrl ?? null}
								filename={activeDocument.filename}
								mimeType={activeDocument.mimeType}
								onClose={handleCloseWorkspace}
								bind:currentPage={currentPage}
								bind:totalPages={currentTotalPages}
							/>
						{:catch}
							<div class="workspace-compare-state workspace-compare-state-error">
								Failed to load document preview.
							</div>
						{/await}
					{/if}
				{/if}
			</div>
		</section>
	</div>

	<!-- Desktop / tablet side pane -->
	<aside 
		bind:this={desktopShellElement}
		class="workspace-shell workspace-shell-desktop transition fade"
		class:workspace-fade-in={isVisible}
		class:workspace-resizing={isResizing}
		class:workspace-shell-expanded={presentation === "expanded"}
		style:width={presentation === "docked" && workspaceWidth > 0 ? `${workspaceWidth}px` : undefined}
		style:transition={
			isResizing
				? 'none'
				: presentation === 'expanded'
					? 'opacity 180ms ease-out, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)'
					: 'opacity 150ms ease-out, transform 150ms ease-out'
		}
		style:opacity={isVisible ? '1' : '0'}
		style:transform={desktopShellTransform}
		aria-label={$t('documentWorkspace.documentWorkspace')}
	>
		<div 
			class="workspace-resize-handle" 
			data-testid="resize-handle"
			onmousedown={startResize}
			ondblclick={resetWorkspaceWidth}
			onkeydown={handleResizeKeyDown}
			role="slider"
			aria-label={$t('documentWorkspace.resizePanel')}
			aria-valuemin={MIN_WIDTH}
			aria-valuemax={typeof window !== 'undefined' ? Math.floor(window.innerWidth * MAX_WIDTH_RATIO) : 800}
			aria-valuenow={workspaceWidth}
			tabindex="0"
		></div>
		<div class="workspace-header">
			<div class="workspace-heading">
				<div class="workspace-eyebrow">{$t('documentWorkspace.workingDocument')}</div>
				<div class="workspace-title-row">
					{#if canJumpToSource(activeDocument)}
						<button
							type="button"
							class="workspace-title workspace-title-link"
							onclick={() => onJumpToSource?.(activeDocument)}
							title={$t('documentWorkspace.viewSourceMessage')}
						>
							<span>{getDocumentTitle(activeDocument)}</span>
							<span class="workspace-title-source-icon">
								<ArrowUpRight size={14} strokeWidth={2.1} aria-hidden="true" />
							</span>
						</button>
					{:else}
						<div class="workspace-title">
							<span>{getDocumentTitle(activeDocument)}</span>
						</div>
					{/if}
					<div class="workspace-header-actions">
						{@render atlasDownloadControl(activeDocument)}
						{#if showPresentationToggle && presentation !== "expanded"}
							<button
								type="button"
								class="btn-icon-bare workspace-expand-button"
								onclick={requestExpandedPresentation}
								aria-label={$t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
								title={$t('documentWorkspace.expandWorkspace')}
							>
								<Maximize2 size={18} strokeWidth={2} aria-hidden="true" />
							</button>
						{/if}
						<button
							type="button"
							class="btn-icon-bare workspace-close-button"
							onclick={handleCloseWorkspace}
							aria-label={$t('documentWorkspace.closeWorkspace')}
						>
							<X size={18} strokeWidth={2.1} aria-hidden="true" />
						</button>
					</div>
				</div>
				{#if getDocumentSubtitle(activeDocument)}
					<div class="workspace-subtitle">{getDocumentSubtitle(activeDocument)}</div>
				{/if}
				<div class="workspace-meta-row" data-testid="document-provenance">
					<span class="workspace-source-pill" class:workspace-source-pill-ai={isAiGeneratedDocument(activeDocument)}>
						{#if isAiGeneratedDocument(activeDocument)}
							<span class="workspace-source-sparkle">
								<Sparkles size={13} strokeWidth={2.1} aria-hidden="true" />
							</span>
						{/if}
						<span>{getDocumentSourceLabel(activeDocument)}</span>
					</span>
					{#if canCompareActiveDocument}
						<button
							type="button"
							class="workspace-compare-toggle"
							class:workspace-compare-toggle-active={compareMode}
							onclick={() => {
								compareMode = !compareMode;
							}}
							aria-label={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
							title={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
							aria-pressed={compareMode}
						>
							<ArrowLeftRight size={13} strokeWidth={2.1} aria-hidden="true" />
						</button>
					{/if}
					{#if getDocumentLifecycleLabel(activeDocument)}
						<span class="workspace-status-badge">
							{getDocumentLifecycleLabel(activeDocument)}
						</span>
					{/if}
				</div>
			</div>
		</div>

	<div
		class="workspace-main"
		class:workspace-main-expanded={presentation === "expanded"}
		data-testid="workspace-main"
		data-presentation={presentation}
		data-layout={documents.length > 1 ? "rail-and-preview" : "preview-only"}
	>
		<OpenDocumentsRail
			{documents}
			activeDocumentId={activeDocument.id}
			{onSelectDocument}
			{onJumpToSource}
			{onCloseDocument}
		/>

		<div class="workspace-document-column" data-testid="workspace-document-column">
			{#if familyDocuments.length > 1}
				 <div class="workspace-history" data-testid="document-version-control" aria-label={$t('documentWorkspace.versionHistory')}>
					<div class="workspace-history-label">{$t('documentWorkspace.versionHistory')}</div>
					<div class="workspace-history-list">
						{#each familyDocuments as document (document.id)}
							<button
						type="button"
						class="workspace-history-chip workspace-version-badge"
						class:workspace-history-chip-current={isCurrentFamilyDocument(document)}
						data-testid="document-version-badge"
						onclick={() => handleFamilyDocumentOpen(document)}
					>
								<div class="workspace-history-topline">
									<span
										class="workspace-history-version"
										class:workspace-history-version-current={isCurrentFamilyDocument(document)}
									>
										{getDocumentVersionLabel(document) ?? $t('documentWorkspace.version')}
									</span>
									{#if isLatestFamilyDocument(document)}
										<span class="workspace-history-badge">{$t('documentWorkspace.latest')}</span>
									{/if}
								</div>
								<div class="workspace-history-title">{getDocumentTitle(document)}</div>
							</button>
						{/each}
					</div>
				</div>
			{/if}

	<div class="workspace-body" data-testid="page-scroll-container">
		{#if compareMode && comparedDocument}
			<div class="workspace-compare">
				<div class="workspace-compare-header">
					<div class="workspace-compare-header-left">
						<div>
							<div class="workspace-compare-title">{$t('documentWorkspace.compareVersionsTitle')}</div>
							{#if compareSummary}
								<div class="workspace-compare-summary">
									{$t('documentWorkspace.compareSummary', { changed: compareSummary.changedLines, added: compareSummary.addedLines, removed: compareSummary.removedLines })}
								</div>
							{/if}
						</div>
						<button
							type="button"
							class="btn-icon-bare workspace-sync-scroll-button"
							class:workspace-sync-scroll-active={syncScrollEnabled}
							onclick={toggleSyncScroll}
							aria-label={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
							title={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
							aria-pressed={syncScrollEnabled}
						>
							<Link size={16} strokeWidth={2} aria-hidden="true" />
						</button>
					</div>
					<label class="workspace-compare-select-wrap">
						<span class="workspace-compare-select-label">{$t('documentWorkspace.against')}</span>
						<select class="workspace-compare-select" bind:value={compareDocumentId}>
							{#each familyDocuments.filter((document) => document.id !== activeDocument.id) as document (document.id)}
								<option value={document.id}>
									{getDocumentVersionLabel(document) ?? getDocumentTitle(document)}
								</option>
							{/each}
						</select>
					</label>
				</div>

				{#if compareLoading}
					<div class="workspace-compare-state">{$t('documentWorkspace.loadingComparison')}</div>
				{:else if compareError}
					<div class="workspace-compare-state workspace-compare-state-error">{compareError}</div>
				{:else if compareCurrentTextHtml && compareOtherTextHtml}
					<div class="workspace-compare-grid">
						<section class="workspace-compare-panel">
							<div class="workspace-compare-panel-head">
								<span class="workspace-compare-panel-label">{$t('documentWorkspace.current')}</span>
								<span class="workspace-compare-panel-meta">{getDocumentTitle(activeDocument)} {getDocumentVersionLabel(activeDocument) ?? ''}</span>
							</div>
							<div class="workspace-compare-panel-body" bind:this={leftPanelBody} onscroll={() => syncScroll(leftPanelBody, rightPanelBody)}>
								{@html compareCurrentTextHtml}
							</div>
						</section>
						<section class="workspace-compare-panel">
							<div class="workspace-compare-panel-head">
								<span class="workspace-compare-panel-label">{$t('documentWorkspace.compared')}</span>
								<span class="workspace-compare-panel-meta">{getDocumentTitle(comparedDocument)} {getDocumentVersionLabel(comparedDocument) ?? ''}</span>
							</div>
							<div class="workspace-compare-panel-body" bind:this={rightPanelBody} onscroll={() => syncScroll(rightPanelBody, leftPanelBody)}>
								{@html compareOtherTextHtml}
							</div>
						</section>
					</div>
				{/if}
			</div>
			{:else}
				{#if shouldRenderDesktopPreview}
					{#await ensureDocumentPreviewRendererModule() then { default: DocumentPreviewRendererComponent }}
						<DocumentPreviewRendererComponent
							open={true}
							artifactId={activeDocument.artifactId ?? null}
							previewUrl={activeDocument.previewUrl ?? null}
							filename={activeDocument.filename}
							mimeType={activeDocument.mimeType}
							onClose={handleCloseWorkspace}
							bind:currentPage={currentPage}
							bind:totalPages={currentTotalPages}
						/>
					{:catch}
						<div class="workspace-compare-state workspace-compare-state-error">
							{$t('documentWorkspace.previewLoadFailed')}
						</div>
					{/await}
				{/if}
			{/if}
	</div>
		</div>
	</div>
</aside>
{/if}

<style>
	.workspace-mobile-backdrop {
		position: fixed;
		inset: 0;
		z-index: 95;
		display: flex;
		align-items: stretch;
		justify-content: stretch;
		background: color-mix(in srgb, var(--surface-overlay) 70%, transparent 30%);
		backdrop-filter: blur(10px);
	}

	.workspace-shell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--surface-page);
	}

	.workspace-shell-mobile {
		position: relative;
		z-index: 1;
		height: 100%;
		width: 100%;
	}

	.workspace-shell-desktop {
		display: none;
		transition: opacity var(--duration-standard) ease-out, transform var(--duration-standard) ease-out;
		opacity: 0;
		transform: translateX(-20px);
	}

	.workspace-fade-in {
		opacity: 1;
		transform: translateX(0);
	}

	.workspace-header {
		display: block;
		padding: 0.95rem 1rem;
		border-left: 1px solid var(--border-default);
		border-bottom: 1px solid var(--border-default);
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--surface-elevated) 92%, transparent 8%), var(--surface-page));
	}

	.workspace-shell-mobile .workspace-header {
		border-left: none;
		padding: 0.72rem 0.82rem 0.68rem;
	}

	.workspace-shell-mobile .workspace-eyebrow {
		font-size: 0.64rem;
		letter-spacing: 0.1em;
	}

	.workspace-shell-mobile .workspace-title-row {
		align-items: flex-start;
		gap: 0.55rem;
	}

	.workspace-shell-mobile .workspace-title {
		white-space: normal;
		font-size: 0.94rem;
		line-height: 1.25;
	}

	.workspace-shell-mobile .workspace-title span {
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.workspace-shell-mobile .workspace-subtitle {
		margin-top: 0.24rem;
		font-size: 0.72rem;
	}

	.workspace-shell-mobile .workspace-meta-row {
		gap: 0.28rem;
		margin-top: 0.28rem;
	}

	.workspace-shell-mobile .workspace-source-pill,
	.workspace-shell-mobile .workspace-status-badge,
	.workspace-shell-mobile .workspace-compare-toggle {
		padding: 0.14rem 0.38rem;
		font-size: 0.62rem;
	}

	.workspace-heading {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.workspace-eyebrow {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.workspace-title {
		display: inline-flex;
		align-items: center;
		gap: 0.38rem;
		min-width: 0;
		max-width: 100%;
		margin-top: 0;
		border: none;
		background: transparent;
		padding: 0;
		font-family: 'Libre Baskerville', serif;
		font-size: 1rem;
		line-height: 1.35;
		color: var(--text-primary);
		text-align: left;
		white-space: nowrap;
	}

	.workspace-title span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.workspace-title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		min-width: 0;
		margin-top: 0.22rem;
	}

	.workspace-title-link {
		cursor: pointer;
	}

	.workspace-title-link:hover,
	.workspace-title-link:focus-visible {
		color: var(--text-primary);
	}

	.workspace-title-link:focus-visible {
		border-radius: 0.25rem;
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 70%, transparent 30%);
		outline-offset: 0.18rem;
	}

	.workspace-title-source-icon {
		flex: 0 0 auto;
		color: var(--icon-muted);
		opacity: 0.58;
		transition:
			color 180ms ease,
			opacity 180ms ease,
			transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.workspace-title-link:hover .workspace-title-source-icon,
	.workspace-title-link:focus-visible .workspace-title-source-icon {
		color: var(--text-primary);
		opacity: 1;
		transform: translate(2px, -2px);
	}

	.workspace-subtitle {
		margin-top: 0.3rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--text-secondary);
	}

	.workspace-meta-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.38rem;
		min-width: 0;
	}

	.workspace-source-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-elevated) 66%, var(--surface-page) 34%);
		padding: 0.18rem 0.46rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 650;
		line-height: 1.25;
		color: var(--text-muted);
	}

	.workspace-source-pill-ai {
		border-color: color-mix(in srgb, var(--border-default) 72%, var(--text-primary) 28%);
		background: color-mix(in srgb, var(--surface-page) 76%, var(--surface-elevated) 24%);
		color: var(--text-secondary);
	}

	.workspace-source-sparkle {
		flex: 0 0 auto;
		color: var(--text-primary);
	}

	.workspace-compare-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.68rem;
		height: 1.68rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-elevated) 66%, var(--surface-page) 34%);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color var(--duration-fast) ease,
			background-color var(--duration-fast) ease,
			color var(--duration-fast) ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
			box-shadow var(--duration-fast) ease;
	}

	.workspace-compare-toggle:hover,
	.workspace-compare-toggle:focus-visible,
	.workspace-compare-toggle-active {
		border-color: color-mix(in srgb, var(--accent) 52%, var(--border-default) 48%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--text-primary);
	}

	.workspace-compare-toggle:hover {
		transform: translateY(-1px);
		box-shadow: 0 7px 16px color-mix(in srgb, var(--shadow-color, #000) 9%, transparent 91%);
	}

	.workspace-compare-toggle:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 70%, transparent 30%);
		outline-offset: 0.16rem;
	}

	.workspace-status-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.18rem 0.46rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, var(--accent) 24%);
		background: color-mix(in srgb, var(--surface-elevated) 70%, var(--accent) 30%);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.workspace-close-button {
		flex-shrink: 0;
	}

	.workspace-header-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.workspace-mobile-documents-button {
		gap: 0.16rem;
		min-width: 2.45rem;
		color: var(--icon-muted);
		transition:
			background-color 160ms ease,
			color 160ms ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.workspace-mobile-documents-button:hover,
	.workspace-mobile-documents-button[aria-expanded="true"] {
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
		color: var(--text-primary);
	}

	.workspace-mobile-documents-button:hover {
		transform: translateY(-1px);
	}

	.workspace-mobile-documents-button span {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1;
	}

	.workspace-expand-button {
		color: var(--icon-muted);
	}

	.workspace-expand-button:hover {
		color: var(--text-primary);
	}

	.workspace-body {
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.workspace-main {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		border-left: 1px solid var(--border-default);
	}

	.workspace-main-expanded {
		background: color-mix(in srgb, var(--surface-page) 94%, var(--surface-elevated) 6%);
	}

	.workspace-document-column {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		flex-direction: column;
	}

	.workspace-main-expanded .workspace-document-column {
		flex: 1 1 min(76rem, 100%);
	}

	.workspace-compare {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		flex-direction: column;
		background: var(--surface-page);
	}

	.workspace-compare-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.9rem;
		padding: 0.95rem 1rem 0.8rem;
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-elevated) 72%, var(--surface-page) 28%);
	}

	.workspace-compare-header-left {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.workspace-compare-title {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.workspace-compare-summary {
		margin-top: 0.2rem;
		font-size: 0.76rem;
		color: var(--text-secondary);
	}

	.workspace-compare-select-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
	}

	.workspace-compare-select-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.workspace-compare-select {
		min-width: 9rem;
		padding: 0.45rem 0.72rem;
		border: 1px solid var(--border-default);
		border-radius: 0.75rem;
		background: var(--surface-page);
		font-size: 0.8rem;
		color: var(--text-primary);
	}

	.workspace-compare-state {
		padding: 1rem;
		font-size: 0.86rem;
		color: var(--text-secondary);
	}

	.workspace-compare-state-error {
		color: var(--danger);
	}

	.workspace-sync-scroll-button {
		color: var(--text-muted);
		transition: color 150ms var(--ease-out);
	}

	.workspace-sync-scroll-button:hover {
		color: var(--text-secondary);
	}

	.workspace-sync-scroll-button.workspace-sync-scroll-active {
		color: var(--accent);
	}

	.workspace-compare-grid {
		display: grid;
		flex: 1 1 auto;
		min-height: 0;
		grid-template-columns: 1fr;
	}

	.workspace-compare-panel {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border-bottom: 1px solid var(--border-default);
	}

	.workspace-compare-panel:last-child {
		border-bottom: none;
	}

	.workspace-compare-panel-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--surface-page) 90%, transparent 10%);
	}

	.workspace-compare-panel-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.workspace-compare-panel-meta {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.workspace-compare-panel-body {
		min-height: 0;
		flex: 1 1 auto;
		overflow: auto;
		padding: 1rem;
	}

	.workspace-compare-panel-body :global(pre) {
		margin: 0;
	}

	.workspace-compare-panel-body :global(.workspace-diff) {
		width: max-content;
		min-width: 100%;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
		font-size: 0.78rem;
		line-height: 1.55;
	}

	.workspace-compare-panel-body :global(.workspace-diff code) {
		display: block;
		width: max-content;
		min-width: 100%;
	}

	.workspace-compare-panel-body :global(.workspace-diff-line) {
		display: grid;
		grid-template-columns: 2.15rem minmax(max-content, 1fr);
		width: max-content;
		min-width: 100%;
		border-left: 3px solid transparent;
	}

	.workspace-compare-panel-body :global(.workspace-diff-line-added) {
		border-left-color: color-mix(in srgb, var(--success, #248a3d) 70%, var(--border-default) 30%);
		background: color-mix(in srgb, var(--success, #248a3d) 14%, transparent 86%);
	}

	.workspace-compare-panel-body :global(.workspace-diff-line-removed) {
		border-left-color: color-mix(in srgb, var(--danger) 70%, var(--border-default) 30%);
		background: color-mix(in srgb, var(--danger) 12%, transparent 88%);
	}

	.workspace-compare-panel-body :global(.workspace-diff-gutter) {
		position: sticky;
		left: 0;
		z-index: 1;
		display: inline-flex;
		align-items: flex-start;
		justify-content: center;
		background: inherit;
		color: var(--text-muted);
		font-weight: 700;
		user-select: none;
	}

	.workspace-compare-panel-body :global(.workspace-diff-content) {
		display: inline-block;
		min-width: 0;
		padding-right: 1rem;
		white-space: pre;
	}

	.workspace-history {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.42rem;
		padding: 0.58rem 0.75rem 0.64rem;
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-page) 94%, transparent 6%);
	}

	.workspace-history-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.workspace-history-list {
		display: flex;
		min-width: 0;
		gap: 0.35rem;
		overflow-x: auto;
		padding: 0.18rem 0.1rem 0.42rem;
	}

	.workspace-history-chip {
		display: inline-flex;
		flex-direction: column;
		align-items: stretch;
		min-width: 8.5rem;
		max-width: 13.5rem;
		gap: 0.28rem;
		padding: 0.36rem 0.48rem;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--surface-elevated);
		text-align: left;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			border-color var(--duration-fast) ease,
			background-color var(--duration-fast) ease,
			color var(--duration-fast) ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
			box-shadow var(--duration-fast) ease;
	}

	.workspace-history-chip:hover {
		border-color: var(--border-strong);
		background: color-mix(in srgb, var(--surface-elevated) 86%, var(--surface-page) 14%);
		color: var(--text-primary);
		transform: translateY(-1px);
		box-shadow: 0 8px 18px color-mix(in srgb, var(--shadow-color, #000) 10%, transparent 90%);
	}

	.workspace-version-badge {
		flex: 0 0 auto;
	}

	.workspace-history-chip-current {
		border-color: color-mix(in srgb, var(--text-primary) 18%, var(--border-default) 82%);
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
		color: var(--text-primary);
	}

	.workspace-history-topline {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	.workspace-history-version,
	.workspace-history-badge {
		display: inline-flex;
		align-items: center;
		border-radius: 0.35rem;
		padding: 0.1rem 0.34rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.62rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.workspace-history-version {
		border: 1px solid var(--border-default);
		color: var(--text-secondary);
		background: var(--surface-page);
	}

	.workspace-history-version-current {
		border-color: color-mix(in srgb, var(--accent) 68%, var(--border-default) 32%);
		background: color-mix(in srgb, var(--accent) 16%, var(--surface-page) 84%);
		color: var(--text-primary);
	}

	.workspace-history-badge {
		color: var(--text-muted);
		background: color-mix(in srgb, var(--surface-page) 85%, transparent 15%);
	}

	.workspace-history-title {
		min-width: 0;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.76rem;
		line-height: 1.2;
		color: inherit;
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}

	@media (min-width: 768px) {
		.workspace-shell-desktop {
			display: flex;
			width: min(68vw, 59.375rem);
			max-width: 68%;
			min-width: min(38.75rem, 68vw);
			flex: 0 0 auto;
			border-left: 1px solid var(--border-subtle);
			background: var(--surface-page);
			transition: opacity var(--duration-standard) ease-out, transform var(--duration-standard) ease-out;
			transform-origin: center;
			opacity: 0;
			transform: translateX(-20px);
		}

		.workspace-shell-expanded {
			position: fixed;
			top: 1.25rem;
			right: max(1.25rem, calc((100vw - 1600px) / 2));
			bottom: 1.25rem;
			left: max(1.25rem, calc((100vw - 1600px) / 2));
			z-index: 115;
			width: auto;
			max-width: none;
			min-width: 0;
			border: 1px solid var(--border-default);
			border-radius: 0.8rem;
			box-shadow: var(--shadow-lg);
		}

		.workspace-shell-expanded .workspace-resize-handle {
			display: none;
		}

		.workspace-fade-in {
			opacity: 1;
			transform: translateX(0);
		}

		.workspace-resizing {
			transition: none;
		}

		.workspace-resize-handle {
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			cursor: col-resize;
			background: transparent;
			z-index: 10;
		}

		.workspace-resize-handle:hover {
			background: var(--accent);
		}

		.workspace-compare-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}

		.workspace-compare-panel {
			border-bottom: none;
		}

		.workspace-compare-panel + .workspace-compare-panel {
			border-left: 1px solid var(--border-default);
		}

		.workspace-mobile-backdrop {
			display: none;
		}
	}

	.workspace-shell-mobile .workspace-expand-button {
		display: none;
	}

	.workspace-download-dropdown {
		position: relative;
		display: inline-flex;
	}

	.workspace-download-menu {
		position: absolute;
		top: calc(100% + 0.35rem);
		right: 0;
		z-index: 5;
		display: grid;
		min-width: 11rem;
		gap: 0.15rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 84%, transparent);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		padding: 0.3rem;
		box-shadow: var(--shadow-md, 0 0.8rem 2rem rgb(0 0 0 / 16%));
	}

	.workspace-download-option {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		border-radius: calc(var(--radius-sm) - 2px);
		padding: 0.48rem 0.55rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
		text-decoration: none;
		transition:
			transform 140ms ease,
			background-color 140ms ease;
	}

	.workspace-download-option:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		transform: translateX(1px);
	}

	.workspace-download-option:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent);
	}
</style>
