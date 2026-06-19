<script lang="ts">
import { get, writable } from "svelte/store";
import { onMount, onDestroy, tick, untrack } from "svelte";
import { t } from "$lib/i18n";
import { page } from "$app/state";
import { goto, invalidate, replaceState } from "$app/navigation";
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
	cancelAtlasJob as cancelAtlasJobRequest,
	submitAtlasTurn,
} from "$lib/client/api/atlas";
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
	recordDocumentWorkspaceOpen,
	uploadKnowledgeAttachment,
} from "$lib/client/api/knowledge";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
import { currentConversationId } from "$lib/stores/ui";
import {
	selectedModel,
	selectedReasoningDepth,
	setSelectedModel,
	setSelectedReasoningDepth,
} from "$lib/stores/settings";
import EvidenceManager from "$lib/components/chat/EvidenceManager.svelte";
import type {
	ArtifactSummary,
	AtlasAction,
	AtlasAvailability,
	AtlasJobCard,
	AtlasProfile,
	ChatGeneratedFile,
	ChatMessage,
	ConversationDraft,
	ConversationForkOrigin,
	ContextCompressionMarker,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
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
	createBrowserNormalChatClientTurnRuntime,
	type NormalChatRuntimeSnapshot,
} from "$lib/client/normal-chat-client-turn-runtime";
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
	applyResponseActivityEntryToMessageList,
	applyToolCallUpdateToMessageList,
	attachUnassignedFileProductionJobsToAssistant,
	finalizeStreamingMessageList,
	getWorkspacePresentationAfterDocumentOpen,
	hasActiveAtlasJobs,
	hasActiveFileProductionJobs,
	mergeFileProductionJob,
	removeMessageById,
	patchSkillDraftInMessageList,
	toFriendlySendError,
	updateMessageById,
	isPendingSkillUnavailableError,
	isConversationReadOnly,
	isOsFileDropEvent,
	markPendingSkillUnavailable,
	shouldHydrateFileProductionJobsOnToolCall,
	type DraftChangePayload,
	type MessageEditPayload,
	type MessageRegeneratePayload,
	type SendPayload,
} from "./_helpers";

type ChatPageDataWithAtlas = PageProps["data"] & {
	atlasJobs?: AtlasJobCard[];
	atlasAvailability?: AtlasAvailability | null;
};
type ChatPageProps = Omit<PageProps, "data"> & {
	data: ChatPageDataWithAtlas;
	params?: { conversationId: string };
};
let { data }: ChatPageProps = $props();
const getData = () => data;
type ChatAvailableModel = { id: string; iconUrl?: string | null };
type AvailableModelsValue =
	| ChatAvailableModel[]
	| Promise<ChatAvailableModel[]>
	| null
	| undefined;
type ChatPageDataWithAvailableModels = Omit<
	ChatPageDataWithAtlas,
	"availableModels"
> & {
	availableModels?: AvailableModelsValue;
};

function getAvailableModelsValue(
	source: ChatPageDataWithAtlas,
): AvailableModelsValue {
	return (source as ChatPageDataWithAvailableModels).availableModels;
}

function getAtlasAvailabilityValue(
	source: ChatPageDataWithAtlas,
): AtlasAvailability {
	return (
		source.atlasAvailability ?? {
			enabled: false,
			configured: false,
			reason: $t("composerTools.atlasUnavailableReason"),
		}
	);
}

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
const initialAtlasJobs = getData().atlasJobs ?? [];
const initialContextCompressionSnapshots =
	getData().contextCompressionSnapshots ?? [];
const initialActiveSkillSession = getData().activeSkillSession ?? null;
const initialSidecarPending = getData().sidecarPending ?? false;
const initialConversationId = getData().conversation.id;
const initialConversationStatus = getData().conversation.status ?? "open";
const initialUserPersonality = getData().userPersonality ?? null;
const initialUserModel = (getData().userModel ?? "model1") as ModelId;
let availableModelsForIcons = $state<ChatAvailableModel[]>([]);
let availableModelsSequence = 0;

$effect(() => {
	const sequence = ++availableModelsSequence;
	const nextAvailableModels = getAvailableModelsValue(data);
	if (Array.isArray(nextAvailableModels)) {
		availableModelsForIcons = nextAvailableModels;
		return;
	}

	Promise.resolve(nextAvailableModels ?? [])
		.then((models) => {
			if (sequence === availableModelsSequence && Array.isArray(models)) {
				availableModelsForIcons = models;
			}
		})
		.catch((error) => {
			console.warn("Failed to resolve chat model metadata:", error);
		});
});

const modelIcons = $derived.by(() => {
	const currentAvailableModels = getAvailableModelsValue(data);
	const models = Array.isArray(currentAvailableModels)
		? currentAvailableModels
		: availableModelsForIcons;
	return Object.fromEntries(
		models.map((model) => [model.id, model.iconUrl ?? null]),
	) as Record<string, string | null>;
});
const atlasAvailability = $derived(getAtlasAvailabilityValue(data));
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
let normalChatRuntimeActive = $state(false);
let queuedTurn = $state<SendPayload | null>(null);
let titleGenerationTriggered = false;
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
let atlasJobs = $state<AtlasJobCard[]>(initialAtlasJobs);
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
	isConversationReadOnly({ status: conversationStatus }),
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
let sidecarPending = initialSidecarPending;
let hydratingConversation = false;
let detailMetadataEpoch = 0;
let suppressHydration = $state(false);
// Set to true when we're waiting for the initial pending message to be sent (landing page transition)
let initialStreamPending = $state(untrack(() => data.bootstrap ?? false));
const evidencePollMaxAttempts = 48;
const evidencePollControllers = new Map<string, AbortController>();

function markDetailMetadataFreshnessBoundary() {
	detailMetadataEpoch += 1;
}

function applyNormalChatRuntimeSnapshot(snapshot: NormalChatRuntimeSnapshot) {
	normalChatRuntimeActive = snapshot.active;
	isSending = snapshot.isSending;
	queuedTurn = snapshot.queuedTurn;
	queuedContextCompression = snapshot.queuedContextCompression;
}

const normalChatRuntime = createBrowserNormalChatClientTurnRuntime({
	submitAtlasTurn,
	getConversationId: () => data.conversation.id,
	getSelectedModel: () => $selectedModel,
	getReasoningDepth: () => $selectedReasoningDepth,
	getPersonalityProfileId: () => selectedPersonalityId,
	getActiveDocumentArtifactId: () => getActiveWorkspaceArtifactId(),
	getMessages: () => $messages,
	isReadOnly: () => isConversationReadOnlyForChat,
	isEditResendPending: () => isEditResendPending,
	isBrowserHidden: () =>
		browser && typeof document !== "undefined"
			? document.visibilityState === "hidden"
			: false,
	randomId: () => crypto.randomUUID(),
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	onStateChange: applyNormalChatRuntimeSnapshot,
	setConversationModelSelection: (modelId) =>
		setConversationModelSelection(data.conversation.id, modelId),
	setInitialStreamPending: (pending) => {
		initialStreamPending = pending;
	},
	setSuppressHydration: (suppress) => {
		suppressHydration = suppress;
	},
	markHasPersistedMessages: () => {
		hasPersistedMessages = true;
	},
	clearDraft: () => {
		conversationDraft = null;
		draftPersistence.clear();
	},
	deleteDraft: () => {
		void deleteConversationDraft(data.conversation.id);
	},
	clearAttachedArtifacts: () => {
		const currentAttachedArtifacts = attachedArtifacts;
		attachedArtifacts = [];
		return currentAttachedArtifacts;
	},
	recordConversationActivity: () => {
		upsertConversationLocal(
			data.conversation.id,
			data.conversation.title,
			Date.now() / 1000,
		);
	},
	startPendingSkillSession: async (payload) => {
		try {
			skillSessionError = null;
			const pendingSkill = payload.pendingSkill;
			if (!pendingSkill) {
				return {
					ok: false,
					errorMessage: $t("skillSessions.errors.start"),
				};
			}
			activeSkillSession = await startConversationSkillSession(
				data.conversation.id,
				pendingSkill,
			);
			return { ok: true };
		} catch (error) {
			if (isPendingSkillUnavailableError(error)) {
				return {
					ok: false,
					errorMessage: $t("pendingSkill.recoveryError"),
					restoredPayload: markPendingSkillUnavailable(payload),
				};
			}
			return {
				ok: false,
				errorMessage: localizedSkillSessionError(
					error,
					"skillSessions.errors.start",
				),
			};
		}
	},
	appendUserMessage: (message) => {
		messages.update((list) => [...list, message]);
	},
	appendAssistantPlaceholder: (placeholder) => {
		messages.update((list) => appendAssistantPlaceholder(list, placeholder));
	},
	appendTokenChunk: (placeholderId, chunk) => {
		messages.update((list) =>
			appendTokenChunkToMessageList(list, placeholderId, chunk),
		);
	},
	appendThinkingChunk: (placeholderId, chunk) => {
		messages.update((list) =>
			appendThinkingChunkToMessageList(list, placeholderId, chunk),
		);
	},
	applyResponseActivityUpdate: (placeholderId, entry) => {
		messages.update((list) =>
			applyResponseActivityEntryToMessageList(list, placeholderId, entry),
		);
	},
	applyToolCallUpdate: (placeholderId, name, input, status, details) => {
		messages.update((list) =>
			applyToolCallUpdateToMessageList(list, {
				placeholderId,
				name,
				input,
				status,
				details,
			}),
		);
	},
	shouldHydrateFileProductionJobsOnToolCall,
	removeMessage: (messageId) => {
		messages.update((list) => removeMessageById(list, messageId));
	},
	finalizeStreamingMessage: ({
		placeholderId,
		clientUserMessageId,
		metadata,
	}) => {
		messages.update((list) =>
			finalizeStreamingMessageList(list, {
				placeholderId,
				clientUserMessageId,
				metadata,
			}),
		);
	},
	applyStreamMetadata: (metadata) => {
		if (metadata) {
			markDetailMetadataFreshnessBoundary();
		}
		contextStatus = metadata?.contextStatus ?? contextStatus;
		contextSources = metadata?.contextSources ?? contextSources;
		activeWorkingSet = metadata?.activeWorkingSet ?? activeWorkingSet;
		taskState = metadata?.taskState ?? taskState;
		contextDebug = metadata?.contextDebug ?? contextDebug;
		totalCostUsdMicros = metadata?.totalCostUsdMicros ?? totalCostUsdMicros;
		totalTokens = metadata?.totalTokens ?? totalTokens;
	},
	attachFileProductionJobsToAssistantMessage,
	pollMessageEvidence: (assistantMessageId) => {
		void pollMessageEvidence(assistantMessageId);
	},
	refreshMessageCost: (assistantMessageId) => {
		setTimeout(() => refreshMessageCost(assistantMessageId), 1500);
	},
	hydrateConversationDetail: () => {
		void hydrateConversationDetail(data.conversation.id);
	},
	pollForCompletion: (placeholderId, clientUserMessageId) => {
		void pollForCompletion(placeholderId, clientUserMessageId ?? null);
	},
	loadPersistedData: () => {
		return loadPersistedData();
	},
	mergeGeneratedFiles: (files) => {
		markDetailMetadataFreshnessBoundary();
		const existingIds = new Set(generatedFiles.map((file) => file.id));
		const newFiles = files.filter((file) => !existingIds.has(file.id));
		generatedFiles = [...generatedFiles, ...newFiles];
	},
	mergeFileProductionJobs: (jobs) => {
		markDetailMetadataFreshnessBoundary();
		fileProductionJobs = jobs.reduce(
			(currentJobs, job) => mergeFileProductionJob(currentJobs, job),
			fileProductionJobs,
		);
	},
	setContextCompressionMarkers: (markers) => {
		markDetailMetadataFreshnessBoundary();
		contextCompressionMarkers = markers;
	},
	maybeTriggerTitleGeneration,
	runManualContextCompression,
	restorePayloadToDraft,
	markPendingSkillUnavailable,
	isPendingSkillUnavailableError,
	isForkedSourceHistoryConfirmationRequired,
	toFriendlySendError: (error) => toFriendlySendError(error, $t),
	setSendError: (message) => {
		if (message === "pendingSkill.recoveryError") {
			sendError = $t("pendingSkill.recoveryError");
			return;
		}
		if (message === "fork.regenerateWarning") {
			sendError = get(t)("fork.regenerateWarning");
			return;
		}
		sendError = message;
	},
	setSkillSessionError: (message) => {
		skillSessionError = message;
	},
	onBackgroundInterrupted: () => {
		// The runtime owns the interruption flag; the page owns the recovery fetch.
	},
	onBackgroundVisibilityRestore: () => {
		void invalidate(`app:conversation-detail:${data.conversation.id}`);
	},
});

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
	setSelectedModel(
		getConversationModelSelection(conversationId, profileDefault),
	);
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
	if (!pendingDraft?.message.trim()) {
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
	normalChatRuntime.reset();
	messages.set(data.messages ?? []);
	hasPersistedMessages = (data.messages?.length ?? 0) > 0;
	sendError = null;
	isSending = false;
	titleGenerationTriggered = false;
	selectedPersonalityId = getConversationPersonalitySelection(
		data.conversation.id,
		data.userPersonality ?? null,
	);
	const lastAssistantModel = data.messages
		?.slice()
		.reverse()
		.find((m) => m.role === "assistant" && m.modelId)?.modelId;
	applyConversationModelSelection(
		data.conversation.id,
		(lastAssistantModel ?? data.userModel ?? "model1") as ModelId,
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
	atlasJobs = data.atlasJobs ?? [];
	contextCompressionMarkers = data.contextCompressionSnapshots ?? [];
	conversationStatus = data.conversation.status ?? "open";
	totalCostUsdMicros = data.totalCostUsdMicros ?? 0;
	totalTokens = data.totalTokens ?? 0;
	detailMetadataEpoch = 0;
	restorePersistedWorkspaceState();
	bootstrapMode = data.bootstrap ?? false;
	sidecarPending = data.sidecarPending ?? false;
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
	if (bootstrapMode || sidecarPending) {
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
	if (!data?.conversation?.id || normalChatRuntimeActive) {
		return;
	}
	if (data.conversation.id !== prevConversationId) {
		prevConversationId = data.conversation.id;
		resetState();
	}
});

function recoverVisiblePageActivity() {
	if (document.visibilityState !== "visible") return;
	normalChatRuntime.handleVisibilityVisible();

	// Recover evidence for any messages with pending status
	recoverPendingEvidence();
}

function handleVisibilityChange() {
	recoverVisiblePageActivity();
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

function applyConversationDetailMetadata(
	detail: Awaited<ReturnType<typeof fetchConversationDetail>>,
) {
	markDetailMetadataFreshnessBoundary();
	contextStatus = detail.contextStatus ?? contextStatus;
	contextSources = detail.contextSources ?? contextSources;
	activeWorkingSet = detail.activeWorkingSet ?? activeWorkingSet;
	taskState = detail.taskState ?? taskState;
	contextDebug = detail.contextDebug ?? contextDebug;
	if (detail.generatedFiles) {
		generatedFiles = [...detail.generatedFiles];
	}
	if (detail.fileProductionJobs) {
		fileProductionJobs = [...detail.fileProductionJobs];
	}
	if (detail.atlasJobs) {
		atlasJobs = [...detail.atlasJobs];
	}
	if (detail.contextCompressionSnapshots) {
		contextCompressionMarkers = [...detail.contextCompressionSnapshots];
	}
	if (detail.totalCostUsdMicros != null) {
		totalCostUsdMicros = detail.totalCostUsdMicros;
		totalTokens = detail.totalTokens ?? 0;
	}
}

async function pollForCompletion(
	placeholderId: string,
	clientUserMessageId: string | null = null,
	attempt = 0,
) {
	const maxAttempts = 60;
	const pollInterval = 2000;

	if (attempt >= maxAttempts) {
		console.info("[CHAT] Polling timeout - checking final state");
		normalChatRuntime.completePollingRecovery();
		void loadPersistedData();
		return;
	}

	console.info("[CHAT] Polling for completion, attempt:", attempt + 1);
	const detail = await fetchConversationDetail(data.conversation.id).catch(
		() => null,
	);

	if (!detail) {
		setTimeout(
			() =>
				void pollForCompletion(placeholderId, clientUserMessageId, attempt + 1),
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
		const newAssistantIndex = newMessages.findIndex(
			(message: ChatMessage) => message.id === newAssistant.id,
		);
		const persistedUserMessage =
			newAssistantIndex > 0 &&
			newMessages[newAssistantIndex - 1]?.role === "user"
				? (newMessages[newAssistantIndex - 1] as ChatMessage)
				: null;
		console.info(
			"[CHAT] Completion detected - new assistant message found, content length:",
			newAssistant.content.length,
		);

		// Remove the placeholder
		messages.update((list) => {
			const filtered = list.filter(
				(message) =>
					message.id !== placeholderId &&
					(message.id !== persistedUserMessage?.id ||
						message.id === clientUserMessageId),
			);
			const withPersistedUser =
				clientUserMessageId && persistedUserMessage
					? filtered.map((message) =>
							message.id === clientUserMessageId
								? {
										...persistedUserMessage,
										renderKey:
											message.renderKey ??
											persistedUserMessage.renderKey ??
											clientUserMessageId,
									}
								: message,
						)
					: filtered;
			return [...withPersistedUser, newAssistant];
		});

		normalChatRuntime.completePollingRecovery();

		applyConversationDetailMetadata(detail);
		conversationStatus = detail.conversation?.status ?? conversationStatus;

		// Poll for evidence
		if (newAssistant.id) {
			void pollMessageEvidence(newAssistant.id);
		}
		void normalChatRuntime.drainPostTurnQueue();

		return;
	}

	// Still waiting, poll again
	setTimeout(
		() =>
			void pollForCompletion(placeholderId, clientUserMessageId, attempt + 1),
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
		applyConversationDetailMetadata(detail);
		forkOrigin = detail.forkOrigin ?? forkOrigin;
		conversationStatus = detail.conversation?.status ?? conversationStatus;
		conversationDraft = null;
		const pending = consumePendingConversationMessage(data.conversation.id);
		void pending;
	}
	normalChatRuntime.completePollingRecovery();
}

async function checkForOrphanedStreamOnMount() {
	await normalChatRuntime.checkForOrphanedStreamOnMount();
}

onMount(() => {
	currentConversationId.set(data.conversation.id);
	requestAnimationFrame(() => {
		const lastAssistantModel = data.messages
			?.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.modelId)?.modelId;
		applyConversationModelSelection(
			initialConversationId,
			lastAssistantModel ?? initialUserModel,
		);
	});
	triggerForkOpeningTransition();
	document.addEventListener("visibilitychange", handleVisibilityChange);
	window.addEventListener("pageshow", recoverVisiblePageActivity);
	window.addEventListener("focus", recoverVisiblePageActivity);
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
		window.removeEventListener("pageshow", recoverVisiblePageActivity);
		window.removeEventListener("focus", recoverVisiblePageActivity);
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

	normalChatRuntime.detach();

	void draftPersistence.flush();

	if (
		!hasPersistedMessages &&
		data?.conversation?.id &&
		!hasMeaningfulDraft(
			conversationDraft?.draftText ?? "",
			conversationDraft?.selectedAttachmentIds ?? [],
			conversationDraft?.selectedLinkedSources ?? [],
			conversationDraft?.pendingSkill ?? null,
			conversationDraft?.atlasMode === true,
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
	const requestMetadataEpoch = detailMetadataEpoch;

	try {
		const payload = await fetchConversationDetail(conversationId);
		if (
			conversationId !== data.conversation.id ||
			payload.conversation?.id !== data.conversation.id
		) {
			return;
		}
		if (!suppressHydration) {
			attachedArtifacts = payload.attachedArtifacts ?? attachedArtifacts;
		}
		const metadataIsFresh = requestMetadataEpoch === detailMetadataEpoch;
		if (metadataIsFresh) {
			activeWorkingSet = payload.activeWorkingSet ?? activeWorkingSet;
			contextStatus = payload.contextStatus ?? contextStatus;
			contextSources = payload.contextSources ?? contextSources;
			taskState = payload.taskState ?? taskState;
			contextDebug = payload.contextDebug ?? contextDebug;
			generatedFiles = payload.generatedFiles ?? generatedFiles;
			fileProductionJobs = payload.fileProductionJobs ?? fileProductionJobs;
			atlasJobs = payload.atlasJobs ?? atlasJobs;
			contextCompressionMarkers =
				payload.contextCompressionSnapshots ?? contextCompressionMarkers;
			totalCostUsdMicros = payload.totalCostUsdMicros ?? totalCostUsdMicros;
			totalTokens = payload.totalTokens ?? totalTokens;
		}
		conversationDraft = payload.draft ?? conversationDraft;
		forkOrigin = payload.forkOrigin ?? forkOrigin;
		activeSkillSession = payload.activeSkillSession ?? null;
		conversationStatus = payload.conversation?.status ?? conversationStatus;
		bootstrapMode = false;
		sidecarPending = false;

		if (
			!normalChatRuntimeActive &&
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

function createClientAtlasTurnId(): string {
	const random =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `atlas-${random}`;
}

async function handleCancelAtlasJob(jobId: string) {
	try {
		const job = await cancelAtlasJobRequest(jobId);
		atlasJobs = atlasJobs.map((current) =>
			current.id === job.id ? job : current,
		);
		markDetailMetadataFreshnessBoundary();
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : $t("atlas.cancelUnavailable");
	}
}

function handleAtlasLifecycleAction(payload: {
	jobId: string;
	action: AtlasAction;
	message: string;
	profile: AtlasProfile;
}) {
	if (isConversationReadOnlyForChat) return;
	void normalChatRuntime.send({
		message: payload.message,
		attachmentIds: [],
		attachments: [],
		pendingAttachments: [],
		linkedSources: [],
		pendingSkill: null,
		conversationId: data.conversation.id,
		atlasMode: true,
		atlasProfile: payload.profile,
		atlasAction: payload.action,
		parentAtlasJobId: payload.jobId,
		clientAtlasTurnId: createClientAtlasTurnId(),
	});
}

$effect(() => {
	const conversationId = data.conversation?.id;
	const shouldPollConversation =
		hasActiveFileProductionJobs(fileProductionJobs) ||
		hasActiveAtlasJobs(atlasJobs);
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

let initializedAtlasJobsData = false;
let prevAtlasJobsData: typeof data.atlasJobs;
$effect(() => {
	if (!initializedAtlasJobsData) {
		prevAtlasJobsData = data.atlasJobs;
		initializedAtlasJobsData = true;
		return;
	}
	if (data.atlasJobs !== prevAtlasJobsData) {
		prevAtlasJobsData = data.atlasJobs;
		atlasJobs = [...(data.atlasJobs ?? [])];
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
		pendingSkill: payload.pendingSkill ?? null,
		atlasMode: payload.atlasMode === true,
		atlasProfile: payload.atlasProfile ?? null,
		clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
	});
	void draftPersistence.persist(
		{
			conversationId: nextConversationId,
			draftText: payload.message,
			selectedAttachmentIds: payload.attachmentIds,
			selectedLinkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.pendingSkill ?? null,
			atlasMode: payload.atlasMode === true,
			atlasProfile: payload.atlasProfile ?? null,
			clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
		},
		true,
	);
}

function restoreQueuedTurnToDraft() {
	normalChatRuntime.restoreQueuedTurnToDraft();
}

function editQueuedTurn() {
	normalChatRuntime.editQueuedTurn();
}

function clearQueuedTurn() {
	normalChatRuntime.clearQueuedTurn();
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

	try {
		for (let attempt = 0; attempt < evidencePollMaxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;

			try {
				const result = await fetchMessageEvidence(
					data.conversation.id,
					messageId,
					controller.signal,
				);

				if (result.status === "pending") {
					const shouldContinue = await waitForEvidencePollDelay(
						evidencePollDelayMs(attempt),
						controller.signal,
					);
					if (!shouldContinue) return;
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
				return;
			}
		}
	} finally {
		if (evidencePollControllers.get(messageId) === controller) {
			evidencePollControllers.delete(messageId);
		}
	}
}

function evidencePollDelayMs(attempt: number): number {
	if (attempt < 4) return 250;
	if (attempt < 11) return 500;
	if (attempt < 24) return 1000;
	return 2000;
}

function waitForEvidencePollDelay(
	delayMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", handleAbort);
			resolve(true);
		}, delayMs);

		function handleAbort() {
			clearTimeout(timeout);
			signal.removeEventListener("abort", handleAbort);
			resolve(false);
		}

		signal.addEventListener("abort", handleAbort, { once: true });
	});
}

async function refreshMessageCost(messageId: string) {
	try {
		const detail = await fetchConversationDetail(data.conversation.id);
		const msg = detail.messages.find((m) => m.id === messageId);
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
	const draft = response.draft;
	messages.update((list) =>
		patchSkillDraftInMessageList(list, {
			messageId,
			draft,
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
	if (normalChatRuntimeActive) {
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
	const modelIdForTurn = payload.modelId ?? $selectedModel;
	setConversationModelSelection(data.conversation.id, modelIdForTurn);
	if (
		!text.trim() ||
		isConversationReadOnlyForChat ||
		isSending ||
		isEditResendPending
	)
		return;

	await normalChatRuntime.send(payload, {
		skipUserMessage,
		skipPersistUserMessage,
		clearDraft,
		retryAssistantMessageId,
		retryUserMessageId,
		confirmForkedSourceHistoryMutation,
		onForkedSourceHistoryConfirmationRequired,
	});
}

function handleRetry() {
	normalChatRuntime.retry();
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

	// Preserve the user message's attachments so they survive regenerate.
	const originalAttachments = msgs[userIdx].attachments ?? [];
	const regenAttachmentIds: string[] = originalAttachments.map(
		(a) => a.artifactId,
	);
	const regenAttachments = originalAttachments.map((a) => ({
		id: a.artifactId,
		type: a.type,
		retrievalClass: "durable" as const,
		name: a.name,
		mimeType: a.mimeType,
		sizeBytes: a.sizeBytes,
		conversationId: a.conversationId,
		summary: null,
		createdAt: a.createdAt,
		updatedAt: a.createdAt,
	}));

	// Remove the assistant message(s) from in-memory state
	messages.update((m) => m.slice(0, assistantIdx));

	sendError = null;
	handleSend(
		{
			message: userText,
			attachmentIds: regenAttachmentIds,
			attachments: regenAttachments,
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

	// Snapshot original attachments before deleting the message so they survive edit+resubmit.
	const originalAttachments = msgs[editIdx].attachments ?? [];
	const editAttachmentIds: string[] = originalAttachments.map(
		(a) => a.artifactId,
	);
	const editAttachments = originalAttachments.map((a) => ({
		id: a.artifactId,
		type: a.type,
		retrievalClass: "durable" as const,
		name: a.name,
		mimeType: a.mimeType,
		sizeBytes: a.sizeBytes,
		conversationId: a.conversationId,
		summary: null,
		createdAt: a.createdAt,
		updatedAt: a.createdAt,
	}));

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
		attachmentIds: editAttachmentIds,
		attachments: editAttachments,
		pendingAttachments: [],
	});
}

function handleStop() {
	normalChatRuntime.stop();
}

function latestTimelineMessageId(): string | null {
	return (
		[...$messages].reverse().find((message) => Boolean(message.id))?.id ?? null
	);
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

function handleCompact() {
	normalChatRuntime.compact();
}

function handleQueue(payload: SendPayload) {
	normalChatRuntime.queue(payload);
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
		atlasMode: payload.atlasMode === true,
		atlasProfile: payload.atlasProfile ?? null,
		clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
	});
	void draftPersistence.persist({
		conversationId: nextConversationId,
		draftText: payload.draftText,
		selectedAttachmentIds: payload.selectedAttachmentIds,
		selectedLinkedSources: payload.selectedLinkedSources,
		pendingSkill: payload.pendingSkill,
		atlasMode: payload.atlasMode === true,
		atlasProfile: payload.atlasProfile ?? null,
		clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
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
						{atlasJobs}
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
						onCancelAtlasJob={handleCancelAtlasJob}
						onAtlasLifecycleAction={handleAtlasLifecycleAction}
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
				composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
				{atlasAvailability}
				{personalityProfiles}
				{selectedPersonalityId}
				onPersonalityChange={setSelectedPersonalityId}
				onModelChange={setSelectedConversationModelId}
				reasoningDepth={$selectedReasoningDepth}
				onReasoningDepthChange={setSelectedReasoningDepth}
				draftText={conversationDraft?.draftText ?? ''}
				draftAttachments={conversationDraft?.selectedAttachments ?? []}
				draftLinkedSources={conversationDraft?.selectedLinkedSources ?? []}
				draftPendingSkill={conversationDraft?.pendingSkill ?? null}
				draftAtlasMode={conversationDraft?.atlasMode === true}
				draftAtlasProfile={conversationDraft?.atlasProfile ?? null}
				draftClientAtlasTurnId={conversationDraft?.clientAtlasTurnId ?? null}
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
