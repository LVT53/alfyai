<script lang="ts">
import { prewarmDocumentPreview } from "$lib/client/document-preview-prewarm";
import type { KnowledgeDocumentItem } from "$lib/types";
import { formatByteSize } from "$lib/utils/format";
import { formatMediumDateTime } from "$lib/utils/time";
import { t } from "$lib/i18n";
import {
	Archive,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Code,
	Download,
	File,
	FileText,
	Image,
	Loader,
	Monitor,
	Table,
	Trash2,
	Upload,
} from "@lucide/svelte";

type DocumentSortKey = "name" | "size" | "type" | "date";
type SortDirection = "asc" | "desc";

interface DocumentsListProps {
	documents: KnowledgeDocumentItem[];
	loading?: boolean;
	paginationLimit?: 20 | 50 | 100;
	currentPage?: number;
	totalDocuments?: number;
	totalPages?: number;
	searchQuery?: string;
	sortKey?: DocumentSortKey;
	sortDirection?: SortDirection;
	serverManaged?: boolean;
	bulkDeleteSuccessVersion?: number;
	onPaginationLimitChange?: (limit: number) => void;
	onPageChange?: (page: number) => void;
	onSearchQueryChange?: (query: string) => void;
	onSortChange?: (
		sortKey: DocumentSortKey,
		sortDirection: SortDirection,
	) => void;
	onSelect?: (document: KnowledgeDocumentItem) => void;
	onDelete?: (documentId: string) => void;
	onBulkDelete?: (documentIds: string[]) => Promise<boolean>;
	onDownload?: (documentId: string) => void;
	onUpload?: (files: File[]) => void | Promise<void>;
}

let {
	documents,
	loading = false,
	paginationLimit = 20,
	currentPage = 1,
	totalDocuments,
	totalPages: serverTotalPages,
	searchQuery = "",
	sortKey = "date",
	sortDirection = "desc",
	serverManaged = false,
	bulkDeleteSuccessVersion = 0,
	onPaginationLimitChange,
	onPageChange,
	onSearchQueryChange,
	onSortChange,
	onSelect,
	onDelete,
	onBulkDelete,
	onDownload,
	onUpload,
}: DocumentsListProps = $props();

// Selection state
let selectedIds = $state<Set<string>>(new Set());

// Drag-drop state
let isDragOver = $state(false);
let dragCounter = $state(0);
let fileInputRef = $state<HTMLInputElement | undefined>(undefined);
let isUploading = $state(false);
let localSearchQuery = $state("");
let activeSortKey = $state<DocumentSortKey>("date");
let activeSortDirection = $state<SortDirection>("desc");
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

// AI-facing version expand/collapse state
let expandedAiVersions = $state<Set<string>>(new Set());

// AI-facing version content cache: promptArtifactId → { loading, text, error }
let aiVersionContent = $state<
	Record<
		string,
		{ loading: boolean; text: string | null; error: string | null }
	>
>({});

// AbortControllers for in-flight AI-version fetches, keyed by promptArtifactId
const aiVersionAborts = new Map<string, AbortController>();

// Selection derived state
const selectedCount = $derived(selectedIds.size);
const isAllSelected = $derived.by(() => {
	if (paginatedDocuments.length === 0) return false;
	return paginatedDocuments.every((doc) => selectedIds.has(doc.id));
});
const isIndeterminate = $derived.by(() => {
	if (paginatedDocuments.length === 0) return false;
	const selectedOnPage = paginatedDocuments.filter((doc) =>
		selectedIds.has(doc.id),
	).length;
	return selectedOnPage > 0 && selectedOnPage < paginatedDocuments.length;
});
const hasSelection = $derived(selectedIds.size > 0);

$effect(() => {
	localSearchQuery = searchQuery;
});

$effect(() => {
	activeSortKey = sortKey;
	activeSortDirection = sortDirection;
});

$effect(() => {
	return () => {
		if (searchDebounce) {
			clearTimeout(searchDebounce);
		}
	};
});

// Clear selection when page changes (explicit, non-looping)
$effect(() => {
	const currentPageValue = currentPage;
	return () => {
		if (currentPageValue !== currentPage) {
			selectedIds = new Set();
		}
	};
});

// Clamp currentPage to valid range when totalPages shrinks
$effect(() => {
	if (totalPages > 0 && currentPage > totalPages) {
		onPageChange?.(totalPages);
	} else if (totalPages === 0 && currentPage > 1) {
		onPageChange?.(1);
	}
});

// Clear selection when bulk delete succeeds (parent signals via version increment)
$effect(() => {
	const currentVersion = bulkDeleteSuccessVersion;
	return () => {
		if (
			currentVersion !== bulkDeleteSuccessVersion &&
			bulkDeleteSuccessVersion > 0
		) {
			selectedIds = new Set();
		}
	};
});

// Accepted file types for upload
const acceptedFileTypes =
	".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.pptx,.ppt,.html,.htm,.jpg,.jpeg,.jfif,.png,.gif,.bmp,.tiff,.tif,.webp,.svg,.heic,.heif,.avif";

function handleDragEnter(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	dragCounter += 1;
	if (event.dataTransfer?.types.includes("Files")) {
		isDragOver = true;
	}
}

function handleDragLeave(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	dragCounter -= 1;
	if (dragCounter === 0) {
		isDragOver = false;
	}
}

function handleDragOver(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
}

async function handleDrop(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	isDragOver = false;
	dragCounter = 0;

	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;

	const validFiles = Array.from(files).filter((file) => {
		// Basic file type validation
		const extension = file.name.split(".").pop()?.toLowerCase();
		const acceptedExtensions = acceptedFileTypes
			.split(",")
			.map((t) => t.replace(".", ""));
		return extension && acceptedExtensions.includes(extension);
	});

	if (validFiles.length === 0) return;

	await processUpload(validFiles);
}

function handleUploadClick() {
	fileInputRef?.click();
}

function handleEmptyStateClick() {
	if (!onUpload || isUploading) return;
	handleUploadClick();
}

async function handleFileSelect(event: Event) {
	const input = event.target as HTMLInputElement;
	const files = input.files;
	if (!files || files.length === 0) return;

	await processUpload(Array.from(files));

	// Reset input for reuse
	input.value = "";
}

async function processUpload(files: File[]) {
	if (!onUpload || files.length === 0) return;

	isUploading = true;
	try {
		await onUpload(files);
	} catch (error) {
		console.error("Upload failed:", error);
	} finally {
		isUploading = false;
	}
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").toLowerCase().trim();
}

function tokenizeQuery(query: string): string[] {
	return normalizeText(query)
		.split(/\s+/)
		.filter((term) => term.length > 1);
}

function scoreTermMatches(
	target: string,
	terms: string[],
	weight: number,
): number {
	if (!target || terms.length === 0) return 0;
	let score = 0;
	for (const term of terms) {
		if (target.includes(term)) {
			score += weight;
		}
	}
	return score;
}

function getDocumentKind(
	document: KnowledgeDocumentItem,
): "generated" | "skill_note" | "uploaded" {
	if (
		document.documentOrigin === "skill_note" ||
		document.type === "skill_note"
	) {
		return "skill_note";
	}
	return document.documentOrigin === "generated" ||
		document.type === "generated_output"
		? "generated"
		: "uploaded";
}

function scoreDocumentForSearch(
	document: KnowledgeDocumentItem,
	query: string,
): number {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return 1;

	const terms = tokenizeQuery(normalizedQuery);
	const name = normalizeText(document.name);
	const label = normalizeText(document.documentLabel ?? null);
	const role = normalizeText(document.documentRole ?? null);
	const summary = normalizeText(document.summary ?? null);
	const kind = getDocumentKind(document);

	let score = 0;

	if (name.includes(normalizedQuery)) score += 70;
	if (label?.includes(normalizedQuery)) score += 60;
	if (summary?.includes(normalizedQuery)) score += 28;
	if (role?.includes(normalizedQuery)) score += 18;
	if (kind.includes(normalizedQuery)) score += 12;

	score += scoreTermMatches(name, terms, 18);
	score += scoreTermMatches(label, terms, 15);
	score += scoreTermMatches(summary, terms, 6);
	score += scoreTermMatches(role, terms, 5);

	return score;
}

const searchedDocuments = $derived.by(() => {
	if (serverManaged) {
		return documents.map((document) => ({ document, score: 0 }));
	}
	const query = normalizeText(localSearchQuery);
	if (!query) {
		return documents.map((document) => ({ document, score: 0 }));
	}

	return documents
		.map((document) => ({
			document,
			score: scoreDocumentForSearch(document, query),
		}))
		.filter((entry) => entry.score > 0);
});

function compareText(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		sensitivity: "base",
		numeric: true,
	});
}

const sortedDocuments = $derived.by(() => {
	if (serverManaged) {
		return documents;
	}
	const direction = activeSortDirection === "asc" ? 1 : -1;
	const entries = [...searchedDocuments];

	entries.sort((leftEntry, rightEntry) => {
		const left = leftEntry.document;
		const right = rightEntry.document;

		// When searching, preserve relevance as highest priority.
		if (
			localSearchQuery.trim().length > 0 &&
			leftEntry.score !== rightEntry.score
		) {
			return rightEntry.score - leftEntry.score;
		}

		if (activeSortKey === "name") {
			const byName = compareText(left.name, right.name) * direction;
			if (byName !== 0) return byName;
		}

		if (activeSortKey === "size") {
			const bySize =
				((left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)) * direction;
			if (bySize !== 0) return bySize;
		}

		if (activeSortKey === "type") {
			const byType =
				compareText(getDocumentKind(left), getDocumentKind(right)) * direction;
			if (byType !== 0) return byType;
		}

		if (activeSortKey === "date") {
			const byDate =
				((left.createdAt ?? 0) - (right.createdAt ?? 0)) * direction;
			if (byDate !== 0) return byDate;
		}

		// Deterministic tie-breakers
		const byNameTie = compareText(left.name, right.name);
		if (byNameTie !== 0) return byNameTie;
		const byDateTie = (right.createdAt ?? 0) - (left.createdAt ?? 0);
		if (byDateTie !== 0) return byDateTie;
		return compareText(left.id, right.id);
	});

	return entries.map((entry) => entry.document);
});

// Filter out normalized_document artifacts — they are bundled inside the source document row.
const displayDocuments = $derived(
	sortedDocuments.filter((doc) => doc.type !== "normalized_document"),
);
const displayDocumentCount = $derived(
	serverManaged
		? (totalDocuments ?? displayDocuments.length)
		: displayDocuments.length,
);

// Pagination
const totalPages = $derived(
	serverManaged
		? (serverTotalPages ?? Math.ceil(displayDocumentCount / paginationLimit))
		: Math.ceil(displayDocuments.length / paginationLimit),
);
const paginatedDocuments = $derived.by(() => {
	if (serverManaged) {
		return displayDocuments;
	}
	const start = (currentPage - 1) * paginationLimit;
	const end = start + paginationLimit;
	return displayDocuments.slice(start, end);
});

const showingFrom = $derived(
	displayDocumentCount === 0 ? 0 : (currentPage - 1) * paginationLimit + 1,
);
const showingTo = $derived(
	Math.min(currentPage * paginationLimit, displayDocumentCount),
);
const showInitialEmptyState = $derived(
	documents.length === 0 &&
		displayDocumentCount === 0 &&
		localSearchQuery.trim().length === 0,
);

function toggleSort(nextSortKey: DocumentSortKey) {
	let nextDirection: SortDirection;
	if (activeSortKey === nextSortKey) {
		nextDirection = activeSortDirection === "asc" ? "desc" : "asc";
	} else {
		nextDirection =
			nextSortKey === "name" || nextSortKey === "type" ? "asc" : "desc";
	}
	activeSortKey = nextSortKey;
	activeSortDirection = nextDirection;
	onSortChange?.(nextSortKey, nextDirection);
}

function handleSearchInput() {
	if (!serverManaged) return;
	if (searchDebounce) {
		clearTimeout(searchDebounce);
	}
	searchDebounce = setTimeout(() => {
		searchDebounce = null;
		onSearchQueryChange?.(localSearchQuery);
	}, 250);
}

async function toggleAiVersion(documentId: string, promptArtifactId: string) {
	const next = new Set(expandedAiVersions);
	if (next.has(documentId)) {
		next.delete(documentId);
		expandedAiVersions = next;
		return;
	}

	// Expanding — fetch the AI-facing content if not already loaded
	next.add(documentId);
	expandedAiVersions = next;

	if (!aiVersionContent[promptArtifactId]) {
		// Abort any in-flight fetch for this artifact
		aiVersionAborts.get(promptArtifactId)?.abort();
		const controller = new AbortController();
		aiVersionAborts.set(promptArtifactId, controller);

		aiVersionContent = {
			...aiVersionContent,
			[promptArtifactId]: { loading: true, text: null, error: null },
		};

		try {
			const response = await fetch(`/api/knowledge/${promptArtifactId}`, {
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`Failed to load content (${response.status})`);
			}
			const data = await response.json();
			const text = data?.artifact?.contentText ?? null;
			aiVersionContent = {
				...aiVersionContent,
				[promptArtifactId]: {
					loading: false,
					text,
					error: text ? null : "No content available",
				},
			};
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			aiVersionContent = {
				...aiVersionContent,
				[promptArtifactId]: {
					loading: false,
					text: null,
					error: err instanceof Error ? err.message : "Failed to load content",
				},
			};
		} finally {
			if (aiVersionAborts.get(promptArtifactId) === controller) {
				aiVersionAborts.delete(promptArtifactId);
			}
		}
	}
}

function getAriaSort(
	column: DocumentSortKey,
): "none" | "ascending" | "descending" {
	if (activeSortKey !== column) return "none";
	return activeSortDirection === "asc" ? "ascending" : "descending";
}

function getSortIndicator(column: DocumentSortKey): string {
	if (activeSortKey !== column) return "↕";
	return activeSortDirection === "asc" ? "↑" : "↓";
}

function getFileExtension(filename: string | null | undefined): string {
	const value = (filename ?? "").trim();
	if (!value.includes(".")) return "";
	return value.split(".").pop()?.toLowerCase() ?? "";
}

function formatFileType(mimeType: string | null, filename: string): string {
	const mime = (mimeType ?? "").toLowerCase();
	const ext = getFileExtension(filename);

	if (mime === "application/pdf") return "PDF";
	if (
		mime.startsWith("text/") ||
		ext === "txt" ||
		ext === "md" ||
		ext === "markdown"
	) {
		return ext.toUpperCase() || "TXT";
	}
	if (
		mime ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		ext === "docx"
	)
		return "DOCX";
	if (mime === "application/msword" || ext === "doc") return "DOC";
	if (
		mime ===
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		ext === "xlsx"
	)
		return "XLSX";
	if (mime === "application/vnd.ms-excel" || ext === "xls") return "XLS";
	if (
		mime ===
			"application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		ext === "pptx"
	)
		return "PPTX";
	if (mime === "application/vnd.ms-powerpoint" || ext === "ppt") return "PPT";
	if (mime === "text/csv" || ext === "csv") return "CSV";
	if (mime === "application/json" || ext === "json") return "JSON";
	if (
		mime.startsWith("image/") ||
		[
			"png",
			"jpg",
			"jpeg",
			"gif",
			"bmp",
			"tiff",
			"tif",
			"webp",
			"svg",
			"heic",
			"heif",
			"avif",
		].includes(ext)
	) {
		return ext.toUpperCase() || "IMG";
	}
	if (mime === "text/html" || ext === "html" || ext === "htm") return "HTML";
	if (ext) return ext.toUpperCase();
	return "FILE";
}

function getFileIcon(mimeType: string | null, filename: string): typeof File {
	const mime = normalizeText(mimeType);
	const extension = getFileExtension(filename);

	if (
		mime.startsWith("image/") ||
		[
			"png",
			"jpg",
			"jpeg",
			"jfif",
			"gif",
			"bmp",
			"tiff",
			"tif",
			"svg",
			"webp",
			"heic",
			"heif",
			"avif",
		].includes(extension)
	) {
		return Image;
	}

	if (mime === "application/pdf" || extension === "pdf") {
		return FileText;
	}

	if (
		mime.includes("spreadsheet") ||
		mime.includes("excel") ||
		mime.includes("csv") ||
		["csv", "xls", "xlsx", "ods"].includes(extension)
	) {
		return Table;
	}

	if (
		mime.includes("presentation") ||
		["ppt", "pptx", "odp"].includes(extension)
	) {
		return Monitor;
	}

	if (
		mime.includes("code") ||
		mime.includes("javascript") ||
		mime.includes("typescript") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime.includes("html") ||
		mime.includes("css") ||
		[
			"js",
			"ts",
			"tsx",
			"jsx",
			"json",
			"xml",
			"html",
			"css",
			"py",
			"java",
			"go",
			"rs",
		].includes(extension)
	) {
		return Code;
	}

	if (
		mime.includes("zip") ||
		mime.includes("compressed") ||
		mime.includes("archive") ||
		["zip", "rar", "7z", "tar", "gz"].includes(extension)
	) {
		return Archive;
	}

	if (
		mime.includes("text/") ||
		["txt", "md", "rtf", "log", "odt", "doc", "docx"].includes(extension) ||
		mime.includes("document") ||
		mime.includes("word")
	) {
		return FileText;
	}

	return File;
}

function handleRowClick(event: MouseEvent, document: KnowledgeDocumentItem) {
	// Don't trigger if clicking on row actions or selection controls
	if (
		(event.target as HTMLElement).closest(
			"button, input, label, .checkbox-label",
		)
	)
		return;
	onSelect?.(document);
}

function handleDocumentPreviewIntent(document: KnowledgeDocumentItem) {
	void prewarmDocumentPreview(document);
}

function handleDeleteClick(event: MouseEvent, documentId: string) {
	event.stopPropagation();
	onDelete?.(documentId);
}

function handleDownloadClick(event: MouseEvent, documentId: string) {
	event.stopPropagation();
	onDownload?.(documentId);
}

// Selection handlers
function toggleSelection(documentId: string) {
	const next = new Set(selectedIds);
	if (next.has(documentId)) {
		next.delete(documentId);
	} else {
		next.add(documentId);
	}
	selectedIds = next;
}

function toggleSelectAll() {
	if (isAllSelected) {
		// Deselect all on current page
		const next = new Set(selectedIds);
		for (const doc of paginatedDocuments) {
			next.delete(doc.id);
		}
		selectedIds = next;
	} else {
		// Select all on current page
		const next = new Set(selectedIds);
		for (const doc of paginatedDocuments) {
			next.add(doc.id);
		}
		selectedIds = next;
	}
}

function clearSelection() {
	selectedIds = new Set();
}

async function handleBulkDelete(): Promise<boolean> {
	if (selectedIds.size === 0) return false;
	if (!onBulkDelete) return false;

	const idsToDelete = Array.from(selectedIds);
	try {
		const success = await onBulkDelete(idsToDelete);
		// Only clear selection if delete was explicitly successful
		if (success === true) {
			clearSelection();
		}
		return success;
	} catch {
		// Keep selection on error so user can retry
		return false;
	}
}
</script>

<div
	class="documents-list-wrapper"
	class:drag-over={isDragOver}
	role="region"
	aria-label={$t('knowledge.documents')}
	ondragenter={handleDragEnter}
	ondragleave={handleDragLeave}
	ondragover={handleDragOver}
	ondrop={handleDrop}
>
	<!-- Drop zone overlay - desktop only -->
	{#if isDragOver}
		<div class="drop-zone-overlay" data-testid="drop-zone-overlay">
			<div class="drop-zone-content">
				<div class="drop-zone-icon">
					<Upload size={18} strokeWidth={1.5} aria-hidden="true" />
				</div>
				<p class="drop-zone-text">{$t('knowledge.dropFiles')}</p>
			</div>
		</div>
	{/if}

	<div class="documents-list" class:loading>
	{#if onUpload}
		<input
			type="file"
			bind:this={fileInputRef}
			onchange={handleFileSelect}
			accept={acceptedFileTypes}
			multiple
			class="hidden-input"
			aria-hidden="true"
			data-testid="file-input"
		/>
	{/if}
	{#if showInitialEmptyState}
		{#if onUpload}
			<button
				type="button"
				class="empty-state empty-state-upload-enabled"
				onclick={handleEmptyStateClick}
				disabled={isUploading}
				aria-label={$t('knowledge.upload')}
			>
				<div class="empty-icon">
					<FileText size={48} strokeWidth={1} aria-hidden="true" />
				</div>
				<p class="empty-title">{$t('knowledge.noDocuments')}</p>
				<p class="empty-hint">{$t('knowledge.uploadOrGenerateHint')}</p>
			</button>
		{:else}
			<div class="empty-state">
				<div class="empty-icon">
					<FileText size={48} strokeWidth={1} aria-hidden="true" />
				</div>
				<p class="empty-title">{$t('knowledge.noDocuments')}</p>
				<p class="empty-hint">{$t('knowledge.uploadOrGenerateHint')}</p>
			</div>
		{/if}
	{:else}
		<div class="filter-controls">
			<div class="search-controls">
				<input
					id="documents-search-input"
					type="search"
					class="documents-search-input"
					placeholder={$t('knowledge.searchPlaceholder')}
					bind:value={localSearchQuery}
					oninput={handleSearchInput}
					aria-label={$t('knowledge.searchDocuments')}
				/>
			</div>

			{#if onUpload}
				<button
				type="button"
				class="upload-btn"
				aria-label={$t('knowledge.upload')}
				title={$t('knowledge.upload')}
				disabled={isUploading}
				onclick={handleUploadClick}
			>
				{#if isUploading}
					<span class="upload-spinner"></span>
				{:else}
					<Upload size={18} strokeWidth={1.5} aria-hidden="true" />
				{/if}
				</button>
			{/if}
	</div>

				{#if sortedDocuments.length === 0}
			<div class="empty-state">
			<p class="empty-title">
				{localSearchQuery.trim().length > 0
					? $t('knowledge.noDocumentsMatch')
					: $t('knowledge.noDocumentsAvailable')}
				</p>
			</div>
		{:else if displayDocuments.length === 0}
			<div class="empty-state">
			<p class="empty-title">
				{$t('knowledge.noDocumentsAvailable')}
				</p>
			</div>
		{:else}
			<div class="table-container">
				<table class="documents-table">
					<thead>
						<tr>
							<th class="col-checkbox">
								<label class="checkbox-label">
									<input
										type="checkbox"
										class="custom-checkbox"
										checked={isAllSelected}
										indeterminate={isIndeterminate}
										onchange={toggleSelectAll}
										aria-label={$t('knowledge.selectAll')}
									/>
								</label>
							</th>
							<th class="col-icon" scope="col" aria-label={$t('knowledge.type')}></th>
							<th class="col-name" scope="col" aria-sort={getAriaSort('name')}>
								<button type="button" class="sort-button" onclick={() => toggleSort('name')}>
									{$t('knowledge.name')} <span class="sort-indicator">{getSortIndicator('name')}</span>
								</button>
							</th>
							<th class="col-type" scope="col" aria-sort={getAriaSort('type')}>
								<button type="button" class="sort-button" onclick={() => toggleSort('type')}>
									{$t('knowledge.type')} <span class="sort-indicator">{getSortIndicator('type')}</span>
								</button>
							</th>
							<th class="col-size" scope="col" aria-sort={getAriaSort('size')}>
								<button type="button" class="sort-button" onclick={() => toggleSort('size')}>
									{$t('knowledge.size')} <span class="sort-indicator">{getSortIndicator('size')}</span>
								</button>
							</th>
							<th class="col-date" scope="col" aria-sort={getAriaSort('date')}>
								<button type="button" class="sort-button" onclick={() => toggleSort('date')}>
									{$t('knowledge.date')} <span class="sort-indicator">{getSortIndicator('date')}</span>
								</button>
							</th>
							<th class="col-actions" scope="col">{$t('knowledge.actions')}</th>
						</tr>
					</thead>
					<tbody>
						{#each paginatedDocuments as document (document.id)}
							{@const Icon = getFileIcon(document.mimeType, document.name)}
							<tr
								class="document-row document-list-item"
								class:selected={selectedIds.has(document.id)}
								onclick={(e) => handleRowClick(e, document)}
								onpointerenter={() => handleDocumentPreviewIntent(document)}
								onfocus={() => handleDocumentPreviewIntent(document)}
								tabindex="0"
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										onSelect?.(document);
									}
								}}
							>
								<td class="col-checkbox">
									<label class="checkbox-label">
										<input
											type="checkbox"
											class="custom-checkbox"
											checked={selectedIds.has(document.id)}
											onchange={() => toggleSelection(document.id)}
											onclick={(e) => e.stopPropagation()}
											aria-label={$t('knowledge.selectDocument', { name: document.name })}
										/>
									</label>
								</td>
								<td class="col-icon">
									<div class="file-icon" data-testid="file-icon">
										<Icon size={18} strokeWidth={1.5} aria-hidden="true" />
									</div>
								</td>
								<td class="col-name">
									<div class="document-name">
										{#if document.normalizedAvailable && document.promptArtifactId}
											<button
												type="button"
												class="ai-version-toggle"
												aria-label={expandedAiVersions.has(document.id)
													? $t('knowledge.hideAiVersion')
													: $t('knowledge.viewAiVersion')}
												onclick={(e) => {
													e.stopPropagation();
													toggleAiVersion(document.id, document.promptArtifactId!);
												}}
											>
											{#if expandedAiVersions.has(document.id)}
													<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
												{:else}
													<ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
												{/if}
											</button>
										{/if}
										{document.name}
									{#if document.isOriginal}
										<span class="original-badge">{$t('knowledge.original')}</span>
									{:else if document.versionNumber != null && document.documentFamilyId}
										<span class="version-badge">v{document.versionNumber}</span>
									{/if}
									{#if document.documentFamilyStatus === 'historical'}
										<span class="historical-badge">{$t('knowledge.historical')}</span>
									{/if}
									</div>
								</td>
								<td class="col-type" data-mobile-label={$t('knowledge.type')}>
								{#if document.documentOrigin === 'skill_note' || document.type === 'skill_note'}
									<span class="type-badge type-skill-note">{$t('knowledge.skillNote')}</span>
								{:else if document.documentOrigin === 'generated' || document.type === 'generated_output'}
									<span class="type-badge type-generated">{$t('knowledge.generated')}</span>
								{:else}
									<span class="type-badge type-uploaded">{formatFileType(document.mimeType, document.name)}</span>
								{/if}
								</td>
								<td class="col-size" data-mobile-label={$t('knowledge.size')}>
									{formatByteSize(document.sizeBytes, { trimWholeUnits: true })}
								</td>
								<td class="col-date" data-mobile-label={$t('knowledge.date')}>
									{formatMediumDateTime(document.createdAt)}
								</td>
								<td class="col-actions">
									<div class="action-buttons">
										<button
											type="button"
											class="action-btn"
											aria-label={$t('filePreview.download', { filename: document.name })}
											title={$t('filePreview.download', { filename: document.name })}
											onclick={(e) => handleDownloadClick(e, document.id)}
										>
										<Download size={16} strokeWidth={2} aria-hidden="true" />
										</button>
										<button
											type="button"
											class="action-btn action-btn-danger"
											aria-label={$t('knowledge.deleteConfirm')}
											title={$t('knowledge.deleteConfirm')}
											onclick={(e) => handleDeleteClick(e, document.id)}
										>
										<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
										</button>
									</div>
								</td>
							</tr>
							{#if document.normalizedAvailable && document.promptArtifactId && expandedAiVersions.has(document.id)}
							{@const promptId = document.promptArtifactId}
							{@const content = aiVersionContent[promptId] ?? null}
							<tr class="ai-version-row">
								<td class="col-checkbox"></td>
								<td class="col-icon"></td>
								<td colspan="5" class="ai-version-cell">
									<div class="ai-version-panel">
										<span class="ai-version-label">{$t('knowledge.aiFacingVersion')}</span>
										{#if content?.loading}
												<div class="ai-version-loading">
													<span class="ai-version-spinner">
														<Loader size={16} strokeWidth={2} aria-hidden="true" />
													</span>
													{$t('knowledge.aiVersionLoading')}
												</div>
										{:else if content?.error}
											<div class="ai-version-error">{content.error}</div>
										{:else if content?.text}
											<pre class="ai-version-content">{content.text}</pre>
										{:else}
											<div class="ai-version-empty">{$t('knowledge.aiVersionNoContent')}</div>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Bulk action bar -->
			{#if hasSelection}
				<div class="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
					<div class="bulk-info">
						<span class="bulk-count">{selectedCount} {$t('knowledge.selected')}</span>
					</div>
					<div class="bulk-actions">
						<button
							type="button"
							class="bulk-btn bulk-btn-danger"
							onclick={handleBulkDelete}
							disabled={!onBulkDelete}
						>
							...
							{$t('knowledge.deleteSelected')}
						</button>
						<button
							type="button"
							class="bulk-btn bulk-btn-secondary"
							onclick={clearSelection}
						>
							{$t('knowledge.clear')}
						</button>
					</div>
				</div>
			{/if}

			{#if displayDocumentCount > paginationLimit}
				<nav class="pagination" aria-label="Pagination">
					<div class="pagination-info">
						<span>{$t('knowledge.showing', { from: showingFrom, to: showingTo, total: displayDocumentCount })}</span>
						<select
							class="page-size-select"
							aria-label={$t('knowledge.itemsPerPage')}
							value={paginationLimit}
							onchange={(e) => onPaginationLimitChange?.(parseInt((e.target as HTMLSelectElement).value))}
						>
							<option value={20}>20</option>
							<option value={50}>50</option>
							<option value={100}>100</option>
						</select>
					</div>
					<div class="pagination-controls">
						<span class="page-info">{$t('knowledge.pageInfo', { current: currentPage, total: totalPages })}</span>
						<button
							type="button"
							class="pagination-btn"
							aria-label={$t('knowledge.previousPage')}
							disabled={currentPage <= 1}
							onclick={() => onPageChange?.(currentPage - 1)}
						>
						<ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
						</button>
						<button
							type="button"
							class="pagination-btn"
							aria-label={$t('knowledge.nextPage')}
							disabled={currentPage >= totalPages}
							onclick={() => onPageChange?.(currentPage + 1)}
						>
						<ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
						</button>
					</div>
				</nav>
			{/if}
		{/if}
	{/if}
</div>
</div>

<style>
	.documents-list-wrapper {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 200px;
	}

	/* Drop zone overlay - desktop only */
	.drop-zone-overlay {
		display: none;
		position: absolute;
		inset: 0;
		z-index: 100;
		background: color-mix(in srgb, var(--surface-elevated) 95%, transparent);
		border: 2px dashed var(--accent);
		border-radius: 1.2rem;
		backdrop-filter: blur(4px);
	}

	@media (min-width: 768px) {
		.drop-zone-overlay {
			display: flex;
			align-items: center;
			justify-content: center;
		}
	}

	.drop-zone-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-xl);
	}

	.drop-zone-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
	}

	.drop-zone-text {
		font-size: 1rem;
		font-weight: 500;
		color: var(--text-primary);
		margin: 0;
	}

	.documents-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: var(--space-2xl) var(--space-lg);
		text-align: center;
		border-radius: 1.2rem;
		border: 1px dashed var(--border-default);
		background: var(--surface-elevated);
	}

	.empty-state-upload-enabled {
		width: 100%;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background var(--duration-standard) var(--ease-out);
	}

	.empty-state-upload-enabled:hover:not(:disabled) {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--surface-elevated) 92%, var(--accent) 8%);
	}

	.empty-state-upload-enabled:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.empty-state-upload-enabled:disabled {
		cursor: not-allowed;
		opacity: 0.72;
	}

	.empty-icon {
		color: var(--icon-muted);
		opacity: 0.5;
		margin-bottom: var(--space-md);
	}

	.empty-title {
		font-size: 1rem;
		font-weight: 500;
		color: var(--text-primary);
		margin: 0 0 var(--space-xs) 0;
	}

	.empty-hint {
		font-size: 0.875rem;
		color: var(--text-muted);
		margin: 0;
	}

	.filter-controls {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
	}

	.search-controls {
		display: flex;
		flex: 0 1 50%;
		max-width: 50%;
		min-width: 14rem;
	}

	.documents-search-input {
		width: 100%;
		padding: 0.58rem 0.74rem;
		border: 1px solid var(--border-default);
		border-radius: 0.7rem;
		background: var(--surface-elevated);
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.documents-search-input:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.hidden-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.upload-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
		background: var(--accent);
		color: white;
		cursor: pointer;
		transition: all var(--duration-standard) var(--ease-out);
		flex-shrink: 0;
	}

	@media (max-width: 900px) {
		.search-controls {
			flex-basis: 100%;
			max-width: 100%;
		}
	}

	.upload-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 85%, black);
		border-color: color-mix(in srgb, var(--accent) 85%, black);
		color: white;
	}

	.upload-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.upload-spinner {
		display: inline-block;
		width: 16px;
		height: 16px;
		border: 2px solid var(--border-default);
		border-top-color: var(--icon-primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.table-container {
		max-height: 600px;
		overflow-y: auto;
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
	}

	.documents-table {
		width: 100%;
		border-collapse: collapse;
	}

	.documents-table thead {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--surface-elevated);
		border-bottom: 1px solid var(--border-default);
	}

	.documents-table th {
		padding: var(--space-md) var(--space-lg);
		text-align: left;
		font-size: 0.68rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--text-muted);
	}

	.sort-button {
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		padding: 0;
		border: none;
		background: transparent;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: inherit;
		cursor: pointer;
	}

	.sort-button:hover {
		color: var(--text-primary);
	}

	.sort-indicator {
		font-size: 0.72rem;
		line-height: 1;
		opacity: 0.85;
	}

	.documents-table td {
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}

	.documents-table tbody tr:last-child td {
		border-bottom: none;
	}

	.document-row {
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.document-row:hover {
		background: var(--surface-elevated);
	}

	.document-row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.col-icon {
		width: 40px;
	}

	.file-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--icon-muted);
	}

	.col-name {
		min-width: 200px;
	}

	.document-name {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex-wrap: wrap;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.version-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.original-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--success) 15%, transparent);
		color: var(--success);
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.historical-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.col-type {
		width: 100px;
	}

	.type-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.625rem;
		border-radius: var(--radius-full);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.type-uploaded {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
	}

	.type-generated {
		background: color-mix(in srgb, var(--text-muted) 15%, transparent);
		color: var(--text-muted);
		border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
	}

	.type-skill-note {
		background: color-mix(in srgb, var(--success) 15%, transparent);
		color: var(--success);
		border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
	}

	/* AI-facing version toggle */
	.ai-version-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: 4px;
		background: var(--surface-page);
		color: var(--icon-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.ai-version-toggle:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page) 92%);
	}

	.ai-version-toggle:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.ai-version-row {
		background: color-mix(in srgb, var(--surface-page) 94%, var(--accent) 6%);
	}

	.ai-version-cell {
		padding: var(--space-sm) var(--space-lg) var(--space-md) var(--space-lg);
	}

	.ai-version-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		font-size: 0.8125rem;
		color: var(--text-secondary);
		max-height: 320px;
		overflow-y: auto;
	}

	.ai-version-label {
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.75rem;
		color: var(--accent);
	}

	.ai-version-content {
		margin: 0;
		padding: var(--space-md);
		background: var(--surface-raised);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-wrap: break-word;
		color: var(--text-primary);
	}

	.ai-version-loading {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.ai-version-spinner {
		animation: spin 1s linear infinite;
	}

	.ai-version-error {
		font-size: 0.8125rem;
		color: var(--text-danger);
	}

	.ai-version-empty {
		font-size: 0.8125rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.col-size {
		width: 80px;
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.col-date {
		width: 140px;
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.col-actions {
		width: 80px;
	}

	.action-buttons {
		display: flex;
		gap: var(--space-xs);
		justify-content: flex-end;
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		transition: all var(--duration-standard) var(--ease-out);
	}

	.action-btn:hover {
		background: var(--surface-elevated);
		color: var(--icon-primary);
	}

	.action-btn-danger:hover {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	.pagination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-md) var(--space-lg);
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		flex-wrap: wrap;
		gap: var(--space-md);
	}

	.pagination-info {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.page-size-select {
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		font-size: 0.8125rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.pagination-controls {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.page-info {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.pagination-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--icon-muted);
		cursor: pointer;
		transition: all var(--duration-standard) var(--ease-out);
	}

	.pagination-btn:hover:not(:disabled) {
		background: var(--surface-page);
		color: var(--icon-primary);
		border-color: var(--accent);
	}

	.pagination-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.loading {
		opacity: 0.6;
		pointer-events: none;
	}

	/* Checkbox styles */
	.col-checkbox {
		width: 44px;
		text-align: center;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.custom-checkbox {
		appearance: none;
		width: 18px;
		height: 18px;
		border: 1.5px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		cursor: pointer;
		transition: all var(--duration-standard) var(--ease-out);
		position: relative;
	}

	.custom-checkbox:hover {
		border-color: var(--accent);
	}

	.custom-checkbox:checked {
		background: var(--accent);
		border-color: var(--accent);
	}

	.custom-checkbox:checked::after {
		content: '';
		position: absolute;
		left: 5px;
		top: 2px;
		width: 5px;
		height: 9px;
		border: solid white;
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}

	.custom-checkbox:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* Selected row highlight */
	.document-row.selected {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	.document-row.selected:hover {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	/* Bulk action bar */
	.bulk-action-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-md) var(--space-lg);
		margin-top: var(--space-md);
		border-radius: 1.2rem;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		flex-wrap: wrap;
		gap: var(--space-md);
	}

	.bulk-info {
		display: flex;
		align-items: center;
	}

	.bulk-count {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.bulk-actions {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}

	.bulk-btn {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--duration-standard) var(--ease-out);
		border: 1px solid transparent;
	}

	.bulk-btn-danger {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 30%, transparent);
	}

	.bulk-btn-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 20%, transparent);
		border-color: var(--danger);
	}

	.bulk-btn-secondary {
		background: var(--surface-page);
		color: var(--text-secondary);
		border-color: var(--border-default);
	}

	.bulk-btn-secondary:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.bulk-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 720px) {
		.table-container {
			max-height: none;
			overflow: visible;
			border: 0;
			border-radius: 0;
			background: transparent;
		}

		.documents-table,
		.documents-table tbody {
			display: block;
			width: 100%;
		}

		.documents-table thead {
			position: static;
			display: block;
			background: transparent;
			border: 0;
			margin-bottom: var(--space-xs);
		}

		.documents-table thead tr {
			display: flex;
			flex-wrap: wrap;
			gap: var(--space-xs);
		}

		.documents-table th {
			display: none;
			padding: 0;
		}

		.documents-table th.col-name,
		.documents-table th.col-type,
		.documents-table th.col-size,
		.documents-table th.col-date {
			display: block;
			width: auto;
			min-width: 0;
		}

		.documents-table thead .sort-button {
			padding: 0.4rem 0.52rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-elevated);
			font-size: 0.66rem;
		}

		.documents-table tbody {
			display: flex;
			flex-direction: column;
			gap: var(--space-sm);
		}

		.documents-table .document-list-item {
			display: grid;
			grid-template-columns: 26px 28px minmax(0, 1fr) auto;
			grid-template-areas:
				"check icon name actions"
				"check icon type actions"
				"check icon size date";
			column-gap: var(--space-sm);
			row-gap: 0.34rem;
			align-items: center;
			padding: 0.68rem 0.72rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-elevated);
		}

		.documents-table td {
			padding: 0;
			border-bottom: 0;
		}

		.documents-table .col-checkbox {
			grid-area: check;
			width: 26px;
			align-self: start;
			padding-top: 0.12rem;
		}

		.documents-table .col-icon {
			grid-area: icon;
			width: 28px;
			align-self: start;
			padding-top: 0.05rem;
		}

		.documents-table .col-name {
			grid-area: name;
			min-width: 0;
			padding-right: var(--space-xs);
		}

		.document-name {
			min-width: 0;
			gap: 0.32rem;
			font-size: 0.86rem;
			line-height: 1.25;
			overflow-wrap: anywhere;
		}

		.documents-table .col-type {
			grid-area: type;
			width: auto;
			min-width: 0;
		}

		.documents-table .col-size {
			grid-area: size;
			width: auto;
		}

		.documents-table .col-date {
			grid-area: date;
			width: auto;
			justify-self: end;
			text-align: right;
		}

		.documents-table .col-actions {
			grid-area: actions;
			width: auto;
			align-self: center;
		}

		.documents-table .col-type,
		.documents-table .col-size,
		.documents-table .col-date {
			display: inline-flex;
			align-items: center;
			gap: 0.34rem;
			font-size: 0.74rem;
			line-height: 1.2;
		}

		.documents-table td[data-mobile-label]::before {
			content: attr(data-mobile-label);
			font-size: 0.66rem;
			font-weight: 600;
			text-transform: uppercase;
			color: var(--text-muted);
		}

		.type-badge,
		.version-badge,
		.original-badge,
		.historical-badge {
			letter-spacing: 0.02em;
		}

		.action-buttons {
			flex-direction: column;
			gap: 0.18rem;
		}

		.action-btn {
			width: 30px;
			height: 30px;
		}

		.bulk-action-bar,
		.pagination {
			border-radius: var(--radius-md);
			padding: var(--space-sm);
		}

		.bulk-actions,
		.pagination-info,
		.pagination-controls {
			width: 100%;
			justify-content: space-between;
		}
	}
</style>
