<script lang="ts">
import { browser } from "$app/environment";
import {
	determinePreviewFileType,
	getPreviewLanguage,
} from "$lib/utils/file-preview";
import { summarizeTextComparison } from "$lib/utils/text-compare";
import { renderHighlightedText } from "$lib/utils/markdown-loader";
import type { DocumentWorkspaceItem } from "$lib/types";
import { t } from "$lib/i18n";
import OpenDocumentsRail from "./OpenDocumentsRail.svelte";
import MobileDocumentsSheet from "./MobileDocumentsSheet.svelte";

type DocumentPreviewRendererModule =
	typeof import("$lib/components/document-workspace/DocumentPreviewRenderer.svelte");

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

let activeDocument = $derived.by(() => {
	if (documents.length === 0) return null;
	return (
		documents.find((document) => document.id === activeDocumentId) ??
		documents[0] ??
		null
	);
});
let compareMode = $state(false);
let mobileDocumentsSheetOpen = $state(false);
let compareDocumentId = $state<string | null>(null);
let compareCurrentTextHtml = $state<string | null>(null);
let compareOtherTextHtml = $state<string | null>(null);
let compareSummary = $state<ReturnType<typeof summarizeTextComparison> | null>(
	null,
);
let compareLoading = $state(false);
let compareError = $state<string | null>(null);
let documentPreviewRendererModulePromise: Promise<DocumentPreviewRendererModule> | null =
	null;
let desktopShellElement = $state<HTMLElement | null>(null);
let mobileShellElement = $state<HTMLElement | null>(null);
// Fade animation state
let isVisible = $state(false);
let shouldRender = $state(false);
let closeAnimationTimer: ReturnType<typeof setTimeout> | null = null;
let shouldShowWorkspaceShell = $derived(open && documents.length > 0);

// Page navigation state
let currentPage = $state(1);
let currentTotalPages = $state(1);
let lastDocumentId = $state<string | null>(null);

// Resize state
let isResizing = $state(false);
let resizeStartX = $state(0);
let resizeStartWidth = $state(950);
const DEFAULT_WORKSPACE_WIDTH = 950;
const MIN_WIDTH = 620;
const MAX_WIDTH_RATIO = 0.68;
const LEGACY_NARROW_WIDTH_THRESHOLD = 700;
const WORKSPACE_WIDTH_STORAGE_KEY = "document-workspace-width";

let workspaceWidth = $state(getInitialWorkspaceWidth());

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

let familyDocuments = $derived.by(() => {
	if (!activeDocument?.documentFamilyId) return [];

	const mergedById = new Map<string, DocumentWorkspaceItem>();
	for (const document of [...availableDocuments, ...documents]) {
		if (document.documentFamilyId !== activeDocument.documentFamilyId) continue;
		const existing = mergedById.get(document.id);
		mergedById.set(
			document.id,
			existing ? { ...existing, ...document } : document,
		);
	}

	return Array.from(mergedById.values()).sort((left, right) => {
		const leftVersion = left.versionNumber ?? 0;
		const rightVersion = right.versionNumber ?? 0;
		if (rightVersion !== leftVersion) return rightVersion - leftVersion;
		if (left.id === activeDocument.id) return -1;
		if (right.id === activeDocument.id) return 1;
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
	if (documents.some((entry) => entry.id === document.id)) {
		onSelectDocument(document.id);
		return;
	}
	onOpenDocument?.(document);
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

	const response = await fetch(previewUrl);
	if (!response.ok) {
		throw new Error("Failed to load comparison preview");
	}

	const text = await response.text();
	return text;
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

async function renderHighlightedCompareText(
	document: DocumentWorkspaceItem,
	text: string,
) {
	return renderHighlightedText(
		text,
		getPreviewLanguage(document.mimeType, document.filename),
		browser
			? (globalThis.document?.documentElement?.classList.contains("dark") ??
					false)
			: false,
	);
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
			const [currentHtml, otherHtml] = await Promise.all([
				renderHighlightedCompareText(activeDocument, currentText),
				renderHighlightedCompareText(comparedDocument, otherText),
			]);

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
</script>

<svelte:window onkeydown={handleWindowKeydown} />
<svelte:document onpointerdown={handleDocumentPointerdown} />

{#if shouldRender && activeDocument}
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
								<svg class="workspace-title-source-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M7 17 17 7" />
									<path d="M7 7h10v10" />
								</svg>
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
									<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M8 6h13" />
										<path d="M8 12h13" />
										<path d="M8 18h13" />
										<path d="M3 6h.01" />
										<path d="M3 12h.01" />
										<path d="M3 18h.01" />
									</svg>
									<span aria-hidden="true">{documents.length}</span>
								</button>
							{/if}
							{#if getDocumentDownloadUrl(activeDocument)}
								<a
									class="btn-icon-bare workspace-download-button"
									href={getDocumentDownloadUrl(activeDocument)}
									target="_blank"
									rel="noopener noreferrer"
									aria-label={$t('filePreview.download', { filename: activeDocument.filename })}
									title={$t('filePreview.download', { filename: activeDocument.filename })}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
										<polyline points="7 10 12 15 17 10" />
										<line x1="12" x2="12" y1="15" y2="3" />
									</svg>
								</a>
							{/if}
							{#if showPresentationToggle}
								<button
									type="button"
									class="btn-icon-bare workspace-expand-button"
									onclick={requestExpandedPresentation}
									aria-label={$t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
									title={$t('documentWorkspace.expandWorkspace')}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<polyline points="15 3 21 3 21 9" />
										<polyline points="9 21 3 21 3 15" />
										<line x1="21" y1="3" x2="14" y2="10" />
										<line x1="3" y1="21" x2="10" y2="14" />
									</svg>
								</button>
							{/if}
							<button
								type="button"
								class="btn-icon-bare workspace-close-button"
								onclick={handleCloseWorkspace}
								aria-label={$t('documentWorkspace.closeWorkspace')}
							>
								<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
									<line x1="18" x2="6" y1="6" y2="18" />
									<line x1="6" x2="18" y1="6" y2="18" />
								</svg>
							</button>
						</div>
					</div>
					{#if getDocumentSubtitle(activeDocument)}
						<div class="workspace-subtitle">{getDocumentSubtitle(activeDocument)}</div>
					{/if}
					<div class="workspace-meta-row" data-testid="document-provenance">
						<span class="workspace-source-pill" class:workspace-source-pill-ai={isAiGeneratedDocument(activeDocument)}>
							{#if isAiGeneratedDocument(activeDocument)}
								<svg class="workspace-source-sparkle" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M9.94 14.6 8.5 18l-1.44-3.4L3.7 13.1l3.36-1.5L8.5 8.2l1.44 3.4 3.36 1.5-3.36 1.5Z" />
									<path d="M17.5 8.7 16.7 11l-.8-2.3-2.3-.8 2.3-.8.8-2.3.8 2.3 2.3.8-2.3.8Z" />
								</svg>
							{/if}
							<span>{getDocumentSourceLabel(activeDocument)}</span>
						</span>
						{#if getDocumentLifecycleLabel(activeDocument)}
							<span class="workspace-status-badge">
								{getDocumentLifecycleLabel(activeDocument)}
							</span>
						{/if}
					</div>
				</div>
			</div>

			{#if canCompareActiveDocument}
				<div class="workspace-actions">
					<button
						type="button"
						class="workspace-source-button"
						onclick={() => {
							compareMode = !compareMode;
						}}
					>
						{compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
					</button>
				</div>
			{/if}

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
									<span class="workspace-history-version">
										{getDocumentVersionLabel(document) ?? 'Version'}
									</span>
									{#if isLatestFamilyDocument(document)}
										<span class="workspace-history-badge">Latest</span>
									{/if}
									{#if isCurrentFamilyDocument(document)}
										<span class="workspace-history-badge workspace-history-badge-current">Current</span>
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
							<div>
								<div class="workspace-compare-title">Compare Versions</div>
								{#if compareSummary}
									<div class="workspace-compare-summary">
										{compareSummary.changedLines} changed • {compareSummary.addedLines} added • {compareSummary.removedLines} removed
									</div>
								{/if}
							</div>
							<label class="workspace-compare-select-wrap">
								<span class="workspace-compare-select-label">Against</span>
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
									<div class="workspace-compare-panel-body">
										{@html compareCurrentTextHtml}
									</div>
								</section>
								<section class="workspace-compare-panel">
									<div class="workspace-compare-panel-head">
										<span class="workspace-compare-panel-label">{$t('documentWorkspace.compared')}</span>
										<span class="workspace-compare-panel-meta">{getDocumentTitle(comparedDocument)} {getDocumentVersionLabel(comparedDocument) ?? ''}</span>
									</div>
									<div class="workspace-compare-panel-body">
										{@html compareOtherTextHtml}
									</div>
								</section>
							</div>
						{/if}
					</div>
				{:else}
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
			isResizing ? 'none' : 'opacity 150ms ease-out, transform 150ms ease-out'
		}
		style:opacity={isVisible ? '1' : '0'}
		style:transform={isVisible ? 'translateX(0)' : 'translateX(-20px)'}
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
							<svg class="workspace-title-source-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M7 17 17 7" />
								<path d="M7 7h10v10" />
							</svg>
						</button>
					{:else}
						<div class="workspace-title">
							<span>{getDocumentTitle(activeDocument)}</span>
						</div>
					{/if}
					<div class="workspace-header-actions">
						{#if getDocumentDownloadUrl(activeDocument)}
							<a
								class="btn-icon-bare workspace-download-button"
								href={getDocumentDownloadUrl(activeDocument)}
								target="_blank"
								rel="noopener noreferrer"
								aria-label={$t('filePreview.download', { filename: activeDocument.filename })}
								title={$t('filePreview.download', { filename: activeDocument.filename })}
							>
								<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
									<polyline points="7 10 12 15 17 10" />
									<line x1="12" x2="12" y1="15" y2="3" />
								</svg>
							</a>
						{/if}
						{#if showPresentationToggle}
							<button
								type="button"
								class="btn-icon-bare workspace-expand-button"
								onclick={presentation === "expanded" ? requestDockedPresentation : requestExpandedPresentation}
								aria-label={presentation === "expanded" ? $t('documentWorkspace.collapseWorkspaceLabel', { title: getDocumentTitle(activeDocument) }) : $t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
								title={presentation === "expanded" ? $t('documentWorkspace.collapseWorkspace') : $t('documentWorkspace.expandWorkspace')}
							>
								<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="15 3 21 3 21 9" />
									<polyline points="9 21 3 21 3 15" />
									<line x1="21" y1="3" x2="14" y2="10" />
									<line x1="3" y1="21" x2="10" y2="14" />
								</svg>
							</button>
						{/if}
						<button
							type="button"
							class="btn-icon-bare workspace-close-button"
							onclick={handleCloseWorkspace}
							aria-label={$t('documentWorkspace.closeWorkspace')}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
								<line x1="18" x2="6" y1="6" y2="18" />
								<line x1="6" x2="18" y1="6" y2="18" />
							</svg>
						</button>
					</div>
				</div>
				{#if getDocumentSubtitle(activeDocument)}
					<div class="workspace-subtitle">{getDocumentSubtitle(activeDocument)}</div>
				{/if}
				<div class="workspace-meta-row" data-testid="document-provenance">
					<span class="workspace-source-pill" class:workspace-source-pill-ai={isAiGeneratedDocument(activeDocument)}>
						{#if isAiGeneratedDocument(activeDocument)}
							<svg class="workspace-source-sparkle" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M9.94 14.6 8.5 18l-1.44-3.4L3.7 13.1l3.36-1.5L8.5 8.2l1.44 3.4 3.36 1.5-3.36 1.5Z" />
								<path d="M17.5 8.7 16.7 11l-.8-2.3-2.3-.8 2.3-.8.8-2.3.8 2.3 2.3.8-2.3.8Z" />
							</svg>
						{/if}
						<span>{getDocumentSourceLabel(activeDocument)}</span>
					</span>
					{#if getDocumentLifecycleLabel(activeDocument)}
						<span class="workspace-status-badge">
							{getDocumentLifecycleLabel(activeDocument)}
						</span>
					{/if}
				</div>
			</div>
		</div>

	{#if canCompareActiveDocument}
		<div class="workspace-actions">
			<button
				type="button"
				class="workspace-source-button"
				onclick={() => {
					compareMode = !compareMode;
				}}
			>
				{compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
			</button>
		</div>
	{/if}

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
									<span class="workspace-history-version">
										{getDocumentVersionLabel(document) ?? $t('documentWorkspace.version')}
									</span>
									{#if isLatestFamilyDocument(document)}
										<span class="workspace-history-badge">{$t('documentWorkspace.latest')}</span>
									{/if}
									{#if isCurrentFamilyDocument(document)}
										<span class="workspace-history-badge workspace-history-badge-current">{$t('documentWorkspace.current')}</span>
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
					<div>
						<div class="workspace-compare-title">{$t('documentWorkspace.compareVersionsTitle')}</div>
						{#if compareSummary}
							<div class="workspace-compare-summary">
								{$t('documentWorkspace.compareSummary', { changed: compareSummary.changedLines, added: compareSummary.addedLines, removed: compareSummary.removedLines })}
							</div>
						{/if}
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
							<div class="workspace-compare-panel-body">
								{@html compareCurrentTextHtml}
							</div>
						</section>
						<section class="workspace-compare-panel">
							<div class="workspace-compare-panel-head">
								<span class="workspace-compare-panel-label">{$t('documentWorkspace.compared')}</span>
								<span class="workspace-compare-panel-meta">{getDocumentTitle(comparedDocument)} {getDocumentVersionLabel(comparedDocument) ?? ''}</span>
							</div>
							<div class="workspace-compare-panel-body">
								{@html compareOtherTextHtml}
							</div>
						</section>
					</div>
				{/if}
			</div>
		{:else}
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
	.workspace-shell-mobile .workspace-status-badge {
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

	.workspace-actions {
		display: flex;
		justify-content: flex-start;
		padding: 0.7rem 1rem 0;
		border-left: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-page) 96%, transparent 4%);
	}

	.workspace-shell-mobile .workspace-actions {
		border-left: none;
	}

	.workspace-source-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.46rem 0.82rem;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-elevated);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.76rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text-secondary);
		transition:
			border-color var(--duration-fast) ease,
			background-color var(--duration-fast) ease,
			color var(--duration-fast) ease;
	}

	.workspace-source-button:hover {
		border-color: var(--border-strong);
		background: color-mix(in srgb, var(--surface-elevated) 72%, var(--surface-page) 28%);
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
		align-items: end;
		justify-content: space-between;
		gap: 0.9rem;
		padding: 0.95rem 1rem 0.8rem;
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-elevated) 72%, var(--surface-page) 28%);
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

	.workspace-history {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.55rem 0.75rem;
		border-left: 1px solid var(--border-default);
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-page) 94%, transparent 6%);
	}

	.workspace-shell-mobile .workspace-history {
		border-left: none;
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
	}

	.workspace-history-chip {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		max-width: 12rem;
		gap: 0.4rem;
		padding: 0.3rem 0.44rem;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--surface-elevated);
		text-align: left;
		color: var(--text-secondary);
		transition:
			border-color var(--duration-fast) ease,
			background-color var(--duration-fast) ease,
			color var(--duration-fast) ease;
	}

	.workspace-history-chip:hover {
		border-color: var(--border-strong);
		background: color-mix(in srgb, var(--surface-elevated) 86%, var(--surface-page) 14%);
		color: var(--text-primary);
	}

	.workspace-version-badge {
		flex: 0 0 auto;
		box-shadow: none;
	}

	.workspace-history-chip-current {
		border-color: color-mix(in srgb, var(--text-primary) 18%, var(--border-default) 82%);
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
		color: var(--text-primary);
	}

	.workspace-history-topline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
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

	.workspace-history-badge {
		color: var(--text-muted);
		background: color-mix(in srgb, var(--surface-page) 85%, transparent 15%);
	}

	.workspace-history-badge-current {
		color: var(--text-primary);
		background: color-mix(in srgb, var(--surface-page) 70%, var(--surface-elevated) 30%);
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
</style>
