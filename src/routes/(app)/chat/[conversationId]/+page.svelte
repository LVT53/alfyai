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
	deleteConversation,
	deleteConversationDraft,
	deleteConversationMessages,
	fetchConversationDetail,
	fetchMessageEvidence,
	generateConversationTitle,
	createConversationFork,
	runConversationContextCompression,
} from "$lib/client/api/conversations";
import {
	cancelAtlasJob as cancelAtlasJobRequest,
	submitAtlasTurn,
} from "$lib/client/api/atlas";
import {
	cancelFileProductionJob as cancelFileProductionJobRequest,
	dismissFileProductionJob as dismissFileProductionJobRequest,
	retryFileProductionJob as retryFileProductionJobRequest,
} from "$lib/client/api/file-production";
import {
	dismissSkillDraft as dismissSkillDraftRequest,
	saveSkillDraft as saveSkillDraftRequest,
} from "$lib/client/api/skills";
import { updateInstructionSuggestionStatus } from "$lib/client/api/conversations";
import { ApiError } from "$lib/client/api/http";
import {
	recordDocumentWorkspaceOpen,
	uploadKnowledgeAttachment,
	uploadRefusalFromError,
} from "$lib/client/api/knowledge";
import { extractionFromUploadResponse } from "$lib/client/extraction-poll";
import type { OpenInstructionDialog } from "$lib/client/instruction-command";
import { isAttachmentReadinessReason } from "$lib/shared/attachment-readiness";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
import {
	ackCloudConnector,
	checkCloudWarning,
	setLocalDistill,
} from "$lib/client/api/connections";
import {
	cancelWrite as cancelWriteRequest,
	confirmWrite as confirmWriteRequest,
	fetchConversationPendingWrites,
} from "$lib/client/api/connection-writes";
import { currentConversationId } from "$lib/stores/ui";
import { projects } from "$lib/stores/projects";
import {
	selectedModel,
	selectedReasoningDepth,
	setSelectedModel,
	setSelectedReasoningDepth,
} from "$lib/stores/settings";
import { isPendingFileProductionJobId } from "$lib/components/chat/file-production-helpers";
import CloudConnectorWarningModal from "$lib/components/chat/CloudConnectorWarningModal.svelte";
import { isProviderModelId } from "$lib/model-types";
import type { ModelId } from "$lib/model-types";
import type { MessageUserIntent } from "$lib/message-user-intent";
import type {
	AtlasAction,
	AtlasAvailability,
	AtlasJobCard,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type { ArtifactCardSummary } from "$lib/server/services/artifacts/types";
import type { ChatGeneratedFile } from "$lib/server/services/file-production/types";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import type { ContextCompressionMarker } from "$lib/server/services/context-compression";
import type { ConversationForkOrigin } from "$lib/server/services/conversation-forks";
import type { ConversationDraft } from "$lib/server/services/conversations";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type {
	ArtifactSummary,
	DocumentWorkspaceItem,
} from "$lib/server/services/knowledge/types";
import type {
	ChatMessage,
	NormalChatRuntimePhase,
} from "$lib/server/services/messages-types";
import type { TaskState } from "$lib/server/services/task-state/types";
import type { I18nKey } from "$lib/i18n";
import type { PageProps } from "./$types";
import {
	createBrowserNormalChatClientTurnRuntime,
	type NormalChatRuntimeSnapshot,
} from "$lib/client/normal-chat-client-turn-runtime";
import type { StreamTimingSnapshot } from "$lib/services/streaming";
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
	conversations,
	removeConversationLocal,
	updateConversationMemoryIncognitoLocal,
	updateConversationTitleLocal,
	upsertConversationLocal,
} from "$lib/stores/conversations";
import {
	getForkCreationErrorKey,
	hasForkedAssistantInRange,
	isForkedSourceHistoryConfirmationRequired,
	laterTurnCount,
	regenerateDropsLaterTurns,
} from "./lifecycle-guards";
import ChatComposerPanel from "./_components/ChatComposerPanel.svelte";
import DegradedCapabilitiesBanner from "$lib/components/chat/DegradedCapabilitiesBanner.svelte";
import ChatMessagePane from "./_components/ChatMessagePane.svelte";
import DropZoneOverlay from "$lib/components/chat/DropZoneOverlay.svelte";
import ConversationTitleText from "$lib/components/chat/ConversationTitleText.svelte";
import DocumentWorkspace from "$lib/components/document-workspace/DocumentWorkspace.svelte";
import { LayoutGrid } from "@lucide/svelte";
import InstructionCommandDialog from "$lib/components/instructions/InstructionCommandDialog.svelte";
import {
	appendAssistantPlaceholder,
	appendThinkingChunkToMessageList,
	appendTokenChunkToMessageList,
	applyResponseActivityEntryToMessageList,
	applyToolCallUpdateToMessageList,
	attachUnassignedFileProductionJobsToAssistant,
	attachUnassignedPendingWritesToAssistant,
	buildPendingFileProductionJobPlaceholder,
	dropPendingFileProductionJobs,
	failPendingFileProductionJobPlaceholder,
	finalizeStreamingMessageList,
	getWorkspacePresentationAfterDocumentOpen,
	hasActiveAtlasJobs,
	hasActiveFileProductionJobs,
	mergeFileProductionJob,
	removeMessageById,
	patchInstructionSuggestionInMessageList,
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
const initialTaskState = getData().taskState ?? null;
const initialContextDebug = getData().contextDebug ?? null;
const initialConversationDraft = getData().draft ?? null;
const initialForkOrigin = getData().forkOrigin ?? null;
const initialBootstrapMode = getData().bootstrap ?? false;
const initialGeneratedFiles = getData().generatedFiles ?? [];
const initialFileProductionJobs = getData().fileProductionJobs ?? [];
const initialArtifacts = getData().artifacts ?? [];
const initialAtlasJobs = getData().atlasJobs ?? [];
const initialPendingWrites = getData().pendingWrites ?? [];
const initialContextCompressionSnapshots =
	getData().contextCompressionSnapshots ?? [];
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
const skillDraftLocalizedApiErrorKeys: Record<string, I18nKey> = {
	"composerCommandRegistry.disabled": "composerCommandRegistry.disabled",
	"skillDrafts.notFound": "skillDrafts.notFound",
	"skillDrafts.inheritedCopyBlocked": "skillDrafts.inheritedCopyBlocked",
	"skills.notFound": "skills.notFound",
};

let titleSyncedConversationId: string | null = null;

$effect(() => {
	// Incognito, one-way — pass the freshly-loaded server truth directly
	// rather than relying on the local map alone: the landing page's
	// creation flow hard-navigates here (a full page load), which wipes
	// that map, so on this row's first paint after arming incognito it
	// would otherwise be empty. See upsertConversationLocal's own comment.
	upsertConversationLocal(
		data.conversation.id,
		data.conversation.title,
		data.conversation.updatedAt,
		data.conversation.projectId ?? null,
		data.conversation.memoryIncognito ?? false,
	);
	// Arriving on a conversation, its freshly-loaded detail is the newest
	// word on its title, so it replaces whatever the sidebar snapshot held.
	// Only on arrival: a later reload of the same conversation (a
	// visibility-restore invalidate) could have left before a generated
	// title was saved, and must not put "New Conversation" back.
	if (titleSyncedConversationId !== data.conversation.id) {
		titleSyncedConversationId = data.conversation.id;
		updateConversationTitleLocal(data.conversation.id, data.conversation.title);
	}
});

// The conversations store is the one live source for a conversation's title:
// a generated title and a sidebar rename both land there, and the sidebar,
// the phone header (+layout.svelte) and this page's title bar and <title>
// all read it. The page's own data only covers the moment before the row
// exists.
let effectiveConversationTitle = $derived(
	$conversations.find((item) => item.id === data.conversation.id)?.title ??
		data.conversation?.title ??
		"",
);

// Project breadcrumb for the desktop title bar (see the chat-title-bar
// markup below) — looked up from the shared projects store rather than
// fetched here, since the sidebar already keeps it populated.
let activeProjectId = $derived(data.conversation?.projectId ?? null);
let activeProjectName = $derived(
	activeProjectId
		? ($projects.find((project) => project.id === activeProjectId)?.name ??
				null)
		: null,
);

// Handed up by the `/instruction` dialog host on mount; null until then, and
// the command tray cannot be opened before hydration either.
let openInstructionDialog: OpenInstructionDialog | null = $state(null);

const messages = writable<ChatMessage[]>(initialMessages);
const draftPersistence = createDraftPersistence();
let sendError = $state<string | null>(null);
let isSending = $state(false);
let isEditResendPending = $state(false);
let normalChatRuntimeActive = $state(false);
let normalChatRuntimePhase = $state<NormalChatRuntimePhase>("idle");
// R1 (ADR-0060) — canRetry crosses the seam now: the runtime already
// decides whether a Retry affordance is meaningful (it silently refused
// retry() before this existed), and the page must not offer one it knows
// will be refused.
let normalChatRuntimeCanRetry = $state(false);
let normalChatRuntimeCanStop = $derived(
	normalChatRuntimeActive &&
		(normalChatRuntimePhase === "preparing" ||
			normalChatRuntimePhase === "generating"),
);
let queuedTurn = $state<SendPayload | null>(null);
let titleGenerationTriggered = false;
let prevConversationId: string | null = null;

// Issue 7.4 fix pass — single chokepoint for the cloud-connector privacy
// warning. Previously this check/modal lived inside MessageInput.svelte's
// local send() path, so any caller that reached normalChatRuntime.send()
// (or the runtime's separate retry() path) WITHOUT going through that one
// component's send() — regenerate, edit-then-resend, retry, and (found while
// doing this pass) the Atlas lifecycle-action send — could dispatch a
// message to a cloud model with active connector capabilities without ever
// showing the warning. The check + modal now live here, at the page, and
// EVERY fresh-send-to-model path (handleSend/handleRegenerate/handleEdit/
// handleRetry/handleAtlasLifecycleAction, plus the composer's own send and
// its queued-after-upload send via the `beforeSend` prop MessageInput now
// awaits) funnels through `ensureCloudWarningAcked()` before it may proceed.
// `composerActiveCapabilities` is bound two-way from MessageInput (which
// still owns loading/toggling the per-conversation capability set — that's
// composer UI state, not part of the gate) so every gated path checks the
// SAME "does the user currently have connector capabilities active" signal
// the composer itself would use.
let composerActiveCapabilities = $state<Set<string>>(new Set());
let cloudWarningOpen = $state(false);
let cloudWarningChecking = $state(false);
let cloudWarningAcked = $state(false);
let cloudWarningResolve: ((proceed: boolean) => void) | null = null;
// Issue 7.4 race-fix follow-up — MessageInput hands this up once on mount
// (see its `onCapabilitiesReady` prop). Calling it returns the SAME
// in-flight-or-settled promise as its own on-mount `fetchActiveCapabilities()`
// call, so `ensureCloudWarningAcked` can await the real capability set
// instead of racing it. Left null if the composer hasn't mounted yet (should
// never happen in practice — ChatComposerPanel is always rendered on this
// page — but `ensureCloudWarningAcked` degrades gracefully if so, by simply
// reading whatever `composerActiveCapabilities` currently holds).
let ensureComposerCapabilitiesLoaded: (() => Promise<void>) | null = null;
function handleCapabilitiesReady(ensureLoaded: () => Promise<void>) {
	ensureComposerCapabilitiesLoaded = ensureLoaded;
}

function shouldCheckCloudWarning(): boolean {
	return (
		!cloudWarningAcked &&
		composerActiveCapabilities.size > 0 &&
		isProviderModelId($selectedModel)
	);
}

// Returns true once it's safe to dispatch (no warning needed, or the user
// acknowledged/enabled local mode), false if a warning is already in
// progress for a different caller (reentrancy — treat as a no-op, matching
// the pre-existing double-Enter-must-be-a-no-op guarantee) or the user
// cancelled.
async function ensureCloudWarningAcked(): Promise<boolean> {
	if (cloudWarningChecking || cloudWarningOpen) return false;
	if (cloudWarningAcked) return true;

	// Cheap, synchronous pre-check: an on-box/local model never needs the
	// warning regardless of connector capabilities, so we can return
	// immediately without ever touching the (possibly still-loading)
	// capability fetch below. Keeps the overwhelmingly common local-model
	// send path latency-free.
	if (!isProviderModelId($selectedModel)) return true;

	// `composerActiveCapabilities` is populated asynchronously by
	// MessageInput's on-mount `fetchActiveCapabilities()` call. If that
	// fetch hasn't resolved yet, the set is still its empty initial value —
	// reading it right now would silently conclude "no connectors, no
	// warning" purely because the fetch hasn't finished, not because the
	// user actually has no active connectors. This is exactly the race that
	// let `maybeSendPendingInitialMessage` (a brand-new conversation's very
	// first message, sent moments after mount) under-warn. Await the SAME
	// promise MessageInput itself is awaiting before deciding: if it's
	// already resolved this costs a single microtask (no perceptible
	// delay); if it's still in flight, wait for the real answer instead of
	// guessing "empty".
	if (ensureComposerCapabilitiesLoaded) {
		await ensureComposerCapabilitiesLoaded();
	}

	if (!shouldCheckCloudWarning()) return true;

	cloudWarningChecking = true;
	let shouldWarn = false;
	try {
		const result = await checkCloudWarning($selectedModel, [
			...composerActiveCapabilities,
		]);
		shouldWarn = result.shouldWarn;
	} catch {
		// Fail open: this is a UI nudge, not a data boundary (the actual
		// on-device-vs-cloud handling is enforced server-side). Don't block
		// sending a message over a network hiccup on the warning check itself.
		shouldWarn = false;
	} finally {
		cloudWarningChecking = false;
	}

	if (!shouldWarn) return true;

	cloudWarningOpen = true;
	return new Promise<boolean>((resolve) => {
		cloudWarningResolve = resolve;
	});
}

async function handleCloudWarningContinue() {
	try {
		await ackCloudConnector();
	} catch {
		// Non-fatal: the ack didn't persist, so the warning may simply
		// reappear on a future send — not a reason to block this one.
	}
	cloudWarningAcked = true;
	cloudWarningOpen = false;
	const resolve = cloudWarningResolve;
	cloudWarningResolve = null;
	resolve?.(true);
}

async function handleCloudWarningEnableLocalMode() {
	try {
		await setLocalDistill(true);
	} catch {
		// Non-fatal: local mode can be turned on later from Settings.
	}
	cloudWarningOpen = false;
	const resolve = cloudWarningResolve;
	cloudWarningResolve = null;
	resolve?.(true);
}

function handleCloudWarningCancel() {
	// Aborts the pending send; whatever state the caller preserved (composer
	// text/attachments for a fresh send, the not-yet-mutated message list for
	// regenerate/edit) is untouched, since every gated caller awaits this
	// resolution before doing anything destructive.
	cloudWarningOpen = false;
	const resolve = cloudWarningResolve;
	cloudWarningResolve = null;
	resolve?.(false);
}
let hasPersistedMessages = initialHasPersistedMessages;
let contextStatus = $state<ConversationContextStatus | null>(
	initialContextStatus,
);
let totalCostUsdMicros = $state(initialTotalCostUsdMicros);
let totalTokens = $state(initialTotalTokens);
let totalCostUsd = $derived(totalCostUsdMicros / 1_000_000);
// Last-turn cost: the costUsd of the most recent assistant message that has one.
let lastTurnCostUsd = $derived.by(() => {
	for (let i = $messages.length - 1; i >= 0; i--) {
		const msg = $messages[i];
		if (msg.role === "assistant" && typeof msg.costUsd === "number") {
			return msg.costUsd;
		}
	}
	return 0;
});
let attachedArtifacts = $state<ArtifactSummary[]>(initialAttachedArtifacts);
let taskState = $state<TaskState | null>(initialTaskState);
let contextDebug = $state<ContextDebugState | null>(initialContextDebug);
let conversationDraft = $state<ConversationDraft | null>(
	initialConversationDraft,
);
let forkOrigin = $state<ConversationForkOrigin | null>(initialForkOrigin);
let generatedFiles = $state<ChatGeneratedFile[]>(initialGeneratedFiles);
let fileProductionJobs = $state<FileProductionJob[]>(initialFileProductionJobs);
// The chat header's count button and the panel's list state (Slice 0 Task
// S7): the conversation detail payload's own artifacts field, refreshed
// alongside generatedFiles/fileProductionJobs everywhere they are, never a
// second fetch path.
let artifacts = $state<ArtifactCardSummary[]>(initialArtifacts);
let artifactListOpen = $state(false);
// Read by closeWorkspace() to return focus to the button that opens "what
// this chat made" when the panel closes — both refs exist because the
// desktop and compact buttons are both always in the DOM (CSS decides which
// one is visible per breakpoint); calling .focus() on the hidden one is a
// harmless no-op, so trying both always lands on whichever one is showing.
let artifactCountButtonEl = $state<HTMLButtonElement | null>(null);
let artifactCountButtonCompactEl = $state<HTMLButtonElement | null>(null);
let atlasJobs = $state<AtlasJobCard[]>(initialAtlasJobs);
let pendingWrites = $state<PendingWrite[]>(initialPendingWrites);
let contextCompressionMarkers = $state<ContextCompressionMarker[]>(
	initialContextCompressionSnapshots,
);
let skillDraftActionState = $state<
	Record<string, { busy?: boolean; error?: string | null }>
>({});
let instructionSuggestionActionState = $state<
	Record<string, { busy?: boolean; error?: string | null }>
>({});
let writeActionState = $state<
	Record<string, { busy?: boolean; error?: string | null }>
>({});
let forkingMessageId = $state<string | null>(null);
let contextCompressionInFlight = $state(false);
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
let returnToDockedOnExpandedClose = $derived.by(() => {
	const activeDocument =
		workspaceDocuments.find(
			(document) => document.id === activeWorkspaceDocumentId,
		) ?? null;
	if (!activeDocument || activeDocument.mimeType !== "text/html") return true;
	return !atlasJobs.some(
		(job) => job.outputs.htmlChatGeneratedFileId === activeDocument.id,
	);
});
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
const streamTimingDiagnostics = {
	latest: null as StreamTimingSnapshot | null,
	record(timing: StreamTimingSnapshot) {
		this.latest = timing;
	},
};

function markDetailMetadataFreshnessBoundary() {
	detailMetadataEpoch += 1;
}

function applyNormalChatRuntimeSnapshot(snapshot: NormalChatRuntimeSnapshot) {
	normalChatRuntimeActive = snapshot.active;
	normalChatRuntimePhase = snapshot.phase;
	normalChatRuntimeCanRetry = snapshot.canRetry;
	isSending = snapshot.isSending;
	queuedTurn = snapshot.queuedTurn;
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
	onStreamTiming: (timing) => {
		streamTimingDiagnostics.record(timing);
	},
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
	// R1 (ADR-0060) — one dispatch point for every visible message-list
	// mutation the runtime drives, replacing nine separate one-line
	// pass-throughs to the helpers below. The page still owns the list and
	// still owns exactly how each event mutates it; the runtime just no
	// longer needs nine differently-shaped adapter members to say so.
	applyMessageListEvent: (event) => {
		switch (event.type) {
			case "appendUser":
				messages.update((list) => [...list, event.message]);
				return;
			case "appendAssistantPlaceholder":
				messages.update((list) =>
					appendAssistantPlaceholder(list, event.placeholder),
				);
				return;
			case "appendToken":
				messages.update((list) =>
					appendTokenChunkToMessageList(list, event.placeholderId, event.chunk),
				);
				return;
			case "appendThinking":
				messages.update((list) =>
					appendThinkingChunkToMessageList(
						list,
						event.placeholderId,
						event.chunk,
					),
				);
				return;
			case "applyToolCall":
				messages.update((list) =>
					applyToolCallUpdateToMessageList(list, {
						placeholderId: event.placeholderId,
						name: event.name,
						input: event.input,
						status: event.status,
						details: event.details,
					}),
				);
				return;
			case "applyResponseActivity":
				messages.update((list) =>
					applyResponseActivityEntryToMessageList(
						list,
						event.placeholderId,
						event.entry,
					),
				);
				return;
			case "setRuntimePhase":
				messages.update((list) =>
					updateMessageById(list, event.placeholderId, (message) => ({
						...message,
						runtimePhase: event.phase,
					})),
				);
				return;
			case "remove":
				messages.update((list) => removeMessageById(list, event.messageId));
				return;
			case "finalize":
				messages.update((list) =>
					finalizeStreamingMessageList(list, {
						placeholderId: event.placeholderId,
						clientUserMessageId: event.clientUserMessageId,
						metadata: event.metadata,
					}),
				);
				return;
		}
	},
	shouldHydrateFileProductionJobsOnToolCall,
	applyStreamMetadata: (metadata) => {
		if (metadata) {
			markDetailMetadataFreshnessBoundary();
		}
		contextStatus = metadata?.contextStatus ?? contextStatus;
		taskState = metadata?.taskState ?? taskState;
		contextDebug = metadata?.contextDebug ?? contextDebug;
		totalCostUsdMicros = metadata?.totalCostUsdMicros ?? totalCostUsdMicros;
		totalTokens = metadata?.totalTokens ?? totalTokens;
	},
	attachFileProductionJobsToAssistantMessage,
	// Item 6 (UX-speed plan) — see buildPendingFileProductionJobPlaceholder /
	// failPendingFileProductionJobPlaceholder in ./_helpers for what the
	// placeholder looks like; this just wires it into the same
	// fileProductionJobs array real jobs live in, so the existing
	// getFileProductionJobsForMessage matching in MessageArea.svelte (an
	// assistantMessageId-less job matches the currently-streaming assistant
	// message by conversationId + recency) picks it up with no further
	// plumbing.
	addFileProductionJobPlaceholder: (placeholder) => {
		fileProductionJobs = [
			buildPendingFileProductionJobPlaceholder({
				id: placeholder.id,
				conversationId: placeholder.conversationId,
				input: placeholder.input,
				now: Date.now(),
				translate: $t,
			}),
			...fileProductionJobs,
		];
	},
	failFileProductionJobPlaceholder: (params) => {
		fileProductionJobs = fileProductionJobs.map((job) =>
			job.id === params.id
				? failPendingFileProductionJobPlaceholder(job, {
						message: params.message,
						now: Date.now(),
						translate: $t,
					})
				: job,
		);
	},
	refreshPendingWrites: () => {
		void refreshPendingWrites();
	},
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
		// Item 6 (UX-speed plan) — a real job list always supersedes whatever
		// placeholder stood in for it; drop placeholders first so a
		// placeholder and its real replacement never render side by side.
		fileProductionJobs = jobs.reduce(
			(currentJobs, job) => mergeFileProductionJob(currentJobs, job),
			dropPendingFileProductionJobs(fileProductionJobs),
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

// The chat header's count button and the panel's list (Slice 0 Task S7).
// Absent-at-zero (the button is not drawn at all in a chat that made
// nothing), never a second query: `artifacts` is the same conversation
// detail payload field generatedFiles/fileProductionJobs already refresh
// from.
let artifactCount = $derived(artifacts.length);

/**
 * The File kind reuses the SAME real item (`previewUrl`, `mimeType`, …)
 * `availableWorkspaceDocuments` already builds for the produced-file row's
 * own Open action, rather than a second, poorer representation built from
 * the bare summary. The other four kinds have no real body yet (Slice 0
 * non-goal — the registry ships empty), so their item is minimal and honest:
 * the panel's existing preview stack shows "not available" instead of
 * inventing content.
 *
 * `updatedAt` is carried through either way, so the list row can show "made
 * by Alfy {when}" (mockup surface 2) regardless of which branch built the
 * item.
 */
function artifactToWorkspaceItem(
	summary: ArtifactCardSummary,
): DocumentWorkspaceItem {
	if (summary.kind === "file") {
		const matching = availableWorkspaceDocuments.find(
			(item) => item.artifactId === summary.id,
		);
		// availableWorkspaceDocuments predates `kind`/`updatedAt` and never
		// sets either, so both are carried in explicitly here — otherwise the
		// panel's type/version pill (DocumentWorkspace.svelte's
		// `{#if activeDocument.kind}`) silently never renders for the single
		// most common open: a File that already has a real item.
		if (matching) {
			return { ...matching, kind: summary.kind, updatedAt: summary.updatedAt };
		}
	}
	return {
		id: summary.id,
		source: "knowledge_artifact",
		filename: summary.title,
		title: summary.title,
		mimeType: null,
		artifactId: summary.id,
		versionNumber: summary.versionNumber,
		kind: summary.kind,
		updatedAt: summary.updatedAt,
	};
}

let artifactWorkspaceItems = $derived(artifacts.map(artifactToWorkspaceItem));

// The panel's list rows call the existing onSelectDocument(item.id) path
// (Task S5) rather than a second lookup, so every item this slice can open
// — File through its real generatedFiles entry, the four new kinds through
// their minimal one — must be findable through availableDocuments too.
//
// artifactWorkspaceItems first, availableWorkspaceDocuments only as
// fallback: for a File that already has a real generatedFiles entry, both
// arrays carry an item with the SAME id, but only the artifact-derived one
// carries `kind`/`updatedAt` (availableWorkspaceDocuments predates the
// artifact family and never sets either). DocumentWorkspace.svelte's
// activeDocument derivation resolves by id through `documents` then
// `availableDocuments` — the FIRST match wins — so the artifact-aware copy
// must be findable before the plain one, or the panel opens the plain one
// and its type/version pill silently never renders.
let availableWorkspaceDocumentsWithArtifacts = $derived([
	...artifactWorkspaceItems,
	...availableWorkspaceDocuments.filter(
		(item) =>
			!artifactWorkspaceItems.some((existing) => existing.id === item.id),
	),
]);

function openArtifactList() {
	workspaceOpen = true;
	artifactListOpen = true;
}

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
	options: {
		preservePresentation?: boolean;
		presentation?: "docked" | "expanded";
	} = {},
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
	// The panel's "what this chat made" list (Task S7) calls this same
	// onSelectDocument path for an item that may not be an open tab yet —
	// it only ever appeared in availableDocuments. Selecting such an item
	// has to open it (adding it to workspaceDocuments), not merely point
	// activeWorkspaceDocumentId at an id no open tab has: the shell's own
	// shouldShowWorkspaceShell depends on workspaceDocuments.length once
	// the list itself has closed, so "select" alone would close the panel
	// the instant the list did.
	const alreadyOpenTab = workspaceDocuments.some(
		(entry) => entry.id === documentId,
	);
	if (!alreadyOpenTab) {
		const candidate = availableWorkspaceDocumentsWithArtifacts.find(
			(entry) => entry.id === documentId,
		);
		if (candidate) {
			openWorkspaceDocument(candidate, { preservePresentation: true });
			return;
		}
	}
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
	artifactListOpen = false;
	// The panel's own close control (× or Escape) is about to leave the DOM,
	// which would otherwise drop focus to <body> and strand a keyboard user
	// at the top of the page. The count button is a stable landing spot
	// whenever it exists, regardless of what actually opened this panel
	// instance.
	artifactCountButtonEl?.focus();
	artifactCountButtonCompactEl?.focus();
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

// The conversation in which one particular message was brought into view for
// the reader — a search result, a jump to a document's source. The thread
// must not pull the view away from it (MessageArea's `showingLinkedMessage`).
let linkedMessageConversationId = $state<string | null>(null);
// Counts the jumps, so only the latest one ends the linked-message state.
let linkedMessageJumps = 0;

/**
 * Resolves once `element` has held still on screen for `stillFrames` frames
 * in a row, or after two seconds of a thread that keeps moving.
 */
function whenStillOnScreen(
	element: HTMLElement | null,
	stillFrames: number,
): Promise<void> {
	return new Promise((resolve) => {
		if (!element) {
			resolve();
			return;
		}
		let lastTop = element.getBoundingClientRect().top;
		let still = 0;
		let frames = 0;
		const step = () => {
			const top = element.getBoundingClientRect().top;
			still = Math.abs(top - lastTop) < 1 ? still + 1 : 0;
			lastTop = top;
			frames += 1;
			if (still >= stillFrames || frames >= 120) {
				resolve();
				return;
			}
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
}

async function focusMessage(messageId: string) {
	const conversationId = data.conversation.id;
	const jump = ++linkedMessageJumps;
	const isCurrentJump = () =>
		jump === linkedMessageJumps &&
		linkedMessageConversationId === conversationId;
	linkedMessageConversationId = conversationId;
	await tick();
	const target = document.getElementById(`message-${messageId}`);
	// Replies render their markdown after the thread first paints; the
	// message moves until what is above it has its height, and a scroll
	// issued before then lands short of it.
	await whenStillOnScreen(target, 5);
	if (!isCurrentJump()) return;
	target?.scrollIntoView({ behavior: "smooth", block: "center" });
	// The page drives the view only until the message has come to rest on
	// screen (ten still frames outlast a smooth scroll's start). After that
	// the view is the reader's, and a later reply, or "jump to latest", may
	// hold the latest message in view again.
	await whenStillOnScreen(target, 10);
	if (isCurrentJump()) linkedMessageConversationId = null;
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
	// Issue 7.4 fix pass — the landing-page-to-conversation bootstrap send
	// calls handleSend() directly, never through MessageInput's UI at all, so
	// it never went through any cloud-warning check even before this pass
	// (it predates 7.4). Gated here for the same reason as the other direct
	// normalChatRuntime.send() callers. This send fires moments after mount
	// (via a requestAnimationFrame in resetState), which used to race
	// MessageInput's own on-mount capability fetch: `composerActiveCapabilities`
	// could still be its empty initial value here, making the gate under-warn
	// on a brand-new conversation's very first message — the canonical moment
	// Option-C exists for. `ensureCloudWarningAcked` now closes that race by
	// awaiting the capability fetch itself before deciding (see its own
	// comment above), so this call site no longer needs special handling.
	void (async () => {
		const proceed = await ensureCloudWarningAcked();
		if (!proceed) return;
		handleSend({ ...pendingDraft, pendingAttachments: [] });
	})();
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
	taskState = data.taskState ?? null;
	contextDebug = data.contextDebug ?? null;
	conversationDraft = data.draft ?? null;
	forkOrigin = data.forkOrigin ?? null;
	triggerForkOpeningTransition();
	generatedFiles = data.generatedFiles ?? [];
	fileProductionJobs = data.fileProductionJobs ?? [];
	artifacts = data.artifacts ?? [];
	atlasJobs = data.atlasJobs ?? [];
	pendingWrites = data.pendingWrites ?? [];
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
	forkingMessageId = null;
	linkedMessageConversationId = null;
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

// R1 (ADR-0060, defect 2) — this used to refuse to run while a turn was
// active (`|| normalChatRuntimeActive`), which was the hole: navigating
// `/chat/A` -> `/chat/B` while A was still streaming left A's turn running
// against this same component instance, its callbacks writing streamed
// text, evidence, activity, and hydration through `data.conversation.id`,
// which had already become B's id. The reset must run unconditionally on
// every conversation switch — `resetState()` calls `normalChatRuntime.reset()`
// first, which detaches the transport immediately, before anything below
// swaps in B's fresh state. (The runtime also tags every turn with the
// conversation it started in and drops any write whose conversation is no
// longer current — see `isTurnConversationActive` in
// normal-chat-client-turn-runtime.ts — as a second, independent guard for
// the same defect.)
$effect(() => {
	if (!data?.conversation?.id) {
		return;
	}
	if (data.conversation.id !== prevConversationId) {
		prevConversationId = data.conversation.id;
		resetState();
	}
});

// Declared after the reset above so that it runs after it: resetState()
// ends any linked-message state, and on a direct load both run in the same
// flush.
//
// The navigation whose ?focus_message= has been acted on. page.url keeps the
// parameter for the whole visit (replaceState below rewrites the address
// bar and page.state, not page.url), so without this every change to the
// messages — each streamed token — would scroll back to the linked message.
let focusedFromUrl: URL | null = null;

$effect(() => {
	const url = page.url;
	const focusMessageId = getChatFocusMessageIdFromUrl(url);
	if (!focusMessageId || url === focusedFromUrl) return;
	if (!$messages.some((message) => message.id === focusMessageId)) return;
	focusedFromUrl = url;

	void focusMessage(focusMessageId);
	// Drop the parameter so a reload does not jump again. Not from inside
	// this effect: on a direct load it runs while the page hydrates, before
	// the router has started, and replaceState throws until it has. The next
	// frame is after that (the same deferral as the bootstrap parameter).
	requestAnimationFrame(() => {
		if (page.url !== url) return;
		replaceState(clearChatFocusMessageParam(url), page.state);
	});
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
	taskState = detail.taskState ?? taskState;
	contextDebug = detail.contextDebug ?? contextDebug;
	if (detail.generatedFiles) {
		generatedFiles = [...detail.generatedFiles];
	}
	if (detail.fileProductionJobs) {
		fileProductionJobs = [...detail.fileProductionJobs];
	}
	if (detail.artifacts) {
		artifacts = [...detail.artifacts];
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
	// Issue 7.5 — pending writes aren't part of ConversationDetail (dedicated
	// endpoint, see +page.ts), so both callers of this function (the
	// non-streaming polling fallback and the post-timeout persisted-data
	// reload) get their pending-write cards refreshed here too.
	void refreshPendingWrites();
}

async function refreshPendingWrites() {
	try {
		pendingWrites = await fetchConversationPendingWrites(data.conversation.id);
	} catch {
		// Best-effort — the page still functions with a stale/empty list; the
		// next successful refresh (turn completion, tool-call hydrate, or a
		// full page reload) will bring it back in sync.
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
			contextStatus = payload.contextStatus ?? contextStatus;
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
	// Issue 7.5 — this is the SAME trigger a completed connection tool call
	// (files/calendar/email/photos) uses to hydrate mid-turn (see
	// shouldHydrateFileProductionJobsOnToolCall in ./_helpers), so a
	// "save"/"send"/etc. write proposal's pending-write card can appear
	// without a dedicated, parallel hydration path.
	void refreshPendingWrites();
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
	// Issue 7.5 — same zero-latency optimistic stamp as above, applied to
	// pending writes; see attachUnassignedPendingWritesToAssistant's doc
	// comment in ./_helpers for why this runs alongside (not instead of)
	// the durable refreshPendingWrites() refetch (ctx.refreshPendingWrites,
	// called by the runtime right after this function).
	pendingWrites = attachUnassignedPendingWritesToAssistant(pendingWrites, {
		conversationId: data.conversation.id,
		assistantMessageId,
	});
}

async function handleRetryFileProductionJob(jobId: string) {
	// Item 6 (UX-speed plan) — a placeholder card has no server-side job
	// behind it; FileProductionCard.svelte already hides this action for a
	// placeholder, this is the defense-in-depth twin.
	if (isPendingFileProductionJobId(jobId)) return;
	try {
		const job = await retryFileProductionJobRequest(jobId);
		fileProductionJobs = mergeFileProductionJob(fileProductionJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to retry file production";
	}
}

async function handleCancelFileProductionJob(jobId: string) {
	if (isPendingFileProductionJobId(jobId)) return;
	try {
		const job = await cancelFileProductionJobRequest(jobId);
		fileProductionJobs = mergeFileProductionJob(fileProductionJobs, job);
	} catch (err) {
		sendError =
			err instanceof Error ? err.message : "Failed to cancel file production";
	}
}

async function handleDismissFileProductionJob(jobId: string) {
	if (isPendingFileProductionJobId(jobId)) return;
	// Optimistic removal: hide the card immediately, then confirm via the
	// dismiss route (Slice 3). The read-model filter re-confirms on reload.
	const previous = fileProductionJobs;
	fileProductionJobs = fileProductionJobs.filter((job) => job.id !== jobId);
	try {
		await dismissFileProductionJobRequest(jobId);
	} catch (err) {
		// Roll back on failure so the user can retry the dismiss.
		fileProductionJobs = previous;
		sendError =
			err instanceof Error ? err.message : "Failed to dismiss file production";
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

async function handleAtlasLifecycleAction(payload: {
	jobId: string;
	action: AtlasAction;
	message: string;
	profile: AtlasProfile;
}) {
	if (isConversationReadOnlyForChat) return;
	// Issue 7.4 fix pass — this was a direct normalChatRuntime.send() caller
	// that bypassed MessageInput's send() entirely (found while centralizing
	// the cloud-warning gate; not one of the three previously-known leaks).
	const proceed = await ensureCloudWarningAcked();
	if (!proceed) return;
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

let initializedPendingWritesData = false;
let prevPendingWritesData: typeof data.pendingWrites;
$effect(() => {
	if (!initializedPendingWritesData) {
		prevPendingWritesData = data.pendingWrites;
		initializedPendingWritesData = true;
		return;
	}
	if (data.pendingWrites !== prevPendingWritesData) {
		prevPendingWritesData = data.pendingWrites;
		pendingWrites = [...(data.pendingWrites ?? [])];
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
						// Only fields the answer actually carries: an answer can
						// hold a citation audit with no evidence summary (the
						// audit is persisted when the message is created, the
						// summary is composed afterwards), and applying that must
						// not clear a summary the message already shows.
						...(result.evidenceSummary !== undefined
							? { evidenceSummary: result.evidenceSummary }
							: {}),
						// Workspaces Slice E — the Info popover's "Project files"
						// row reads this count, and the poll is the only live
						// channel that carries it: the terminal stream frame is
						// sent before the server composes the evidence, and a
						// conversation-detail hydration is skipped on a normal
						// turn because that frame already carries its own
						// projection fields. The count is written with the
						// evidence and read back with it, so it arrives here.
						...(result.projectFilesRead !== undefined
							? { projectFilesRead: result.projectFilesRead }
							: {}),
						// The Info popover's "Citation audit" row: also
						// persisted-only, and older than the evidence — the turn
						// writes it when the message is created, so it arrives on
						// this answer whatever the evidence step found.
						...(result.citationAudit !== undefined
							? { citationAudit: result.citationAudit }
							: {}),
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

// Instruction suggestions (Workspace Slice F). Dismiss records the answer
// straight away; Review opens the shared dialog on the offered scope and
// records it only after the save went through — an offer the user answered
// with a save that failed stays pending, and never claims to have been
// accepted. The offered text is passed through untouched: the row is what the
// model wrote, not a paraphrase of it.
function setInstructionSuggestionActionState(
	suggestionId: string,
	state: { busy?: boolean; error?: string | null },
) {
	instructionSuggestionActionState = {
		...instructionSuggestionActionState,
		[suggestionId]: state,
	};
}

async function answerInstructionSuggestion(params: {
	messageId: string;
	suggestionId: string;
	status: "reviewed" | "dismissed";
	failureKey: I18nKey;
}) {
	setInstructionSuggestionActionState(params.suggestionId, {
		busy: true,
		error: null,
	});
	try {
		const suggestion = await updateInstructionSuggestionStatus(
			data.conversation.id,
			{
				messageId: params.messageId,
				suggestionId: params.suggestionId,
				status: params.status,
			},
		);
		messages.update((list) =>
			patchInstructionSuggestionInMessageList(list, {
				messageId: params.messageId,
				suggestion,
			}),
		);
		setInstructionSuggestionActionState(params.suggestionId, {
			busy: false,
			error: null,
		});
	} catch {
		// The row keeps the offer on screen with the failure under it: the
		// answer may still be given, and losing the text would lose the only
		// copy of what the model suggested.
		setInstructionSuggestionActionState(params.suggestionId, {
			busy: false,
			error: get(t)(params.failureKey),
		});
	}
}

function handleDismissInstructionSuggestion(payload: {
	messageId: string;
	suggestion: InstructionSuggestion;
}) {
	return answerInstructionSuggestion({
		messageId: payload.messageId,
		suggestionId: payload.suggestion.id,
		status: "dismissed",
		failureKey: "instructions.suggestionDismissFailed",
	});
}

function handleReviewInstructionSuggestion(payload: {
	messageId: string;
	suggestion: InstructionSuggestion;
}) {
	const { messageId, suggestion } = payload;
	openInstructionDialog?.(suggestion.text, {
		scope: suggestion.scope,
		onSaved: () =>
			answerInstructionSuggestion({
				messageId,
				suggestionId: suggestion.id,
				status: "reviewed",
				failureKey: "instructions.suggestionReviewFailed",
			}),
	});
}

// Issue 7.5 — write-confirm card actions. Mirrors the skill-draft handlers
// above: {busy,error} is owned here (keyed by write id — write ids are
// globally unique, so no message-id compound key is needed the way skill
// drafts need `${messageId}:${draftId}`), and the source of truth for the
// card's rendered status is always `pendingWrites` (refreshed from the
// server after every confirm/cancel — including on failure, since a 409
// "already_executed"/"cancelled" means the row's true state moved even
// though THIS call didn't do it, and the card must reflect that rather
// than get stuck showing a stale "still pending" view under an error).
function setWriteActionState(
	writeId: string,
	state: { busy?: boolean; error?: string | null },
) {
	writeActionState = { ...writeActionState, [writeId]: state };
}

async function handleConfirmWrite(writeId: string) {
	setWriteActionState(writeId, { busy: true, error: null });
	try {
		await confirmWriteRequest(writeId);
		setWriteActionState(writeId, { busy: false, error: null });
	} catch (error) {
		// A 409 "expired" is not an error the user can do anything about, and
		// it is not a failure either: the proposal simply went stale, and the
		// refresh below is about to repaint the card into its expired state,
		// which already says so and names the move ("ask again"). Laying a red
		// "Failed to confirm the write." over that would be the third piece of
		// chrome telling the same story, in the wrong register.
		const expired =
			error instanceof ApiError &&
			error.status === 409 &&
			error.message === "expired";
		setWriteActionState(writeId, {
			busy: false,
			error: expired ? null : get(t)("connections.writeConfirm.confirmError"),
		});
	} finally {
		await refreshPendingWrites();
	}
}

async function handleCancelWrite(writeId: string) {
	setWriteActionState(writeId, { busy: true, error: null });
	try {
		await cancelWriteRequest(writeId);
		setWriteActionState(writeId, { busy: false, error: null });
	} catch {
		setWriteActionState(writeId, {
			busy: false,
			error: get(t)("connections.writeConfirm.cancelError"),
		});
	} finally {
		await refreshPendingWrites();
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
			result.conversation.memoryIncognito ?? false,
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
	// Regenerate only — the replaced assistant message's `userIntent`, carried
	// onto the optimistic placeholder so its provenance chip does not blink off
	// and back on. See SendRuntimeOptions.retryUserIntent.
	retryUserIntent?: MessageUserIntent,
	// Regenerate only — "answer_now" when "Answer now" drives it, so the server
	// does not count it as a regenerate. See SendRuntimeOptions.retryOrigin.
	retryOrigin?: "regenerate" | "answer_now",
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
		retryUserIntent,
		retryOrigin,
		confirmForkedSourceHistoryMutation,
		onForkedSourceHistoryConfirmationRequired,
	});
}

async function handleRetry() {
	// Issue 7.4 fix pass — retry() is a runtime path entirely separate from
	// handleSend/normalChatRuntime.send() (it replays the last user message
	// via its own startStream call), so it never went through MessageInput's
	// send() and, before this pass, never went through any cloud-warning
	// check at all.
	const proceed = await ensureCloudWarningAcked();
	if (!proceed) return;
	normalChatRuntime.retry();
}

// "Answer now" — polls the runtime's own `isSending` snapshot (updated
// synchronously by applyNormalChatRuntimeSnapshot whenever the runtime's
// internal state actually changes) rather than assuming the abort triggered
// by normalChatRuntime.stop() has settled by the time this call returns:
// stop() only requests the abort (AbortController.abort()) — the runtime's
// completeTurn()/isSending=false only runs once the aborted fetch's reader
// promise actually rejects, which is a real (if usually fast) async hop, not
// something the caller can assume finished in the same tick. Bounded so a
// pathological stall degrades to "give up and let the caller's own isSending
// guard reject the regenerate" rather than hanging forever.
function waitForRuntimeIdle(timeoutMs = 4000): Promise<void> {
	if (!isSending) return Promise.resolve();
	return new Promise((resolve) => {
		const start = Date.now();
		const interval = setInterval(() => {
			if (!isSending || Date.now() - start >= timeoutMs) {
				clearInterval(interval);
				resolve();
			}
		}, 20);
	});
}

async function handleRegenerate(
	payload: MessageRegeneratePayload,
	confirmForkedSourceHistoryMutation = false,
) {
	if (isConversationReadOnlyForChat || isEditResendPending) return;
	if (isSending) {
		// Only the "Answer now" quick-answer button (ThinkingBlock's header,
		// wired through MessageBubble's existing onRegenerate prop — see
		// MessageBubble.svelte) may regenerate while a turn is still
		// in flight: it targets the very message that is currently streaming,
		// interrupting it first (the same stop() the Stop button uses) and
		// then regenerating in quick mode. Every other regenerate call site
		// (the toolbar button) never sets reasoningDepthOverride and keeps the
		// pre-existing "never regenerate mid-stream" guard unchanged.
		if (!payload.reasoningDepthOverride) return;
		normalChatRuntime.stop();
		await waitForRuntimeIdle();
		if (isSending || isEditResendPending) return;
	}
	// Issue 7.4 fix pass — gate BEFORE any optimistic mutation (removing the
	// assistant message from $messages below), so a cancelled regenerate
	// leaves the timeline untouched rather than showing a response already
	// removed while the user is still deciding. handleSend() itself is NOT
	// gated a second time below — it's already covered by this check, and
	// re-running it would risk a second round-trip re-showing the modal
	// (e.g. after "Turn on local mode", which doesn't ack — see
	// shouldWarnCloudConnector) for a single regenerate action.
	const proceed = await ensureCloudWarningAcked();
	if (!proceed) return;
	const { messageId, reasoningDepthOverride } = payload;
	const msgs = $messages;
	// A still-streaming assistant message is keyed by the CLIENT placeholder
	// id the runtime minted for it; a stopped turn is persisted server-side
	// and its terminal frame carries the real assistantMessageId, which
	// finalizeStreamingMessageList swaps in (keeping `renderKey` pinned to
	// the placeholder id). "Answer now" captures the id at click time, so by
	// the time the stop above has settled, `messageId` may only match the
	// finalized message's renderKey — match either, or the whole action
	// silently no-ops.
	const assistantIdx = msgs.findIndex(
		(m) => m.id === messageId || m.renderKey === messageId,
	);
	if (assistantIdx === -1) return;
	const assistantMessageId = msgs[assistantIdx].id;
	// Captured before the slice below removes this message from the timeline.
	const assistantUserIntent = msgs[assistantIdx].userIntent;
	const hasKnownForks = hasForkedAssistantInRange(msgs, assistantIdx);
	if (
		hasKnownForks &&
		!confirmForkedSourceHistoryMutation &&
		!window.confirm(get(t)("fork.regenerateWarning"))
	) {
		return;
	}

	// B1 — regenerating a non-latest assistant message silently discarded
	// every later turn. Warn before that destructive slice, unless the fork
	// guard above already covered this range: a fork in range implies later
	// turns exist, so one confirmation suffices (no double-prompt).
	if (
		!hasKnownForks &&
		!confirmForkedSourceHistoryMutation &&
		regenerateDropsLaterTurns(msgs, assistantIdx) &&
		!window.confirm(
			get(t)("chat.regenerateLaterTurnsWarning", {
				count: laterTurnCount(msgs, assistantIdx),
			}),
		)
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
			// "Answer now" — this turn only; the user's own reasoning-depth
			// toggle (adapters.getReasoningDepth()) is never touched. Undefined
			// for every other regenerate path, which keeps the user's depth.
			reasoningDepth: reasoningDepthOverride,
		},
		true,
		true,
		true,
		assistantMessageId,
		msgs[userIdx].id,
		confirmForkedSourceHistoryMutation || hasKnownForks,
		() => {
			messages.set(msgs);
			if (window.confirm(get(t)("fork.regenerateWarning"))) {
				handleRegenerate(payload, true);
			}
		},
		assistantUserIntent,
		// Only "Answer now" sets reasoningDepthOverride (see the isSending
		// guard above); it is already recorded as its own answer_now event.
		reasoningDepthOverride ? "answer_now" : "regenerate",
	);
}

async function handleEdit(
	payload: MessageEditPayload,
	confirmForkedSourceHistoryMutation = false,
) {
	if (isConversationReadOnlyForChat || isSending || isEditResendPending) return;
	// Issue 7.4 fix pass — gate BEFORE deleting the edited-and-onward messages
	// below, so a cancelled edit leaves the conversation untouched. handleSend()
	// at the end of this function is intentionally NOT gated again — see the
	// matching note in handleRegenerate.
	const proceed = await ensureCloudWarningAcked();
	if (!proceed) return;
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
		// Gap 2 — server-side telemetry signal only (activity_events
		// "edit_resend"); does not change how this turn is otherwise sent.
		isEditResend: true,
	});
}

// Async so callers that must not race the dying turn can await it — the
// composer's `/new` awaits this before navigating away. The Stop button and
// the composer's own Stop control ignore the promise, exactly as before.
async function handleStop() {
	normalChatRuntime.stop();
	await waitForRuntimeIdle();
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

// Issue 7.4 — this queues `payload` while a previous turn is still
// streaming; it is drained later by `normalChatRuntime.drainPostTurnQueue()`
// (see normal-chat-client-turn-runtime.ts), which calls the runtime's own
// internal `send()` directly once the active turn finishes — NOT through
// this page's `handleSend`/`ensureCloudWarningAcked`. This is an
// INTENTIONAL, currently-unfixed gap in the Option-C cloud-warning gate:
// routing a mid-stream queue-drain through a blocking modal would be
// confusing UX (the warning would pop up mid-generation, disconnected from
// any user action), so it was explicitly left out of scope rather than
// papered over. It is the only remaining un-gated send path — every other
// send-to-model path (composer send, queued-after-attachment-upload,
// regenerate, edit, retry, Atlas lifecycle actions, and the landing-page
// bootstrap send) funnels through `ensureCloudWarningAcked()`.
function handleQueue(payload: SendPayload) {
	normalChatRuntime.queue(payload);
}

// Owner idea (variant A) — a follow-up chip click sends its text as the next
// user message "through the normal send path (respecting the queue/
// generating state)": mirrors MessageInput's own send()/queue() split
// (isGenerating decides which) rather than introducing a third path. Only
// ever called for the LATEST assistant message's chips (MessageBubble's own
// `isLast` gate), so there is no later turn to warn about, unlike
// handleRegenerate.
function handleSendFollowUp(payload: { text: string }) {
	if (isConversationReadOnlyForChat) return;
	const text = payload.text.trim();
	if (!text) return;
	const minimalPayload: SendPayload = {
		message: text,
		attachmentIds: [],
		attachments: [],
		pendingAttachments: [],
	};
	if (isSending) {
		handleQueue(minimalPayload);
		return;
	}
	void handleSend(minimalPayload);
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
	| {
			success: true;
			/**
			 * The upload's extraction job rides INSIDE the attachment, on
			 * `PendingAttachment.extraction`. It used to travel beside it only
			 * because that field did not exist when this page was written. An
			 * older server response simply has none, and the composer chip then
			 * looks exactly as it did before the ledger existed.
			 */
			attachment: import("$lib/server/services/knowledge/types").PendingAttachment;
	  }
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
					// The code beside the sentence is what the composer renders,
					// so a Hungarian user reads Hungarian. The sentence stays for
					// a build whose server has not shipped the codes yet.
					readinessErrorCode: isAttachmentReadinessReason(
						result.readinessErrorCode,
					)
						? result.readinessErrorCode
						: null,
					extraction: extractionFromUploadResponse(result) ?? undefined,
				},
			};
		}
		return {
			success: false,
			fileName: file.name,
			error: $t("knowledge.uploadFailedFallback"),
		};
	} catch (err) {
		// A refused type answers with an i18n key; the `error` string beside it
		// is English whatever the user's language is.
		const refusal = uploadRefusalFromError(err, file);
		return {
			success: false,
			fileName: file.name,
			error: refusal
				? $t(refusal.key, refusal.params)
				: err instanceof Error
					? err.message
					: $t("knowledge.uploadFailedFallback"),
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
	aria-label={$t('chat.pageRegionLabel')}
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<DropZoneOverlay active={fileDragActive} rejected={fileDragRejected} />
	<div
		class="chat-stage relative flex min-h-0 flex-1 overflow-hidden rounded-lg"
		class:chat-stage-workspace-open={workspaceOpen && workspaceDocuments.length > 0}
		class:stage--incognito={data.conversation.memoryIncognito}
	>
		<div class="chat-main relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div class="chat-title-bar hidden h-10 shrink-0 items-center justify-center border-b border-border px-6 lg:flex">
				<!-- Leading spacer: equal flex-basis to the trailing actions column
				     keeps the title visually centred whether or not the count
				     button is drawn, instead of the title drifting sideways. -->
				<div class="chat-title-bar-side" aria-hidden="true"></div>
				<h1
					class="flex min-w-0 max-w-[min(42rem,72vw)] items-baseline justify-center text-center text-[13px] font-medium leading-5 text-text-primary"
					title={activeProjectName
						? `${activeProjectName} / ${effectiveConversationTitle}`
						: effectiveConversationTitle}
					aria-live="polite"
				>
					{#if activeProjectName}
						<!-- The project segment is the way back to the project's own
						     page, where its instructions and its chat list live. The
						     name is the visible text; the accessible name says it is a
						     door, for the same reason the sidebar's button does. -->
						<a
							class="chat-title-project truncate"
							href={`/projects/${activeProjectId}`}
							data-testid="chat-title-project-link"
							aria-label={$t('projects.openA11y', { name: activeProjectName })}
						>{activeProjectName}</a>
						<span class="chat-title-sep" aria-hidden="true">/</span>
					{/if}
					<span class="chat-title-main truncate">
						<ConversationTitleText title={effectiveConversationTitle} />
					</span>
				</h1>
				<div class="chat-title-bar-side chat-title-bar-actions">
					{#if artifactCount > 0}
						<button
							bind:this={artifactCountButtonEl}
							type="button"
							class="artifact-count-button"
							data-testid="artifact-count-button"
							aria-label={$t('artifacts.header.buttonA11y', { count: artifactCount })}
							aria-pressed={artifactListOpen}
							onclick={openArtifactList}
						>
							<LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
							<b>{artifactCount}</b>
						</button>
					{/if}
				</div>
			</div>

			<!-- The title bar above is `hidden … lg:flex`; below `lg` this compact
			     row carries the same button, right-aligned, with no title (the app
			     shell's own Header already shows the conversation title on small
			     screens). A distinct test id avoids a strict-mode collision with
			     the desktop button: both exist in the DOM at every width, CSS
			     alone decides which one is visible. -->
			{#if artifactCount > 0}
				<div class="chat-title-bar-compact flex items-center justify-end lg:hidden">
					<button
						bind:this={artifactCountButtonCompactEl}
						type="button"
						class="artifact-count-button"
						data-testid="artifact-count-button-compact"
						aria-label={$t('artifacts.header.buttonA11y', { count: artifactCount })}
						aria-pressed={artifactListOpen}
						onclick={openArtifactList}
					>
						<LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
						<b>{artifactCount}</b>
					</button>
				</div>
			{/if}

			<DegradedCapabilitiesBanner isAdmin={data.user?.role === 'admin'} />

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
						isIncognito={data.conversation.memoryIncognito ?? false}
						{isThinkingActive}
						{modelIcons}
						{fileProductionJobs}
						{atlasJobs}
						{pendingWrites}
						contextCompressionMarkers={contextCompressionMarkers}
						{forkOrigin}
						{forkOpening}
						{forkingMessageId}
						showingLinkedMessage={linkedMessageConversationId === data.conversation.id}
						readOnly={isConversationReadOnlyForChat}
						onOpenDocument={openWorkspaceDocument}
						onRegenerate={handleRegenerate}
						onSendFollowUp={handleSendFollowUp}
						onEdit={handleEdit}
						onFork={handleFork}
						{skillDraftActionState}
						onSaveSkillDraft={handleSaveSkillDraft}
						onDismissSkillDraft={handleDismissSkillDraft}
						{instructionSuggestionActionState}
						onReviewInstructionSuggestion={handleReviewInstructionSuggestion}
						onDismissInstructionSuggestion={handleDismissInstructionSuggestion}
						onRetryFileProductionJob={handleRetryFileProductionJob}
						onCancelFileProductionJob={handleCancelFileProductionJob}
						onDismissFileProductionJob={handleDismissFileProductionJob}
						onCancelAtlasJob={handleCancelAtlasJob}
						onAtlasLifecycleAction={handleAtlasLifecycleAction}
						{writeActionState}
						onConfirmWrite={handleConfirmWrite}
						onCancelWrite={handleCancelWrite}
					/>
				{/if}
			</div>

			<ChatComposerPanel
				{sendError}
				canRetry={normalChatRuntimeCanRetry}
				onRetry={handleRetry}
				onErrorClose={handleErrorClose}
				onSend={handleSend}
				onQueue={handleQueue}
				onStop={handleStop}
				onCompact={handleCompact}
				onDraftChange={handleDraftChange}
				onEditQueuedMessage={editQueuedTurn}
				onDeleteQueuedMessage={clearQueuedTurn}
				disabled={isConversationReadOnlyForChat || isEditResendPending}
				isGenerating={!isConversationReadOnlyForChat && (isSending || isEditResendPending)}
				canStopStreaming={!isConversationReadOnlyForChat && normalChatRuntimeCanStop}
				hasQueuedMessage={Boolean(queuedTurn)}
				queuedMessagePreview={queuedTurn?.message ?? ''}
				maxLength={data.maxMessageLength}
				conversationId={data.conversation.id}
				{contextStatus}
				{attachedArtifacts}
				{contextDebug}
				{totalCostUsd}
				{lastTurnCostUsd}
				{totalTokens}
				composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
				onInstructionCommand={(text) => openInstructionDialog?.(text)}
				{atlasAvailability}
				{personalityProfiles}
				{selectedPersonalityId}
				onPersonalityChange={setSelectedPersonalityId}
				onModelChange={setSelectedConversationModelId}
				reasoningDepth={$selectedReasoningDepth}
				onReasoningDepthChange={setSelectedReasoningDepth}
				memoryIncognito={data.conversation.memoryIncognito ?? false}
				onMemoryIncognitoChange={(value) =>
					updateConversationMemoryIncognitoLocal(data.conversation.id, value)}
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
				bind:activeCapabilities={composerActiveCapabilities}
				beforeSend={ensureCloudWarningAcked}
				checkingCloudWarning={cloudWarningChecking}
				onCapabilitiesReady={handleCapabilitiesReady}
			/>
		</div>

		<DocumentWorkspace
			open={workspaceOpen}
			presentation={workspacePresentation}
			{returnToDockedOnExpandedClose}
			documents={workspaceDocuments}
			availableDocuments={availableWorkspaceDocumentsWithArtifacts}
			activeDocumentId={activeWorkspaceDocumentId}
			conversationId={data.conversation.id}
			list={{
				open: artifactListOpen,
				items: artifactWorkspaceItems,
				title: $t('artifacts.panel.title'),
			}}
			onListOpenChange={(open) => {
				artifactListOpen = open;
			}}
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

	<!-- `/instruction` from this chat's composer: the shared dialog, scoped to
	     the project this conversation sits in (null for a loose chat, which
	     leaves the personal scope alone). -->
	<InstructionCommandDialog
		projectId={activeProjectId}
		onOpenReady={(openWith) => (openInstructionDialog = openWith)}
	/>

	{#if cloudWarningOpen}
		<CloudConnectorWarningModal
			cloudModelId={$selectedModel}
			onCancel={handleCloudWarningCancel}
			onContinue={handleCloudWarningContinue}
			onEnableLocalMode={handleCloudWarningEnableLocalMode}
		/>
	{/if}
</div>

<style>
	.chat-main {
		flex: 1 1 0%;
		min-width: 0;
	}

	.chat-messages {
		min-width: 0;
	}

	.chat-title-bar {
		background: color-mix(in srgb, var(--surface-page) 92%, transparent 8%);
	}

	/* Equal-width leading/trailing columns keep the centred title from
	   drifting when the count button is or is not drawn (Slice 0 Task S7). */
	.chat-title-bar-side {
		display: flex;
		flex: 1 1 0;
		min-width: 0;
	}

	.chat-title-bar-actions {
		justify-content: flex-end;
	}

	.chat-title-bar-compact {
		flex-shrink: 0;
		padding: var(--space-xs, 0.375rem) var(--space-sm, 0.625rem) 0;
	}

	.artifact-count-button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 28px;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		padding: 0 0.5rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.artifact-count-button:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.artifact-count-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring) inset;
	}

	.chat-title-bar-compact .artifact-count-button {
		min-width: 32px;
		height: 32px;
		justify-content: center;
	}

	/* Project breadcrumb: dimmed relative to the title so the title itself
	   still reads as the primary label. Capped narrower than the title so a
	   long project name can't crowd it out; the title gets the remaining
	   space and truncates on its own if still too tight. */
	.chat-title-project {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 9rem;
		color: var(--text-muted);
		text-decoration: none;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.chat-title-project:hover,
	.chat-title-project:focus-visible {
		color: var(--text-primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.chat-title-sep {
		flex-shrink: 0;
		margin: 0 0.4rem;
		color: var(--text-muted);
		opacity: 0.6;
	}

	.chat-title-main {
		flex: 1 1 auto;
		min-width: 3rem;
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
