<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { browser } from "$app/environment";
import { page as kitPage } from "$app/state";
import {
	deleteKnowledgeArtifact,
	fetchMemoryProfile,
	fetchMemorySummary,
	fetchMemoryTimeline,
	submitKnowledgeMemoryAction,
	submitMemoryV2Action,
	uploadKnowledgeAttachment,
} from "$lib/client/api/knowledge";
import { ApiError } from "$lib/client/api/http";
import { buildChatSourceMessageHref } from "$lib/client/document-workspace-navigation";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import PageSwitcher from "$lib/components/ui/PageSwitcher.svelte";
import { t } from "$lib/i18n";

import KnowledgeMemoryView from "./_components/KnowledgeMemoryView.svelte";
import DocumentsList from "./_components/DocumentsList.svelte";
// biome-ignore lint/style/useImportType: this component must remain a runtime import for SSR rendering.
import KnowledgeWorkspaceCoordinatorComponent from "./_components/KnowledgeWorkspaceCoordinator.svelte";
import type {
	DocumentWorkspaceItem,
	KnowledgeDocumentItem,
	MemoryPersonaSummaryPayload,
	MemoryProfileActionPayload,
	MemoryProfilePublicPayload,
	MemoryTimelineReport,
} from "$lib/types";
import { toWorkspaceDocument } from "./_helpers";
import type { PageProps } from "./$types";

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
let lastMemoryProfileTabState = $state<KnowledgeTab | null>(null);
let openMemoryReviewCount = $derived(memoryProfile?.review.openCount ?? 0);
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
	window.open(`/api/knowledge/${artifactId}/download`, "_blank");
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

function formatUploadFailures(files: File[], failures: string[]): string {
	const failureDetails = failures.slice(0, 3).join(" ");
	const remainingFailures =
		failures.length > 3 ? ` ${failures.length - 3} more failed.` : "";
	if (failures.length === files.length) {
		return `Failed to upload ${files.length} file${files.length === 1 ? "" : "s"}: ${failureDetails}${remainingFailures}`;
	}
	return `${failures.length} file${failures.length === 1 ? "" : "s"} failed to upload: ${failureDetails}${remainingFailures}`;
}

async function handleDocumentsUpload(files: File[]) {
	if (files.length === 0) return;

	manageError = "";
	const failures: string[] = [];

	for (const file of files) {
		try {
			await uploadKnowledgeAttachment(file, null);
		} catch (error) {
			const reason = error instanceof Error ? error.message : "Upload failed";
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

async function handleSummaryEdit(text: string) {
	if (memorySummaryBusy) return;
	manageError = "";
	memorySummaryBusy = true;
	try {
		memorySummary = (
			await submitMemoryV2Action({ kind: "summary", action: "edit", text })
		).summary;
	} catch (error) {
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
	} finally {
		memorySummaryBusy = false;
	}
}

async function handleRetireMemoryItem(itemId: string) {
	const key = `${itemId}:retire`;
	if (pendingMemoryActionKey === key) return;

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
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.status === 409 || error.code === "stale_projection")
		) {
			await loadMemoryProfile(true);
			manageError =
				"Memory profile was updated. Review the latest profile and try again.";
			return;
		}
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
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
	<div class="main-content flex flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8">
		<div class="mx-auto flex w-full max-w-[1040px] flex-col gap-6">
			<div class="px-1">
				<h1 class="text-[2rem] font-serif text-text-primary md:text-[2.6rem]">
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
						onEditSummary={handleSummaryEdit}
						timelineReports={memoryTimelineReports}
						onUndoConsolidation={handleUndoConsolidation}
						onRetire={handleRetireMemoryItem}
					/>
				</div>
			{:else}
				<div id="documents-panel" role="tabpanel" aria-labelledby="documents-tab" class="documents-section space-y-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h2 id="documents-title" class="text-2xl font-serif text-text-primary">
								{$t('knowledge.documents')}
							</h2>
						</div>
						<span class="rounded-full border border-border bg-surface-elevated px-3 py-1 text-xs font-sans text-text-muted">
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
