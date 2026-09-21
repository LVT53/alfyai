<script lang="ts">
import { tick } from "svelte";
import { createExtractionAnnouncer } from "$lib/client/extraction-announcements";
import { prewarmDocumentPreview } from "$lib/client/document-preview-prewarm";
import type { KnowledgeDocumentItem } from "./documents-table";
import {
	partitionUploadableFiles,
	type UploadTypeRefusal,
} from "$lib/utils/file-drag";
import { UPLOAD_REJECT_I18N_KEYS } from "$lib/utils/clipboard-attachments";
import {
	buildAcceptAttribute,
	fileExtension,
	getCategory,
	getEntryByFilename,
	getEntryByMimeType,
	type FileTypeCategory,
} from "$lib/shared/file-types";
import { disabledFileTypeIds } from "$lib/stores/upload-format-gate";
import {
	maxFileUploadSizeBytes,
	maxFileUploadSizeMb,
} from "$lib/stores/upload-limits";
import { formatByteSize } from "$lib/utils/format";
import { formatMediumDateTime } from "$lib/utils/time";
import { type I18nKey, t } from "$lib/i18n";
import {
	ArrowDown,
	ArrowUp,
	Archive,
	ChevronLeft,
	ChevronRight,
	Code,
	Download,
	Eye,
	File as FileIcon,
	FileText,
	Image,
	Monitor,
	Table,
	Trash2,
	Upload,
	RotateCw,
	X,
} from "@lucide/svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";
import {
	canCancelExtraction,
	canOpenDocument,
	canRetryExtraction,
	compareDocuments,
	deriveDocumentStatus,
	deriveDocumentVersion,
	extractionDetailKey,
	extractionStatusKey,
	getDocumentKind,
	hasNormalisedVersion,
	isExtractionInProgress,
	nextSortDirection,
} from "./documents-table";

// Version is a column but not a sort key: the server-side library sort
// (see +page.server.ts) offers name/size/type/date only, and a client-side
// version sort would silently reorder one page out of six.
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
	/**
	 * Called with the SOURCE artifact id (`displayArtifactId`) — the extraction
	 * ledger is keyed on the artifact, not on the job, so a pre-ledger document
	 * with a synthesised job id can still be retried.
	 */
	onRetryExtraction?: (artifactId: string) => void | Promise<void>;
	onCancelExtraction?: (artifactId: string) => void | Promise<void>;
	/**
	 * "Read this document again, better." Only ever called with a tier the
	 * server itself offered through `onLoadReextractTiers`.
	 */
	onReextract?: (artifactId: string, tier: string) => void | Promise<void>;
	/**
	 * The tiers the backend serves. Asked for when a menu opens rather than
	 * with the page: the answer costs a capability probe and is the same for
	 * every row, so a library nobody re-extracts pays nothing for it.
	 */
	onLoadReextractTiers?: (artifactId: string) => Promise<string[]>;
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
	onRetryExtraction,
	onCancelExtraction,
	onReextract,
	onLoadReextractTiers,
}: DocumentsListProps = $props();

// Artifact ids with a Retry/Cancel round trip in flight. Local to the row so
// a slow endpoint disables exactly the button that was pressed, and so a
// double click cannot enqueue the same action twice.
let extractionActionIds = $state<Set<string>>(new Set());

// The polite live region's one sentence. The list re-renders on every poll,
// so this is driven by `changed()` rather than by the rows themselves: a
// region bound to the DTO would read the same status back at a screen-reader
// user once a second for the whole length of a read.
let extractionAnnouncement = $state("");
const extractionAnnouncer = createExtractionAnnouncer();

$effect(() => {
	const changed = extractionAnnouncer.changed(
		documents.flatMap((document) =>
			document.extraction
				? [
						{
							artifactId: document.displayArtifactId,
							name: document.name,
							job: document.extraction,
						},
					]
				: [],
		),
	);
	if (changed.length === 0) return;
	// One string for the whole batch, so five documents settling together is
	// one announcement rather than five.
	extractionAnnouncement = changed
		.map(
			(entry) => `${entry.name}: ${$t(extractionStatusKey(entry.job.status))}`,
		)
		.join(". ");
});

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

// The per-file upload limit and the accepted types both come from one place
// now: the store the SSR shell and every upload intent write to, and the
// shared file-type registry. The literals they replaced were the fourth copy
// of 100 MB and the only hand-maintained accept string in the app.
//
// Phase 5: no longer a `const`. The MinerU-4 gate (spec D6) can narrow the
// offered set at runtime, so the `<input accept>` and the drop filter below
// both read THIS derived string — one source, and they cannot disagree about
// what the page offers. An open gate (the default, and the failure mode)
// yields the memoised full string.
let acceptedFileTypes = $derived(
	buildAcceptAttribute("knowledge", $disabledFileTypeIds),
);

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

/**
 * What a fully refused drop says.
 *
 * A drop that failed for ONE reason gets that reason's own sentence — the
 * same one the upload endpoint would have answered with, and the one that
 * ends in what to do instead ("Unpack it and upload the files inside.").
 * Anything else keeps the generic line: a batch refused for three different
 * reasons has no single remedy, and presenting one file's problem as the
 * batch's would be worse than saying less.
 *
 * The count matters because two of the four messages name a file: they are
 * used for a batch only when every file in it also shares an extension, so
 * "EPUB files aren't supported yet" is true of all of them.
 */
function dropRefusalMessage(refusals: readonly UploadTypeRefusal[]): string {
	const first = refusals[0];
	if (!first) return $t("knowledge.dropNoValidFiles");

	const oneReason = refusals.every(
		(refusal) => refusal.reason === first.reason,
	);
	const speaksForAll =
		refusals.length === 1 ||
		refusals.every((refusal) => refusal.ext === first.ext);
	if (!oneReason || !speaksForAll) return $t("knowledge.dropNoValidFiles");

	return $t(UPLOAD_REJECT_I18N_KEYS[first.reason] as I18nKey, {
		name: first.name,
		ext: first.ext,
	});
}

async function handleDrop(event: DragEvent) {
	event.preventDefault();
	event.stopPropagation();
	isDragOver = false;
	dragCounter = 0;

	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;

	const { valid, rejectedUnsupportedType, rejectedTooLarge, refusals } =
		partitionUploadableFiles(Array.from(files), {
			acceptedTypes: acceptedFileTypes,
			maxFileSizeBytes: $maxFileUploadSizeBytes,
		});

	// Surface rejections to the user. If some files were fine we still upload
	// them; only fully-invalid batches are aborted.
	if (rejectedTooLarge.length > 0) {
		showDropError(
			$t("knowledge.dropFileTooLarge", {
				limit: formatByteSize($maxFileUploadSizeBytes, {
					trimWholeUnits: true,
				}),
			}),
		);
	} else if (rejectedUnsupportedType.length > 0 && valid.length === 0) {
		showDropError(dropRefusalMessage(refusals));
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

// ---- sticky column header ------------------------------------------------
// The header pins to the top of whatever scrolls this page. It only earns its
// shadow once it is actually pinned, so a table read from the top is a flat
// card and a table scrolled into is a header over rows.
let stickySentinel = $state<HTMLElement | null>(null);
let headerStuck = $state(false);

function scrollParentOf(element: HTMLElement): HTMLElement | null {
	let node = element.parentElement;
	while (node) {
		const overflowY = getComputedStyle(node).overflowY;
		if (/(auto|scroll|overlay)/.test(overflowY)) return node;
		node = node.parentElement;
	}
	return null;
}

$effect(() => {
	const sentinel = stickySentinel;
	if (!sentinel || typeof IntersectionObserver === "undefined") return;
	const observer = new IntersectionObserver(
		(entries) => {
			const entry = entries[entries.length - 1];
			if (!entry) return;
			headerStuck = !entry.isIntersecting && entry.boundingClientRect.top <= 0;
		},
		{ root: scrollParentOf(sentinel), threshold: 0 },
	);
	observer.observe(sentinel);
	return () => observer.disconnect();
});

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

const sortedDocuments = $derived.by(() => {
	if (serverManaged) {
		return documents;
	}
	const entries = [...searchedDocuments];

	entries.sort((leftEntry, rightEntry) => {
		// When searching, preserve relevance as highest priority.
		if (
			localSearchQuery.trim().length > 0 &&
			leftEntry.score !== rightEntry.score
		) {
			return rightEntry.score - leftEntry.score;
		}
		return compareDocuments(
			leftEntry.document,
			rightEntry.document,
			activeSortKey,
			activeSortDirection,
		);
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
	const nextDirection = nextSortDirection(
		activeSortKey,
		activeSortDirection,
		nextSortKey,
	);
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

/**
 * The type badge. NOT the canonical extension: canonicalising would print
 * "JPG" for a .jpeg and "MD" for a .markdown, which the old hand-written
 * chain never did. The file's own extension is the label; the registry is
 * consulted only for the one case the old code special-cased (.htm shows
 * "HTML") and for a file with no extension at all.
 */
function formatFileType(mimeType: string | null, filename: string): string {
	const extension = fileExtension(filename);
	if (!extension) {
		const byMime = getEntryByMimeType(mimeType);
		return byMime ? byMime.extensions[0].toUpperCase() : "FILE";
	}
	if (getEntryByFilename(filename)?.preview.kind === "html") return "HTML";
	return extension.toUpperCase();
}

/**
 * This list's glyph vocabulary. The registry stores a neutral `category` and
 * leaves the icon to the surface (spec conflict 8), so this record is the
 * whole of what used to be a 90-line `getFileIcon` chain. `media` and `other`
 * keep the generic glyph. Once slice B's `FileTypeIcon` takes a
 * `FileTypeCategory`, this record and the Lucide imports collapse into it.
 */
const CATEGORY_TO_ICON: Record<FileTypeCategory, typeof FileIcon> = {
	image: Image,
	pdf: FileText,
	spreadsheet: Table,
	presentation: Monitor,
	document: FileText,
	text: FileText,
	code: Code,
	archive: Archive,
	media: FileIcon,
	other: FileIcon,
};

function getFileIcon(
	mimeType: string | null,
	filename: string,
): typeof FileIcon {
	return CATEGORY_TO_ICON[getCategory(filename, mimeType)];
}

function handleRowClick(event: MouseEvent, document: KnowledgeDocumentItem) {
	// Don't trigger if clicking on row actions or selection controls
	if (
		(event.target as HTMLElement).closest(
			"button, input, label, .checkbox-label",
		)
	)
		return;
	openDocument(document);
}

// A document the reader has not finished with has no AI-facing version yet.
// Opening it would show an empty workspace, which reads as "this file is
// broken" rather than "this file is not ready", so the row stays inert until
// the ledger settles.
function openDocument(document: KnowledgeDocumentItem) {
	if (!canOpenDocument(document)) return;
	onSelect?.(document);
}

async function runExtractionAction(
	event: MouseEvent,
	artifactId: string,
	action: ((artifactId: string) => void | Promise<void>) | undefined,
) {
	event.stopPropagation();
	if (!action || extractionActionIds.has(artifactId)) return;
	// Retry requeues the job, so the button that was pressed usually unmounts
	// with the verdict that justified it. Remember the row: it is focusable in
	// its own right, and it is where a keyboard user should land rather than
	// on `<body>` at the top of the page.
	const row = (event.currentTarget as HTMLElement | null)?.closest("tr");
	extractionActionIds = new Set(extractionActionIds).add(artifactId);
	try {
		await action(artifactId);
	} finally {
		const next = new Set(extractionActionIds);
		next.delete(artifactId);
		extractionActionIds = next;
		await tick();
		restoreRowFocus(row);
	}
}

// ── Re-extract at a different quality ──────────────────────────────────────

/**
 * The tiers, worst to best. The menu is ordered by this rather than by the
 * server's reply so the list reads as a ladder, and so "everything at or below
 * where this document already is" is a prefix rather than a set membership
 * test.
 */
const REEXTRACT_TIERS = ["flash", "basic", "standard", "advanced"] as const;
const REEXTRACT_TIER_KEYS = {
	flash: "knowledge.extraction.reextract.tier.flash",
	basic: "knowledge.extraction.reextract.tier.basic",
	standard: "knowledge.extraction.reextract.tier.standard",
	advanced: "knowledge.extraction.reextract.tier.advanced",
} as const satisfies Record<(typeof REEXTRACT_TIERS)[number], I18nKey>;

type ReextractTierState =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "ready"; tiers: string[] };

// One open menu at a time, keyed on the artifact. Tier lists are cached per
// artifact for the life of the page: they come from one server-wide probe, and
// re-asking on every open would make the menu feel slower than it is.
let reextractMenuId = $state<string | null>(null);
let reextractTiers = $state<Record<string, ReextractTierState>>({});

/**
 * Re-extraction is a MinerU-route promise: a direct-text upload has no tiers
 * to choose between, and a generated output has no source bytes at all. A row
 * with no producer recorded is a pre-Phase-4 document, which is exactly the
 * case this action exists for (D12 — no automatic backfill).
 */
function canReextractDocument(document: KnowledgeDocumentItem): boolean {
	const job = document.extraction;
	if (!job || isExtractionInProgress(document)) return false;
	if (job.intakeRoute !== "mineru") return false;
	const producer = document.extractionProducer;
	return !producer || producer === "mineru";
}

function isKnownReextractTier(
	tier: string,
): tier is (typeof REEXTRACT_TIERS)[number] {
	return (REEXTRACT_TIERS as readonly string[]).includes(tier);
}

/** Server order is ignored; the ladder's order is the one a user reads. */
function orderedReextractTiers(tiers: string[]): string[] {
	return REEXTRACT_TIERS.filter((tier) => tiers.includes(tier));
}

/**
 * A second guard, not the only one. `GET .../reextract` now filters the list
 * down to tiers strictly ABOVE the document's own, and POST refuses a lower or
 * equal one outright, so this normally has nothing left to disable. It stays
 * for a row whose `extractionTier` is fresher than the tier list beside it —
 * then the menu says "already at this quality" rather than offering a request
 * the server will refuse.
 */
function isReextractTierDisabled(
	document: KnowledgeDocumentItem,
	tier: string,
): boolean {
	const current = document.extractionTier;
	if (!current || !isKnownReextractTier(current)) return false;
	return (
		REEXTRACT_TIERS.indexOf(tier as (typeof REEXTRACT_TIERS)[number]) <=
		REEXTRACT_TIERS.indexOf(current)
	);
}

async function toggleReextractMenu(event: MouseEvent, artifactId: string) {
	event.stopPropagation();
	if (reextractMenuId === artifactId) {
		reextractMenuId = null;
		return;
	}
	reextractMenuId = artifactId;
	if (reextractTiers[artifactId]?.kind === "ready") return;
	if (!onLoadReextractTiers) {
		reextractTiers = { ...reextractTiers, [artifactId]: { kind: "error" } };
		return;
	}
	reextractTiers = { ...reextractTiers, [artifactId]: { kind: "loading" } };
	try {
		const tiers = await onLoadReextractTiers(artifactId);
		reextractTiers = {
			...reextractTiers,
			[artifactId]: { kind: "ready", tiers },
		};
	} catch {
		// The reason is the page's to report (it owns the error banner); the
		// menu only has to stop claiming it is still loading.
		reextractTiers = { ...reextractTiers, [artifactId]: { kind: "error" } };
	}
}

function closeReextractMenu(artifactId: string, refocus = true) {
	if (reextractMenuId !== artifactId) return;
	reextractMenuId = null;
	if (!refocus) return;
	const toggle = document.querySelector<HTMLButtonElement>(
		`[data-reextract-toggle="${CSS.escape(artifactId)}"]`,
	);
	toggle?.focus();
}

async function chooseReextractTier(
	event: MouseEvent,
	document_: KnowledgeDocumentItem,
	tier: string,
) {
	event.stopPropagation();
	const artifactId = document_.displayArtifactId;
	if (!onReextract || extractionActionIds.has(artifactId)) return;
	reextractMenuId = null;
	const row = (event.currentTarget as HTMLElement | null)?.closest("tr");
	extractionActionIds = new Set(extractionActionIds).add(artifactId);
	try {
		await onReextract(artifactId, tier);
		// The status announcer only speaks when a job's STATUS changes, and a
		// document going from "Ready" to "Queued" via a menu the user just used
		// deserves a sentence of its own.
		extractionAnnouncement = $t("knowledge.extraction.reextract.queued", {
			name: document_.name,
			tier: isKnownReextractTier(tier) ? $t(REEXTRACT_TIER_KEYS[tier]) : tier,
		});
	} finally {
		const next = new Set(extractionActionIds);
		next.delete(artifactId);
		extractionActionIds = next;
		await tick();
		restoreRowFocus(row);
	}
}

function restoreRowFocus(row: HTMLTableRowElement | null | undefined) {
	if (!row?.isConnected) return;
	const active = document.activeElement;
	// Still inside the row (the button survived, or the user moved on
	// themselves): leave it alone.
	if (active && active !== document.body && row.contains(active)) return;
	row.focus();
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

<!--
	One rendering of the Status cell, shared by the desktop column and the
	mobile meta line, so the two can never drift into saying different things
	about the same row.
-->
{#snippet statusContent(document: KnowledgeDocumentItem, badge: ReturnType<typeof deriveDocumentStatus>, busy: boolean, place: 'status' | 'meta')}
	{#if badge?.kind === 'extraction'}
		{@const job = badge.job}
		{@const detailKey = extractionDetailKey(job)}
		<span
			class="extraction-badge"
			class:is-working={job.status !== 'failed' && job.status !== 'canceled'}
			class:is-failed={job.status === 'failed'}
			class:is-canceled={job.status === 'canceled'}
			data-testid="extraction-status"
			data-extraction-status={job.status}
			title={detailKey ? $t(detailKey) : undefined}
		>
			{#if job.status !== 'failed' && job.status !== 'canceled'}
				<Spinner size={12} />
			{/if}
			{$t(extractionStatusKey(job.status))}
		</span>
		{#if detailKey}
			<span class="extraction-detail">{$t(detailKey)}</span>
		{/if}
		{#if job.attemptCount > 1 && job.status !== 'succeeded'}
			<span class="extraction-attempt">
				{$t('knowledge.extraction.attempt', {
					current: job.attemptCount,
					max: job.maxAttempts,
				})}
			</span>
		{/if}
		<span class="extraction-actions">
			{#if canRetryExtraction(document)}
				<button
					type="button"
					class="extraction-action"
					data-testid={`extraction-retry-${place}`}
					disabled={busy}
					aria-busy={busy}
					aria-label={$t('knowledge.extraction.retryLabel', { name: document.name })}
					title={$t('knowledge.extraction.retryLabel', { name: document.name })}
					onclick={(e) => runExtractionAction(e, document.displayArtifactId, onRetryExtraction)}
				>
					<RotateCw size={13} strokeWidth={2} aria-hidden="true" />
					{busy ? $t('knowledge.extraction.busy') : $t('knowledge.extraction.retry')}
				</button>
			{/if}
			{#if canCancelExtraction(document)}
				<button
					type="button"
					class="extraction-action"
					data-testid={`extraction-cancel-${place}`}
					disabled={busy}
					aria-busy={busy}
					aria-label={$t('knowledge.extraction.cancelLabel', { name: document.name })}
					title={$t('knowledge.extraction.cancelLabel', { name: document.name })}
					onclick={(e) => runExtractionAction(e, document.displayArtifactId, onCancelExtraction)}
				>
					<X size={13} strokeWidth={2} aria-hidden="true" />
					{busy ? $t('knowledge.extraction.busy') : $t('knowledge.extraction.cancel')}
				</button>
			{/if}
		</span>
	{:else if badge?.kind === 'family' && badge.value === 'historical'}
		<span class="historical-badge">{$t('knowledge.historical')}</span>
	{:else if badge?.kind === 'family'}
		<span class="status-badge">{$t('knowledge.statusCurrent')}</span>
	{/if}
{/snippet}

<!--
	"Re-extract at a different quality". Lives in the Actions column rather than
	beside Retry/Cancel because those two only exist while the Status cell has a
	verdict to show, and the document this action is for is usually one that
	succeeded — the Status cell has already moved on.
-->
{#snippet reextractAction(document: KnowledgeDocumentItem, busy: boolean)}
	{@const artifactId = document.displayArtifactId}
	{@const open = reextractMenuId === artifactId}
	{@const state = reextractTiers[artifactId]}
	<div class="reextract-wrap">
		<button
			type="button"
			class="action-btn"
			class:is-open={open}
			data-testid="extraction-reextract-toggle"
			data-reextract-toggle={artifactId}
			disabled={busy}
			aria-busy={busy}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label={$t('knowledge.extraction.reextract.label', { name: document.name })}
			title={$t('knowledge.extraction.reextract.label', { name: document.name })}
			onclick={(e) => void toggleReextractMenu(e, artifactId)}
		>
			<RotateCw size={16} strokeWidth={2} aria-hidden="true" />
		</button>
		{#if open}
			<div
				class="reextract-menu"
				role="menu"
				tabindex="-1"
				data-testid="extraction-reextract-menu"
				aria-label={$t('knowledge.extraction.reextract.menuLabel')}
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation();
						closeReextractMenu(artifactId);
					}
				}}
			>
				<p class="reextract-menu-label">{$t('knowledge.extraction.reextract.menuLabel')}</p>
				{#if !state || state.kind === 'loading'}
					<p class="reextract-menu-note">{$t('knowledge.extraction.reextract.loading')}</p>
				{:else if state.kind === 'error'}
					<p class="reextract-menu-note">{$t('knowledge.extraction.reextract.failed')}</p>
				{:else}
					{@const tiers = orderedReextractTiers(state.tiers)}
					{#if tiers.length === 0}
						<p class="reextract-menu-note">{$t('knowledge.extraction.reextract.empty')}</p>
					{:else}
						{#each tiers as tier (tier)}
							{@const current = document.extractionTier === tier}
							<button
								type="button"
								role="menuitem"
								class="reextract-menu-item"
								data-testid={`extraction-reextract-tier-${tier}`}
								disabled={busy || isReextractTierDisabled(document, tier)}
								aria-current={current ? 'true' : undefined}
								onclick={(e) => void chooseReextractTier(e, document, tier)}
							>
								<span>{$t(REEXTRACT_TIER_KEYS[tier as keyof typeof REEXTRACT_TIER_KEYS])}</span>
								{#if current}
									<span class="reextract-menu-current"
										>{$t('knowledge.extraction.reextract.current')}</span
									>
								{/if}
							</button>
						{/each}
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<svelte:window
	onclick={() => {
		if (reextractMenuId) closeReextractMenu(reextractMenuId, false);
	}}
/>

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
	<!-- The Status column, spoken once per real change. A badge that swaps
	     "Reading" for "Ready" is invisible to a screen reader otherwise. -->
	<div
		class="sr-only"
		role="status"
		aria-live="polite"
		data-testid="documents-extraction-announcer"
	>
		{extractionAnnouncement}
	</div>

	<!-- Drop zone overlay - desktop only -->
	{#if isDragOver}
		<div class="drop-zone-overlay" data-testid="drop-zone-overlay">
			<div class="drop-zone-content">
				<div class="drop-zone-icon">
					<Upload size={18} strokeWidth={1.5} aria-hidden="true" />
				</div>
				<p class="drop-zone-text">{$t('knowledge.dropFiles', { max: $maxFileUploadSizeMb })}</p>
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
						<Spinner size={15} />
					</span>
				{/if}
			</div>

			<span class="filter-spacer"></span>

			<div class="sort-controls">
				<label class="sort-field">
					<span class="sort-label">{$t('knowledge.sortByShort')}</span>
					<select
						class="sort-select"
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
					class="sort-direction"
					data-testid="sort-direction"
					aria-label={activeSortDirection === 'asc'
						? $t('knowledge.sortAscending')
						: $t('knowledge.sortDescending')}
					title={$t('knowledge.sortDirection')}
					onclick={() => toggleSort(activeSortKey)}
				>
					{#if activeSortDirection === 'asc'}
						<ArrowUp size={13} strokeWidth={2.2} aria-hidden="true" />
					{:else}
						<ArrowDown size={13} strokeWidth={2.2} aria-hidden="true" />
					{/if}
				</button>
			</div>

			<!-- Last in the row, beside Sort: the toolbar reads search · sort ·
			     act, and the one thing that writes to the library sits where a
			     primary action is looked for. Its tooltip carries the per-file
			     size limit that the removed drop-hint row used to print. -->
			{#if onUpload}
				<button
					type="button"
					class="upload-btn"
					aria-label={$t('knowledge.upload')}
					title={$t('knowledge.uploadLimitTooltip', {
						limit: formatByteSize($maxFileUploadSizeBytes, {
							trimWholeUnits: true,
						}),
					})}
					disabled={isUploading}
					onclick={handleUploadClick}
				>
					{#if isUploading}
						<Spinner size={16} />
					{:else}
						<Upload size={16} strokeWidth={2} aria-hidden="true" />
					{/if}
					<span class="upload-btn-label">{$t('knowledge.upload')}</span>
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
				<!-- A zero-height mark at the very top of the card. Once it has
				     scrolled out of the scroll container the header is pinned,
				     and it says so with a shadow. -->
				<div
					class="sticky-sentinel"
					bind:this={stickySentinel}
					aria-hidden="true"
				></div>
				<table class="documents-table">
					<thead class:is-stuck={headerStuck} data-testid="documents-table-head">
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
								<button
									type="button"
									class="sort-button"
									class:is-active={activeSortKey === 'name'}
									onclick={() => toggleSort('name')}
								>
									{$t('knowledge.name')} <span class="sort-indicator">{getSortIndicator('name')}</span>
								</button>
							</th>
							<th class="col-version" scope="col">{$t('knowledge.version')}</th>
							<th class="col-type" scope="col" aria-sort={getAriaSort('type')}>
								<button
									type="button"
									class="sort-button"
									class:is-active={activeSortKey === 'type'}
									onclick={() => toggleSort('type')}
								>
									{$t('knowledge.type')} <span class="sort-indicator">{getSortIndicator('type')}</span>
								</button>
							</th>
							<th class="col-status" scope="col">{$t('knowledge.status')}</th>
							<th class="col-size" scope="col" aria-sort={getAriaSort('size')}>
								<button
									type="button"
									class="sort-button"
									class:is-active={activeSortKey === 'size'}
									onclick={() => toggleSort('size')}
								>
									{$t('knowledge.size')} <span class="sort-indicator">{getSortIndicator('size')}</span>
								</button>
							</th>
							<th class="col-date" scope="col" aria-sort={getAriaSort('date')}>
								<button
									type="button"
									class="sort-button"
									class:is-active={activeSortKey === 'date'}
									onclick={() => toggleSort('date')}
								>
									{$t('knowledge.date')} <span class="sort-indicator">{getSortIndicator('date')}</span>
								</button>
							</th>
							<th class="col-actions" scope="col">{$t('knowledge.actions')}</th>
						</tr>
					</thead>
					<tbody>
						{#each paginatedDocuments as document (document.id)}
							{@const Icon = getFileIcon(document.mimeType, document.name)}
							{@const versionBadge = deriveDocumentVersion(document)}
							{@const statusBadge = deriveDocumentStatus(document)}
							{@const aiVersionAvailable = hasNormalisedVersion(document)}
							{@const extracting = isExtractionInProgress(document)}
							{@const extractionBusy = extractionActionIds.has(document.displayArtifactId)}
							<tr
								class="document-row document-list-item"
								class:selected={selectedIds.has(document.id)}
								class:is-extracting={extracting}
								onclick={(e) => handleRowClick(e, document)}
								onpointerenter={() => handleDocumentPreviewIntent(document)}
								onfocus={() => handleDocumentPreviewIntent(document)}
								tabindex="0"
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										openDocument(document);
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
											<span class="document-title">{document.name}</span>
										</div>
										<div class="mobile-document-meta">
											{#if versionBadge.kind === 'original'}
												<span class="original-badge">{$t('knowledge.original')}</span>
											{:else if versionBadge.kind === 'version'}
												<span class="version-badge">v{versionBadge.versionNumber}</span>
											{/if}
											{@render statusContent(document, statusBadge, extractionBusy, 'meta')}
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
								<td class="col-version" data-mobile-label={$t('knowledge.version')}>
									{#if versionBadge.kind === 'original'}
										<span class="original-badge">{$t('knowledge.original')}</span>
									{:else if versionBadge.kind === 'version'}
										<span class="version-badge">v{versionBadge.versionNumber}</span>
									{:else}
										<span class="cell-blank" aria-hidden="true">—</span>
									{/if}
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
								<td class="col-status" data-mobile-label={$t('knowledge.status')}>
									{#if statusBadge}
										{@render statusContent(document, statusBadge, extractionBusy, 'status')}
									{:else}
										<!-- No extraction verdict and no version family: neither
										     current nor historical, and nothing left to process. -->
										<span class="cell-blank" aria-hidden="true">—</span>
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
										{#if aiVersionAvailable}
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
										{:else}
											<!-- Kept as a greyed slot rather than removed, so the action
											     column does not jitter between rows and the absence is
											     explained on hover. -->
											{@const absenceReason = extracting
												? $t('knowledge.extraction.inProgressTooltip')
												: $t('knowledge.noNormalisedVersion')}
											<span
												class="action-btn action-btn-disabled"
												data-testid="what-ai-sees-disabled"
												title={absenceReason}
												aria-label={absenceReason}
												role="img"
											>
												<Eye size={16} strokeWidth={2} aria-hidden="true" />
											</span>
										{/if}
										{#if canReextractDocument(document)}
											{@render reextractAction(document, extractionBusy)}
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
									<td colspan="7" class="ai-version-cell">
										<div class="ai-version-panel">
											<div class="ai-version-header">
												<h4 class="ai-version-label">{$t('knowledge.whatAiSees')}</h4>
												<p class="ai-version-explainer">{$t('knowledge.whatAiSeesDescription')}</p>
											</div>
											{#if content?.loading}
												<div class="ai-version-loading">
													<Spinner size={16} />
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
				<div class="bulk-action-bar" role="toolbar" aria-label={$t('knowledge.bulkActionsLabel')}>
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
				<nav class="pagination" aria-label={$t('knowledge.paginationLabel')}>
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
	/* Announced, never drawn: the Status column already says this on screen. */
	.sr-only {
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

	.documents-list-wrapper {
		/* Every card on this tab — filter bar, table, bulk bar, pager, drop
		   overlay — is drawn at one radius rather than at four hand-typed
		   values that drifted apart (1rem, 1.2rem, --radius-md). */
		--knowledge-card-radius: 1rem;
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
		margin: 0;
		z-index: 100;
		background: color-mix(in srgb, var(--surface-elevated) 95%, transparent);
		border: 2px dashed
			color-mix(in srgb, var(--accent) 55%, var(--border-default) 45%);
		border-radius: var(--knowledge-card-radius);
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

	/* search · spacer · sort · upload. The spacer, not `space-between`: with
	   three groups on the row, space-between stranded Upload in the middle. */
	.filter-controls {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-start;
		padding: var(--space-md) var(--space-lg);
		border: 1px solid var(--border-default);
		border-radius: var(--knowledge-card-radius);
		background: var(--surface-elevated);
	}

	.filter-spacer {
		flex: 1 1 auto;
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 40px;
		padding: 0 0.85rem;
		border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		letter-spacing: 0.025em;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
		flex-shrink: 0;
	}

	@media (max-width: 900px) {
		.search-controls {
			flex-basis: 100%;
			max-width: 100%;
		}
	}

	.upload-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.upload-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.upload-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.upload-btn {
			transition: none !important;
		}
	}

	/* `clip`, not `hidden`: both crop the header's and the last row's corners
	   to the container's radius, but `hidden` makes the container a scroll
	   container, and a sticky header inside one stops sticking to the page.
	   `clip` is not a scroll container, so the corners read as one rounded box
	   AND the header still pins. */
	.table-container {
		border-radius: var(--knowledge-card-radius);
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		overflow: clip;
	}

	/* Desktop: let the table grow with the page scroll instead of nesting its own
	   inner scroll container. The sticky header remains sticky against the page. */
	@media (min-width: 720px) {
		.table-container {
			max-height: none;
		}

		.documents-table thead {
			position: sticky;
			top: 0;
			z-index: 10;
		}
	}

	/* Fixed layout, not auto: with nine columns an auto table sizes itself to
	   its widest cell and grows straight out of the card — at 1024px the old
	   auto table was 120px wider than the panel holding it. Fixed gives every
	   short column the room it needs and lets the name take whatever is left,
	   at any width, without a horizontal scrollbar and without giving up the
	   sticky header. */
	.documents-table {
		width: 100%;
		table-layout: fixed;
		border-collapse: collapse;
	}

	.sticky-sentinel {
		height: 0;
	}

	.documents-table thead {
		position: sticky;
		top: 0;
		z-index: 10;
	}

	/* The header band is painted on the cells, not on the <thead>: under
	   `border-collapse: collapse` a row's own background and border are the
	   first thing a browser drops. A band of the page surface over the card's
	   elevated surface is the same step the memory filter bar takes, and the
	   hairline is an inset shadow so it survives the collapse. */
	.documents-table thead th {
		background: var(--surface-page);
		box-shadow: inset 0 -1px 0 var(--border-default);
		transition: box-shadow var(--duration-standard) var(--ease-out);
	}

	/* Only once it is actually pinned. */
	.documents-table thead.is-stuck th {
		box-shadow:
			inset 0 -1px 0 var(--border-default),
			0 6px 10px -8px rgba(0, 0, 0, 0.35);
	}

	/* The band has to reach the card's rounded corners, and the container
	   clips the overhang. */
	.documents-table thead th:first-child {
		border-top-left-radius: var(--knowledge-card-radius);
	}

	.documents-table thead th:last-child {
		border-top-right-radius: var(--knowledge-card-radius);
	}

	/* Pinned, the card's top edge is somewhere above the viewport, so a
	   rounded band floating over square rows reads as a mistake. */
	.documents-table thead.is-stuck th:first-child,
	.documents-table thead.is-stuck th:last-child {
		border-top-left-radius: 0;
		border-top-right-radius: 0;
	}

	.documents-table th {
		padding: var(--space-sm) var(--space-md);
		text-align: left;
		font-size: 0.68rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--text-muted);
		vertical-align: middle;
	}

	/* Same grammar as the users table in settings: the header hovers to accent,
	   the column being sorted keeps the primary text colour, and the caret that
	   says which way is the only accent mark in the row. */
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
		border-radius: var(--radius-sm);
		transition: color var(--duration-standard) var(--ease-out);
	}

	.sort-button:hover {
		color: var(--accent);
	}

	.sort-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.sort-button.is-active {
		color: var(--text-primary);
	}

	.sort-indicator {
		font-size: 0.72rem;
		line-height: 1;
		opacity: 0.55;
	}

	.sort-button.is-active .sort-indicator {
		opacity: 1;
		color: var(--accent);
	}

	@media (prefers-reduced-motion: reduce) {
		.sort-button {
			transition: none !important;
		}
	}

	/* Sort control and its direction, on every width — the board puts them
	   beside the search box rather than hiding them behind a breakpoint. */
	.sort-controls {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}

	.sort-field {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}

	.sort-label {
		font-size: 0.72rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.sort-select {
		height: 2rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.76rem;
	}

	.sort-select:focus {
		outline: none;
		border-color: var(--accent);
	}

	.sort-direction {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	.sort-direction:hover,
	.sort-direction:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
	}

	/* An empty cell wears the same box as the badge it stands in for, with a
	   transparent border, so its dash starts on the badge's text origin
	   instead of 6px to its left. */
	.cell-blank {
		display: inline-flex;
		align-items: center;
		min-height: 1.35rem;
		padding: 0.125rem 0.375rem;
		border: 1px solid transparent;
		color: var(--text-muted);
		font-size: 0.8125rem;
		line-height: 1;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 1.35rem;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	/* The extraction ledger's verdict. It shares the Status column's badge
	   geometry so a row that is mid-extraction does not change the column's
	   height, and only the colour says which of the three moods it is in. */
	.extraction-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 1.35rem;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.extraction-badge.is-failed {
		border-color: var(--color-danger, var(--border-default));
		color: var(--color-danger, var(--text-muted));
	}

	.extraction-badge.is-canceled {
		border-style: dashed;
	}

	.extraction-detail,
	.extraction-attempt {
		display: block;
		margin-top: 0.2rem;
		color: var(--text-muted);
		font-size: 0.6875rem;
		line-height: 1.3;
		/* The failure sentence is the useful half of this cell — let it wrap
		   rather than truncating the reason a user is about to act on. */
		white-space: normal;
	}

	.extraction-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.extraction-action {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		padding: 0.125rem 0.35rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-primary);
		font-size: 0.6875rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.extraction-action:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.extraction-action:disabled {
		opacity: 0.55;
		cursor: default;
	}

	/* The row is not openable while the reader still owes it text; say so with
	   the cursor as well as with the tooltip on the greyed eye. */
	.document-row.is-extracting {
		cursor: default;
	}

	/* Greyed, not gone: the slot keeps the action column from jittering. At
	   0.25 it had all but vanished in dark, where it must still read as a
	   deliberate absence rather than a rendering fault. */
	.action-btn-disabled {
		opacity: 0.4;
		cursor: default;
	}

	@media (prefers-reduced-motion: reduce) {
		.sort-direction {
			transition: none !important;
		}
	}

	.documents-table td {
		padding: var(--space-md);
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
		background: color-mix(in srgb, var(--accent) 4%, transparent 96%);
	}

	:global(.dark) .document-row:hover {
		background: color-mix(in srgb, var(--accent) 7%, transparent 93%);
	}

	.document-row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	/* Version and Status are columns of their own now, so the row has nine
	   cells to fit inside the card. The two glyph columns give their padding
	   back, and the short columns refuse to wrap — a date broken over three
	   lines is what pushed the table past the card's edge. */
	/* Scoped through `.documents-table` so these beat the blanket
	   `.documents-table td` padding — at the generic 16px a 36px glyph column
	   has 4px of content left and the file icon collapses to a dot. */
	/* The two glyph columns, measured against each other rather than each
	   padded by feel. The tick box ends exactly on the checkbox cell's right
	   edge (0.75rem of padding + the 0.75rem the 44px hit area leaves around a
	   20px box), and the file glyph starts 0.75rem past it — left-aligned, so
	   that padding IS the gap. At the old values they were 5px apart and read
	   as one two-part control. Both stay on the row's middle line: the cells
	   are `vertical-align: middle` and both wrappers centre on the cross
	   axis. */
	.documents-table .col-checkbox {
		width: 2.75rem;
		padding-left: 0.75rem;
		padding-right: 0;
		vertical-align: middle;
	}

	.documents-table .col-icon {
		width: 2.5rem;
		padding-left: 0.75rem;
		padding-right: var(--space-sm);
		vertical-align: middle;
	}

	.documents-table .col-icon .file-icon {
		justify-content: flex-start;
	}

	/* Proportional, not fixed rem: the table is drawn from 720px of card up,
	   and columns fixed in rem would leave the name a sliver at the narrow
	   end. Percentages shrink together and always leave the name the rest. */
	.col-version {
		width: 8%;
	}

	.col-type {
		width: 12%;
	}

	.col-status {
		width: 9%;
	}

	.col-size {
		width: 8%;
	}

	/* Wide enough for "Sep 11, 2026, 7:25 PM" on ONE line at the narrowest
	   width the table is drawn at. It used to be overridden to 140px further
	   down, which broke the date over two lines on every row. */
	.col-date {
		width: 17%;
	}

	.col-actions {
		width: 11%;
	}

	.documents-table th.col-actions {
		text-align: right;
	}

	.col-version,
	.col-status,
	.col-size,
	.col-date {
		white-space: nowrap;
	}

	/* A column of measurements reads down its last digit, like every other
	   numeric column in the app (see `td.numeric` in the settings users
	   table). Centred, "144.5 KB" and "3.0 KB" agreed on nothing. */
	.documents-table th.col-size,
	.documents-table td.col-size {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	/* Fixed layout gives this column whatever the others leave, so a long
	   file name wraps inside its cell instead of widening the table. */
	.col-name {
		overflow-wrap: anywhere;
	}

	.file-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--icon-muted);
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
		min-height: 1.35rem;
		line-height: 1;
		white-space: nowrap;
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
		min-height: 1.35rem;
		line-height: 1;
		white-space: nowrap;
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
		min-height: 1.35rem;
		line-height: 1;
		white-space: nowrap;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.type-badge {
		display: inline-flex;
		align-items: center;
		min-height: 1.35rem;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-full);
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
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

	.documents-table td.col-size,
	.documents-table td.col-date {
		font-size: 0.8125rem;
		color: var(--text-secondary);
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
		background: color-mix(in srgb, var(--text-primary) 8%, transparent 92%);
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

	.action-btn:disabled {
		cursor: default;
		opacity: 0.5;
	}

	/* The re-extract tier menu. Anchored to its own button rather than to the
	   cell so it opens under the control that was pressed, and right-aligned so
	   it never escapes the table's right edge. */
	.reextract-wrap {
		position: relative;
		display: flex;
	}

	.action-btn.is-open {
		background: color-mix(in srgb, var(--text-primary) 8%, transparent 92%);
		color: var(--icon-primary);
	}

	.reextract-menu {
		position: absolute;
		top: calc(100% + var(--space-2xs, 2px));
		right: 0;
		z-index: 20;
		display: flex;
		min-width: 200px;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-xs);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-raised, var(--surface-page));
		box-shadow: var(--shadow-md, 0 8px 24px rgb(0 0 0 / 18%));
		text-align: left;
	}

	.reextract-menu-label {
		margin: 0;
		padding: var(--space-2xs, 2px) var(--space-xs);
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.reextract-menu-note {
		margin: 0;
		padding: var(--space-xs);
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.reextract-menu-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		padding: var(--space-xs);
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		font-size: 0.8125rem;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
	}

	.reextract-menu-item:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.reextract-menu-item:disabled {
		cursor: default;
		color: var(--text-muted);
	}

	.reextract-menu-current {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
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
		border-radius: var(--knowledge-card-radius);
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
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
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
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page) 92%);
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.pagination-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
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

	/* `.custom-checkbox` itself is the app-wide tick box: src/app.css. */

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
		border-radius: var(--knowledge-card-radius);
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
		font-weight: 400;
	}

	.bulk-actions {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}

	.bulk-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		min-height: 34px;
		padding: 0.3125rem 0.75rem;
		border-radius: var(--radius-md);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		letter-spacing: 0.025em;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
		border: 1px solid transparent;
	}

	.bulk-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Straight off `.btn-danger` in app.css: 12% fill, 38% border, and the
	   hover that goes with them. */
	.bulk-btn-danger {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 38%, transparent);
	}

	.bulk-btn-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 18%, transparent);
		border-color: color-mix(in srgb, var(--danger) 55%, transparent);
	}

	.bulk-btn-secondary {
		background: var(--surface-page);
		color: var(--text-secondary);
		border-color: var(--border-default);
	}

	.bulk-btn-secondary:hover {
		background: color-mix(in srgb, var(--text-primary) 7%, var(--surface-page));
		color: var(--text-primary);
		border-color: color-mix(in srgb, var(--text-primary) 30%, transparent);
	}

	.bulk-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.bulk-btn,
		.pagination-btn,
		.action-btn,
		.document-row {
			transition: none !important;
		}
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

		/* Icon-only on a phone: the label costs the search box the width it
		   needs, and the button keeps its aria-label and its tooltip. It also
		   moves back up beside the search box — `.sort-controls` claims a full
		   row here, so an Upload left after it in source order would be
		   stranded alone on a third line. */
		.upload-btn {
			order: 1;
			min-width: 44px;
			min-height: 44px;
			padding: 0;
		}

		.upload-btn-label {
			display: none;
		}

		/* Nothing to push against once the row wraps. */
		.filter-spacer {
			display: none;
		}

		/* Touch targets: the sort control and its direction both reach 44px. */
		.sort-controls {
			order: 2;
			display: grid;
			grid-template-columns: minmax(0, 1fr) 44px;
			flex: 1 0 100%;
			gap: var(--space-xs);
			min-width: 0;
		}

		.sort-field {
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

		.sort-label {
			font-size: 0.72rem;
			font-weight: 600;
		}

		.sort-select {
			min-width: 0;
			min-height: 44px;
			height: 42px;
			padding: 0 0.65rem;
			border: 0;
			border-radius: var(--radius-md);
			font-size: 0.82rem;
		}

		.sort-direction {
			width: 44px;
			min-height: 44px;
			padding: 0;
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

		/* The card lays these two out on a grid, so the desktop table's
		   measured paddings are given back. */
		.documents-table .col-checkbox {
			grid-area: check;
			width: 44px;
			padding-left: 0;
			margin: -0.55rem 0 -0.45rem -0.55rem;
		}

		.documents-table .col-icon {
			grid-area: icon;
			width: 34px;
			min-height: 34px;
			padding: 0;
			justify-self: center;
		}

		/* The card layout draws the glyph in a 34px tile of its own, so it
		   goes back to the middle of that tile. */
		.documents-table .col-icon .file-icon {
			width: 34px;
			height: 34px;
			justify-content: center;
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

		/* Every column the card layout re-states inside `.mobile-document-meta`
		   is hidden here. Version and Status were left visible: with no
		   grid-area of their own they auto-placed into fresh rows of the card
		   grid, so each row drew its badges twice — and an unversioned upload
		   drew two stray em dashes. */
		.documents-table .col-version {
			display: none;
		}

		.documents-table .col-status {
			display: none;
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

		.mobile-document-meta > span:not(.type-badge):not(.version-badge):not(
				.original-badge
			):not(.historical-badge) {
			display: inline-flex;
			align-items: center;
			min-height: 1.5rem;
			padding: 0.18rem 0.44rem;
			border-radius: var(--radius-sm);
			border: 1px solid var(--border-subtle);
			background: var(--surface-page);
			white-space: nowrap;
		}

		/* Every badge in the card's meta row stands the same height, so the
		   line reads as one band rather than as three staggered lozenges. */
		.mobile-document-meta .type-badge,
		.mobile-document-meta .version-badge,
		.mobile-document-meta .original-badge,
		.mobile-document-meta .historical-badge {
			min-height: 1.5rem;
			padding: 0.18rem 0.5rem;
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
			grid-template-columns: repeat(3, 44px);
			gap: var(--space-sm);
			justify-content: flex-end;
			padding-top: 0.1rem;
		}

		.action-btn {
			width: 44px;
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
