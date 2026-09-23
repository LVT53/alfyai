<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { browser } from "$app/environment";
import { page as kitPage } from "$app/state";
import {
	cancelExtraction,
	deleteKnowledgeArtifact,
	fetchKnowledgeMemoryOverview,
	fetchMemoryProfile,
	fetchMemorySummary,
	fetchMemoryTimeline,
	fetchReextractTiers,
	reextractDocument,
	retryExtraction,
	submitKnowledgeMemoryAction,
	submitMemoryV2Action,
	uploadKnowledgeAttachment,
	uploadRefusalFromError,
} from "$lib/client/api/knowledge";
import { ApiError } from "$lib/client/api/http";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { buildChatSourceMessageHref } from "$lib/client/document-workspace-navigation";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import PageSwitcher from "$lib/components/ui/PageSwitcher.svelte";
import { t } from "$lib/i18n";

import KnowledgeMemoryView from "./_components/KnowledgeMemoryView.svelte";
import DocumentsList from "./_components/DocumentsList.svelte";
// biome-ignore lint/style/useImportType: this component must remain a runtime import for SSR rendering.
import KnowledgeWorkspaceCoordinatorComponent from "./_components/KnowledgeWorkspaceCoordinator.svelte";
import type {
	MemoryPersonaSummaryPayload,
	MemoryProfileActionPayload,
	MemoryProfilePublicPayload,
	MemoryTimelineReport,
} from "$lib/memory-profile-types";
import type { KnowledgeLibraryDocumentItem } from "$lib/server/services/knowledge";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { KnowledgeMemoryOverviewPayload } from "$lib/server/services/memory-types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import { createExtractionPoller } from "$lib/client/extraction-poll";
import { toWorkspaceDocument } from "./_helpers";
import type { PageProps } from "./$types";

type KnowledgeDocumentItem = KnowledgeLibraryDocumentItem;

type DocumentSortKey = "name" | "size" | "type" | "date";
type SortDirection = "asc" | "desc";
type KnowledgeWorkspaceCoordinator = KnowledgeWorkspaceCoordinatorComponent;
type KnowledgeTab = "memory" | "documents";

const MEMORY_UPDATE_ERROR_MESSAGE = "Failed to update memory profile.";

let { data }: PageProps = $props();
const getData = () => data;
const initialDocuments = (getData().documents ?? []) as KnowledgeDocumentItem[];
const initialLibrary = getData().library;

let activeTab = $state<KnowledgeTab>(getKnowledgeTabFromUrl(kitPage.url));
let documents = $state<KnowledgeDocumentItem[]>(initialDocuments);
let deletingArtifactIds = $state(new Set<string>());
let manageError = $state("");

let memoryProfile = $state<MemoryProfilePublicPayload | null>(null);
let memoryLoaded = $state(false);
let memoryLoading = $state(false);
let memoryLoadError = $state("");
let pendingMemoryActionKey = $state<string | null>(null);
let memorySummary = $state<MemoryPersonaSummaryPayload["summary"]>(null);
let memorySummaryBusy = $state(false);
let memoryTimelineReports = $state<MemoryTimelineReport[]>([]);
let memoryProcessing = $state<
	KnowledgeMemoryOverviewPayload["processing"] | null
>(null);
let lastMemoryProfileTabState = $state<KnowledgeTab | null>(null);
let openMemoryReviewCount = $derived(memoryProfile?.review.openCount ?? 0);
// Guards the one-time scroll-to-review-section handoff from the home
// "memories need review" notice link (?tab=memory#memory-review) so it does
// not re-fire on every reactive update once it has run.
let scrolledToMemoryReviewHash = $state(false);
// True while a server-side documents search/sort/page round-trip is in flight.
let documentsNavigating = $state(false);

let workspaceCoordinator: KnowledgeWorkspaceCoordinator | undefined = $state();
let workspaceOpenRequestSequence = 0;
let workspaceOpenRequest = $state<{
	sequence: number;
	document: DocumentWorkspaceItem;
} | null>(null);

function coerceDocumentPaginationLimit(
	value: number | null | undefined,
): 20 | 50 | 100 {
	return value === 50 || value === 100 ? value : 20;
}

const initialDocumentPaginationLimit = coerceDocumentPaginationLimit(
	initialLibrary?.pagination.pageSize,
);
let documentPaginationLimit = $state<20 | 50 | 100>(
	initialDocumentPaginationLimit,
);
let documentCurrentPage = $state(initialLibrary?.pagination.page ?? 1);
let documentTotalItems = $state(
	initialLibrary?.pagination.totalItems ?? initialDocuments.length,
);
let documentTotalPages = $state(
	initialLibrary?.pagination.totalPages ??
		Math.ceil(initialDocuments.length / initialDocumentPaginationLimit),
);
let documentSearchQuery = $state(initialLibrary?.query ?? "");
let documentSortKey = $state<DocumentSortKey>(
	initialLibrary?.sort.key ?? "date",
);
let documentSortDirection = $state<SortDirection>(
	initialLibrary?.sort.direction ?? "desc",
);
let documentDeleteCandidateId = $state<string | null>(null);
let bulkDeleteCandidateIds = $state<string[] | null>(null);
let bulkDeleteSuccessVersion = $state(0);
let knowledgeTabs = $derived<
	Array<{
		id: KnowledgeTab;
		label: string;
		href: string;
		tabId: string;
		panelId: string;
		badge?: string | number | null;
		badgeLabel?: string;
	}>
>([
	{
		id: "memory",
		label: $t("memory.title"),
		href: "/knowledge",
		tabId: "memory-profile-tab",
		panelId: "memory-profile-panel",
		badge: openMemoryReviewCount > 0 ? openMemoryReviewCount : null,
		badgeLabel: $t("memoryProfile.needsReview"),
	},
	{
		id: "documents",
		label: $t("knowledge.documents"),
		href: buildKnowledgeLibraryUrl({ tab: "documents" }),
		tabId: "documents-tab",
		panelId: "documents-panel",
	},
]);

function getKnowledgeTabFromUrl(url: URL): KnowledgeTab {
	const searchParams = url.searchParams;
	const requestedTab = searchParams.get("tab");
	const hasDocumentQuery =
		searchParams.has("q") ||
		searchParams.has("sort") ||
		searchParams.has("dir") ||
		searchParams.has("page") ||
		searchParams.has("pageSize");
	return requestedTab === "documents" || hasDocumentQuery
		? "documents"
		: "memory";
}

function syncSearchParam(
	searchParams: URLSearchParams,
	key: string,
	value: string | null,
) {
	if (value) {
		searchParams.set(key, value);
		return;
	}
	searchParams.delete(key);
}

function syncDocumentUrlState(
	searchParams: URLSearchParams,
	params: {
		tab: KnowledgeTab;
		query: string;
		sortKey: DocumentSortKey;
		sortDirection: SortDirection;
		page: number;
		pageSize: number;
	},
) {
	if (params.tab === "memory") {
		searchParams.delete("tab");
		searchParams.delete("q");
		searchParams.delete("sort");
		searchParams.delete("dir");
		searchParams.delete("page");
		searchParams.delete("pageSize");
		return;
	}

	syncSearchParam(
		searchParams,
		"tab",
		params.tab === "documents" ? "documents" : null,
	);
	syncSearchParam(searchParams, "q", params.query.trim() || null);
	syncSearchParam(
		searchParams,
		"sort",
		params.sortKey === "date" ? null : params.sortKey,
	);
	syncSearchParam(
		searchParams,
		"dir",
		params.sortDirection === "desc" ? null : params.sortDirection,
	);
	syncSearchParam(
		searchParams,
		"page",
		params.page > 1 ? String(params.page) : null,
	);
	syncSearchParam(
		searchParams,
		"pageSize",
		params.pageSize !== 20 ? String(params.pageSize) : null,
	);
}

function buildKnowledgeLibraryUrl(params: {
	query?: string;
	sortKey?: DocumentSortKey;
	sortDirection?: SortDirection;
	page?: number;
	pageSize?: number;
	tab?: KnowledgeTab;
}): string {
	const searchParams = new URLSearchParams(kitPage.url.search);
	const query = params.query ?? documentSearchQuery;
	const sortKey = params.sortKey ?? documentSortKey;
	const sortDirection = params.sortDirection ?? documentSortDirection;
	const page = params.page ?? documentCurrentPage;
	const pageSize = params.pageSize ?? documentPaginationLimit;
	const tab = params.tab ?? activeTab;

	syncDocumentUrlState(searchParams, {
		tab,
		query,
		sortKey,
		sortDirection,
		page,
		pageSize,
	});

	const queryString = searchParams.toString();
	return queryString ? `/knowledge?${queryString}` : "/knowledge";
}

async function updateKnowledgeLibraryParams(params: {
	query?: string;
	sortKey?: DocumentSortKey;
	sortDirection?: SortDirection;
	page?: number;
	pageSize?: number;
}) {
	if (!browser) return;
	documentsNavigating = true;
	try {
		await goto(buildKnowledgeLibraryUrl({ ...params, tab: "documents" }), {
			keepFocus: true,
			noScroll: true,
		});
	} finally {
		documentsNavigating = false;
	}
}

function handleTabChange(tab: KnowledgeTab) {
	activeTab = tab;
	if (!browser) return;
	void goto(buildKnowledgeLibraryUrl({ tab }), {
		keepFocus: true,
		noScroll: true,
	});
}

function handlePageSwitcherChange(tab: string) {
	if (tab === "memory" || tab === "documents") {
		handleTabChange(tab);
	}
}

function handleDocumentPaginationLimitChange(limit: number) {
	const nextLimit = coerceDocumentPaginationLimit(limit);
	documentPaginationLimit = nextLimit;
	documentCurrentPage = 1;
	void updateKnowledgeLibraryParams({ pageSize: nextLimit, page: 1 });
}

function handleDocumentPageChange(page: number) {
	documentCurrentPage = page;
	void updateKnowledgeLibraryParams({ page });
}

function handleDocumentSearchQueryChange(query: string) {
	documentSearchQuery = query;
	documentCurrentPage = 1;
	void updateKnowledgeLibraryParams({ query, page: 1 });
}

function handleDocumentSortChange(
	sortKey: DocumentSortKey,
	sortDirection: SortDirection,
) {
	documentSortKey = sortKey;
	documentSortDirection = sortDirection;
	documentCurrentPage = 1;
	void updateKnowledgeLibraryParams({ sortKey, sortDirection, page: 1 });
}

function handleDocumentSelect(document: KnowledgeDocumentItem) {
	workspaceOpenRequest = {
		sequence: ++workspaceOpenRequestSequence,
		document: toWorkspaceDocument(document),
	};
}

function closeWorkspaceDocument(documentId?: string) {
	workspaceCoordinator?.closeDocument?.(documentId);
}

function addDeletingArtifact(id: string) {
	deletingArtifactIds = new Set([...deletingArtifactIds, id]);
}

function removeDeletingArtifact(id: string) {
	const next = new Set(deletingArtifactIds);
	next.delete(id);
	deletingArtifactIds = next;
}

function handleDocumentDownload(documentId: string) {
	if (!browser) return;
	const document = documents.find((candidate) => candidate.id === documentId);
	if (!document) return;
	const artifactId = toWorkspaceDocument(document).artifactId;
	if (!artifactId) return;
	// `window.open(..., "_blank")` sent a NAVIGATION, which an expired session
	// answers with the 303 to /login — so the user got a blank tab showing the
	// login screen where their file should have been, and nothing here noticed.
	// The shared helper confirms the session first and then streams the file
	// straight to disk.
	void startAuthenticatedDownload(
		`/api/knowledge/${artifactId}/download`,
		document.name,
	);
}

async function handleDocumentDelete(documentId: string) {
	if (!documents.some((document) => document.id === documentId)) return;
	documentDeleteCandidateId = documentId;
}

async function handleBulkDocumentDelete(
	documentIds: string[],
): Promise<boolean> {
	if (documentIds.length === 0) return false;
	bulkDeleteCandidateIds = documentIds;
	return false;
}

async function deleteDocumentById(documentId: string): Promise<{
	deletedDocument: KnowledgeDocumentItem | null;
	failureName: string | null;
}> {
	const document = documents.find((candidate) => candidate.id === documentId);
	if (!document) return { deletedDocument: null, failureName: null };

	addDeletingArtifact(documentId);
	try {
		const payload = await deleteKnowledgeArtifact(documentId);
		if (payload.success === false) {
			throw new Error(
				payload.message ??
					payload.error ??
					$t("knowledge.failedRemoveArtifact"),
			);
		}
		return { deletedDocument: document, failureName: null };
	} catch {
		return { deletedDocument: null, failureName: document.name };
	} finally {
		removeDeletingArtifact(documentId);
	}
}

async function executeBulkDocumentDelete(documentIds: string[]) {
	if (documentIds.length === 0) return;

	manageError = "";
	const failures: string[] = [];
	const deletedDocuments: KnowledgeDocumentItem[] = [];

	for (const documentId of documentIds) {
		const result = await deleteDocumentById(documentId);
		if (result.deletedDocument) deletedDocuments.push(result.deletedDocument);
		if (result.failureName) failures.push(result.failureName);
	}

	await refreshKnowledgeLibrary();
	for (const deletedDocument of deletedDocuments) {
		closeWorkspaceDocument(toWorkspaceDocument(deletedDocument).id);
	}

	if (failures.length > 0) {
		manageError = `Failed to delete ${failures.length} document${failures.length === 1 ? "" : "s"}: ${failures.join(", ")}`;
	}
	bulkDeleteSuccessVersion += 1;
}

async function jumpToWorkspaceSource(document: DocumentWorkspaceItem) {
	if (!(document.originConversationId && document.originAssistantMessageId)) {
		return;
	}

	await goto(
		buildChatSourceMessageHref({
			conversationId: document.originConversationId,
			assistantMessageId: document.originAssistantMessageId,
		}),
	);
}

// The batch summary above the per-file reasons. Every per-file reason already
// comes back translated (`uploadRefusalFromError` → `$t`); the sentence that
// wrapped them was built here from template literals and an inline English `s`
// plural, so a Hungarian user read their own reasons inside an English frame.
function formatUploadFailures(files: File[], failures: string[]): string {
	const details = failures.slice(0, 3).join(" ");
	const remaining =
		failures.length > 3
			? ` ${$t("knowledge.uploadFailuresMore", { count: failures.length - 3 })}`
			: "";
	const allFailed = failures.length === files.length;
	return (
		$t(
			allFailed
				? "knowledge.uploadFailuresAll"
				: "knowledge.uploadFailuresSome",
			{ count: allFailed ? files.length : failures.length, details },
		) + remaining
	);
}

async function handleDocumentsUpload(files: File[]) {
	if (files.length === 0) return;

	manageError = "";
	const failures: string[] = [];

	for (const file of files) {
		try {
			await uploadKnowledgeAttachment(file, null);
		} catch (error) {
			// A refused type answers with an i18n key; the `error` string beside
			// it is English whatever the user's language is.
			const refusal = uploadRefusalFromError(error, file);
			const reason = refusal
				? $t(refusal.key, refusal.params)
				: error instanceof Error
					? error.message
					: $t("knowledge.uploadFailedFallback");
			failures.push(`${file.name}: ${reason}`);
		}
	}

	await refreshKnowledgeLibrary();

	if (failures.length > 0) {
		manageError = formatUploadFailures(files, failures);
	}
}

function isDeletingArtifact(id: string): boolean {
	return deletingArtifactIds.has(id);
}

async function refreshKnowledgeLibrary() {
	await invalidateAll();
}

// --- Extraction ledger -----------------------------------------------------
//
// The Status column is only as honest as its last poll. This mounts the one
// shared poller (`$lib/client/extraction-poll`) rather than a second one of
// its own, so the composer, the landing page and this list are one poll storm
// at worst. Arming is derived from the rows: a library of finished documents
// asks for nothing, and the poller disarms itself the moment the last tracked
// job settles.

const hasPendingExtraction = $derived(
	documents.some(
		(document) =>
			document.extraction !== undefined &&
			!isTerminalExtractionStatus(document.extraction.status),
	),
);

/**
 * Only the rows that still owe an answer, and only while the Documents tab is
 * the one on screen. An empty list is how the poller learns to disarm.
 */
function pendingExtractionArtifactIds(): string[] {
	if (activeTab !== "documents") return [];
	return documents
		.filter(
			(document) =>
				document.extraction !== undefined &&
				!isTerminalExtractionStatus(document.extraction.status),
		)
		.map((document) => document.displayArtifactId);
}

function applyExtractionJobs(jobs: DocumentExtractionJobDTO[]): void {
	const byArtifactId = new Map(
		jobs
			.filter((job) => job.sourceArtifactId !== null)
			.map((job) => [job.sourceArtifactId as string, job]),
	);
	if (byArtifactId.size === 0) return;

	let succeededSomething = false;
	documents = documents.map((document) => {
		const job = byArtifactId.get(document.displayArtifactId);
		if (!job) return document;
		if (
			document.extraction?.status !== "succeeded" &&
			job.status === "succeeded"
		) {
			succeededSomething = true;
		}
		return { ...document, extraction: job };
	});

	// A finished extraction changes more than the badge: the normalised
	// artifact now exists, so "What AI sees" and the workspace become real.
	// Only the server load knows those, hence exactly one reload per batch
	// that settled rather than one per poll.
	if (succeededSomething) {
		void refreshKnowledgeLibrary();
	}
}

const extractionPoller = createExtractionPoller({
	getArtifactIds: pendingExtractionArtifactIds,
	onJobs: applyExtractionJobs,
	onError: (error) => {
		console.warn("[KNOWLEDGE] Extraction status poll failed", error);
	},
});

// Re-evaluate arming whenever the tracked set could have changed. `sync()` is
// cheap and idempotent — it leaves an already-armed timer alone precisely so
// that a page re-rendering on every poll cannot postpone the next one.
$effect(() => {
	void hasPendingExtraction;
	void activeTab;
	if (browser) extractionPoller.sync();
});

// Teardown only. Deliberately a second effect with no reactive reads: the
// poller's `stop()` is permanent, so putting it in the cleanup of the effect
// above would kill it on the first re-render rather than on unmount.
$effect(() => () => extractionPoller.stop());

async function handleExtractionRetry(artifactId: string) {
	manageError = "";
	try {
		const job = await retryExtraction(artifactId);
		applyExtractionJobs([job]);
		// The poller did not fetch this one, so tell it the job exists or it
		// will not count the row as unsettled and will stay disarmed.
		extractionPoller.observe(job);
		extractionPoller.sync();
	} catch (error) {
		manageError = $t("knowledge.extraction.actionFailed");
		console.warn("[KNOWLEDGE] Extraction retry failed", error);
	}
}

/**
 * "Read this one again, better." The ledger row goes back to `queued` and the
 * poller picks the document up exactly as it does after a Retry; the normalized
 * artifact keeps its id, so nothing that references it dangles while the new
 * parse runs.
 */
function reextractErrorMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : null;
	if (code === "tier_unavailable") {
		return $t("knowledge.extraction.error.tier_unavailable");
	}
	if (code === "tier_not_higher") {
		return $t("knowledge.extraction.reextract.error.tier_not_higher");
	}
	if (code === "reextract_limit") {
		return $t("knowledge.extraction.reextract.error.reextract_limit");
	}
	return $t("knowledge.extraction.reextract.failed");
}

async function handleReextract(artifactId: string, tier: string) {
	manageError = "";
	try {
		const job = await reextractDocument(artifactId, tier);
		applyExtractionJobs([job]);
		extractionPoller.observe(job);
		extractionPoller.sync();
	} catch (error) {
		// The endpoint's refusals reuse the extraction taxonomy, so a tier that
		// vanished between opening the menu and pressing it reads as "that
		// quality is not available" rather than as a generic failure. The two
		// refusals the SERVER owns — "that is not an upgrade" and "you already
		// have too many of these running" — say so in their own words, because
		// both are recoverable by doing something different rather than by
		// trying again.
		manageError = reextractErrorMessage(error);
		console.warn("[KNOWLEDGE] Re-extraction failed", error);
	}
}

async function handleExtractionCancel(artifactId: string) {
	manageError = "";
	try {
		const job = await cancelExtraction(artifactId);
		applyExtractionJobs([job]);
		extractionPoller.observe(job);
		extractionPoller.sync();
	} catch (error) {
		manageError = $t("knowledge.extraction.actionFailed");
		console.warn("[KNOWLEDGE] Extraction cancel failed", error);
	}
}

async function loadMemoryProfile(force = false) {
	if (memoryLoading) return;
	if (memoryLoaded && !force) return;

	memoryLoading = true;
	memoryLoadError = "";

	try {
		memoryProfile = await fetchMemoryProfile();
		memoryLoaded = true;
	} catch (error) {
		memoryLoadError =
			error instanceof Error ? error.message : "Failed to load memory profile.";
	} finally {
		memoryLoading = false;
	}

	// Summary and timeline are additive surfaces — load them best-effort and
	// without blocking callers that await the profile itself (e.g. the
	// stale-projection recovery path).
	void refreshMemorySummary();
	void refreshMemoryTimeline();
	void refreshMemoryOverview();
}

async function refreshMemoryOverview() {
	try {
		memoryProcessing = (await fetchKnowledgeMemoryOverview()).processing;
	} catch (error) {
		console.warn("[KNOWLEDGE_MEMORY] Failed to load memory overview", error);
	}
}

async function refreshMemorySummary() {
	try {
		memorySummary = (await fetchMemorySummary()).summary;
	} catch (error) {
		console.warn("[KNOWLEDGE_MEMORY] Failed to load memory summary", error);
	}
}

async function refreshMemoryTimeline() {
	try {
		memoryTimelineReports = (await fetchMemoryTimeline()).reports;
	} catch (error) {
		console.warn("[KNOWLEDGE_MEMORY] Failed to load memory timeline", error);
	}
}

async function handleSummaryEdit(text: string): Promise<boolean> {
	if (memorySummaryBusy) return false;
	manageError = "";
	memorySummaryBusy = true;
	try {
		memorySummary = (
			await submitMemoryV2Action({ kind: "summary", action: "edit", text })
		).summary;
		return true;
	} catch (error) {
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
		return false;
	} finally {
		memorySummaryBusy = false;
	}
}

async function handleRetireMemoryItem(itemId: string): Promise<boolean> {
	const key = `${itemId}:retire`;
	if (pendingMemoryActionKey === key) return false;

	manageError = "";
	pendingMemoryActionKey = key;
	try {
		memoryProfile = await submitMemoryV2Action({
			kind: "profile_item",
			action: "retire",
			itemId,
			expectedProjectionRevision: memoryProfile?.projectionRevision ?? 0,
		});
		memoryLoaded = true;
		return true;
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.status === 409 || error.code === "stale_projection")
		) {
			await loadMemoryProfile(true);
			manageError =
				"Memory profile was updated. Review the latest profile and try again.";
			return false;
		}
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
		return false;
	} finally {
		pendingMemoryActionKey = null;
	}
}

async function handleUndoConsolidation(reportId: string, actionIndex: number) {
	const key = `${reportId}:${actionIndex}:undo`;
	if (pendingMemoryActionKey === key) return;

	manageError = "";
	pendingMemoryActionKey = key;
	try {
		memoryProfile = await submitMemoryV2Action({
			kind: "consolidation",
			action: "undo",
			reportId,
			actionIndex,
		});
		memoryLoaded = true;
		await refreshMemoryTimeline();
	} catch (error) {
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
	} finally {
		pendingMemoryActionKey = null;
	}
}

async function handleMemoryAction(
	payload: MemoryProfileActionPayload,
): Promise<boolean> {
	const key = `${payload.itemId}:${payload.action}`;
	if (pendingMemoryActionKey === key) return false;

	manageError = "";
	pendingMemoryActionKey = key;
	try {
		memoryProfile = await submitKnowledgeMemoryAction(payload);
		memoryLoaded = true;
		return true;
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.status === 409 || error.code === "stale_projection")
		) {
			await loadMemoryProfile(true);
			manageError =
				"Memory profile was updated. Review the latest profile and try again.";
			return false;
		}
		// The review item left the queue meanwhile (expired, retired, or resolved
		// through a sibling card): refresh so its dead buttons disappear.
		if (
			payload.target === "review_item" &&
			error instanceof ApiError &&
			(error.status === 404 || error.code === "not_found")
		) {
			await loadMemoryProfile(true);
			manageError = $t("memoryProfile.reviewItemGone");
			return false;
		}
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
		return false;
	} finally {
		pendingMemoryActionKey = null;
	}
}

async function executeRemoveArtifact(id: string) {
	if (isDeletingArtifact(id)) return;

	manageError = "";
	const deletedDocument =
		documents.find((document) => document.id === id) ?? null;
	addDeletingArtifact(id);

	try {
		const payload = await deleteKnowledgeArtifact(id);
		if (payload.success === false) {
			throw new Error(
				payload.message ??
					payload.error ??
					$t("knowledge.failedRemoveArtifact"),
			);
		}
		await refreshKnowledgeLibrary();
		if (deletedDocument) {
			closeWorkspaceDocument(toWorkspaceDocument(deletedDocument).id);
		}
	} catch (error) {
		manageError =
			error instanceof Error ? error.message : "Failed to remove artifact.";
	} finally {
		removeDeletingArtifact(id);
	}
}

$effect(() => {
	activeTab = getKnowledgeTabFromUrl(kitPage.url);
});

$effect(() => {
	if (activeTab !== "memory") {
		lastMemoryProfileTabState = activeTab;
		return;
	}

	if (lastMemoryProfileTabState === "memory") return;
	lastMemoryProfileTabState = "memory";
	void loadMemoryProfile(true);
});

// The home notice's "Review them →" link lands here as
// /knowledge?tab=memory#memory-review. The section only exists once the
// profile has loaded AND has open review items (KnowledgeMemoryView renders
// it conditionally), so this waits for both rather than trusting the browser's
// own hash-scroll, which only ever gets one chance at the initial (pre-data)
// DOM.
$effect(() => {
	if (scrolledToMemoryReviewHash) return;
	if (!browser) return;
	if (activeTab !== "memory") return;
	if (kitPage.url.hash !== "#memory-review") return;
	if (!memoryProfile || memoryProfile.review.openCount <= 0) return;

	scrolledToMemoryReviewHash = true;
	requestAnimationFrame(() => {
		const section = document.getElementById("memory-review");
		if (!section) return;
		section.scrollIntoView({ behavior: "smooth", block: "start" });
		section.focus({ preventScroll: true });
	});
});

$effect(() => {
	const library = data.library;
	documents = library.documents ?? [];
	documentPaginationLimit = coerceDocumentPaginationLimit(
		library.pagination.pageSize,
	);
	documentCurrentPage = library.pagination.page;
	documentTotalItems = library.pagination.totalItems;
	documentTotalPages = library.pagination.totalPages;
	documentSearchQuery = library.query;
	documentSortKey = library.sort.key;
	documentSortDirection = library.sort.direction;
});
</script>

<svelte:head>
	<title>{$t('knowledge.title')}</title>
</svelte:head>

<div class="knowledge-page flex h-full min-h-0 flex-col overflow-hidden bg-surface-page">
	<!-- The padding lives on the inner column, not on the scroll container: a
	     sticky header stops at its scroll container's padding edge, so 24px of
	     padding here left the Documents header pinned 24px below the top. -->
	<div class="main-content flex flex-1 flex-col overflow-y-auto">
		<div class="mx-auto box-content flex w-full max-w-[1040px] flex-col gap-6 px-5 py-6 md:px-8">
			<div class="px-1">
				<!-- One page title across the app: 1.75rem serif, not a per-page size. -->
				<h1 class="page-title font-serif text-text-primary">
					{$t('knowledge.title')}
				</h1>
			</div>

			{#if manageError}
				<div class="rounded-[0.75rem] border border-danger bg-surface-elevated px-4 py-3 text-sm font-sans text-danger shadow-sm" role="alert">
					{manageError}
				</div>
			{/if}

			<PageSwitcher
				items={knowledgeTabs}
				activeId={activeTab}
				ariaLabel={$t("knowledge.sections")}
				onChange={handlePageSwitcherChange}
			/>

			{#if activeTab === "memory"}
				<div id="memory-profile-panel" role="tabpanel" aria-labelledby="memory-profile-tab">
					<KnowledgeMemoryView
						profile={memoryProfile}
						{memoryLoading}
						{memoryLoaded}
						{memoryLoadError}
						pendingActionKey={pendingMemoryActionKey}
						actionError={manageError}
						onRetryLoadMemory={() => void loadMemoryProfile(true)}
						onAction={handleMemoryAction}
						summary={memorySummary}
						summaryBusy={memorySummaryBusy}
						processing={memoryProcessing}
						onEditSummary={handleSummaryEdit}
						timelineReports={memoryTimelineReports}
						onUndoConsolidation={handleUndoConsolidation}
						onRetire={handleRetireMemoryItem}
					/>
				</div>
			{:else}
				<div id="documents-panel" role="tabpanel" aria-labelledby="documents-tab" class="documents-section space-y-3">
					<div class="flex flex-wrap items-center gap-2.5">
						<h2 id="documents-title" class="documents-eyebrow">
							{$t('knowledge.documents')}
						</h2>
						<span class="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-[0.66rem] font-sans text-text-muted">
							{$t('knowledge.documentCount', { count: documentTotalItems })}
						</span>
					</div>
					<DocumentsList
						documents={documents}
						loading={documentsNavigating}
						paginationLimit={documentPaginationLimit}
						currentPage={documentCurrentPage}
						totalDocuments={documentTotalItems}
						totalPages={documentTotalPages}
						searchQuery={documentSearchQuery}
						sortKey={documentSortKey}
						sortDirection={documentSortDirection}
						serverManaged={true}
						bulkDeleteSuccessVersion={bulkDeleteSuccessVersion}
						onPaginationLimitChange={handleDocumentPaginationLimitChange}
						onPageChange={handleDocumentPageChange}
						onSearchQueryChange={handleDocumentSearchQueryChange}
						onSortChange={handleDocumentSortChange}
						onSelect={handleDocumentSelect}
						onDelete={handleDocumentDelete}
						onBulkDelete={handleBulkDocumentDelete}
						onDownload={handleDocumentDownload}
						onUpload={handleDocumentsUpload}
						onRetryExtraction={handleExtractionRetry}
						onCancelExtraction={handleExtractionCancel}
						onReextract={handleReextract}
						onLoadReextractTiers={fetchReextractTiers}
					/>
				</div>
			{/if}
		</div>
	</div>

	<KnowledgeWorkspaceCoordinatorComponent
		bind:this={workspaceCoordinator}
		{documents}
		openRequest={workspaceOpenRequest}
		onJumpToSource={jumpToWorkspaceSource}
	/>
</div>

{#if documentDeleteCandidateId}
	<ConfirmDialog
		title={$t('knowledge.deleteDocument')}
		message={`Remove "${documents.find((document) => document.id === documentDeleteCandidateId)?.name ?? "this document"}" from the Knowledge Base?`}
		confirmText={$t('common.delete')}
		confirmVariant="danger"
		onCancel={() => (documentDeleteCandidateId = null)}
		onConfirm={() => {
			const targetId = documentDeleteCandidateId;
			documentDeleteCandidateId = null;
			if (targetId) {
				void executeRemoveArtifact(targetId);
			}
		}}
	/>
{/if}

{#if bulkDeleteCandidateIds}
	<ConfirmDialog
		title={$t('knowledge.deleteDocuments')}
		message={`Delete ${bulkDeleteCandidateIds.length} selected document${bulkDeleteCandidateIds.length === 1 ? "" : "s"}? This cannot be undone.`}
		confirmText={$t('common.delete')}
		confirmVariant="danger"
		onCancel={() => (bulkDeleteCandidateIds = null)}
		onConfirm={() => {
			const targetIds = bulkDeleteCandidateIds;
			bulkDeleteCandidateIds = null;
			if (targetIds) {
				void executeBulkDocumentDelete(targetIds);
			}
		}}
	/>
{/if}

<style>
	.page-title {
		font-size: 1.75rem;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}

	.documents-eyebrow {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
</style>
