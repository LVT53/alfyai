<script lang="ts">
import { goto } from "$app/navigation";
import {
	deleteKnowledgeArtifact,
	fetchKnowledgeLibrary,
	fetchKnowledgeMemory,
	fetchKnowledgeMemoryOverview,
	submitKnowledgeBulkAction,
	submitKnowledgeMemoryAction,
	uploadKnowledgeAttachment,
	type KnowledgeBulkAction,
	type KnowledgeMemoryActionPayload,
} from "$lib/client/api/knowledge";
import { browser } from "$app/environment";
import { buildChatSourceMessageHref } from "$lib/client/document-workspace-navigation";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";

import KnowledgeMemoryModal from "./_components/KnowledgeMemoryModal.svelte";
import KnowledgeMemoryView from "./_components/KnowledgeMemoryView.svelte";
import DocumentsList from "./_components/DocumentsList.svelte";
import type KnowledgeWorkspaceCoordinator from "./_components/KnowledgeWorkspaceCoordinator.svelte";
import type {
	FocusContinuityItem,
	KnowledgeDocumentItem,
	KnowledgeMemoryPayload,
	KnowledgeMemorySummary,
	PersonaMemoryItem,
	TaskMemoryItem,
	WorkCapsule,
} from "$lib/types";
import {
	getDefaultPersonaMemoryFilter,
	getFocusContinuityItemCount,
	toWorkspaceDocument,
	type FocusContinuityView,
	type MemoryModal,
	type PersonaMemoryFilter,
} from "./_helpers";
import type { PageProps } from "./$types";

const OVERVIEW_POLL_INTERVAL_MS = 20_000;
const OVERVIEW_POLL_MAX_ATTEMPTS = 15;
const MEMORY_UPDATE_ERROR_MESSAGE = "Failed to update memory profile.";

let { data }: PageProps = $props();
const getData = () => data;
const initialDocuments = (getData().documents ?? []) as KnowledgeDocumentItem[];

let documents = $state<KnowledgeDocumentItem[]>(initialDocuments);
let personaMemories = $state<PersonaMemoryItem[]>([]);
let taskMemories = $state<TaskMemoryItem[]>([]);
let focusContinuities = $state<FocusContinuityItem[]>([]);
let memorySummary = $state<KnowledgeMemorySummary>({
	personaCount: 0,
	taskCount: 0,
	focusContinuityCount: 0,
	activeConstraintCount: 0,
	currentProjectContextCount: 0,
	overview: null,
	overviewBullets: [],
	overviewSource: null,
	overviewStatus: "disabled",
	overviewUpdatedAt: null,
	overviewLastAttemptAt: null,
	durablePersonaCount: 0,
});
const honchoEnabled = getData().honchoEnabled ?? false;

let deletingArtifactIds = $state(new Set<string>());

// Coordinator bridge for workspace document management
let workspaceCoordinator: KnowledgeWorkspaceCoordinator | undefined = $state();

let pendingMemoryActionKey = $state<string | null>(null);
let pendingKnowledgeActionKey = $state<string | null>(null);
let manageError = $state("");

// Generic confirmation state machine for memory/library actions
type ConfirmationKind =
	| "memory_action"
	| "bulk_persona_forget"
	| "bulk_task_forget"
	| "bulk_focus_continuity_forget"
	| "knowledge_action";
interface PendingConfirmation {
	kind: ConfirmationKind;
	title: string;
	message: string;
	onConfirm: () => void;
}
let pendingConfirmation = $state<PendingConfirmation | null>(null);

function showConfirmation(
	kind: ConfirmationKind,
	title: string,
	message: string,
	onConfirm: () => void,
): boolean {
	pendingConfirmation = { kind, title, message, onConfirm };
	return false; // Return false to pause execution; onConfirm will be called if user confirms
}

function handleConfirmationConfirm() {
	const confirmation = pendingConfirmation;
	pendingConfirmation = null;
	if (confirmation) {
		confirmation.onConfirm();
	}
}

function handleConfirmationCancel() {
	pendingConfirmation = null;
}
let memoryLoaded = $state(false);
let memoryLoading = $state(false);
let memoryLoadError = $state("");
let liveOverviewRefreshing = $state(false);
let liveOverviewPollAttempts = $state(0);
let memoryTabVisible = $state(true);
let activeMemoryModal = $state<MemoryModal>(null);
let selectedPersonaMemoryIds = $state<string[]>([]);
let personaMemoryFilter = $state<PersonaMemoryFilter>("active");
let selectedTaskMemoryIds = $state<string[]>([]);
let selectedFocusContinuityIds = $state<string[]>([]);
let focusContinuityView = $state<FocusContinuityView>("tasks");
const userDisplayName = getData().userDisplayName?.trim() || "You";

// Documents section state
let documentPaginationLimit = $state<20 | 50 | 100>(20);
let documentCurrentPage = $state(1);
let documentDeleteCandidateId = $state<string | null>(null);
let bulkDeleteCandidateIds = $state<string[] | null>(null);
let bulkDeleteSuccessVersion = $state(0);
let deletingArtifactCount = $derived(deletingArtifactIds.size);
let filteredPersonaMemories = $derived(
	personaMemories.filter((memory) => memory.state === personaMemoryFilter),
);
let personaMemoryStateCounts = $derived.by(() => ({
	active: personaMemories.filter((memory) => memory.state === "active").length,
	dormant: personaMemories.filter((memory) => memory.state === "dormant")
		.length,
	archived: personaMemories.filter((memory) => memory.state === "archived")
		.length,
}));
let focusContinuityItemCount = $derived(
	getFocusContinuityItemCount({ taskMemories, focusContinuities }),
);

let overviewBullets = $derived(memorySummary.overviewBullets ?? []);
let overviewSource = $derived(memorySummary.overviewSource);
let overviewStatus = $derived(memorySummary.overviewStatus);
let overviewUpdatedAt = $derived(memorySummary.overviewUpdatedAt);
let overviewLastAttemptAt = $derived(memorySummary.overviewLastAttemptAt);
let durablePersonaCount = $derived(memorySummary.durablePersonaCount);
let activeConstraintCount = $derived(memorySummary.activeConstraintCount ?? 0);
let currentProjectContextCount = $derived(
	memorySummary.currentProjectContextCount ?? 0,
);

// Documents section handlers
function handleDocumentPaginationLimitChange(limit: number) {
	documentPaginationLimit = limit as 20 | 50 | 100;
}

function handleDocumentPageChange(page: number) {
	documentCurrentPage = page;
}

function handleDocumentSelect(document: KnowledgeDocumentItem) {
	workspaceCoordinator?.handleOpenDocument(toWorkspaceDocument(document));
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
	// Find the document to get the artifact ID
	const document = documents.find((d) => d.id === documentId);
	if (!document) return;

	const artifactId = toWorkspaceDocument(document).artifactId;
	if (!artifactId) return;

	// Trigger download via API endpoint
	const downloadUrl = `/api/knowledge/${artifactId}/download`;
	window.open(downloadUrl, "_blank");
}

async function handleDocumentDelete(documentId: string) {
	const document = documents.find((d) => d.id === documentId);
	if (!document) return;

	await removeArtifact(documentId);
}

async function handleBulkDocumentDelete(
	documentIds: string[],
): Promise<boolean> {
	if (documentIds.length === 0) return false;
	bulkDeleteCandidateIds = documentIds;
	return false; // Return false - actual deletion happens after confirmation
}

async function executeBulkDocumentDelete(documentIds: string[]) {
	if (documentIds.length === 0) return;

	manageError = "";
	const failures: string[] = [];

	for (const documentId of documentIds) {
		const document = documents.find((d) => d.id === documentId);
		if (!document) continue;

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
		} catch (error) {
			failures.push(document.name);
		} finally {
			removeDeletingArtifact(documentId);
		}
	}

	await refreshKnowledgeLibrary();

	for (const documentId of documentIds) {
		const deletedDocument = documents.find(
			(document) => document.id === documentId,
		);
		if (deletedDocument) {
			closeWorkspaceDocument(toWorkspaceDocument(deletedDocument).id);
		}
	}

	if (failures.length > 0) {
		manageError = `Failed to delete ${failures.length} document${failures.length === 1 ? "" : "s"}: ${failures.join(", ")}`;
	}

	// Increment success version to signal DocumentsList to clear selection
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
		const failureDetails = failures.slice(0, 3).join(" ");
		const remainingFailures =
			failures.length > 3 ? ` ${failures.length - 3} more failed.` : "";
		manageError =
			failures.length === files.length
				? `Failed to upload ${files.length} file${files.length === 1 ? "" : "s"}: ${failureDetails}${remainingFailures}`
				: `${failures.length} file${failures.length === 1 ? "" : "s"} failed to upload: ${failureDetails}${remainingFailures}`;
	}
}

function isDeletingArtifact(id: string): boolean {
	return deletingArtifactIds.has(id);
}

function applyMemoryPayload(payload: KnowledgeMemoryPayload) {
	personaMemories = payload.personaMemories ?? [];
	taskMemories = payload.taskMemories ?? [];
	focusContinuities = payload.focusContinuities ?? [];
	memorySummary = payload.summary
		? {
				personaCount: payload.summary.personaCount ?? 0,
				taskCount: payload.summary.taskCount ?? 0,
				focusContinuityCount: payload.summary.focusContinuityCount ?? 0,
				activeConstraintCount: payload.summary.activeConstraintCount ?? 0,
				currentProjectContextCount:
					payload.summary.currentProjectContextCount ?? 0,
				overview: payload.summary.overview ?? null,
				overviewBullets: payload.summary.overviewBullets ?? [],
				overviewSource: payload.summary.overviewSource ?? null,
				overviewStatus:
					payload.summary.overviewStatus ??
					(honchoEnabled ? "not_enough_durable_memory" : "disabled"),
				overviewUpdatedAt: payload.summary.overviewUpdatedAt ?? null,
				overviewLastAttemptAt: payload.summary.overviewLastAttemptAt ?? null,
				durablePersonaCount: payload.summary.durablePersonaCount ?? 0,
			}
		: {
				personaCount: 0,
				taskCount: 0,
				focusContinuityCount: 0,
				activeConstraintCount: 0,
				currentProjectContextCount: 0,
				overview: null,
				overviewBullets: [],
				overviewSource: null,
				overviewStatus: honchoEnabled
					? "not_enough_durable_memory"
					: "disabled",
				overviewUpdatedAt: null,
				overviewLastAttemptAt: null,
				durablePersonaCount: 0,
			};
	if (activeMemoryModal === "persona") {
		personaMemoryFilter = getDefaultPersonaMemoryFilter(personaMemories);
	}
	memoryLoaded = true;
	memoryLoadError = "";
}

function applyMemoryOverviewSummary(summary: KnowledgeMemorySummary) {
	memorySummary = {
		...memorySummary,
		personaCount: summary.personaCount ?? memorySummary.personaCount,
		activeConstraintCount:
			summary.activeConstraintCount ?? memorySummary.activeConstraintCount,
		currentProjectContextCount:
			summary.currentProjectContextCount ??
			memorySummary.currentProjectContextCount,
		overview: summary.overview ?? null,
		overviewBullets: summary.overviewBullets ?? [],
		overviewSource: summary.overviewSource ?? null,
		overviewStatus:
			summary.overviewStatus ??
			(honchoEnabled ? "not_enough_durable_memory" : "disabled"),
		overviewUpdatedAt: summary.overviewUpdatedAt ?? null,
		overviewLastAttemptAt: summary.overviewLastAttemptAt ?? null,
		durablePersonaCount:
			summary.durablePersonaCount ?? memorySummary.durablePersonaCount,
	};
}

async function ensureMemoryLoaded(force = false) {
	if (memoryLoading) return;
	if (memoryLoaded && !force) return;

	memoryLoading = true;
	memoryLoadError = "";

	try {
		const result = await fetchKnowledgeMemory();
		applyMemoryPayload(result);
	} catch (error) {
		memoryLoadError =
			error instanceof Error ? error.message : $t("knowledge.failedLoadMemory");
	} finally {
		memoryLoading = false;
	}
}

function shouldPollLiveOverview(): boolean {
	if (!honchoEnabled || !memoryLoaded || memoryLoading) return false;
	if (!memoryTabVisible) return false;
	if (overviewSource === "honcho_live" || overviewSource === "honcho_scoped")
		return false;
	if (
		overviewStatus === "disabled" ||
		overviewStatus === "not_enough_durable_memory"
	) {
		return false;
	}
	return true;
}

async function refreshLiveOverview(force = false) {
	if (liveOverviewRefreshing || !honchoEnabled || !memoryLoaded) return;
	if (!force && liveOverviewPollAttempts >= OVERVIEW_POLL_MAX_ATTEMPTS) return;

	liveOverviewRefreshing = true;
	if (!force) {
		liveOverviewPollAttempts += 1;
	}

	try {
		const payload = await fetchKnowledgeMemoryOverview({ force });
		applyMemoryOverviewSummary(payload.summary);
	} catch (error) {
		if (force) {
			manageError =
				error instanceof Error
					? error.message
					: $t("knowledge.failedRefreshOverview");
		}
	} finally {
		liveOverviewRefreshing = false;
	}
}

function openMemoryModal(kind: Exclude<MemoryModal, null>) {
	resetModalSelections();
	activeMemoryModal = kind;
	if (kind === "persona") {
		personaMemoryFilter = getDefaultPersonaMemoryFilter(personaMemories);
	}
	if (kind === "focus") {
		focusContinuityView = "tasks";
	}
	void ensureMemoryLoaded();
}

function closeMemoryModal() {
	activeMemoryModal = null;
	resetModalSelections();
}

function isMemoryActionPending(key: string): boolean {
	return pendingMemoryActionKey === key;
}

function resetModalSelections() {
	selectedPersonaMemoryIds = [];
	selectedTaskMemoryIds = [];
	selectedFocusContinuityIds = [];
}

function togglePersonaSelection(id: string) {
	selectedPersonaMemoryIds = selectedPersonaMemoryIds.includes(id)
		? selectedPersonaMemoryIds.filter((value) => value !== id)
		: [...selectedPersonaMemoryIds, id];
}

function toggleTaskSelection(id: string) {
	selectedTaskMemoryIds = selectedTaskMemoryIds.includes(id)
		? selectedTaskMemoryIds.filter((value) => value !== id)
		: [...selectedTaskMemoryIds, id];
}

function toggleAllPersonaSelections() {
	selectedPersonaMemoryIds =
		selectedPersonaMemoryIds.length === filteredPersonaMemories.length
			? []
			: filteredPersonaMemories.map((memory) => memory.id);
}

function toggleAllTaskSelections() {
	selectedTaskMemoryIds =
		selectedTaskMemoryIds.length === taskMemories.length
			? []
			: taskMemories.map((memory) => memory.taskId);
}

function toggleFocusContinuitySelection(id: string) {
	selectedFocusContinuityIds = selectedFocusContinuityIds.includes(id)
		? selectedFocusContinuityIds.filter((value) => value !== id)
		: [...selectedFocusContinuityIds, id];
}

function toggleAllFocusContinuitySelections() {
	selectedFocusContinuityIds =
		selectedFocusContinuityIds.length === focusContinuities.length
			? []
			: focusContinuities.map((memory) => memory.continuityId);
}

function setPersonaMemoryFilter(filter: PersonaMemoryFilter) {
	personaMemoryFilter = filter;
	selectedPersonaMemoryIds = [];
}

function setFocusContinuityView(view: FocusContinuityView) {
	focusContinuityView = view;
	if (view === "tasks") {
		selectedTaskMemoryIds = [];
		return;
	}
	selectedFocusContinuityIds = [];
}

async function refreshKnowledgeLibrary() {
	const result = await fetchKnowledgeLibrary();
	documents = result.documents ?? [];
}

async function submitMemoryAction(
	payload: KnowledgeMemoryActionPayload,
): Promise<KnowledgeMemoryPayload> {
	return submitKnowledgeMemoryAction(payload);
}

async function runMemoryAction(
	payload: KnowledgeMemoryActionPayload,
	key: string,
	confirmationMessage?: string,
) {
	if (isMemoryActionPending(key)) return;

	if (confirmationMessage) {
		showConfirmation(
			"memory_action",
			$t("knowledge.confirmAction"),
			confirmationMessage,
			() => {
				void executeMemoryAction(payload, key);
			},
		);
		return;
	}

	await executeMemoryAction(payload, key);
}

async function executeMemoryAction(
	payload: KnowledgeMemoryActionPayload,
	key: string,
) {
	if (isMemoryActionPending(key)) return;

	await withPendingMemoryAction(key, async () => {
		const result = await submitMemoryAction(payload);
		applyMemoryPayload(result);
		if (payload.action === "forget_persona_memory") {
			const forgottenId = payload.clusterId ?? payload.conclusionId;
			selectedPersonaMemoryIds = selectedPersonaMemoryIds.filter(
				(id) => id !== forgottenId,
			);
		}
		if (payload.action === "forget_task_memory") {
			selectedTaskMemoryIds = selectedTaskMemoryIds.filter(
				(id) => id !== payload.taskId,
			);
		}
		if (payload.action === "forget_all_persona_memory") {
			selectedPersonaMemoryIds = [];
		}
		if (payload.action === "forget_focus_continuity") {
			selectedFocusContinuityIds = selectedFocusContinuityIds.filter(
				(id) => id !== payload.continuityId,
			);
		}
	});
}

async function runBulkPersonaForget() {
	if (selectedPersonaMemoryIds.length === 0) return;

	showConfirmation(
		"bulk_persona_forget",
		"Forget Persona Memories",
		`Forget ${selectedPersonaMemoryIds.length} selected persona memory item${selectedPersonaMemoryIds.length === 1 ? "" : "s"}?`,
		() => void executeBulkPersonaForget(),
	);
}

async function executeBulkPersonaForget() {
	await withPendingMemoryAction("forget-selected-persona", async () => {
		let result: KnowledgeMemoryPayload | null = null;
		if (
			selectedPersonaMemoryIds.length === personaMemories.length &&
			honchoEnabled
		) {
			result = await submitMemoryAction({
				action: "forget_all_persona_memory",
			});
		} else {
			for (const id of selectedPersonaMemoryIds) {
				result = await submitMemoryAction({
					action: "forget_persona_memory",
					clusterId: id,
				});
			}
		}
		if (result) {
			applyMemoryPayload(result);
		}
		selectedPersonaMemoryIds = [];
	});
}

async function runBulkTaskForget() {
	if (selectedTaskMemoryIds.length === 0) return;

	showConfirmation(
		"bulk_task_forget",
		"Forget Task Memories",
		`Forget ${selectedTaskMemoryIds.length} selected task memory item${selectedTaskMemoryIds.length === 1 ? "" : "s"}?`,
		() => void executeBulkTaskForget(),
	);
}

async function executeBulkTaskForget() {
	await withPendingMemoryAction("forget-selected-task", async () => {
		let result: KnowledgeMemoryPayload | null = null;
		for (const id of selectedTaskMemoryIds) {
			result = await submitMemoryAction({
				action: "forget_task_memory",
				taskId: id,
			});
		}
		if (result) {
			applyMemoryPayload(result);
		}
		selectedTaskMemoryIds = [];
	});
}

async function runBulkFocusContinuityForget() {
	if (selectedFocusContinuityIds.length === 0) return;

	showConfirmation(
		"bulk_focus_continuity_forget",
		"Forget Focus Continuity",
		`Forget ${selectedFocusContinuityIds.length} selected continuity item${selectedFocusContinuityIds.length === 1 ? "" : "s"} across chats?`,
		() => void executeBulkFocusContinuityForget(),
	);
}

async function executeBulkFocusContinuityForget() {
	await withPendingMemoryAction(
		"forget-selected-focus-continuity",
		async () => {
			let result: KnowledgeMemoryPayload | null = null;
			for (const id of selectedFocusContinuityIds) {
				result = await submitMemoryAction({
					action: "forget_focus_continuity",
					continuityId: id,
				});
			}
			if (result) {
				applyMemoryPayload(result);
			}
			selectedFocusContinuityIds = [];
		},
	);
}

async function withPendingMemoryAction(
	key: string,
	action: () => Promise<void>,
) {
	manageError = "";
	pendingMemoryActionKey = key;

	try {
		await action();
	} catch (error) {
		manageError =
			error instanceof Error ? error.message : MEMORY_UPDATE_ERROR_MESSAGE;
	} finally {
		pendingMemoryActionKey = null;
	}
}

function isKnowledgeActionPending(key: string): boolean {
	return pendingKnowledgeActionKey === key;
}

async function runKnowledgeAction(
	action: KnowledgeBulkAction,
	key: string,
	confirmationMessage: string,
) {
	if (isKnowledgeActionPending(key)) return;

	showConfirmation(
		"knowledge_action",
		$t("knowledge.confirmAction"),
		confirmationMessage,
		() => void executeKnowledgeAction(action, key),
	);
}

async function executeKnowledgeAction(
	action: KnowledgeBulkAction,
	key: string,
) {
	if (isKnowledgeActionPending(key)) return;

	manageError = "";
	pendingKnowledgeActionKey = key;

	try {
		const result = await submitKnowledgeBulkAction(action);
		if (result.success === false) {
			throw new Error(
				result.error ??
					result.message ??
					$t("knowledge.failedUpdateKnowledgeBase"),
			);
		}

		await refreshKnowledgeLibrary();
		if (action === "forget_everything" || memoryLoaded) {
			await ensureMemoryLoaded(true);
		}
		if (action === "forget_everything") {
			activeMemoryModal = null;
			resetModalSelections();
		}
	} catch (error) {
		manageError =
			error instanceof Error
				? error.message
				: "Failed to update the Knowledge Base.";
	} finally {
		pendingKnowledgeActionKey = null;
	}
}

async function removeArtifact(id: string) {
	if (isDeletingArtifact(id)) return;
	documentDeleteCandidateId = id;
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
function handleWindowKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && activeMemoryModal) {
		closeMemoryModal();
	}
}

$effect(() => {
	if (typeof document === "undefined") return;
	const handleVisibilityChange = () => {
		memoryTabVisible = !document.hidden;
	};
	handleVisibilityChange();
	document.addEventListener("visibilitychange", handleVisibilityChange);
	return () => {
		document.removeEventListener("visibilitychange", handleVisibilityChange);
	};
});

$effect(() => {
	if (!shouldPollLiveOverview()) {
		liveOverviewPollAttempts = 0;
		return;
	}

	let cancelled = false;
	let intervalId: number | null = null;

	const startPolling = async () => {
		await refreshLiveOverview(false);
		if (
			cancelled ||
			overviewSource === "honcho_live" ||
			overviewSource === "honcho_scoped"
		)
			return;
		intervalId = window.setInterval(() => {
			if (cancelled || liveOverviewRefreshing) return;
			if (liveOverviewPollAttempts >= OVERVIEW_POLL_MAX_ATTEMPTS) {
				if (intervalId) {
					window.clearInterval(intervalId);
					intervalId = null;
				}
				return;
			}
			void refreshLiveOverview(false);
		}, OVERVIEW_POLL_INTERVAL_MS);
	};

	void startPolling();

	return () => {
		cancelled = true;
		if (intervalId) {
			window.clearInterval(intervalId);
		}
	};
});

$effect(() => {
	void ensureMemoryLoaded();
});
</script>

<svelte:head>
	<title>{$t('knowledge.title')}</title>
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="knowledge-page flex h-full min-h-0 flex-col overflow-hidden bg-surface-page">
	<div class="main-content flex flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8">
		<div class="mx-auto flex w-full max-w-[1040px] flex-col gap-8">
		<div class="rounded-[1.5rem] border border-border bg-surface-elevated px-5 py-5 shadow-sm md:px-6">
			<div class="flex flex-col gap-5">
			<div class="space-y-2">
				<h1 class="text-[2rem] font-serif tracking-[-0.05em] text-text-primary md:text-[2.75rem]">
					{$t('knowledge.title')}
				</h1>
					<p class="max-w-[720px] text-sm font-sans leading-[1.5] text-text-secondary">
						{$t('knowledge.description')}
					</p>
				</div>
			</div>
		</div>

		{#if manageError}
			<div class="rounded-[1rem] border border-danger bg-surface-page px-4 py-3 text-sm font-sans text-danger shadow-sm" role="alert">
				{manageError}
			</div>
		{/if}

		<div class="documents-section rounded-[1.5rem] border border-border bg-surface-elevated px-5 py-5 shadow-sm md:px-6">
			<div class="mb-4">
			<h2 class="text-2xl font-serif tracking-[-0.02em] text-text-primary">{$t('knowledge.documents')}</h2>
			<p class="text-sm text-text-secondary mt-1">{$t('knowledge.browseManage')}</p>
			</div>
			<DocumentsList
				documents={documents}
				paginationLimit={documentPaginationLimit}
				currentPage={documentCurrentPage}
				bulkDeleteSuccessVersion={bulkDeleteSuccessVersion}
				onPaginationLimitChange={handleDocumentPaginationLimitChange}
				onPageChange={handleDocumentPageChange}
				onSelect={handleDocumentSelect}
				onDelete={handleDocumentDelete}
				onBulkDelete={handleBulkDocumentDelete}
				onDownload={handleDocumentDownload}
				onUpload={handleDocumentsUpload}
			/>
		</div>

		<KnowledgeMemoryView
			{memoryLoading}
			{memoryLoaded}
			{memoryLoadError}
			personaMemoryCount={personaMemories.length}
			{focusContinuityItemCount}
			{honchoEnabled}
			{overviewBullets}
			{overviewSource}
			{overviewStatus}
			{overviewUpdatedAt}
			{overviewLastAttemptAt}
			{durablePersonaCount}
			{activeConstraintCount}
			{currentProjectContextCount}
			{liveOverviewRefreshing}
			onRetryLoadMemory={() => void ensureMemoryLoaded(true)}
			onRetryLiveOverview={() => void refreshLiveOverview(true)}
			onOpenMemoryModal={openMemoryModal}
		/>
		</div>
	</div>

	<KnowledgeWorkspaceCoordinator
		bind:this={workspaceCoordinator}
		{documents}
		onJumpToSource={jumpToWorkspaceSource}
	/>
</div>

{#if activeMemoryModal}
	<KnowledgeMemoryModal
		activeMemoryModal={activeMemoryModal}
		{memoryLoading}
		{memoryLoaded}
		{memoryLoadError}
		{honchoEnabled}
		{personaMemories}
		{filteredPersonaMemories}
		{personaMemoryFilter}
		{personaMemoryStateCounts}
		{selectedPersonaMemoryIds}
		{taskMemories}
		{selectedTaskMemoryIds}
		{focusContinuities}
		{selectedFocusContinuityIds}
		{focusContinuityView}
		{userDisplayName}
		{isMemoryActionPending}
		onClose={closeMemoryModal}
		onSetPersonaMemoryFilter={setPersonaMemoryFilter}
		onSetFocusContinuityView={setFocusContinuityView}
		onTogglePersonaSelection={togglePersonaSelection}
		onToggleAllPersonaSelections={toggleAllPersonaSelections}
		onToggleTaskSelection={toggleTaskSelection}
		onToggleAllTaskSelections={toggleAllTaskSelections}
		onToggleFocusContinuitySelection={toggleFocusContinuitySelection}
		onToggleAllFocusContinuitySelections={toggleAllFocusContinuitySelections}
		onRunBulkPersonaForget={runBulkPersonaForget}
		onRunBulkTaskForget={runBulkTaskForget}
		onRunBulkFocusContinuityForget={runBulkFocusContinuityForget}
		onRunMemoryAction={runMemoryAction}
	/>
{/if}

{#if documentDeleteCandidateId}
	<ConfirmDialog
		title={$t('knowledge.deleteDocument')}
		message={`Remove "${documents.find(d => d.id === documentDeleteCandidateId)?.name ?? 'this document'}" from the Knowledge Base?`}
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
		message={`Delete ${bulkDeleteCandidateIds.length} selected document${bulkDeleteCandidateIds.length === 1 ? '' : 's'}? This cannot be undone.`}
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

{#if pendingConfirmation}
	<ConfirmDialog
		title={pendingConfirmation.title}
		message={pendingConfirmation.message}
		confirmText="Confirm"
		confirmVariant="danger"
		onCancel={handleConfirmationCancel}
		onConfirm={handleConfirmationConfirm}
	/>
{/if}

<style>
	:global(.knowledge-page input[type='checkbox']) {
		cursor: pointer;
	}

	:global(.memory-preview) {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		overflow: hidden;
	}
</style>
