<script lang="ts">
import { prewarmDocumentPreview } from "$lib/client/document-preview-prewarm";
import type { KnowledgeDocumentItem } from "$lib/types";
import { partitionUploadableFiles } from "$lib/utils/file-drag";
import { formatByteSize } from "$lib/utils/format";
import { formatMediumDateTime } from "$lib/utils/time";
import { t } from "$lib/i18n";
import {
	Archive,
	ChevronLeft,
	ChevronRight,
	Code,
	Download,
	Eye,
	File as FileIcon,
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
let dropError = $state<string | null>(null);
let dropErrorTimer: ReturnType<typeof setTimeout> | null = null;
let localSearchQuery = $state("");
let activeSortKey = $state<DocumentSortKey>("date");
let activeSortDirection = $state<SortDirection>("desc");
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let expandedAiVersions = $state<Set<string>>(new Set());
let aiVersionContent = $state<
	Record<
		string,
		{ loading: boolean; text: string | null; error: string | null }
	>
>({});
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
		if (dropErrorTimer) {
			clearTimeout(dropErrorTimer);
		}
		for (const controller of aiVersionAborts.values()) {
			controller.abort();
		}
		aiVersionAborts.clear();
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

// Authoritative per-file upload size limit (100 MiB = 104857600 bytes),
// mirroring the server default in src/lib/server/env.ts (MAX_FILE_UPLOAD_SIZE).
// Kept as a client constant because $lib/server/* is server-only.
const MAX_FILE_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

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

function showDropError(message: string) {
	dropError = message;
	if (dropErrorTimer) clearTimeout(dropErrorTimer);
	// Auto-dismiss after a short delay so the message doesn't linger forever.
	dropErrorTimer = setTimeout(() => {
		dropError = null;
		dropErrorTimer = null;
	}, 6000);
}

async function handleDrop(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	isDragOver = false;
	dragCounter = 0;

	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;

	const { valid, rejectedUnsupportedType, rejectedTooLarge } =
		partitionUploadableFiles(Array.from(files), {
			acceptedTypes: acceptedFileTypes,
			maxFileSizeBytes: MAX_FILE_UPLOAD_SIZE_BYTES,
		});

	// Surface rejections to the user. If some files were fine we still upload
	// them; only fully-invalid batches are aborted.
	if (rejectedTooLarge.length > 0) {
		showDropError(
			$t("knowledge.dropFileTooLarge", {
				limit: formatByteSize(MAX_FILE_UPLOAD_SIZE_BYTES, {
					trimWholeUnits: true,
				}),
			}),
		);
	} else if (rejectedUnsupportedType.length > 0 && valid.length === 0) {
		showDropError($t("knowledge.dropNoValidFiles"));
	}

	if (valid.length === 0) return;

	await processUpload(valid);
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

function handleSortSelectChange(event: Event) {
	const nextSortKey = (event.currentTarget as HTMLSelectElement)
		.value as DocumentSortKey;
	toggleSort(nextSortKey);
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

	next.add(documentId);
	expandedAiVersions = next;

	if (aiVersionContent[promptArtifactId]) return;

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
				error: text ? null : $t("knowledge.aiVersionNoContent"),
			},
		};
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return;
		aiVersionContent = {
			...aiVersionContent,
			[promptArtifactId]: {
				loading: false,
				text: null,
				error:
					error instanceof Error
						? error.message
						: $t("knowledge.aiVersionLoadFailed"),
			},
		};
	} finally {
		if (aiVersionAborts.get(promptArtifactId) === controller) {
			aiVersionAborts.delete(promptArtifactId);
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

function getFileIcon(
	mimeType: string | null,
	filename: string,
): typeof FileIcon {
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

	return FileIcon;
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
	{#if dropError}
		<div class="drop-error" role="alert" data-testid="drop-error">
			{dropError}
		</div>
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
				{#if loading}
					<span class="search-spinner" aria-hidden="true">
						<Loader size={15} strokeWidth={2} class="animate-spin" aria-hidden="true" />
					</span>
				{/if}
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

			<div class="mobile-sort-controls">
				<label class="mobile-sort-field">
					<span class="mobile-sort-label">{$t('knowledge.sortBy')}</span>
					<select
						class="mobile-sort-select"
						aria-label={$t('knowledge.sortBy')}
						value={activeSortKey}
						onchange={handleSortSelectChange}
					>
						<option value="date">{$t('knowledge.date')}</option>
						<option value="name">{$t('knowledge.name')}</option>
						<option value="type">{$t('knowledge.type')}</option>
						<option value="size">{$t('knowledge.size')}</option>
					</select>
				</label>
				<button
					type="button"
					class="mobile-sort-direction"
					aria-label={$t('knowledge.sortDirection')}
					title={$t('knowledge.sortDirection')}
					onclick={() => toggleSort(activeSortKey)}
				>
					<span aria-hidden="true">{getSortIndicator(activeSortKey)}</span>
				</button>
			</div>
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
									<div class="document-card-main">
										<div class="document-name">
											{#if document.isOriginal}
												<span class="original-badge">{$t('knowledge.original')}</span>
											{:else if document.versionNumber != null && document.documentFamilyId}
												<span class="version-badge">v{document.versionNumber}</span>
											{/if}
											<span class="document-title">{document.name}</span>
											{#if document.documentFamilyStatus === 'historical'}
												<span class="historical-badge">{$t('knowledge.historical')}</span>
											{/if}
										</div>
										<div class="mobile-document-meta">
											{#if document.documentOrigin === 'skill_note' || document.type === 'skill_note'}
												<span class="type-badge type-skill-note">{$t('knowledge.skillNote')}</span>
											{:else if document.documentOrigin === 'generated' || document.type === 'generated_output'}
												<span class="type-badge type-generated">{$t('knowledge.generated')}</span>
											{:else}
												<span class="type-badge type-uploaded">{formatFileType(document.mimeType, document.name)}</span>
											{/if}
											<span>{formatByteSize(document.sizeBytes, { trimWholeUnits: true })}</span>
											<span>{formatMediumDateTime(document.createdAt)}</span>
										</div>
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
										{#if document.normalizedAvailable && document.promptArtifactId}
											<button
												type="button"
												class="action-btn action-btn-ai"
												data-testid="what-ai-sees-button"
												aria-label={expandedAiVersions.has(document.id)
													? $t('knowledge.hideAiVersion')
													: $t('knowledge.whatAiSees')}
												title={expandedAiVersions.has(document.id)
													? $t('knowledge.hideAiVersion')
													: $t('knowledge.whatAiSees')}
												onclick={(e) => {
													e.stopPropagation();
													void toggleAiVersion(document.id, document.promptArtifactId!);
												}}
											>
												<Eye size={16} strokeWidth={2} aria-hidden="true" />
											</button>
										{/if}
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
											<div class="ai-version-header">
												<h4 class="ai-version-label">{$t('knowledge.whatAiSees')}</h4>
												<p class="ai-version-explainer">{$t('knowledge.whatAiSeesDescription')}</p>
											</div>
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
						<button
							type="button"
							class="bulk-btn bulk-btn-secondary bulk-select-all"
							data-testid="bulk-select-all"
							onclick={toggleSelectAll}
							aria-pressed={isAllSelected}
						>
							{$t('knowledge.selectAllCounted', { count: paginatedDocuments.length })}
						</button>
					</div>
					<div class="bulk-actions">
						<button
							type="button"
							class="bulk-btn bulk-btn-danger"
							onclick={handleBulkDelete}
							disabled={!onBulkDelete}
						>
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
						<span class="pagination-range">{$t('knowledge.showing', { from: showingFrom, to: showingTo, total: displayDocumentCount })}</span>
						<label class="page-size-control">
							<span class="page-size-label">{$t('knowledge.itemsPerPage')}</span>
							<select
								class="page-size-select"
								aria-label={$t('knowledge.itemsPerPage')}
								value={paginationLimit}
								onchange={(e) => onPaginationLimitChange?.(parseInt((e.currentTarget as HTMLSelectElement).value))}
							>
								<option value={20}>20</option>
								<option value={50}>50</option>
								<option value={100}>100</option>
							</select>
						</label>
					</div>
					<div class="pagination-controls">
						<button
							type="button"
							class="pagination-btn"
							aria-label={$t('knowledge.previousPage')}
							disabled={currentPage <= 1}
							onclick={() => onPageChange?.(currentPage - 1)}
						>
						<ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
						</button>
						<span class="page-info">{$t('knowledge.pageInfo', { current: currentPage, total: totalPages })}</span>
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

	.drop-error {
		display: flex;
		align-items: center;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
		background: color-mix(in srgb, var(--danger) 8%, var(--surface-elevated));
		color: var(--danger);
		font-size: 0.8125rem;
		line-height: 1.4;
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
		padding: var(--space-md) var(--space-lg);
		border: 1px solid var(--border-default);
		border-radius: 1rem;
		background: var(--surface-elevated);
	}

	.search-controls {
		display: flex;
		flex: 1 1 18rem;
		max-width: 30rem;
		min-width: 14rem;
		position: relative;
		align-items: center;
	}

	.documents-search-input {
		width: 100%;
		padding: 0.58rem 0.74rem;
		border: 1px solid var(--border-default);
		border-radius: 0.7rem;
		background: var(--surface-page);
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.search-spinner {
		position: absolute;
		right: 0.55rem;
		display: inline-flex;
		align-items: center;
		color: var(--icon-muted);
		pointer-events: none;
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
		width: 40px;
		height: 40px;
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
		border-radius: 1rem;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
	}

	/* Desktop: let the table grow with the page scroll instead of nesting its own
	   inner scroll container. The sticky header remains sticky against the page. */
	@media (min-width: 720px) {
		.table-container {
			max-height: none;
			overflow: visible;
		}

		.documents-table thead {
			position: sticky;
			top: 0;
			z-index: 10;
		}
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

	.mobile-sort-controls {
		display: none;
	}

	.mobile-sort-field {
		display: none;
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
		width: 20px;
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
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		min-width: 0;
	}

	.document-card-main {
		min-width: 0;
	}

	.mobile-document-meta {
		display: none;
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
		width: 112px;
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

	.action-btn-ai:hover {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
	}

	.action-btn-ai:active {
		background: color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.ai-version-row {
		background: color-mix(in srgb, var(--surface-page) 94%, var(--accent) 6%);
	}

	.ai-version-cell {
		padding: var(--space-sm) var(--space-lg) var(--space-md) var(--space-lg);
	}

	.ai-version-panel {
		display: flex;
		max-height: 320px;
		flex-direction: column;
		gap: var(--space-md);
		overflow-y: auto;
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.ai-version-label {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent);
	}

	.ai-version-explainer {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.ai-version-content {
		margin: 0;
		padding: var(--space-md);
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-wrap: break-word;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.55;
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
		color: var(--danger);
	}

	.ai-version-empty {
		font-size: 0.8125rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.pagination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-md) var(--space-lg);
		border-radius: 1rem;
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

	.page-size-control {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.page-size-label {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.page-size-select {
		min-height: 40px;
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
		width: 40px;
		height: 40px;
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
		min-width: 44px;
		min-height: 44px;
		cursor: pointer;
	}

	.custom-checkbox {
		appearance: none;
		width: 20px;
		height: 20px;
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
		border-radius: 1rem;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		flex-wrap: wrap;
		gap: var(--space-md);
	}

	.bulk-info {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}

	.bulk-count {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.bulk-select-all {
		padding: 0.25rem 0.625rem;
		font-size: 0.8125rem;
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
		.documents-list-wrapper,
		.documents-list {
			min-width: 0;
			width: 100%;
			max-width: 100%;
			overflow-x: clip;
		}

		.filter-controls {
			flex-wrap: wrap;
			align-items: stretch;
			padding: var(--space-sm);
			border-radius: var(--radius-md);
		}

		.search-controls {
			flex: 1 1 auto;
			min-width: 0;
			max-width: none;
		}

		.upload-btn {
			width: 44px;
			height: 44px;
		}

		.mobile-sort-controls {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 44px;
			flex: 1 0 100%;
			gap: var(--space-xs);
			min-width: 0;
		}

		.mobile-sort-field {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: center;
			min-width: 0;
			min-height: 44px;
			gap: var(--space-xs);
			padding-left: 0.7rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-page);
		}

		.mobile-sort-label {
			font-size: 0.72rem;
			font-weight: 600;
			color: var(--text-muted);
			white-space: nowrap;
		}

		.mobile-sort-select,
		.mobile-sort-direction {
			min-height: 44px;
			background: var(--surface-page);
			color: var(--text-primary);
			font-size: 0.82rem;
		}

		.mobile-sort-select {
			min-width: 0;
			height: 42px;
			padding: 0 0.65rem;
			border: 0;
			border-radius: var(--radius-md);
		}

		.mobile-sort-direction {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			padding: 0;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			cursor: pointer;
		}

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
			display: none;
		}

		.documents-table tbody {
			display: flex;
			flex-direction: column;
			gap: var(--space-sm);
		}

		.documents-table .document-list-item {
			display: grid;
			grid-template-columns: 44px 34px minmax(0, 1fr);
			grid-template-areas:
				"check icon name"
				"actions actions actions";
			column-gap: 0.68rem;
			row-gap: 0.72rem;
			align-items: start;
			padding: 0.92rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-elevated);
			box-shadow: 0 1px 0 color-mix(in srgb, var(--border-subtle) 70%, transparent);
		}

		.documents-table td {
			padding: 0;
			border-bottom: 0;
		}

		.documents-table .col-checkbox {
			grid-area: check;
			width: 44px;
			margin: -0.55rem 0 -0.45rem -0.55rem;
		}

		.documents-table .col-icon {
			grid-area: icon;
			width: 34px;
			min-height: 34px;
			padding-top: 0;
			justify-self: center;
		}

		.file-icon {
			width: 34px;
			height: 34px;
			border-radius: var(--radius-md);
			background: var(--surface-page);
			border: 1px solid var(--border-subtle);
			color: var(--icon-primary);
		}

		.documents-table .col-name {
			grid-area: name;
			min-width: 0;
			padding-top: 0.02rem;
		}

		.document-card-main {
			display: flex;
			min-width: 0;
			flex-direction: column;
			gap: 0.56rem;
		}

		.document-name {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-start;
			min-width: 0;
			gap: 0.36rem 0.48rem;
			font-size: 0.92rem;
			line-height: 1.34;
		}

		.document-title {
			flex: 1 1 100%;
			min-width: 0;
			overflow-wrap: anywhere;
		}

		.documents-table .col-type {
			display: none;
		}

		.documents-table .col-size {
			display: none;
		}

		.documents-table .col-date {
			display: none;
		}

		.documents-table .col-actions {
			grid-area: actions;
			width: 100%;
			padding-top: 0.16rem;
		}

		.mobile-document-meta {
			display: inline-flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.42rem;
			max-width: 100%;
			font-size: 0.75rem;
			line-height: 1.2;
			color: var(--text-secondary);
		}

		.mobile-document-meta > span:not(.type-badge) {
			display: inline-flex;
			align-items: center;
			min-height: 1.5rem;
			padding: 0.18rem 0.44rem;
			border-radius: var(--radius-sm);
			border: 1px solid var(--border-subtle);
			background: var(--surface-page);
			white-space: nowrap;
		}

		.ai-version-row {
			display: block;
			margin-top: calc(-1 * var(--space-xs));
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: color-mix(in srgb, var(--surface-page) 94%, var(--accent) 6%);
		}

		.ai-version-row > td {
			display: none;
		}

		.ai-version-row > .ai-version-cell {
			display: block;
			padding: var(--space-sm);
		}

		.ai-version-panel {
			max-height: min(360px, 58vh);
			gap: var(--space-sm);
		}

		.ai-version-content {
			padding: var(--space-sm);
			font-size: 0.76rem;
		}

		.type-badge,
		.version-badge,
		.original-badge,
		.historical-badge {
			letter-spacing: 0.02em;
			white-space: nowrap;
			flex: 0 0 auto;
			width: max-content;
			max-width: none;
			overflow: visible;
		}

		.action-buttons {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: var(--space-xs);
			justify-content: stretch;
			padding-top: 0.1rem;
		}

		.action-btn {
			width: 100%;
			min-height: 44px;
			background: var(--surface-page);
			border: 1px solid var(--border-subtle);
		}

		.page-size-select,
		.pagination-btn,
		.bulk-btn {
			min-height: 44px;
		}

		.pagination-btn,
		.bulk-btn {
			min-width: 44px;
		}

		.bulk-action-bar,
		.pagination {
			border-radius: var(--radius-md);
			padding: var(--space-sm);
		}

		.bulk-actions {
			width: 100%;
			justify-content: space-between;
		}

		.pagination {
			display: grid;
			grid-template-columns: 1fr;
			gap: 0.7rem;
			align-items: stretch;
		}

		.pagination-info {
			display: grid;
			grid-template-columns: 1fr;
			width: 100%;
			gap: 0.55rem;
			align-items: stretch;
		}

		.pagination-range {
			min-width: 0;
			overflow-wrap: anywhere;
		}

		.page-size-control {
			display: flex;
			justify-content: space-between;
			width: 100%;
			min-height: 44px;
			gap: var(--space-sm);
			padding: 0.28rem 0.32rem 0.28rem 0.72rem;
			border: 1px solid var(--border-subtle);
			border-radius: var(--radius-md);
			background: var(--surface-page);
			white-space: nowrap;
		}

		.page-size-label {
			position: static;
			width: auto;
			height: auto;
			margin: 0;
			overflow: visible;
			clip: auto;
			border: 0;
		}

		.pagination-controls {
			display: grid;
			grid-template-columns: 44px minmax(0, 1fr) 44px;
			width: 100%;
			gap: var(--space-xs);
			align-items: center;
			padding: 0.32rem;
			border: 1px solid var(--border-subtle);
			border-radius: var(--radius-md);
			background: var(--surface-page);
		}

		.page-info {
			min-width: 0;
			overflow-wrap: anywhere;
			text-align: center;
		}
	}
</style>
