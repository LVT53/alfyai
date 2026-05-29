<script lang="ts">
import { get, writable } from "svelte/store";
import { onMount, onDestroy, tick, untrack } from "svelte";
import { t } from "$lib/i18n";
import { page } from "$app/state";
import { goto, invalidate, invalidateAll, replaceState } from "$app/navigation";
import { browser } from "$app/environment";
import {
	cleanupPreparedConversation,
	consumePendingConversationMessage,
	createConversationDraftRecord,
	createDraftPersistence,
	getConversationModelSelection,
	getConversationPersonalitySelection,
	hasMeaningfulDraft,
	setConversationModelSelection,
	setConversationPersonalitySelection,
	storePendingConversationMessage,
} from "$lib/client/conversation-session";
import {
	applyTaskSteering,
	deleteConversation,
	deleteConversationDraft,
	deleteConversationMessages,
	endConversationSkillSession,
	fetchConversationDetail,
	fetchMessageEvidence,
	generateConversationTitle,
	createConversationFork,
	runConversationContextCompression,
	startConversationSkillSession,
} from "$lib/client/api/conversations";
import {
	cancelFileProductionJob as cancelFileProductionJobRequest,
	retryFileProductionJob as retryFileProductionJobRequest,
} from "$lib/client/api/file-production";
import {
	dismissSkillDraft as dismissSkillDraftRequest,
	publishSkillDraft as publishSkillDraftRequest,
	saveSkillDraft as saveSkillDraftRequest,
} from "$lib/client/api/skills";
import { ApiError } from "$lib/client/api/http";
import {
	advanceDeepResearchWorkflow as advanceDeepResearchWorkflowRequest,
	approveDeepResearchPlan as approveDeepResearchPlanRequest,
	cancelDeepResearchJob as cancelDeepResearchJobRequest,
	discussDeepResearchReport as discussDeepResearchReportRequest,
	editDeepResearchPlan as editDeepResearchPlanRequest,
	researchFurtherFromDeepResearchReport as researchFurtherFromDeepResearchReportRequest,
	startDeepResearchChatJob as startDeepResearchChatJobRequest,
} from "$lib/client/api/deep-research";
import {
	recordDocumentWorkspaceOpen,
	uploadKnowledgeAttachment,
} from "$lib/client/api/knowledge";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
import { currentConversationId } from "$lib/stores/ui";
import {
	selectedModel,
	selectedThinkingMode,
	setSelectedModel,
	setSelectedThinkingMode,
} from "$lib/stores/settings";
import EvidenceManager from "$lib/components/chat/EvidenceManager.svelte";
import type {
	ArtifactSummary,
	ChatGeneratedFile,
	ChatMessage,
	ConversationDraft,
	ConversationForkOrigin,
	ContextCompressionMarker,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	DeepResearchDepth,
	DeepResearchJob,
	DeepResearchReportIntent,
	DocumentWorkspaceItem,
	FileProductionJob,
	SkillSession,
	ModelId,
	TaskState,
	TaskSteeringPayload,
} from "$lib/types";
import type { I18nKey } from "$lib/i18n";
import type { PageProps } from "./$types";
import {
	streamChat,
	checkForOrphanedStream,
	getStreamBufferInfo,
} from "$lib/services/streaming";
import type { StreamHandle } from "$lib/services/streaming";
import {
	buildChatSourceMessageHref,
	clearChatFocusMessageParam,
	getChatFocusMessageIdFromUrl,
} from "$lib/client/document-workspace-navigation";
import {
	loadPersistedWorkspaceDocumentState,
	reduceWorkspaceClose,
	reduceWorkspaceDocumentsForDeletedConversation,
	reduceWorkspaceDocumentClose,
	reduceWorkspaceDocumentOpen,
	savePersistedWorkspaceDocumentState,
	WORKSPACE_CONVERSATION_DELETED_EVENT,
} from "$lib/client/document-workspace-state";
import {
	removeConversationLocal,
	updateConversationTitleLocal,
	upsertConversationLocal,
} from "$lib/stores/conversations";
import {
	getForkCreationErrorKey,
	hasForkedAssistantInRange,
	isForkedSourceHistoryConfirmationRequired,
} from "./lifecycle-guards";
import ChatComposerPanel from "./_components/ChatComposerPanel.svelte";
import ChatMessagePane from "./_components/ChatMessagePane.svelte";
import SkillSessionPanel from "./_components/SkillSessionPanel.svelte";
import DropZoneOverlay from "$lib/components/chat/DropZoneOverlay.svelte";
import DocumentWorkspace from "$lib/components/document-workspace/DocumentWorkspace.svelte";
import {
	appendAssistantPlaceholder,
	appendThinkingChunkToMessageList,
	appendTokenChunkToMessageList,
	appendUserMessageAndPlaceholder,
	applyToolCallUpdateToMessageList,
	attachUnassignedFileProductionJobsToAssistant,
	createAssistantPlaceholder,
	createUserMessage,
	finalizeStreamingMessageList,
	getWorkspacePresentationAfterDocumentOpen,
	hasActiveDeepResearchJobs,
	hasActiveFileProductionJobs,
	mergeDeepResearchJobsForHydration,
	mergeFileProductionJob,
	mergeAttachedArtifacts,
	removeMessageById,
	patchSkillDraftInMessageList,
	toFriendlySendError,
	updateMessageById,
	cloneSendPayload,
	isPendingSkillUnavailableError,
	isConversationReadOnly,
	isOsFileDropEvent,
	markPendingSkillUnavailable,
	shouldStartDeepResearchJob,
	shouldDeleteConversationAfterCancellingDeepResearch,
	shouldHydrateFileProductionJobsOnToolCall,
	type DraftChangePayload,
	type MessageEditPayload,
	type MessageRegeneratePayload,
	type SendPayload,
} from "./_helpers";

let { data }: PageProps = $props();
const getData = () => data;
const initialMessages = getData().messages ?? [];
const initialHasPersistedMessages = initialMessages.length > 0;
const initialContextStatus = getData().contextStatus ?? null;
const initialTotalCostUsdMicros = getData().totalCostUsdMicros ?? 0;
const initialTotalTokens = getData().totalTokens ?? 0;
const initialAttachedArtifacts = getData().attachedArtifacts ?? [];
const initialActiveWorkingSet = getData().activeWorkingSet ?? [];
const initialTaskState = getData().taskState ?? null;
const initialContextDebug = getData().contextDebug ?? null;
const initialContextSources = getData().contextSources ?? null;
const initialConversationDraft = getData().draft ?? null;
const initialForkOrigin = getData().forkOrigin ?? null;
const initialBootstrapMode = getData().bootstrap ?? false;
const initialGeneratedFiles = getData().generatedFiles ?? [];
const initialFileProductionJobs = getData().fileProductionJobs ?? [];
const initialDeepResearchJobs = getData().deepResearchJobs ?? [];
const initialContextCompressionSnapshots =
	getData().contextCompressionSnapshots ?? [];
const initialActiveSkillSession = getData().activeSkillSession ?? null;
const initialConversationId = getData().conversation.id;
const initialConversationStatus = getData().conversation.status ?? "open";
const initialUserPersonality = getData().userPersonality ?? null;
const initialUserModel = (getData().userModel ?? "model1") as ModelId;
const modelIcons = $derived.by(() => {
	const models =
		((data as typeof data & {
			availableModels?: Array<{ id: string; iconUrl?: string | null }>;
		}).availableModels ?? []);
	return Object.fromEntries(
		models.map((model) => [model.id, model.iconUrl ?? null]),
	) as Record<string, string | null>;
});
const canPublishSkillDrafts = false;
const skillDraftLocalizedApiErrorKeys: Record<string, I18nKey> = {
	"composerCommandRegistry.disabled": "composerCommandRegistry.disabled",
	"skillDrafts.notFound": "skillDrafts.notFound",
	"skillDrafts.publishDisabled": "skillDrafts.publishDisabled",
	"skillDrafts.inheritedCopyBlocked": "skillDrafts.inheritedCopyBlocked",
	"skills.notFound": "skills.notFound",
};

$effect(() => {
	upsertConversationLocal(
		data.conversation.id,
		data.conversation.title,
		data.conversation.updatedAt,
		data.conversation.projectId ?? null,
	);
});
const skillSessionLocalizedApiErrorKeys: Record<string, I18nKey> = {
	"composerCommandRegistry.disabled": "composerCommandRegistry.disabled",
	"skillSessions.errors.activeConflict": "skillSessions.errors.activeConflict",
};

// Track conversation title reactively - use $derived to keep in sync with page data
let conversationTitle = $derived(data.conversation?.title ?? "");

// For manual updates (title generation), track separately
let generatedTitleOverride = $state<string | null>(null);
let effectiveConversationTitle = $derived(
	generatedTitleOverride ?? conversationTitle,
);

const messages = writable<ChatMessage[]>(initialMessages);
const draftPersistence = createDraftPersistence();
let sendError = $state<string | null>(null);
let isSending = $state(false);
let isEditResendPending = $state(false);
let activeStream = $state<StreamHandle | null>(null);
let queuedTurn = $state<SendPayload | null>(null);
let titleGenerationTriggered = false;
let lastUserMessage = "";
let lastAssistantResponse = "";
let canRetry = false;
let prevConversationId: string | null = null;
let hasPersistedMessages = initialHasPersistedMessages;
let contextStatus = $state<ConversationContextStatus | null>(
	initialContextStatus,
);
let totalCostUsdMicros = $state(initialTotalCostUsdMicros);
let totalTokens = $state(initialTotalTokens);
let totalCostUsd = $derived(totalCostUsdMicros / 1_000_000);
let attachedArtifacts = $state<ArtifactSummary[]>(initialAttachedArtifacts);
let activeWorkingSet: ArtifactSummary[] = initialActiveWorkingSet;
let taskState = $state<TaskState | null>(initialTaskState);
let contextDebug = $state<ContextDebugState | null>(initialContextDebug);
let contextSources = $state<ContextSourcesState | null>(initialContextSources);
let conversationDraft = $state<ConversationDraft | null>(
	initialConversationDraft,
);
let forkOrigin = $state<ConversationForkOrigin | null>(initialForkOrigin);
let generatedFiles = $state<ChatGeneratedFile[]>(initialGeneratedFiles);
let fileProductionJobs = $state<FileProductionJob[]>(initialFileProductionJobs);
let deepResearchJobs = $state<DeepResearchJob[]>(initialDeepResearchJobs);
let contextCompressionMarkers = $state<ContextCompressionMarker[]>(
	initialContextCompressionSnapshots,
);
let activeSkillSession = $state<SkillSession | null>(initialActiveSkillSession);
let skillSessionBusy = $state(false);
let skillSessionError = $state<string | null>(null);
let skillDraftActionState = $state<
	Record<string, { busy?: boolean; error?: string | null }>
>({});
let forkingMessageId = $state<string | null>(null);
let contextCompressionInFlight = $state(false);
let queuedContextCompression = $state(false);
let forkOpening = $state(Boolean(initialForkOrigin));
let forkOpeningTimeout: ReturnType<typeof setTimeout> | null = null;
let conversationStatus = $state(initialConversationStatus);
let isConversationReadOnlyForChat = $derived(
	isConversationReadOnly({ status: conversationStatus }, deepResearchJobs),
);
const initialWorkspaceState = getPersistedWorkspaceState();
let workspaceDocuments = $state<DocumentWorkspaceItem[]>(
	initialWorkspaceState?.documents ?? [],
);
let activeWorkspaceDocumentId = $state<string | null>(
	initialWorkspaceState?.activeDocumentId ?? null,
);
let workspaceOpen = $state(initialWorkspaceState?.isOpen ?? false);
let workspacePresentation = $state<"docked" | "expanded">(
	initialWorkspaceState?.presentation ?? "docked",
);
let evidenceManagerOpen = $state(false);
let personalityProfiles = $state<
	Array<{ id: string; name: string; description: string }>
>([]);
let selectedPersonalityId = $state<string | null>(
	getConversationPersonalitySelection(
		initialConversationId,
		initialUserPersonality,
	),
);
let bootstrapMode = initialBootstrapMode;
let hydratingConversation = false;
let suppressHydration = $state(false);
// Set to true when the stream was cancelled by the browser (e.g. mobile backgrounding)
// rather than by the user tapping Stop. Triggers a data reload on visibility restore.
let streamInterruptedByBackground = false;
// Set to true when onWaiting fired and we're polling for completion
let isPollingForCompletion = false;
// Set to true when we're waiting for the initial pending message to be sent (landing page transition)
let initialStreamPending = $state(untrack(() => data.bootstrap ?? false));
const evidencePollControllers = new Map<string, AbortController>();

let isThinkingActive = $derived(
	Boolean($messages[$messages.length - 1]?.isThinkingStreaming),
);
// Show loading state when waiting for the first response (either from pending message or new send)
let showInitialLoading = $derived(
	(isSending || initialStreamPending) && $messages.length === 0,
);
let availableWorkspaceDocuments = $derived(
	generatedFiles.map((file) => ({
		id: file.id,
		source: "chat_generated_file" as const,
		filename: file.filename,
		title: file.documentLabel ?? file.filename,
		documentFamilyId: file.documentFamilyId ?? null,
		documentFamilyStatus: file.documentFamilyStatus ?? null,
		documentLabel: file.documentLabel ?? null,
		documentRole: file.documentRole ?? null,
		versionNumber: file.versionNumber ?? 1,
		originConversationId: file.originConversationId ?? file.conversationId,
		originAssistantMessageId:
			file.originAssistantMessageId ?? file.assistantMessageId ?? null,
		sourceChatFileId: file.sourceChatFileId ?? file.id,
		mimeType: file.mimeType,
		previewUrl: `/api/chat/files/${file.id}/preview`,
		artifactId: file.artifactId ?? null,
		conversationId: file.conversationId,
		downloadUrl: `/api/chat/files/${file.id}/download`,
	})),
);

function getPersistedWorkspaceState() {
	if (!browser) return null;
	return loadPersistedWorkspaceDocumentState(window.sessionStorage);
}

function triggerForkOpeningTransition() {
	if (!browser || !forkOrigin) return;
	forkOpeningTimeout && clearTimeout(forkOpeningTimeout);
	forkOpening = true;
	forkOpeningTimeout = setTimeout(() => {
		forkOpening = false;
		forkOpeningTimeout = null;
	}, 320);
}

function restorePersistedWorkspaceState() {
	const persistedWorkspaceState = getPersistedWorkspaceState();
	if (!persistedWorkspaceState) {
		workspaceDocuments = [];
		activeWorkspaceDocumentId = null;
		workspaceOpen = false;
		workspacePresentation = "docked";
		return;
	}

	workspaceDocuments = persistedWorkspaceState.documents;
	activeWorkspaceDocumentId = persistedWorkspaceState.activeDocumentId;
	workspaceOpen = persistedWorkspaceState.isOpen;
	workspacePresentation = persistedWorkspaceState.presentation;
}

$effect(() => {
	if (!browser) return;
	savePersistedWorkspaceDocumentState(window.sessionStorage, {
		documents: workspaceDocuments,
		activeDocumentId: activeWorkspaceDocumentId,
		isOpen: workspaceOpen && workspaceDocuments.length > 0,
		presentation: workspacePresentation,
	});
});

function openWorkspaceDocument(
	document: DocumentWorkspaceItem,
	options: { preservePresentation?: boolean } = {},
) {
	const result = reduceWorkspaceDocumentOpen(workspaceDocuments, document);
	workspaceDocuments = result.documents;
	activeWorkspaceDocumentId = result.activeDocumentId;
	workspaceOpen = result.isOpen;
	workspacePresentation = getWorkspacePresentationAfterDocumentOpen(
		workspacePresentation,
		options,
	);
	if (browser && document.artifactId) {
		void recordDocumentWorkspaceOpen(document.artifactId).catch(
			() => undefined,
		);
	}
}

function selectWorkspaceDocument(documentId: string) {
	activeWorkspaceDocumentId = documentId;
	workspaceOpen = true;
	const document =
		workspaceDocuments.find((entry) => entry.id === documentId) ?? null;
	if (browser && document?.artifactId) {
		void recordDocumentWorkspaceOpen(document.artifactId).catch(
			() => undefined,
		);
	}
}

function closeWorkspaceDocument(documentId: string) {
	const result = reduceWorkspaceDocumentClose(
		workspaceDocuments,
		documentId,
		activeWorkspaceDocumentId,
	);
	workspaceDocuments = result.documents;
	activeWorkspaceDocumentId = result.activeDocumentId;
	workspaceOpen = result.isOpen;
}

function closeWorkspace() {
	const result = reduceWorkspaceClose(
		workspaceDocuments,
		activeWorkspaceDocumentId,
	);
	workspaceDocuments = result.documents;
	activeWorkspaceDocumentId = result.activeDocumentId;
	workspaceOpen = result.isOpen;
	workspacePresentation = "docked";
}

function handleWorkspaceConversationDeleted(conversationId: string) {
	const nextState = reduceWorkspaceDocumentsForDeletedConversation(
		workspaceDocuments,
		conversationId,
		activeWorkspaceDocumentId,
	);
	if (nextState.documents.length === workspaceDocuments.length) return;

	workspaceDocuments = nextState.documents;
	activeWorkspaceDocumentId = nextState.activeDocumentId;
	workspaceOpen = nextState.isOpen;
	if (!nextState.isOpen) {
		workspacePresentation = "docked";
	}
}

function handleWorkspaceConversationDeletedEvent(event: Event) {
	const conversationId = (event as CustomEvent<{ conversationId?: unknown }>)
		.detail?.conversationId;
	if (typeof conversationId !== "string") return;
	handleWorkspaceConversationDeleted(conversationId);
}

async function focusMessage(messageId: string) {
	await tick();
	requestAnimationFrame(() => {
		const target = document.getElementById(`message-${messageId}`);
		target?.scrollIntoView({ behavior: "smooth", block: "center" });
	});
}

async function handleJumpToWorkspaceSource(document: DocumentWorkspaceItem) {
	const conversationId = document.originConversationId;
	const assistantMessageId = document.originAssistantMessageId;
	if (!(conversationId && assistantMessageId)) return;

	if (conversationId === data.conversation.id) {
		await focusMessage(assistantMessageId);
		return;
	}

	await goto(
		buildChatSourceMessageHref({
			conversationId,
			assistantMessageId,
		}),
	);
}

function getActiveWorkspaceArtifactId(): string | undefined {
	if (!workspaceOpen || !activeWorkspaceDocumentId) {
		return undefined;
	}

	const activeDocument =
		workspaceDocuments.find(
			(document) => document.id === activeWorkspaceDocumentId,
		) ?? null;
	return activeDocument?.artifactId ?? undefined;
}

function setSelectedPersonalityId(id: string | null) {
	selectedPersonalityId = id;
	setConversationPersonalitySelection(data.conversation.id, id);
}

function applyConversationModelSelection(
	conversationId: string,
	profileDefault: ModelId,
) {
	setSelectedModel(getConversationModelSelection(conversationId, profileDefault));
}

function setSelectedConversationModelId(modelId: ModelId) {
	setSelectedModel(modelId);
	setConversationModelSelection(data.conversation.id, modelId);
}

function maybeSendPendingInitialMessage() {
	if (
		typeof window === "undefined" ||
		isSending ||
		(data.messages?.length ?? 0) > 0
	) {
		return;
	}

	const pendingDraft = consumePendingConversationMessage(data.conversation.id);
	// Clean up bootstrap URL param so refreshes don't replay the loading state.
	// Defer the history mutation to avoid triggering page-store updates during the
	// initial $effect flush, which can race with keyed-each reconciler state.
	if (browser && page.url.searchParams.get("view") === "bootstrap") {
		requestAnimationFrame(() => {
			const url = new URL(page.url);
			url.searchParams.delete("view");
			replaceState(url, page.state);
		});
	}
	if (!pendingDraft || !pendingDraft.message.trim()) {
		initialStreamPending = false;
		return;
	}
	// Show loading state until streaming actually starts
	initialStreamPending = true;
	if (pendingDraft.modelId) {
		setSelectedConversationModelId(pendingDraft.modelId);
	}
	setSelectedPersonalityId(pendingDraft.personalityProfileId ?? null);
	handleSend({ ...pendingDraft, pendingAttachments: [] });
}

function resetState() {
	for (const controller of evidencePollControllers.values()) {
		controller.abort();
	}
	evidencePollControllers.clear();
	if (activeStream) {
		activeStream.detach();
		activeStream = null;
	}
	messages.set(data.messages ?? []);
	hasPersistedMessages = (data.messages?.length ?? 0) > 0;
	sendError = null;
	isSending = false;
	titleGenerationTriggered = false;
	lastUserMessage = "";
	lastAssistantResponse = "";
	canRetry = false;
	selectedPersonalityId = getConversationPersonalitySelection(
		data.conversation.id,
		data.userPersonality ?? null,
	);
	applyConversationModelSelection(
		data.conversation.id,
		(data.userModel ?? "model1") as ModelId,
	);
	contextStatus = data.contextStatus ?? null;
	attachedArtifacts = data.attachedArtifacts ?? [];
	activeWorkingSet = data.activeWorkingSet ?? [];
	taskState = data.taskState ?? null;
	contextDebug = data.contextDebug ?? null;
	contextSources = data.contextSources ?? null;
	conversationDraft = data.draft ?? null;
	forkOrigin = data.forkOrigin ?? null;
	triggerForkOpeningTransition();
		generatedFiles = data.generatedFiles ?? [];
		fileProductionJobs = data.fileProductionJobs ?? [];
		deepResearchJobs = data.deepResearchJobs ?? [];
		contextCompressionMarkers = data.contextCompressionSnapshots ?? [];
		conversationStatus = data.conversation.status ?? "open";
	totalCostUsdMicros = data.totalCostUsdMicros ?? 0;
	totalTokens = data.totalTokens ?? 0;
	restorePersistedWorkspaceState();
	queuedTurn = null;
	bootstrapMode = data.bootstrap ?? false;
	hydratingConversation = false;
	suppressHydration = false;
	evidenceManagerOpen = false;
	forkingMessageId = null;
	draftPersistence.clear();
	currentConversationId.set(data.conversation.id);
	// Defer pending-message send to avoid state-cascade during hydration
	if (typeof window !== "undefined") {
		requestAnimationFrame(() => {
			maybeSendPendingInitialMessage();
		});
	}
	if (bootstrapMode) {
		void hydrateConversationDetail(data.conversation.id);
	}
}

$effect(() => {
	const focusMessageId = getChatFocusMessageIdFromUrl(page.url);
	if (
		!focusMessageId ||
		!$messages.some((message) => message.id === focusMessageId)
	) {
		return;
	}

	void focusMessage(focusMessageId);
	replaceState(clearChatFocusMessageParam(page.url), page.state);
});

$effect(() => {
	if (!data?.conversation?.id || activeStream) {
		return;
	}
	if (data.conversation.id !== prevConversationId) {
		prevConversationId = data.conversation.id;
		resetState();
	}
});

function handleVisibilityChange() {
	if (document.visibilityState === "visible") {
		if (streamInterruptedByBackground) {
			streamInterruptedByBackground = false;
			void invalidate(`app:conversation-detail:${data.conversation.id}`);
			void checkForOrphanedStreamOnMount();
		}

		// Recover evidence for any messages with pending status
		recoverPendingEvidence();
	}
}

function recoverPendingEvidence() {
	const currentMessages = $messages;
	for (const message of currentMessages) {
		if (
			message.role === "assistant" &&
			message.evidencePending &&
			!message.evidenceSummary
		) {
			void pollMessageEvidence(message.id);
		}
	}
}

async function pollForCompletion(placeholderId: string, attempt = 0) {
	const maxAttempts = 60;
	const pollInterval = 2000;

	if (attempt >= maxAttempts) {
		console.info("[CHAT] Polling timeout - checking final state");
		isPollingForCompletion = false;
		void loadPersistedData();
		return;
	}

	console.info("[CHAT] Polling for completion, attempt:", attempt + 1);
	const detail = await fetchConversationDetail(data.conversation.id).catch(
		() => null,
	);

	if (!detail) {
		setTimeout(
			() => void pollForCompletion(placeholderId, attempt + 1),
			pollInterval,
		);
		return;
	}

	// Get current message IDs to avoid duplicates
	let currentMessageIds: string[] = [];
	messages.update((list) => {
		currentMessageIds = list.map((m) => m.id);
		return list;
	});

	// Find messages that are NOT already in our list and are assistant messages
	const newMessages = detail.messages ?? [];
	const existingAssistantIds = new Set(
		newMessages
			.filter((m: ChatMessage) => m.role === "assistant")
			.map((m: ChatMessage) => m.id),
	);

	// Find NEW assistant messages (ones not already in our list)
	const newAssistantMessages = newMessages.filter(
		(m: ChatMessage) =>
			m.role === "assistant" &&
			m.content &&
			m.content.length > 0 &&
			!currentMessageIds.includes(m.id),
	);

	if (newAssistantMessages.length > 0) {
		// Get the most recent new assistant message
		const newAssistant = newAssistantMessages[newAssistantMessages.length - 1];
		console.info(
			"[CHAT] Completion detected - new assistant message found, content length:",
			newAssistant.content.length,
		);

		// Remove the placeholder
		messages.update((list) => {
			const filtered = list.filter((m) => m.id !== placeholderId);
			return [...filtered, newAssistant];
		});

		isSending = false;
		canRetry = false;

		// Update context status
		if (detail.contextStatus) {
			contextStatus = detail.contextStatus;
		}
		if (detail.contextSources) {
			contextSources = detail.contextSources;
		}
		if (detail.activeWorkingSet) {
			activeWorkingSet = detail.activeWorkingSet;
		}
		if (detail.taskState) {
			taskState = detail.taskState;
		}

		// Update generated files
		if (detail.generatedFiles) {
			generatedFiles = [...(detail.generatedFiles ?? [])];
		}
		if (detail.fileProductionJobs) {
			fileProductionJobs = [...(detail.fileProductionJobs ?? [])];
		}
		if (detail.deepResearchJobs) {
			deepResearchJobs = mergeDeepResearchJobsForHydration(
				deepResearchJobs,
				detail.deepResearchJobs ?? [],
			);
		}
		conversationStatus = detail.conversation?.status ?? conversationStatus;

		// Poll for evidence
		if (newAssistant.id) {
			void pollMessageEvidence(newAssistant.id);
		}

		isPollingForCompletion = false;
		return;
	}

	// Still waiting, poll again
	setTimeout(
		() => void pollForCompletion(placeholderId, attempt + 1),
		pollInterval,
	);
}

async function loadPersistedData() {
	console.info("[CHAT] Loading persisted data after polling timeout");
	hasPersistedMessages = true;
	const detail = await fetchConversationDetail(data.conversation.id).catch(
		() => null,
	);
	if (detail) {
		messages.set([...(detail.messages ?? [])]);
		contextStatus = detail.contextStatus ?? contextStatus;
		contextSources = detail.contextSources ?? contextSources;
		forkOrigin = detail.forkOrigin ?? forkOrigin;
		activeWorkingSet = detail.activeWorkingSet ?? activeWorkingSet;
		taskState = detail.taskState ?? taskState;
		contextDebug = detail.contextDebug ?? contextDebug;
		generatedFiles = [...(detail.generatedFiles ?? [])];
		fileProductionJobs = [...(detail.fileProductionJobs ?? [])];
		deepResearchJobs = mergeDeepResearchJobsForHydration(
			deepResearchJobs,
			detail.deepResearchJobs ?? [],
		);
		conversationStatus = detail.conversation?.status ?? conversationStatus;
		conversationDraft = null;
		const pending = consumePendingConversationMessage(data.conversation.id);
		void pending;
	}
	isSending = false;
	isPollingForCompletion = false;
}

async function reconnectToOrphanedStream(
	streamId: string,
	userMessage: string = "",
	retryCount = 0,
) {
	if (isSending || activeStream) return;

	console.info(
		"[CHAT] Starting reconnection to stream:",
		streamId,
		"userMessage:",
		userMessage.slice(0, 50),
		"attempt:",
		retryCount + 1,
	);
	isSending = true;
	hasPersistedMessages = true;

	const placeholderId = crypto.randomUUID();
	const placeholder = createAssistantPlaceholder(placeholderId);
	const clientUserMsgId = crypto.randomUUID();
	const userMsgObj = createUserMessage({
		id: clientUserMsgId,
		text: userMessage,
		attachmentIds: [],
		attachedArtifacts: [],
	});
	messages.update((list) =>
		appendUserMessageAndPlaceholder(list, userMsgObj, placeholder),
	);

	activeStream = streamChat(
		userMessage || "",
		data.conversation.id,
		{
			onToken(chunk) {
				messages.update((list) =>
					appendTokenChunkToMessageList(list, placeholderId, chunk),
				);
			},
			onThinking(chunk) {
				messages.update((list) =>
					appendThinkingChunkToMessageList(list, placeholderId, chunk),
				);
			},
			onToolCall(name, input, status, details) {
				messages.update((list) =>
					applyToolCallUpdateToMessageList(list, {
						placeholderId,
						name,
						input,
						status,
						details,
					}),
				);
				if (shouldHydrateFileProductionJobsOnToolCall(name, status)) {
					void hydrateConversationDetail(data.conversation.id);
				}
			},
			onWaiting() {
				console.info("[CHAT] Reconnection waiting - polling for completion");
				activeStream?.detach();
				activeStream = null;
				isPollingForCompletion = true;
				void pollForCompletion(placeholderId);
			},
			onEnd(fullText, metadata) {
				// If we're polling for completion, don't finalize - polling will handle it
				if (isPollingForCompletion) {
					console.info(
						"[CHAT] Stream ended during polling - ignoring finalize",
					);
					isPollingForCompletion = false;
					return;
				}
				console.info(
					"[CHAT] Reconnection stream ended, fullText length:",
					fullText.length,
				);
				contextStatus = metadata?.contextStatus ?? contextStatus;
				contextSources = metadata?.contextSources ?? contextSources;
				activeWorkingSet = metadata?.activeWorkingSet ?? activeWorkingSet;
				taskState = metadata?.taskState ?? taskState;
				contextDebug = metadata?.contextDebug ?? contextDebug;
				if (metadata?.generatedFiles) {
					const existingIds = new Set(generatedFiles.map((f) => f.id));
					const newFiles = metadata.generatedFiles.filter(
						(f) => !existingIds.has(f.id),
					);
					generatedFiles = [...generatedFiles, ...newFiles];
				}
				if (metadata?.generatedFiles) {
					void hydrateConversationDetail(data.conversation.id);
				}
				const serverAssistantId = metadata?.assistantMessageId;
				if (serverAssistantId) {
					attachFileProductionJobsToAssistantMessage(serverAssistantId);
				}
				messages.update((list) =>
					finalizeStreamingMessageList(list, {
						placeholderId,
						clientUserMessageId: null,
						metadata,
					}),
				);
				isSending = false;
				activeStream = null;
				canRetry = false;
				if (serverAssistantId) {
					void pollMessageEvidence(serverAssistantId);
					setTimeout(() => refreshMessageCost(serverAssistantId), 1500);
				}
			},
			onError(err) {
				const isBrowserAbort =
					err.name === "AbortError" &&
					browser &&
					document.visibilityState === "hidden";
				if (isBrowserAbort) {
					messages.update((list) => removeMessageById(list, placeholderId));
					activeStream = null;
					isSending = false;
					streamInterruptedByBackground = true;
					return;
				}

				// Capacity error means the orphaned stream is still running in background
				// Retry reconnection with exponential backoff (max 3 retries)
				const isCapacityError =
					err.message?.includes("capacity") || err.code === "CAPACITY_EXCEEDED";
				if (isCapacityError && retryCount < 3) {
					const delay = 2 ** retryCount * 500; // 500ms, 1s, 2s
					console.info(
						"[CHAT] Capacity error - retrying reconnection in",
						delay,
						"ms (attempt",
						retryCount + 2,
						")",
					);
					isSending = false;
					activeStream = null;
					messages.update((list) => removeMessageById(list, placeholderId));
					setTimeout(() => {
						void reconnectToOrphanedStream(
							streamId,
							userMessage,
							retryCount + 1,
						);
					}, delay);
					return;
				}

				// After max retries, fall back to showing persisted data
				if (isCapacityError) {
					console.info("[CHAT] Max retries reached, loading persisted data");
				}

				// Reconnection error - the stream may have completed server-side
				// while we attempted to reconnect. Fetch fresh data directly.
				console.info(
					"[CHAT] Reconnection failed, fetching fresh data directly",
				);
				hasPersistedMessages = true;
				isSending = false;
				activeStream = null;
				messages.update((list) => removeMessageById(list, placeholderId));
				fetchConversationDetail(data.conversation.id)
					.then((detail) => {
						console.info(
							"[CHAT] Fresh data loaded, messages:",
							detail.messages.length,
							"generatedFiles:",
							detail.generatedFiles?.length ?? 0,
						);
						// Log messages to debug empty box issue
						const lastMsg = detail.messages[detail.messages.length - 1];
						const secondLastMsg = detail.messages[detail.messages.length - 2];
						console.info(
							"[CHAT] Last 2 messages:",
							lastMsg?.role,
							"content len:",
							lastMsg?.content?.length ?? "N/A",
							secondLastMsg?.role,
							"content len:",
							secondLastMsg?.content?.length ?? "N/A",
						);

						// Update stores directly - don't call invalidateAll as it can overwrite our fresh data
						messages.set([...(detail.messages ?? [])]); // Create new array to trigger reactivity
						contextStatus = detail.contextStatus ?? contextStatus;
						contextSources = detail.contextSources ?? contextSources;
						activeWorkingSet = detail.activeWorkingSet ?? activeWorkingSet;
						taskState = detail.taskState ?? taskState;
						contextDebug = detail.contextDebug ?? contextDebug;
						forkOrigin = detail.forkOrigin ?? forkOrigin;
						generatedFiles = [...(detail.generatedFiles ?? [])];
						fileProductionJobs = [...(detail.fileProductionJobs ?? [])];
						deepResearchJobs = mergeDeepResearchJobsForHydration(
							deepResearchJobs,
							detail.deepResearchJobs ?? [],
						);
						conversationStatus =
							detail.conversation?.status ?? conversationStatus;
						conversationDraft = null;
						// Clear sessionStorage draft to prevent restoration
						const pending = consumePendingConversationMessage(
							data.conversation.id,
						);
						void pending;
					})
					.catch((e) => {
						console.error("[CHAT] Failed to fetch fresh data:", e);
					});
			},
		},
		{
			reconnectToStreamId: streamId,
			reconnectUserMessage: userMessage,
			thinkingMode: $selectedThinkingMode,
		},
	);
}

async function checkForOrphanedStreamOnMount() {
	// Note: hydratingConversation is intentionally NOT in the skip condition.
	// Orphan detection is independent of bootstrap hydration — the reconnection
	// path guards itself via isSending/activeStream, and hydration skips when
	// activeStream is set. Skipping the orphan check while hydrating causes a
	// race where the client misses the orphaned stream, the server keeps it
	// alive, and the user gets a 502 on the next send due to orphan cancellation
	// timing issues.
	if (isSending || activeStream) {
		return;
	}

	// Pending message consumption is intentionally left to maybeSendPendingInitialMessage().
	// Removing it here prevents a race where this function (called from onMount) steals the
	// message before the $effect → resetState() → maybeSendPendingInitialMessage() path can
	// read it, leaving the chat stuck on 'Conversation Ready' with no way to send.

	// Check for orphaned streams regardless of existing messages
	// Previous turns don't prevent reconnection to active streams
	const streamId = await checkForOrphanedStream(data.conversation.id);

	if (!streamId) return;

	// Fetch buffer info to get the original user message for reconnection
	const bufferInfo = await getStreamBufferInfo(streamId);

	void reconnectToOrphanedStream(streamId, bufferInfo?.userMessage ?? "");
}

onMount(() => {
	currentConversationId.set(data.conversation.id);
	requestAnimationFrame(() => {
		applyConversationModelSelection(initialConversationId, initialUserModel);
	});
	triggerForkOpeningTransition();
	document.addEventListener("visibilitychange", handleVisibilityChange);
	window.addEventListener(
		WORKSPACE_CONVERSATION_DELETED_EVENT,
		handleWorkspaceConversationDeletedEvent,
	);
	void checkForOrphanedStreamOnMount();
	void recoverPendingEvidence();
	void fetchPublicPersonalityProfiles()
		.then((p) => (personalityProfiles = p))
		.catch(() => {});
});

onDestroy(() => {
	if (browser) {
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		window.removeEventListener(
			WORKSPACE_CONVERSATION_DELETED_EVENT,
			handleWorkspaceConversationDeletedEvent,
		);
	}
	if (forkOpeningTimeout) {
		clearTimeout(forkOpeningTimeout);
		forkOpeningTimeout = null;
	}
	for (const controller of evidencePollControllers.values()) {
		controller.abort();
	}
	evidencePollControllers.clear();

	if (activeStream) {
		activeStream.detach();
		activeStream = null;
	}

	void draftPersistence.flush();

	if (
		!hasPersistedMessages &&
		data?.conversation?.id &&
		!hasActiveDeepResearchJobs(deepResearchJobs) &&
		!hasMeaningfulDraft(
			conversationDraft?.draftText ?? "",
			conversationDraft?.selectedAttachmentIds ?? [],
		)
	) {
		cleanupPreparedConversation({
			conversationId: data.conversation.id,
			removeLocal: removeConversationLocal,
		});
	}
});

async function hydrateConversationDetail(conversationId: string) {
	if (hydratingConversation) return;
	hydratingConversation = true;

	try {
		const payload = await fetchConversationDetail(conversationId);
		if (!suppressHydration) {
			attachedArtifacts = payload.attachedArtifacts ?? attachedArtifacts;
		}
		activeWorkingSet = payload.activeWorkingSet ?? activeWorkingSet;
		contextStatus = payload.contextStatus ?? contextStatus;
		contextSources = payload.contextSources ?? contextSources;
		taskState = payload.taskState ?? taskState;
		contextDebug = payload.contextDebug ?? contextDebug;
		conversationDraft = payload.draft ?? conversationDraft;
		forkOrigin = payload.forkOrigin ?? forkOrigin;
		generatedFiles = payload.generatedFiles ?? generatedFiles;
			fileProductionJobs = payload.fileProductionJobs ?? fileProductionJobs;
			deepResearchJobs = payload.deepResearchJobs
				? mergeDeepResearchJobsForHydration(
						deepResearchJobs,
						payload.deepResearchJobs,
					)
				: deepResearchJobs;
			contextCompressionMarkers =
				payload.contextCompressionSnapshots ?? contextCompressionMarkers;
			activeSkillSession = payload.activeSkillSession ?? null;
		conversationStatus = payload.conversation?.status ?? conversationStatus;
		bootstrapMode = false;

		if (
			!activeStream &&
			$messages.length === 0 &&
			(payload.messages?.length ?? 0) > 0
		) {
			messages.set(payload.messages ?? []);
			hasPersistedMessages = true;
		}
	} catch {
		// Ignore hydration failures; the optimistic chat flow can continue without it.
	} finally {
		hydratingConversation = false;
	}
}

async function endCurrentSkillSession(reason: "ended" | "dismissed") {
	if (!activeSkillSession || skillSessionBusy) return;
	skillSessionBusy = true;
	skillSessionError = null;
	try {
		await endConversationSkillSession(data.conversation.id, reason);
		activeSkillSession = null;
	} catch (error) {
		skillSessionError = localizedSkillSessionError(
			error,
			"skillSessions.errors.end",
		);
	} finally {
		skillSessionBusy = false;
	}
}

function attachFileProductionJobsToAssistantMessage(
	assistantMessageId: string,
) {
	fileProductionJobs = attachUnassignedFileProductionJobsToAssistant(
		fileProductionJobs,
		{
			conversationId: data.conversation.id,
			assistantMessageId,
		},
	);
}

function mergeDeepResearchJob(
	jobs: DeepResearchJob[],
	updatedJob: DeepResearchJob,
): DeepResearchJob[] {
	const existingIndex = jobs.findIndex((job) => job.id === updatedJob.id);
	if (existingIndex === -1) {
		return [...jobs, updatedJob];
	}
	return jobs.map((job, index) => (index === existingIndex ? updatedJob : job));
}

function replaceOptimisticDeepResearchJob(
	jobs: DeepResearchJob[],
	optimisticJobId: string,
	updatedJob: DeepResearchJob,
): DeepResearchJob[] {
	return mergeDeepResearchJob(
		jobs.filter((job) => job.id !== optimisticJobId),
		updatedJob,
	);
}

function removeDeepResearchJob(
	jobs: DeepResearchJob[],
	jobId: string,
): DeepResearchJob[] {
	return jobs.filter((job) => job.id !== jobId);
}

function createOptimisticDeepResearchJob(params: {
	conversationId: string;
	triggerMessageId: string | null;
	depth: NonNullable<SendPayload["deepResearchDepth"]>;
	message: string;
}): DeepResearchJob {
	const now = Date.now();
	const title =
		params.message.trim().replace(/\s+/g, " ").slice(0, 96) || "Deep Research";
	return {
		id: `pending-deep-research-${crypto.randomUUID()}`,
		conversationId: params.conversationId,
		triggerMessageId: params.triggerMessageId,
		depth: params.depth,
		status: "awaiting_plan",
		stage: "plan_generation",
		title,
		userRequest: params.message,
		reportArtifactId: null,
		plan: null,
		currentPlan: null,
		timeline: [],
		sourceCounts: { discovered: 0, reviewed: 0, cited: 0 },
		sources: [],
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		cancelledAt: null,
	};
}

async function handleRetryFileProductionJob(jobId: string) {
	try {
		const job = await retryFileProductionJobRequest(jobId);
		fileProductionJobs = mergeFileProductionJob(fileProductionJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to retry file production";
	}
}

async function handleCancelFileProductionJob(jobId: string) {
	try {
		const job = await cancelFileProductionJobRequest(jobId);
		fileProductionJobs = mergeFileProductionJob(fileProductionJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to cancel file production";
	}
}

async function handleCancelDeepResearchJob(jobId: string) {
	const jobBeforeCancel = deepResearchJobs.find((job) => job.id === jobId);
	const shouldDeleteConversation =
		shouldDeleteConversationAfterCancellingDeepResearch({
			jobBeforeCancel,
			messageCount: $messages.length,
			deepResearchJobCount: deepResearchJobs.length,
		});
	try {
		const job = await cancelDeepResearchJobRequest(jobId);
		if (shouldDeleteConversation) {
			draftPersistence.clear();
			await deleteConversationDraft(data.conversation.id).catch(
				() => undefined,
			);
			await deleteConversation(data.conversation.id);
			removeConversationLocal(data.conversation.id);
			await invalidateAll();
			await goto("/");
			return;
		}
		deepResearchJobs = mergeDeepResearchJob(deepResearchJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to cancel Deep Research";
	}
}

async function handleEditDeepResearchPlan(
	jobId: string,
	instructions: string,
	reportIntent?: DeepResearchReportIntent,
) {
	try {
		const job = await editDeepResearchPlanRequest(
			jobId,
			instructions,
			reportIntent,
		);
		deepResearchJobs = mergeDeepResearchJob(deepResearchJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to edit Research Plan";
		throw err;
	}
}

async function handleApproveDeepResearchPlan(jobId: string) {
	try {
		const job = await approveDeepResearchPlanRequest(jobId);
		deepResearchJobs = mergeDeepResearchJob(deepResearchJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to approve Research Plan";
		throw err;
	}
}

async function handleDiscussDeepResearchReport(jobId: string) {
	try {
		const action = await discussDeepResearchReportRequest(jobId);
		upsertConversationLocal(action.conversation);
		if (action.seedMessage) {
			storePendingConversationMessage(action.conversation.id, {
				message: action.seedMessage,
				attachmentIds: [],
				attachments: [],
				modelId: $selectedModel,
				personalityProfileId: selectedPersonalityId,
				deepResearchDepth: null,
			});
		}
		await goto(`/chat/${action.conversation.id}?view=bootstrap`);
	} catch (err) {
		sendError =
			err instanceof Error
				? err.message
				: "Failed to discuss Deep Research artifact";
		throw err;
	}
}

async function handleResearchFurtherFromDeepResearchReport(
	jobId: string,
	options?: { depth?: DeepResearchDepth },
) {
	try {
		const action = await researchFurtherFromDeepResearchReportRequest(
			jobId,
			options,
		);
		upsertConversationLocal(action.conversation);
		await goto(`/chat/${action.conversation.id}`);
	} catch (err) {
		sendError =
			err instanceof Error
				? err.message
				: "Failed to research further from Deep Research artifact";
		throw err;
	}
}

function handleAdvanceDeepResearchWorkflow(jobId: string) {
	void advanceDeepResearchWorkflowRequest(jobId)
		.then((result) => {
			deepResearchJobs = mergeDeepResearchJob(deepResearchJobs, result.job);
			void hydrateConversationDetail(data.conversation.id);
		})
		.catch((err) => {
			sendError =
				err instanceof Error ? err.message : "Failed to advance Deep Research";
		});
}

async function startDeepResearchTurn(params: {
	message: string;
	depth: NonNullable<SendPayload["deepResearchDepth"]>;
	attachmentIds: string[];
	modelId: SendPayload["modelId"];
	personalityProfileId: string | null;
	clientUserMessageId: string | null;
}) {
	const optimisticJob = createOptimisticDeepResearchJob({
		conversationId: data.conversation.id,
		triggerMessageId: params.clientUserMessageId,
		depth: params.depth,
		message: params.message,
	});
	deepResearchJobs = mergeDeepResearchJob(deepResearchJobs, optimisticJob);
	try {
		const job = await startDeepResearchChatJobRequest({
			conversationId: data.conversation.id,
			message: params.message,
			depth: params.depth,
			modelId: params.modelId,
			attachmentIds: params.attachmentIds,
			activeDocumentArtifactId: getActiveWorkspaceArtifactId(),
			personalityProfileId: params.personalityProfileId,
		});
		if (params.clientUserMessageId && job.triggerMessageId) {
			messages.update((list) =>
				updateMessageById(list, params.clientUserMessageId!, (message) => ({
					...message,
					renderKey: message.renderKey ?? params.clientUserMessageId!,
					id: job.triggerMessageId ?? message.id,
				})),
			);
		}
		deepResearchJobs = replaceOptimisticDeepResearchJob(
			deepResearchJobs,
			optimisticJob.id,
			job,
		);
		isSending = false;
		initialStreamPending = false;
		activeStream = null;
		canRetry = false;
		queuedTurn = null;
		queuedContextCompression = false;
		contextCompressionInFlight = false;
		void hydrateConversationDetail(data.conversation.id);
	} catch (err) {
		isSending = false;
		initialStreamPending = false;
		activeStream = null;
		deepResearchJobs = removeDeepResearchJob(
			deepResearchJobs,
			optimisticJob.id,
		);
		restoreQueuedTurnToDraft();
		sendError =
			err instanceof Error ? err.message : "Failed to start Deep Research";
		canRetry = false;
	}
}

$effect(() => {
	const conversationId = data.conversation?.id;
	const shouldPollConversation =
		hasActiveFileProductionJobs(fileProductionJobs) ||
		hasActiveDeepResearchJobs(deepResearchJobs);
	if (!browser || !conversationId || !shouldPollConversation) {
		return;
	}

	const interval = setInterval(() => {
		void hydrateConversationDetail(conversationId);
	}, 2500);

	return () => {
		clearInterval(interval);
	};
});

let initializedGeneratedFilesData = false;
let prevGeneratedFilesData: typeof data.generatedFiles;
$effect(() => {
	if (!initializedGeneratedFilesData) {
		prevGeneratedFilesData = data.generatedFiles;
		initializedGeneratedFilesData = true;
		return;
	}
	if (data.generatedFiles !== prevGeneratedFilesData) {
		prevGeneratedFilesData = data.generatedFiles;
		if (data.generatedFiles) {
			const currentFiles = untrack(() => generatedFiles);
			const existingIds = new Set(currentFiles.map((f) => f.id));
			const newFiles = data.generatedFiles.filter(
				(f) => !existingIds.has(f.id),
			);
			generatedFiles = [...currentFiles, ...newFiles];
		}
	}
});

let initializedFileProductionJobsData = false;
let prevFileProductionJobsData: typeof data.fileProductionJobs;
$effect(() => {
	if (!initializedFileProductionJobsData) {
		prevFileProductionJobsData = data.fileProductionJobs;
		initializedFileProductionJobsData = true;
		return;
	}
	if (data.fileProductionJobs !== prevFileProductionJobsData) {
		prevFileProductionJobsData = data.fileProductionJobs;
		fileProductionJobs = [...(data.fileProductionJobs ?? [])];
	}
});

let initializedDeepResearchJobsData = false;
let prevDeepResearchJobsData: typeof data.deepResearchJobs;
$effect(() => {
	if (!initializedDeepResearchJobsData) {
		prevDeepResearchJobsData = data.deepResearchJobs;
		initializedDeepResearchJobsData = true;
		return;
	}
	if (data.deepResearchJobs !== prevDeepResearchJobsData) {
		prevDeepResearchJobsData = data.deepResearchJobs;
		deepResearchJobs = mergeDeepResearchJobsForHydration(
			deepResearchJobs,
			data.deepResearchJobs ?? [],
		);
	}
});

let initializedContextCompressionData = false;
let prevContextCompressionData: typeof data.contextCompressionSnapshots;
$effect(() => {
	if (!initializedContextCompressionData) {
		prevContextCompressionData = data.contextCompressionSnapshots;
		initializedContextCompressionData = true;
		return;
	}
	if (data.contextCompressionSnapshots !== prevContextCompressionData) {
		prevContextCompressionData = data.contextCompressionSnapshots;
		contextCompressionMarkers = [...(data.contextCompressionSnapshots ?? [])];
	}
});

$effect(() => {
	activeSkillSession = data.activeSkillSession ?? null;
});

$effect(() => {
	conversationStatus = data.conversation.status ?? "open";
});

function restorePayloadToDraft(payload: SendPayload) {
	const nextConversationId = payload.conversationId ?? data.conversation.id;
	conversationDraft = createConversationDraftRecord({
		conversationId: nextConversationId,
		fallbackConversationId: data.conversation.id,
		draftText: payload.message,
		selectedAttachmentIds: payload.attachmentIds,
		selectedAttachments: payload.pendingAttachments ?? [],
		selectedLinkedSources: payload.linkedSources ?? [],
		pendingSkill: payload.deepResearchDepth
			? null
			: (payload.pendingSkill ?? null),
	});
	void draftPersistence.persist(
		{
			conversationId: nextConversationId,
			draftText: payload.message,
			selectedAttachmentIds: payload.attachmentIds,
			selectedLinkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.deepResearchDepth
				? null
				: (payload.pendingSkill ?? null),
		},
		true,
	);
}

function restoreQueuedTurnToDraft() {
	if (!queuedTurn) return;
	const nextQueuedTurn = cloneSendPayload(queuedTurn);
	queuedTurn = null;
	restorePayloadToDraft(nextQueuedTurn);
}

function editQueuedTurn() {
	restoreQueuedTurnToDraft();
	sendError = null;
}

function clearQueuedTurn() {
	queuedTurn = null;
	sendError = null;
}

function maybeTriggerTitleGeneration(
	userMessage: string,
	assistantResponse: string,
) {
	if (
		titleGenerationTriggered ||
		effectiveConversationTitle !== "New Conversation"
	) {
		return;
	}

	titleGenerationTriggered = true;
	const conversationIdForTitle = data.conversation.id;
	generateConversationTitle(conversationIdForTitle, {
		userMessage,
		assistantResponse,
	})
		.then((title) => {
			if (title) {
				updateConversationTitleLocal(conversationIdForTitle, title);
				generatedTitleOverride = title;
			}
		})
		.catch(() => {
			// Ignore errors, title remains 'New conversation'
		});
}

async function pollMessageEvidence(messageId: string) {
	evidencePollControllers.get(messageId)?.abort();
	const controller = new AbortController();
	evidencePollControllers.set(messageId, controller);

	const attempts = 12;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (controller.signal.aborted) return;

		try {
			const result = await fetchMessageEvidence(
				data.conversation.id,
				messageId,
				controller.signal,
			);

			if (result.status === "pending") {
				await new Promise((resolve) =>
					setTimeout(resolve, attempt < 4 ? 250 : 500),
				);
				continue;
			}

			if (result.status === "none" || result.status === "missing") {
				messages.update((list) =>
					updateMessageById(list, messageId, (message) => ({
						...message,
						evidencePending: false,
					})),
				);
				return;
			}

			messages.update((list) =>
				updateMessageById(list, messageId, (message) => ({
					...message,
					evidenceSummary: result.evidenceSummary,
					evidencePending: false,
				})),
			);
			return;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				return;
			}
			break;
		}
	}

	messages.update((list) =>
		updateMessageById(list, messageId, (message) => ({
			...message,
			evidencePending: false,
		})),
	);
}

async function refreshMessageCost(messageId: string) {
	try {
		const detail = await fetchConversationDetail(data.conversation.id);
		const msg = detail.messages.find((m: any) => m.id === messageId);
		if (msg && (msg.costUsd != null || msg.generationDurationMs != null)) {
			messages.update((list) =>
				updateMessageById(list, messageId, (message) => ({
					...message,
					costUsd: msg.costUsd ?? message.costUsd,
					generationDurationMs:
						msg.generationDurationMs ?? message.generationDurationMs,
					modelDisplayName: msg.modelDisplayName ?? message.modelDisplayName,
				})),
			);
		}
		if (detail.totalCostUsdMicros != null) {
			totalCostUsdMicros = detail.totalCostUsdMicros;
			totalTokens = detail.totalTokens ?? 0;
		}
	} catch {
		// Silently ignore — cost will show after page refresh
	}
}

function patchSkillDraftFromResponse(
	messageId: string,
	response: { draft?: NonNullable<ChatMessage["skillDrafts"]>[number] },
) {
	if (!response.draft) return;
	messages.update((list) =>
		patchSkillDraftInMessageList(list, {
			messageId,
			draft: response.draft!,
		}),
	);
}

function skillDraftActionKey(payload: { messageId: string; draftId: string }) {
	return `${payload.messageId}:${payload.draftId}`;
}

function setSkillDraftActionState(
	payload: { messageId: string; draftId: string },
	state: { busy?: boolean; error?: string | null },
) {
	skillDraftActionState = {
		...skillDraftActionState,
		[skillDraftActionKey(payload)]: state,
	};
}

function localizedSkillDraftActionError(
	error: unknown,
	fallbackKey: I18nKey,
): string {
	const translate = get(t);
	if (error instanceof ApiError && error.errorKey) {
		const localizedKey = skillDraftLocalizedApiErrorKeys[error.errorKey];
		if (localizedKey) return translate(localizedKey);
	}
	return translate(fallbackKey);
}

function localizedSkillSessionError(
	error: unknown,
	fallbackKey: I18nKey,
): string {
	const translate = get(t);
	if (error instanceof ApiError && error.errorKey) {
		const localizedKey = skillSessionLocalizedApiErrorKeys[error.errorKey];
		if (localizedKey) return translate(localizedKey);
	}
	return error instanceof Error ? error.message : translate(fallbackKey);
}

function localizedForkCreationError(error: unknown): string {
	const translate = get(t);
	if (error instanceof ApiError) {
		const localizedKey = getForkCreationErrorKey(error.code);
		if (localizedKey) return translate(localizedKey);
	}
	return error instanceof Error ? error.message : translate("fork.failed");
}

async function handleSaveSkillDraft(payload: {
	messageId: string;
	draftId: string;
}) {
	setSkillDraftActionState(payload, { busy: true, error: null });
	try {
		const response = await saveSkillDraftRequest(
			data.conversation.id,
			payload.messageId,
			payload.draftId,
		);
		patchSkillDraftFromResponse(payload.messageId, response);
		setSkillDraftActionState(payload, { busy: false, error: null });
	} catch (error) {
		setSkillDraftActionState(payload, {
			busy: false,
			error: localizedSkillDraftActionError(error, "skillDrafts.saveError"),
		});
	}
}

async function handleDismissSkillDraft(payload: {
	messageId: string;
	draftId: string;
}) {
	setSkillDraftActionState(payload, { busy: true, error: null });
	try {
		const response = await dismissSkillDraftRequest(
			data.conversation.id,
			payload.messageId,
			payload.draftId,
		);
		patchSkillDraftFromResponse(payload.messageId, response);
		setSkillDraftActionState(payload, { busy: false, error: null });
	} catch (error) {
		setSkillDraftActionState(payload, {
			busy: false,
			error: localizedSkillDraftActionError(error, "skillDrafts.dismissError"),
		});
	}
}

async function handlePublishSkillDraft(payload: {
	messageId: string;
	draftId: string;
}) {
	setSkillDraftActionState(payload, { busy: true, error: null });
	try {
		const response = await publishSkillDraftRequest(
			data.conversation.id,
			payload.messageId,
			payload.draftId,
		);
		patchSkillDraftFromResponse(payload.messageId, response);
		setSkillDraftActionState(payload, { busy: false, error: null });
	} catch (error) {
		setSkillDraftActionState(payload, {
			busy: false,
			error: localizedSkillDraftActionError(error, "skillDrafts.publishError"),
		});
	}
}

async function handleFork(payload: { messageId: string }) {
	if (isConversationReadOnlyForChat || forkingMessageId) return;
	if (activeStream) {
		sendError = get(t)("fork.activeStreamGuard");
		return;
	}
	forkingMessageId = payload.messageId;
	sendError = null;
	try {
		const result = await createConversationFork(data.conversation.id, {
			messageId: payload.messageId,
		});
		upsertConversationLocal(
			result.conversation.id,
			result.conversation.title,
			result.conversation.updatedAt,
			result.conversation.projectId ?? null,
		);
		conversationDraft = null;
		queuedTurn = null;
		draftPersistence.clear();
		currentConversationId.set(result.conversation.id);
		await goto(`/chat/${result.conversation.id}`);
	} catch (error) {
		sendError = localizedForkCreationError(error);
	} finally {
		forkingMessageId = null;
	}
}

async function handleSend(
	payload: SendPayload,
	skipUserMessage = false,
	skipPersistUserMessage = false,
	clearDraft = true,
	retryAssistantMessageId?: string,
	retryUserMessageId?: string,
	confirmForkedSourceHistoryMutation = false,
	onForkedSourceHistoryConfirmationRequired?: () => void,
) {
	const text = payload.message;
	const attachmentIds = payload.attachmentIds ?? [];
	const newAttachments = payload.attachments ?? [];
	const modelIdForTurn = payload.modelId ?? $selectedModel;
	setConversationModelSelection(data.conversation.id, modelIdForTurn);
	const personalityProfileIdForTurn =
		payload.personalityProfileId !== undefined
			? payload.personalityProfileId
			: selectedPersonalityId;
	if (
		!text.trim() ||
		isConversationReadOnlyForChat ||
		isSending ||
		isEditResendPending
	)
		return;
	const deepResearchDepthForTurn = shouldStartDeepResearchJob(
		payload,
		retryAssistantMessageId,
	)
		? payload.deepResearchDepth
		: null;

	if (payload.pendingSkill && !deepResearchDepthForTurn) {
		isSending = true;
		try {
			skillSessionError = null;
			activeSkillSession = await startConversationSkillSession(
				data.conversation.id,
				payload.pendingSkill,
			);
		} catch (error) {
			if (isPendingSkillUnavailableError(error)) {
				const restoredPayload = markPendingSkillUnavailable(payload);
				restorePayloadToDraft(restoredPayload);
				skillSessionError = $t("pendingSkill.recoveryError");
			} else {
				skillSessionError = localizedSkillSessionError(
					error,
					"skillSessions.errors.start",
				);
			}
			sendError = skillSessionError;
			canRetry = false;
			isSending = false;
			return;
		}
	}

	sendError = null;
	isSending = true;
	suppressHydration = true;
	initialStreamPending = false;
	lastUserMessage = text;
	canRetry = true;
	hasPersistedMessages = true;
	if (clearDraft) {
		conversationDraft = null;
		draftPersistence.clear();
		void deleteConversationDraft(data.conversation.id);
	}

	// Keep route-level conversation artifacts out of the next composer frame.
	const currentAttachedArtifacts = attachedArtifacts;
	attachedArtifacts = [];

	const sentAttachments = mergeAttachedArtifacts(
		currentAttachedArtifacts,
		newAttachments,
	);
	upsertConversationLocal(
		data.conversation.id,
		data.conversation.title,
		Date.now() / 1000,
	);

	let clientUserMsgId: string | null = null;
	if (!skipUserMessage) {
		clientUserMsgId = crypto.randomUUID();
		const userMessage = createUserMessage({
			id: clientUserMsgId,
			text,
			attachmentIds,
			attachedArtifacts: sentAttachments,
		});
		messages.update((list) => [...list, userMessage]);
	}

	if (deepResearchDepthForTurn) {
		void startDeepResearchTurn({
			message: text,
			depth: deepResearchDepthForTurn,
			attachmentIds,
			modelId: modelIdForTurn,
			personalityProfileId: personalityProfileIdForTurn,
			clientUserMessageId: clientUserMsgId,
		});
		return;
	}

	const placeholderId = crypto.randomUUID();
	const placeholder = createAssistantPlaceholder(placeholderId);
	if (skipUserMessage) {
		messages.update((list) => appendAssistantPlaceholder(list, placeholder));
	} else {
		messages.update((list) => appendAssistantPlaceholder(list, placeholder));
	}

	activeStream = streamChat(
		text,
		data.conversation.id,
		{
			onToken(chunk) {
				messages.update((list) =>
					appendTokenChunkToMessageList(list, placeholderId, chunk),
				);
			},
			onThinking(chunk) {
				messages.update((list) =>
					appendThinkingChunkToMessageList(list, placeholderId, chunk),
				);
			},
			onToolCall(name, input, status, details) {
				messages.update((list) =>
					applyToolCallUpdateToMessageList(list, {
						placeholderId,
						name,
						input,
						status,
						details,
					}),
				);
				if (shouldHydrateFileProductionJobsOnToolCall(name, status)) {
					void hydrateConversationDetail(data.conversation.id);
				}
			},
			onEnd(fullText, metadata) {
				const completedUserMessage = lastUserMessage;
				const completedAssistantResponse = fullText;
				lastAssistantResponse = fullText;
				contextStatus = metadata?.contextStatus ?? contextStatus;
				contextSources = metadata?.contextSources ?? contextSources;
				activeWorkingSet = metadata?.activeWorkingSet ?? activeWorkingSet;
				taskState = metadata?.taskState ?? taskState;
				contextDebug = metadata?.contextDebug ?? contextDebug;
				if (metadata?.generatedFiles) {
					// Merge new files with existing, using ID to prevent duplicates
					const existingIds = new Set(generatedFiles.map((f) => f.id));
					const newFiles = metadata.generatedFiles.filter(
						(f) => !existingIds.has(f.id),
					);
					generatedFiles = [...generatedFiles, ...newFiles];
					void hydrateConversationDetail(data.conversation.id);
				}
				if (metadata?.contextCompressionSnapshots) {
					contextCompressionMarkers = metadata.contextCompressionSnapshots;
				}
				const serverAssistantId = metadata?.assistantMessageId;
				if (serverAssistantId) {
					attachFileProductionJobsToAssistantMessage(serverAssistantId);
				}
				messages.update((list) =>
					finalizeStreamingMessageList(list, {
						placeholderId,
						clientUserMessageId: clientUserMsgId,
						metadata,
					}),
				);
				isSending = false;
				activeStream = null;
				canRetry = false;
				if (serverAssistantId) {
					void pollMessageEvidence(serverAssistantId);
					setTimeout(() => refreshMessageCost(serverAssistantId), 1500);
				}

				if (metadata?.wasStopped) {
					if (queuedContextCompression) {
						queuedContextCompression = false;
						void runManualContextCompression();
					}
					restoreQueuedTurnToDraft();
					return;
				}

				maybeTriggerTitleGeneration(
					completedUserMessage,
					completedAssistantResponse,
				);

				void drainPostTurnQueue();
			},
			onError(err) {
				messages.update((list) => removeMessageById(list, placeholderId));
				activeStream = null;
				isSending = false;
				restoreQueuedTurnToDraft();

				if (isPendingSkillUnavailableError(err)) {
					if (clientUserMsgId) {
						messages.update((list) => removeMessageById(list, clientUserMsgId));
					}
					restorePayloadToDraft(markPendingSkillUnavailable(payload));
					sendError = $t("pendingSkill.recoveryError");
					canRetry = false;
					return;
				}

				if (
					retryAssistantMessageId &&
					!confirmForkedSourceHistoryMutation &&
					isForkedSourceHistoryConfirmationRequired(err)
				) {
					if (onForkedSourceHistoryConfirmationRequired) {
						onForkedSourceHistoryConfirmationRequired();
					} else {
						sendError = get(t)("fork.regenerateWarning");
						canRetry = true;
					}
					return;
				}

				const isBrowserAbort =
					err.name === "AbortError" &&
					browser &&
					document.visibilityState === "hidden";
				if (isBrowserAbort) {
					streamInterruptedByBackground = true;
					return;
				}

				sendError = toFriendlySendError(err, $t);
				canRetry = true;
			},
		},
		{
			modelId: modelIdForTurn,
			skipPersistUserMessage,
			attachmentIds,
			linkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.deepResearchDepth
				? null
				: (payload.pendingSkill ?? null),
			deepResearchDepth: payload.deepResearchDepth ?? null,
			thinkingMode: payload.thinkingMode ?? $selectedThinkingMode,
			forceWebSearch: payload.forceWebSearch === true,
			activeDocumentArtifactId: getActiveWorkspaceArtifactId(),
			personalityProfileId: personalityProfileIdForTurn,
			retryAssistantMessageId,
			retryUserMessageId,
			retryUserMessage: retryAssistantMessageId ? text : undefined,
			confirmForkedSourceHistoryMutation,
		},
	);
}

function handleRetry() {
	if (isConversationReadOnlyForChat) return;
	if (canRetry && lastUserMessage) {
		sendError = null;
		isSending = true;
		hasPersistedMessages = true;
		const retryMessages = $messages;
		const lastAssistantMsg = retryMessages.findLast(
			(m) => m.role === "assistant",
		);
		const retryAssistantMessageId = lastAssistantMsg?.id;
		const retryAssistantIdx = retryAssistantMessageId
			? retryMessages.findIndex((m) => m.id === retryAssistantMessageId)
			: -1;
		const retryUserMessageId =
			retryAssistantIdx > 0 &&
			retryMessages[retryAssistantIdx - 1]?.role === "user"
				? retryMessages[retryAssistantIdx - 1].id
				: undefined;

		const placeholderId = crypto.randomUUID();
		const placeholder = createAssistantPlaceholder(placeholderId);
		messages.update((list) => [...list, placeholder]);

		if (retryAssistantMessageId) {
			messages.update((list) =>
				removeMessageById(list, retryAssistantMessageId),
			);
		}

		activeStream = streamChat(
			lastUserMessage,
			data.conversation.id,
			{
				onToken(chunk) {
					messages.update((list) =>
						appendTokenChunkToMessageList(list, placeholderId, chunk),
					);
				},
				onThinking(chunk) {
					messages.update((list) =>
						appendThinkingChunkToMessageList(list, placeholderId, chunk),
					);
				},
				onToolCall(name, input, status, details) {
					messages.update((list) =>
						applyToolCallUpdateToMessageList(list, {
							placeholderId,
							name,
							input,
							status,
							details,
						}),
					);
					if (shouldHydrateFileProductionJobsOnToolCall(name, status)) {
						void hydrateConversationDetail(data.conversation.id);
					}
				},
				onWaiting() {
					console.info(
						"[CHAT] Entering waiting state - polling for completion",
					);
					activeStream?.detach();
					activeStream = null;
					// Start polling for completion
					void pollForCompletion(placeholderId);
				},
				onEnd(fullText, metadata) {
					lastAssistantResponse = fullText;
					contextStatus = metadata?.contextStatus ?? contextStatus;
					contextSources = metadata?.contextSources ?? contextSources;
					activeWorkingSet = metadata?.activeWorkingSet ?? activeWorkingSet;
					taskState = metadata?.taskState ?? taskState;
					contextDebug = metadata?.contextDebug ?? contextDebug;
					if (metadata?.generatedFiles) {
						// Merge new files with existing, using ID to prevent duplicates
						const existingIds = new Set(generatedFiles.map((f) => f.id));
						const newFiles = metadata.generatedFiles.filter(
							(f) => !existingIds.has(f.id),
						);
						generatedFiles = [...generatedFiles, ...newFiles];
						void hydrateConversationDetail(data.conversation.id);
					}
					if (metadata?.contextCompressionSnapshots) {
						contextCompressionMarkers = metadata.contextCompressionSnapshots;
					}
					const serverAssistantId = metadata?.assistantMessageId;
					if (serverAssistantId) {
						attachFileProductionJobsToAssistantMessage(serverAssistantId);
					}
					messages.update((list) =>
						finalizeStreamingMessageList(list, {
							placeholderId,
							clientUserMessageId: null,
							metadata,
						}),
					);
					isSending = false;
					activeStream = null;
					canRetry = false;
					if (serverAssistantId) {
						void pollMessageEvidence(serverAssistantId);
						// Refresh cost data after analytics recording completes
						setTimeout(() => refreshMessageCost(serverAssistantId), 1500);
					}

						if (metadata?.wasStopped) {
							if (queuedContextCompression) {
								queuedContextCompression = false;
								void runManualContextCompression();
							}
							restoreQueuedTurnToDraft();
							return;
						}

					maybeTriggerTitleGeneration(lastUserMessage, fullText);

						void drainPostTurnQueue();
					},
				onError(err) {
					messages.update((list) => removeMessageById(list, placeholderId));
					activeStream = null;
					isSending = false;
					restoreQueuedTurnToDraft();

					const isBrowserAbort =
						err.name === "AbortError" &&
						browser &&
						document.visibilityState === "hidden";
					if (isBrowserAbort) {
						streamInterruptedByBackground = true;
						return;
					}

					sendError = toFriendlySendError(err, $t);
					canRetry = true;
				},
			},
			{
				modelId: lastAssistantMsg?.modelId ?? $selectedModel,
				thinkingMode: $selectedThinkingMode,
				activeDocumentArtifactId: getActiveWorkspaceArtifactId(),
				personalityProfileId: selectedPersonalityId,
				retryAssistantMessageId: retryAssistantMessageId ?? undefined,
				retryUserMessageId,
				retryUserMessage: retryAssistantMessageId ? lastUserMessage : undefined,
			},
		);
	}
}

function handleRegenerate(
	payload: MessageRegeneratePayload,
	confirmForkedSourceHistoryMutation = false,
) {
	if (isConversationReadOnlyForChat || isSending || isEditResendPending) return;
	const { messageId } = payload;
	const msgs = $messages;
	const assistantIdx = msgs.findIndex((m) => m.id === messageId);
	if (assistantIdx === -1) return;
	const hasKnownForks = hasForkedAssistantInRange(msgs, assistantIdx);
	if (
		hasKnownForks &&
		!confirmForkedSourceHistoryMutation &&
		!window.confirm(get(t)("fork.regenerateWarning"))
	) {
		return;
	}

	// Find the user message immediately before this assistant message
	const userIdx = assistantIdx - 1;
	if (userIdx < 0 || msgs[userIdx].role !== "user") return;

	const userText = msgs[userIdx].content;
	// Remove the assistant message(s) from in-memory state
	messages.update((m) => m.slice(0, assistantIdx));

	sendError = null;
	handleSend(
		{
			message: userText,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		},
		true,
		true,
		true,
		messageId,
		msgs[userIdx].id,
		confirmForkedSourceHistoryMutation || hasKnownForks,
		() => {
			messages.set(msgs);
			if (window.confirm(get(t)("fork.regenerateWarning"))) {
				handleRegenerate(payload, true);
			}
		},
	);
}

async function handleEdit(
	payload: MessageEditPayload,
	confirmForkedSourceHistoryMutation = false,
) {
	if (isConversationReadOnlyForChat || isSending || isEditResendPending) return;
	const { messageId, newText } = payload;
	const msgs = $messages;
	const editIdx = msgs.findIndex((m) => m.id === messageId);
	if (editIdx === -1) return;
	const hasKnownForks = hasForkedAssistantInRange(msgs, editIdx);
	if (
		hasKnownForks &&
		!confirmForkedSourceHistoryMutation &&
		!window.confirm(get(t)("fork.editWarning"))
	) {
		return;
	}

	const idsToDelete = msgs.slice(editIdx).map((m) => m.id);

	// Remove all messages from the edited one onwards
	messages.update((m) => m.slice(0, editIdx));

	sendError = null;
	isEditResendPending = true;
	try {
		await deleteConversationMessages(data.conversation.id, idsToDelete, {
			confirmForkedSourceHistoryMutation:
				confirmForkedSourceHistoryMutation || hasKnownForks,
		});
	} catch (error) {
		messages.set(msgs);
		if (
			!confirmForkedSourceHistoryMutation &&
			isForkedSourceHistoryConfirmationRequired(error)
		) {
			isEditResendPending = false;
			if (window.confirm(get(t)("fork.editWarning"))) {
				void handleEdit(payload, true);
			}
			return;
		}
		sendError =
			error instanceof Error ? error.message : "Failed to delete messages";
		isEditResendPending = false;
		return;
	}

	isEditResendPending = false;
	handleSend({
		message: newText,
		attachmentIds: [],
		attachments: [],
		pendingAttachments: [],
	});
}

function handleStop() {
	if (activeStream) {
		activeStream.stop();
		// The stream will trigger onEnd via the abort controller
	}
}

function latestTimelineMessageId(): string | null {
	return [...$messages].reverse().find((message) => Boolean(message.id))?.id ?? null;
}

function upsertContextCompressionMarker(marker: ContextCompressionMarker) {
	const existingIndex = contextCompressionMarkers.findIndex(
		(existing) => existing.id === marker.id,
	);
	if (existingIndex === -1) {
		contextCompressionMarkers = [...contextCompressionMarkers, marker];
		return;
	}
	contextCompressionMarkers = contextCompressionMarkers.map((existing) =>
		existing.id === marker.id ? marker : existing,
	);
}

function replaceContextCompressionMarker(
	tempId: string,
	marker: ContextCompressionMarker,
) {
	contextCompressionMarkers = [
		...contextCompressionMarkers.filter((existing) => existing.id !== tempId),
		marker,
	];
}

async function runManualContextCompression() {
	if (contextCompressionInFlight) return;
	const sourceEndMessageId = latestTimelineMessageId();
	if (!sourceEndMessageId) return;

	contextCompressionInFlight = true;
	sendError = null;
	const now = Date.now();
	const tempId = `pending-${crypto.randomUUID()}`;
	upsertContextCompressionMarker({
		id: tempId,
		trigger: "manual",
		status: "running",
		sourceEndMessageId,
		createdAt: now,
		updatedAt: now,
	});

	try {
		const snapshot = await runConversationContextCompression(
			data.conversation.id,
			{
				selectedModelId: $selectedModel,
				trigger: "manual",
			},
		);
		replaceContextCompressionMarker(tempId, snapshot);
		if (snapshot.status === "failed") {
			sendError = $t("contextCompression.failed");
		}
		void hydrateConversationDetail(data.conversation.id);
	} catch {
		replaceContextCompressionMarker(tempId, {
			id: tempId,
			trigger: "manual",
			status: "failed",
			sourceEndMessageId,
			createdAt: now,
			updatedAt: Date.now(),
		});
		sendError = $t("contextCompression.failed");
	} finally {
		contextCompressionInFlight = false;
	}
}

async function drainPostTurnQueue() {
	if (queuedContextCompression) {
		queuedContextCompression = false;
		await runManualContextCompression();
	}

	if (queuedTurn) {
		const nextQueuedTurn = cloneSendPayload(queuedTurn);
		queuedTurn = null;
		void handleSend(nextQueuedTurn, false, false, false);
	}
}

function handleCompact() {
	if (isConversationReadOnlyForChat) return;
	if (isSending || isEditResendPending) {
		queuedContextCompression = true;
		sendError = null;
		return;
	}
	void runManualContextCompression();
}

function handleQueue(payload: SendPayload) {
	if (
		isConversationReadOnlyForChat ||
		!isSending ||
		queuedTurn ||
		!payload.message.trim()
	) {
		return;
	}

	queuedTurn = cloneSendPayload(payload);
	conversationDraft = null;
	draftPersistence.clear();
	sendError = null;
}

async function handleSteering(payload: TaskSteeringPayload) {
	if (isConversationReadOnlyForChat) return;
	try {
		const result = await applyTaskSteering(data.conversation.id, payload);
		taskState = result.taskState ?? taskState;
		contextDebug = result.contextDebug ?? contextDebug;
		const detail = await fetchConversationDetail(data.conversation.id).catch(
			() => null,
		);
		contextSources = detail?.contextSources ?? contextSources;
	} catch {
		return;
	}
}

function openEvidenceManager() {
	evidenceManagerOpen = true;
}

function closeEvidenceManager() {
	evidenceManagerOpen = false;
}

function handleErrorClose() {
	sendError = null;
}

function handleDraftChange(payload: DraftChangePayload) {
	const nextConversationId = payload.conversationId ?? data.conversation.id;
	conversationDraft = createConversationDraftRecord({
		conversationId: nextConversationId,
		draftText: payload.draftText,
		selectedAttachmentIds: payload.selectedAttachmentIds,
		selectedAttachments: payload.selectedAttachments,
		selectedLinkedSources: payload.selectedLinkedSources,
		pendingSkill: payload.pendingSkill,
	});
	void draftPersistence.persist({
		conversationId: nextConversationId,
		draftText: payload.draftText,
		selectedAttachmentIds: payload.selectedAttachmentIds,
		selectedLinkedSources: payload.selectedLinkedSources,
		pendingSkill: payload.pendingSkill,
	});
}

let fileDragActive = $state(false);
let fileDragRejected = $state(false);
let dragEnterCount = 0;
let uploadFilesFn: ((files: FileList | null) => Promise<void>) | null = null;

function handleUploadReady(
	uploadFn: (files: FileList | null) => Promise<void>,
) {
	uploadFilesFn = uploadFn;
}

type UploadFileResult =
	| { success: true; attachment: import("$lib/types").PendingAttachment }
	| { success: false; fileName: string; error: string };

async function uploadSingleFile(
	file: File,
	conversationId: string,
): Promise<UploadFileResult> {
	try {
		const result = await uploadKnowledgeAttachment(file, conversationId);
		if (result?.artifact) {
			return {
				success: true,
				attachment: {
					artifact: result.artifact,
					promptReady: Boolean(result.promptReady),
					promptArtifactId:
						typeof result.promptArtifactId === "string"
							? result.promptArtifactId
							: null,
					readinessError:
						typeof result.readinessError === "string" &&
						result.readinessError.trim()
							? result.readinessError
							: null,
				},
			};
		}
		return { success: false, fileName: file.name, error: "Upload failed" };
	} catch (err) {
		return {
			success: false,
			fileName: file.name,
			error: err instanceof Error ? err.message : "Upload failed",
		};
	}
}

function handleUploadFiles(payload: {
	files: File[];
	conversationId: string;
	done: (result: UploadFileResult) => void;
}) {
	for (const file of payload.files) {
		uploadSingleFile(file, payload.conversationId).then(payload.done);
	}
}

function handleDragEnter(event: DragEvent) {
	if (!isOsFileDropEvent(event)) return;
	event.preventDefault();
	dragEnterCount += 1;
	fileDragRejected = isConversationReadOnlyForChat || isSending;
	fileDragActive = true;
}

function handleDragOver(event: DragEvent) {
	if (!isOsFileDropEvent(event)) return;
	event.preventDefault();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "copy";
	}
}

function handleDragLeave(event: DragEvent) {
	if (!isOsFileDropEvent(event)) return;
	dragEnterCount -= 1;
	if (dragEnterCount <= 0) {
		dragEnterCount = 0;
		fileDragActive = false;
		fileDragRejected = false;
	}
}

function handleDrop(event: DragEvent) {
	dragEnterCount = 0;
	fileDragActive = false;
	fileDragRejected = false;
	if (!isOsFileDropEvent(event)) return;
	event.preventDefault();
	if (isConversationReadOnlyForChat || isSending || isEditResendPending) return;
	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;
	void uploadFilesFn?.(files);
}
</script>

<svelte:head>
	<title>{effectiveConversationTitle}</title>
</svelte:head>

<div
	class="chat-page flex h-full min-w-0 flex-col"
	role="region"
	aria-label="Chat page"
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<DropZoneOverlay active={fileDragActive} rejected={fileDragRejected} />
	<div
		class="chat-stage relative flex min-h-0 flex-1 overflow-hidden rounded-lg"
		class:chat-stage-workspace-open={workspaceOpen && workspaceDocuments.length > 0}
	>
		<div class="chat-main relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div class="chat-messages flex flex-1 flex-col overflow-hidden">
				{#if showInitialLoading}
					<div class="flex flex-1 items-center justify-center">
						<div class="flex flex-col items-center gap-3">
							<div class="spinner-large"></div>
							<span class="text-sm text-text-muted">{$t('chat.startingConversation')}</span>
						</div>
					</div>
				{:else}
					<ChatMessagePane
						messages={$messages}
						conversationId={data.conversation.id}
						{isThinkingActive}
						{contextDebug}
						{modelIcons}
						{fileProductionJobs}
						{deepResearchJobs}
						contextCompressionMarkers={contextCompressionMarkers}
						hasActiveSkillSession={Boolean(activeSkillSession)}
						{forkOrigin}
						{forkOpening}
						{forkingMessageId}
						readOnly={isConversationReadOnlyForChat}
						onOpenDocument={openWorkspaceDocument}
						onRegenerate={handleRegenerate}
						onEdit={handleEdit}
						onFork={handleFork}
						onSteer={handleSteering}
						{canPublishSkillDrafts}
						{skillDraftActionState}
						onSaveSkillDraft={handleSaveSkillDraft}
						onDismissSkillDraft={handleDismissSkillDraft}
						onPublishSkillDraft={handlePublishSkillDraft}
						onRetryFileProductionJob={handleRetryFileProductionJob}
						onCancelFileProductionJob={handleCancelFileProductionJob}
						onCancelDeepResearchJob={handleCancelDeepResearchJob}
						onEditDeepResearchPlan={handleEditDeepResearchPlan}
						onApproveDeepResearchPlan={handleApproveDeepResearchPlan}
						onDiscussDeepResearchReport={handleDiscussDeepResearchReport}
						onResearchFurtherFromDeepResearchReport={handleResearchFurtherFromDeepResearchReport}
						onAdvanceDeepResearchWorkflow={handleAdvanceDeepResearchWorkflow}
					/>
				{/if}
			</div>

			<ChatComposerPanel
				{sendError}
				onRetry={handleRetry}
				onErrorClose={handleErrorClose}
				onSend={handleSend}
				onQueue={handleQueue}
				onStop={handleStop}
				onCompact={handleCompact}
				onDraftChange={handleDraftChange}
				onEditQueuedMessage={editQueuedTurn}
				onDeleteQueuedMessage={clearQueuedTurn}
				onManageEvidence={openEvidenceManager}
				disabled={isConversationReadOnlyForChat || isEditResendPending}
				isGenerating={!isConversationReadOnlyForChat && (isSending || isEditResendPending)}
				hasQueuedMessage={Boolean(queuedTurn)}
				queuedMessagePreview={queuedTurn?.message ?? ''}
				maxLength={data.maxMessageLength}
				conversationId={data.conversation.id}
				{contextStatus}
				{attachedArtifacts}
				{contextDebug}
				{contextSources}
				{totalCostUsd}
				{totalTokens}
				deepResearchEnabled={data.deepResearchEnabled}
				composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
				{personalityProfiles}
				{selectedPersonalityId}
				onPersonalityChange={setSelectedPersonalityId}
				onModelChange={setSelectedConversationModelId}
				thinkingMode={$selectedThinkingMode}
				onThinkingModeChange={setSelectedThinkingMode}
				draftText={conversationDraft?.draftText ?? ''}
				draftAttachments={conversationDraft?.selectedAttachments ?? []}
				draftLinkedSources={conversationDraft?.selectedLinkedSources ?? []}
				draftPendingSkill={conversationDraft?.pendingSkill ?? null}
				draftVersion={conversationDraft?.updatedAt ?? 0}
				onUploadReady={handleUploadReady}
				onUploadFiles={handleUploadFiles}
			>
				{#if activeSkillSession}
					<SkillSessionPanel
						session={activeSkillSession}
						busy={skillSessionBusy}
						error={skillSessionError}
						onFinish={() => endCurrentSkillSession("ended")}
						onDismiss={() => endCurrentSkillSession("dismissed")}
					/>
				{/if}
			</ChatComposerPanel>
		</div>

		<DocumentWorkspace
			open={workspaceOpen}
			presentation={workspacePresentation}
			documents={workspaceDocuments}
			availableDocuments={availableWorkspaceDocuments}
			activeDocumentId={activeWorkspaceDocumentId}
			onSelectDocument={selectWorkspaceDocument}
			onOpenDocument={(document) =>
				openWorkspaceDocument(document, { preservePresentation: true })}
			onJumpToSource={handleJumpToWorkspaceSource}
			onCloseDocument={closeWorkspaceDocument}
			onCloseWorkspace={closeWorkspace}
			onPresentationChange={(nextPresentation) => {
				workspacePresentation = nextPresentation;
			}}
		/>
	</div>

	<EvidenceManager
		open={evidenceManagerOpen}
		{contextDebug}
		{contextSources}
		onClose={closeEvidenceManager}
		onSteer={handleSteering}
	/>
</div>

<style>
	.chat-main {
		flex: 1 1 0%;
		min-width: 0;
	}

	.chat-messages {
		min-width: 0;
	}

	.chat-stage-workspace-open .chat-main :global(.scroll-container > div),
	.chat-stage-workspace-open .chat-main :global(.composer-shell) {
		margin-left: auto;
		margin-right: auto;
	}

	.spinner-large {
		width: 32px;
		height: 32px;
		border: 3px solid color-mix(in srgb, var(--border-default) 50%, transparent 50%);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
