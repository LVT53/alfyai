<script lang="ts">
import { onMount } from "svelte";
import {
	Bell,
	Plug,
	Plus,
	Send,
	Square,
	VenetianMask,
	X,
} from "@lucide/svelte";
import { goto } from "$app/navigation";
import { enableBrowserPushNotifications } from "$lib/client/api/browser-push";
import { fetchActiveCapabilities } from "$lib/client/api/connections";
import { setConversationMemoryIncognito } from "$lib/client/api/conversations";
import { fetchKnowledgeLibrary } from "$lib/client/api/knowledge";
import {
	linkedContextSourceArtifactIds,
	linkedContextSourcesOverlap,
} from "$lib/services/working-document-identity";
import {
	discoverSkills,
	type SkillDiscoverySummary,
} from "$lib/client/api/skills";
import {
	COMPOSER_COMMAND_VISIBLE_RESULT_LIMIT,
	STATIC_COMPOSER_COMMANDS,
	type ComposerCommandDefinition,
} from "$lib/composer-commands";
import { t, type I18nKey } from "$lib/i18n";
import { tokenizeTextLinks } from "$lib/services/linkify";
import { currentConversationId } from "$lib/stores/ui";
import {
	isTouchDevice,
	initViewportTracking,
	viewportStore,
} from "$lib/utils/viewport.svelte";
import ContextUsageRing from "./ContextUsageRing.svelte";
import ComposerToolsMenu from "./ComposerToolsMenu.svelte";
import FileAttachment from "./FileAttachment.svelte";
import LinkedDocumentPicker from "./LinkedDocumentPicker.svelte";
import LinkedSourceManager from "./LinkedSourceManager.svelte";
import {
	findActiveComposerCommandToken,
	replaceActiveComposerCommandToken,
	type ComposerCommandToken,
} from "./composer-command-parser";
import { browser } from "$app/environment";
import type {
	ArtifactSummary,
	AtlasAvailability,
	AtlasProfile,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	KnowledgeDocumentItem,
	LinkedContextSource,
	ModelId,
	PendingAttachment,
	PendingSkillSelection,
	ReasoningDepth,
} from "$lib/types";

type SendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	pendingAttachments: PendingAttachment[];
	conversationId: string | null;
	personalityProfileId?: string | null;
	reasoningDepth?: ReasoningDepth;
	linkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
	forceWebSearch?: boolean;
	// ADR 0044 Decision 1 — the composer's single per-conversation Connections
	// master toggle maps to this field: on sends the user's default-on
	// capability set, off sends []. Omitted (not just empty) when the user has
	// no available capabilities at all, so older-client fallback semantics on
	// the server (defaultOn) apply unchanged. The server's fail-closed
	// resolveActiveCapabilities intersect (served ∩ requested) is unchanged —
	// this client can only narrow to nothing, never grant something unowned.
	enabledConnectionCapabilities?: string[];
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	atlasAction?: "create";
	clientAtlasTurnId?: string | null;
};

type DraftPayload = {
	conversationId: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
};

let {
	disabled = false,
	maxLength = 10000,
	showSlashHintProp = true,
	isGenerating = false,
	canStopStreaming = undefined,
	conversationId = null,
	attachmentsEnabled = false,
	ensureConversation = null,
	contextStatus = null,
	attachedArtifacts = [],
	contextDebug = null,
	contextSources = null,
	draftText = "",
	draftAttachments = [],
	draftLinkedSources = [],
	draftPendingSkill = null,
	draftAtlasMode = false,
	draftAtlasProfile = null,
	draftClientAtlasTurnId = null,
	draftVersion = 0,
	onSend = undefined,
	onQueue = undefined,
	onStop = undefined,
	onEditQueuedMessage = undefined,
	onDeleteQueuedMessage = undefined,
	onCompact = undefined,
	onManageEvidence = undefined,
	hasQueuedMessage = false,
	queuedMessagePreview = "",
	onDraftChange = undefined,
	onUploadReady = undefined,
	onUploadFiles = undefined,
	totalCostUsd = 0,
	lastTurnCostUsd = 0,
	totalTokens = 0,
	personalityProfiles = [],
	selectedPersonalityId = null,
	onPersonalityChange = undefined,
	onModelChange = undefined,
	reasoningDepth = "auto",
	onReasoningDepthChange = undefined,
	composerCommandRegistryEnabled = false,
	atlasAvailability = null,
	memoryIncognito = false,
	onMemoryIncognitoChange = undefined,
	activeCapabilities = $bindable(new Set<string>()),
	beforeSend = undefined,
	checkingCloudWarning = false,
	onCapabilitiesReady = undefined,
}: {
	disabled?: boolean;
	maxLength?: number;
	/**
	 * Whether to render the one-time "Press / to start typing" coach hint.
	 * The landing hero composer hides it.
	 */
	showSlashHintProp?: boolean;
	isGenerating?: boolean;
	canStopStreaming?: boolean | undefined;
	conversationId?: string | null;
	attachmentsEnabled?: boolean;
	ensureConversation?: (() => Promise<string>) | null;
	contextStatus?: ConversationContextStatus | null;
	attachedArtifacts?: ArtifactSummary[];
	contextDebug?: ContextDebugState | null;
	contextSources?: ContextSourcesState | null;
	draftText?: string;
	draftAttachments?: PendingAttachment[];
	draftLinkedSources?: LinkedContextSource[];
	draftPendingSkill?: PendingSkillSelection | null;
	draftAtlasMode?: boolean;
	draftAtlasProfile?: AtlasProfile | null;
	draftClientAtlasTurnId?: string | null;
	draftVersion?: number;
	onSend?: ((payload: SendPayload) => void) | undefined;
	onQueue?: ((payload: SendPayload) => void) | undefined;
	onStop?: (() => void) | undefined;
	onEditQueuedMessage?: (() => void) | undefined;
	onDeleteQueuedMessage?: (() => void) | undefined;
	onCompact?: (() => void) | undefined;
	onManageEvidence?: (() => void) | undefined;
	hasQueuedMessage?: boolean;
	queuedMessagePreview?: string;
	onDraftChange?: ((payload: DraftPayload) => void) | undefined;
	onUploadReady?:
		| ((uploadFn: (files: FileList | null) => Promise<void>) => void)
		| undefined;
	onUploadFiles?:
		| ((payload: {
				files: File[];
				conversationId: string;
				done: (
					result:
						| { success: true; attachment: PendingAttachment }
						| { success: false; fileName: string; error: string },
				) => void;
		  }) => void)
		| undefined;
	totalCostUsd?: number;
	lastTurnCostUsd?: number;
	totalTokens?: number;
	personalityProfiles?: Array<{
		id: string;
		name: string;
		description: string;
	}>;
	selectedPersonalityId?: string | null;
	onPersonalityChange?: ((id: string | null) => void) | undefined;
	onModelChange?: ((modelId: ModelId) => void) | undefined;
	reasoningDepth?: ReasoningDepth;
	onReasoningDepthChange?: ((depth: ReasoningDepth) => void) | undefined;
	composerCommandRegistryEnabled?: boolean;
	atlasAvailability?: AtlasAvailability | null;
	/** Whether the current conversation is excluded from the memory pipeline. */
	memoryIncognito?: boolean;
	/** Emitted after a successful incognito toggle so parents can reconcile. */
	onMemoryIncognitoChange?: ((value: boolean) => void) | undefined;
	// Issue 7.4 fix pass — the composer's per-conversation active connection
	// capability set is bindable so the page (the single cloud-warning
	// chokepoint, see +page.svelte's ensureCloudWarningAcked) can read the
	// same set the Connections master toggle produced, for regenerate/edit/
	// retry gate checks that don't originate from a fresh composer send.
	activeCapabilities?: Set<string>;
	// Issue 7.4 fix pass — the page-owned gate check. When provided, every
	// dispatch (a fresh send AND a send queued behind an in-flight attachment
	// upload) awaits this before the composer clears itself, so the composer
	// can no longer dispatch to the model without the page's cloud-warning
	// check running first. Returning false aborts the send: the composer text
	// and attachments are left exactly as the user had them.
	beforeSend?: (() => Promise<boolean>) | undefined;
	// Mirrors the page's "checking" phase (the network round-trip only, not
	// the modal-open wait) purely so the composer can show the existing
	// "Checking privacy…" hint under Send — cosmetic, not part of the gate.
	checkingCloudWarning?: boolean;
	// Issue 7.4 race-fix follow-up — called once on mount (mirrors the
	// `onUploadReady` pattern below) with a stable `ensureCapabilitiesLoaded`
	// function. The page's `ensureCloudWarningAcked` awaits this BEFORE
	// reading `activeCapabilities` so a still-in-flight capability fetch can
	// never be silently read as "zero capabilities, no warning needed" — see
	// the matching comment on `ensureCloudWarningAcked` in +page.svelte for
	// the full race this closes (maybeSendPendingInitialMessage firing before
	// this component's own on-mount fetch resolves).
	onCapabilitiesReady?:
		| ((ensureLoaded: () => Promise<void>) => void)
		| undefined;
} = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);
let fileInput = $state<HTMLInputElement | null>(null);
let isHydrated = $state(false);
let message = $state("");
let pendingAttachments = $state<PendingAttachment[]>([]);
let selectedLinkedSources = $state<LinkedContextSource[]>([]);
let pendingSkill = $state<PendingSkillSelection | null>(null);
let uploadState = $state<"idle" | "uploading" | "preparing">("idle");
let attachmentError = $state("");
let documentPickerOpen = $state(false);
let sourceManagerOpen = $state(false);
let documentPickerInitialQuery = $state("");
let documentPickerDocuments = $state<KnowledgeDocumentItem[]>([]);
let documentPickerLoading = $state(false);
let documentPickerError = $state("");
let resolvedConversationId = $state<string | null>(null);
let showToolsMenu = $state(false);
let commandToken = $state<ComposerCommandToken | null>(null);
let commandTrayMounted = $state(false);
let commandTrayClosing = $state(false);
let dismissedCommandTokenKey = $state<string | null>(null);
let highlightedCommandIndex = $state(0);
let commandTrayMessage = $state("");
let skillDiscoveryQuery = $state("");
let skillDiscoveryResults = $state<SkillDiscoverySummary[]>([]);
let skillDiscoveryLoading = $state(false);
let skillDiscoveryRequestId = 0;
let toolsMenuInitialOpen = $state<"model" | "style" | "depth" | null>(null);
let forceWebSearch = $state(false);
// ADR 0044 Decision 1 — the composer's Connections master toggle.
// `availableCapabilities` (served) and `defaultOnCapabilities` come from a
// single fetch on mount. `connectionsEnabled` is the per-conversation
// on/off state the toggle button controls (default true, trust-the-
// assistant); `activeCapabilities` (bindable, see props above) is derived
// from it below: on -> defaultOnCapabilities, off -> empty set. This is the
// exact `enabledConnectionCapabilities` payload mapping the server side
// (resolveActiveCapabilities) expects — the server intersect stays
// unchanged, this client-side set can only narrow it.
let availableCapabilities = $state<string[]>([]);
let defaultOnCapabilities = $state<Set<string>>(new Set());
let connectionsEnabled = $state(true);
let connectionsSyncedConversationId = $state<string | null>(null);
// Issue 7.4 fix pass — the cloud-warning check/modal itself now lives at the
// page level (+page.svelte's ensureCloudWarningAcked), reached through the
// `beforeSend` prop, so that composer sends, queued-after-upload sends, AND
// regenerate/edit/retry (none of which touch this component) all funnel
// through the SAME single check. `sendPending` is purely local UI state: it
// is true for the whole window between calling `beforeSend()` and it
// resolving, so a double-Enter/double-click on THIS composer instance can't
// invoke `beforeSend()` a second time while the first call is outstanding.
let sendPending = $state(false);
let selectedAtlasProfile = $state<AtlasProfile | null>(null);
let clientAtlasTurnId = $state<string | null>(null);
let atlasPushStatus = $state<
	"idle" | "enabled" | "unavailable" | "denied" | "failed"
>("idle");
let queuedSendAfterProcessing = $state(false);
let linkHighlightScrollTop = $state(0);
let appliedDraftVersion = -1;
let lastEmittedDraftKey = "";
let ensureDraftConversationPromise: Promise<string> | null = null;
let draftEmissionVersion = 0;
let commandTrayCloseTimer: ReturnType<typeof setTimeout> | null = null;
let textareaValueSyncFrame: number | null = null;
const commandRowElements = new Map<string, HTMLElement>();
const COMMAND_TRAY_CLOSE_DURATION_MS = 150;

let isEmpty = $derived(message.trim().length === 0);
let isOverMaxLength = $derived(message.length > maxLength);
let isUploadingAttachment = $derived(uploadState !== "idle");
let isComposerDisabled = $derived(disabled || !isHydrated);
let pendingAttachmentArtifacts = $derived(
	pendingAttachments.map((attachment) => attachment.artifact),
);
let effectiveLinkedSources = $derived(
	dedupeLinkedSourcesByFamily(
		selectedLinkedSources.filter(
			(source) =>
				isPromptReadyLinkedSource(source) &&
				!sourceOverlapsPendingAttachments(source),
		),
	),
);
let hasUnreadyAttachment = $derived(
	pendingAttachments.some((attachment) => !attachment.promptReady),
);
let attachmentReadinessErrors = $derived(
	pendingAttachments.filter((attachment) => Boolean(attachment.readinessError)),
);

// Issue 7.4 fix pass — C1's guarantee (re-entrant send() must not dispatch
// while a gate check is outstanding) is now enforced via `sendPending`, which
// spans the whole `beforeSend()` await (the page's network round-trip AND,
// if it opens, the warning modal), so the Send button (and, via send()'s own
// guard below, the Enter-key path) stays disabled the whole time.
let canSend = $derived(canSubmitMessageText(message) && !sendPending);
// Reason the send button is disabled despite non-empty, non-overlength text
// (ADR-0043 Slice 10, Fix B). The blocking flags come from canSubmitMessageText,
// plus the Issue 7.4 cloud-warning gate (see canSend above).
let sendDisabledHint = $derived(
	!canSend && message.trim().length > 0 && !isOverMaxLength
		? sendPending && checkingCloudWarning
			? "checkingPrivacy"
			: isUploadingAttachment
				? "uploading"
				: hasUnreadyAttachment
					? "preparing"
					: null
		: null,
);
let canQueue = $derived(canSend && isGenerating && !hasQueuedMessage);
let canStop = $derived(isGenerating && (canStopStreaming ?? true));
let canAttach = $derived(
	attachmentsEnabled &&
		Boolean(resolvedConversationId || ensureConversation) &&
		!isUploadingAttachment,
);
let composerArtifacts = $derived(
	Array.from(
		new Map(
			[...attachedArtifacts, ...pendingAttachmentArtifacts].map((artifact) => [
				artifact.id,
				artifact,
			]),
		).values(),
	),
);
let commandTrayRows = $derived(getCommandTrayRows(commandToken));
let commandTokenKey = $derived(getCommandTokenKey(commandToken));
let commandTrayCanOpen = $derived(
	composerCommandRegistryEnabled &&
		Boolean(commandToken) &&
		commandTokenKey !== dismissedCommandTokenKey &&
		(commandTrayRows.length > 0 || commandToken?.prefix === "$"),
);
let showCommandTray = $derived(commandTrayMounted);
let commandTrayInteractive = $derived(
	commandTrayMounted && !commandTrayClosing && commandTrayCanOpen,
);
let visibleCommandTrayRows = $derived(
	commandTrayRows.slice(0, COMPOSER_COMMAND_VISIBLE_RESULT_LIMIT),
);
let activeCommandRow = $derived(
	visibleCommandTrayRows[highlightedCommandIndex] ?? null,
);
function asI18nKey(key: string): I18nKey {
	return key as I18nKey;
}

let activeCommandAnnouncement = $derived(
	activeCommandRow
		? $t("composerCommands.activeAnnouncement", {
				token: activeCommandRow.tokenLabel ?? activeCommandRow.token,
				label:
					activeCommandRow.label ?? $t(asI18nKey(activeCommandRow.labelKey)),
			})
		: "",
);
let composerTextSegments = $derived(tokenizeTextLinks(message));
let selectedAtlasProfileLabel = $derived(
	selectedAtlasProfile ? atlasProfileLabel(selectedAtlasProfile) : "",
);
// One-time "Press / to start typing" coach hint (ADR-0043 Slice 10, Fix C).
// Persists dismissal across sessions via localStorage; SSR-guarded.
const SLASH_SHORTCUT_HINT_KEY = "alfyai:composer:slashHintDismissed";
let slashHintDismissed = $state(false);
let isComposerFocused = $state(false);
let showSlashHint = $derived(
	showSlashHintProp && isHydrated && !slashHintDismissed && !isComposerFocused,
);

$effect(() => {
	resolvedConversationId = conversationId;
	if (!conversationId) {
		ensureDraftConversationPromise = null;
	}
});

// Per-conversation incognito toggle. `incognitoOn` mirrors the conversation's
// stored value but is held locally so it can be toggled mid-chat and, for a
// brand-new (unsaved) conversation, applied once the conversation exists.
let incognitoOn = $state(false);
let incognitoBusy = $state(false);
// Tracks the conversation id the current `incognitoOn` value has been synced
// with, so switching conversations re-reads the stored flag but in-chat toggles
// are not clobbered, and a pending local choice is persisted on creation.
let incognitoSyncedConversationId = $state<string | null>(null);

$effect(() => {
	// Reset the local flag to the stored value whenever the conversation the
	// composer is bound to changes (including the null → id creation step).
	const boundId = conversationId ?? null;
	if (incognitoSyncedConversationId === boundId) return;
	if (boundId === null) {
		incognitoSyncedConversationId = null;
		incognitoOn = memoryIncognito;
		return;
	}
	// A conversation just became available. If the user pre-set incognito on the
	// draft composer, persist that choice; otherwise adopt the stored value.
	if (
		incognitoSyncedConversationId === null &&
		incognitoOn &&
		!memoryIncognito
	) {
		incognitoSyncedConversationId = boundId;
		void persistIncognito(boundId, true);
		return;
	}
	incognitoSyncedConversationId = boundId;
	incognitoOn = memoryIncognito;
});

async function persistIncognito(id: string, value: boolean): Promise<boolean> {
	try {
		await setConversationMemoryIncognito(id, value);
		onMemoryIncognitoChange?.(value);
		return true;
	} catch {
		return false;
	}
}

async function toggleIncognito() {
	if (incognitoBusy) return;
	const next = !incognitoOn;
	incognitoOn = next;
	const id = conversationId ?? resolvedConversationId;
	if (!id) {
		// Brand-new conversation with no id yet: hold the choice locally; the
		// conversation-bound effect above persists it once the id exists.
		return;
	}
	incognitoBusy = true;
	const ok = await persistIncognito(id, next);
	if (!ok) incognitoOn = !next;
	incognitoBusy = false;
}

// ADR 0044 Decision 1 — loads the user's served/defaultOn connection
// capabilities once on mount. `served` (-> availableCapabilities) gates
// whether the Connections master toggle renders at all; `defaultOn` is what
// the toggle's ON payload sends. Fails closed to "no capabilities available"
// (toggle hidden, payload omits the field) on any error. The assignment to
// `activeCapabilities` here is synchronous (not left to the `$effect` below)
// so the page's `ensureCloudWarningAcked` race-fix — which awaits this same
// promise via `ensureCapabilitiesLoaded()` before reading
// `activeCapabilities` — always sees the final value the instant the promise
// resolves, with no microtask-ordering race against a reactive effect.
async function loadActiveCapabilities() {
	try {
		const result = await fetchActiveCapabilities();
		availableCapabilities = result.served;
		defaultOnCapabilities = new Set(result.defaultOn);
	} catch {
		availableCapabilities = [];
		defaultOnCapabilities = new Set();
	} finally {
		activeCapabilities = connectionsEnabled
			? new Set(defaultOnCapabilities)
			: new Set();
	}
}

// Issue 7.4 race-fix follow-up — caches the (possibly still in-flight)
// `loadActiveCapabilities()` promise and hands it to the page via
// `onCapabilitiesReady` (see prop doc above). Calling this more than once
// (e.g. the page awaiting it on every gated send) reuses the same
// promise rather than firing a redundant fetch — resolved instantly once
// the initial load has already completed.
let capabilitiesLoadPromise: Promise<void> | null = null;
function ensureCapabilitiesLoaded(): Promise<void> {
	if (!capabilitiesLoadPromise) {
		capabilitiesLoadPromise = loadActiveCapabilities();
	}
	return capabilitiesLoadPromise;
}

// Per-conversation Connections master toggle. The user's on/off choice is
// remembered per conversation (persisted in localStorage) so it survives
// model switches, the draft -> real conversation creation (null -> id), the
// post-send `/` -> `/chat/[id]` navigation remount, and reloads. Brand-new
// drafts default to on (trust-the-assistant). This supersedes ADR 0044
// Decision 1's original reset-per-conversation behavior, which flipped the
// toggle back on whenever the bound conversation id changed (e.g. on send or
// when a model switch created the draft conversation).
const CONNECTIONS_DISABLED_KEY_PREFIX = "alfyai:composer:connectionsDisabled:";

function readConnectionsDisabled(id: string): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(CONNECTIONS_DISABLED_KEY_PREFIX + id) === "1";
	} catch {
		return false;
	}
}

function persistConnectionsChoice(id: string, enabled: boolean): void {
	if (!browser) return;
	try {
		if (enabled) {
			localStorage.removeItem(CONNECTIONS_DISABLED_KEY_PREFIX + id);
		} else {
			localStorage.setItem(CONNECTIONS_DISABLED_KEY_PREFIX + id, "1");
		}
	} catch {
		/* storage unavailable — fall back to in-memory-only for this session */
	}
}

$effect(() => {
	const boundId = conversationId ?? null;
	if (connectionsSyncedConversationId === boundId) return;
	if (boundId === null) {
		// Back to a brand-new draft: default on.
		connectionsSyncedConversationId = null;
		connectionsEnabled = true;
		return;
	}
	const wasDraft = connectionsSyncedConversationId === null;
	connectionsSyncedConversationId = boundId;
	if (readConnectionsDisabled(boundId)) {
		// Existing conversation (or reload) with a remembered "off" choice.
		connectionsEnabled = false;
	} else if (wasDraft && !connectionsEnabled) {
		// A draft the user turned off just became a real conversation. Carry the
		// choice across creation and persist it so it survives the post-send
		// navigation remount instead of snapping back on.
		persistConnectionsChoice(boundId, false);
	} else {
		connectionsEnabled = true;
	}
});

// Derives the active capability set from the master toggle: on -> the
// default-on set, off -> empty. Also covers the initial load via
// `loadActiveCapabilities` above (redundant assignment there, kept for the
// race-safety note on that function).
$effect(() => {
	activeCapabilities = connectionsEnabled
		? new Set(defaultOnCapabilities)
		: new Set();
});

// Whether the user has any connected service. The composer toggle is always
// shown, but greyed/disabled (with a connect-in-settings tooltip) when false.
const hasConnections = $derived(availableCapabilities.length > 0);

function toggleConnections() {
	// No-op when the user has no connections yet — the button is shown but
	// disabled (greyed) with a tooltip pointing to settings.
	if (!hasConnections) return;
	connectionsEnabled = !connectionsEnabled;
	const id = conversationId ?? resolvedConversationId;
	if (id) {
		// Remember the choice for this conversation immediately. For a brand-new
		// draft (no id yet), the conversation-bound effect above persists it once
		// the conversation is created.
		persistConnectionsChoice(id, connectionsEnabled);
	}
}

$effect(() => {
	if (commandTrayCanOpen) {
		openCommandTray();
	}
});

$effect(() => {
	if (!showCommandTray) return;
	function handleDocumentKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		dismissCommandTray();
		requestAnimationFrame(() => textarea?.focus());
	}
	document.addEventListener("keydown", handleDocumentKeydown);
	return () => document.removeEventListener("keydown", handleDocumentKeydown);
});

$effect(() => {
	if (!commandTrayInteractive || !activeCommandRow) return;
	const activeCommandElement = commandRowElements.get(activeCommandRow.id);
	if (typeof activeCommandElement?.scrollIntoView !== "function") return;
	activeCommandElement.scrollIntoView({
		block: "nearest",
		inline: "nearest",
	});
});

$effect(() => {
	if (draftVersion === appliedDraftVersion) return;

	const shouldApplyDraft =
		appliedDraftVersion === -1 ||
		(draftVersion === 0 && draftText.trim().length > 0) ||
		(message.trim().length === 0 &&
			pendingAttachments.length === 0 &&
			selectedLinkedSources.length === 0 &&
			!pendingSkill &&
			draftText.trim().length > 0);
	appliedDraftVersion = draftVersion;

	if (shouldApplyDraft) {
		message = draftText;

		// Merge draftAttachments (override existing)
		const merged = new Map<string, PendingAttachment>();

		// Keep existing pendingAttachments
		for (const attachment of pendingAttachments) {
			merged.set(attachment.artifact.id, attachment);
		}

		// Override with draftAttachments
		for (const attachment of draftAttachments) {
			merged.set(attachment.artifact.id, attachment);
		}

		pendingAttachments = Array.from(merged.values());
		selectedLinkedSources = composerCommandRegistryEnabled
			? draftLinkedSources.map((source) => ({
					...source,
					familyArtifactIds: [...source.familyArtifactIds],
				}))
			: [];
		pendingSkill =
			composerCommandRegistryEnabled && draftPendingSkill
				? {
						id: draftPendingSkill.id,
						ownership: draftPendingSkill.ownership,
						skillKind: draftPendingSkill.skillKind,
						displayName: draftPendingSkill.displayName,
						baseSkillId: draftPendingSkill.baseSkillId ?? null,
						baseSkillDisplayName:
							draftPendingSkill.baseSkillDisplayName ?? null,
						unavailable: draftPendingSkill.unavailable === true,
					}
				: null;
		attachmentError = "";
		uploadState = "idle";
		queuedSendAfterProcessing = false;
		showToolsMenu = false;
		selectedAtlasProfile = draftAtlasMode
			? (draftAtlasProfile ?? "overview")
			: null;
		clientAtlasTurnId = selectedAtlasProfile
			? (draftClientAtlasTurnId ?? createClientAtlasTurnId())
			: null;
		closeCommandTray();
		lastEmittedDraftKey = "";
		draftEmissionVersion += 1;
		if (
			!composerCommandRegistryEnabled &&
			(draftLinkedSources.length > 0 || draftPendingSkill)
		) {
			void emitDraftChange(true);
		}
		adjustHeight();
	}
});

$effect(() => {
	if (composerCommandRegistryEnabled) return;
	if (selectedLinkedSources.length === 0 && !pendingSkill) return;
	selectedLinkedSources = [];
	pendingSkill = null;
	sourceManagerOpen = false;
	documentPickerOpen = false;
	draftEmissionVersion += 1;
	void emitDraftChange();
});

// Issue 7.4 fix pass — a send queued behind an in-flight attachment upload
// (see send()'s queuedSendAfterProcessing branch above) must go through the
// SAME gate (attemptDispatch → beforeSend) as a normal send once the
// attachment finishes and canSend flips true. This previously called onSend
// directly, bypassing the gate entirely — a second way (besides the
// double-Enter race fixed as C1) to dispatch a connector-enabled message to
// a cloud model with no warning.
$effect(() => {
	if (isGenerating || !queuedSendAfterProcessing || !canSend) return;
	queuedSendAfterProcessing = false;
	void attemptDispatch(message);
});

function isMobile(): boolean {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}
	return isTouchDevice();
}

let lastConversationId = "";

$effect(() => {
	const activeConversationId = $currentConversationId;

	if (
		!activeConversationId ||
		activeConversationId === lastConversationId ||
		!textarea
	) {
		return;
	}

	lastConversationId = activeConversationId;
	// Only clear if we actually switched conversations, not on initial load if it already has text.
	if (!message) {
		message = "";
		pendingAttachments = [];
		selectedLinkedSources = [];
		pendingSkill = null;
		attachmentError = "";
		uploadState = "idle";
		queuedSendAfterProcessing = false;
		showToolsMenu = false;
		selectedAtlasProfile = null;
		clientAtlasTurnId = null;
		closeCommandTray();
		lastEmittedDraftKey = "";
		draftEmissionVersion += 1;
		adjustHeight();
		if (!isMobile()) {
			setTimeout(() => textarea?.focus(), 0);
		}
	}
});

function adjustHeight() {
	if (!textarea) return;
	requestAnimationFrame(() => {
		if (!textarea) return;
		// Map the legacy `innerWidth < 768` rule onto the shared viewport tier.
		// "phone" (< 640) is the closest bucket; 768 sits inside the phone/tablet
		// transition but historically only sub-768 widths got the compact layout.
		const isMobileDevice = viewportStore.tier === "phone";
		const minHeight = isMobileDevice ? 72 : 88;
		textarea.style.height = `${minHeight}px`;
		const maxHeight = isMobileDevice ? 112 : 240;
		textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
	});
}

function syncTextareaValue(nextValue: string, emitWhenUnchanged = false) {
	const valueChanged = message !== nextValue;
	if (valueChanged) {
		message = nextValue;
		dismissedCommandTokenKey = null;
	}
	if (valueChanged || emitWhenUnchanged) {
		draftEmissionVersion += 1;
		adjustHeight();
		void emitDraftChange();
	}
}

function syncTextareaValueFromDom() {
	textareaValueSyncFrame = null;
	if (isComposerDisabled || !textarea) return;
	syncTextareaValue(textarea.value);
	updateCommandTrayFromTextarea();
}

function scheduleTextareaValueSync() {
	if (typeof window === "undefined") return;
	if (textareaValueSyncFrame !== null) {
		cancelAnimationFrame(textareaValueSyncFrame);
	}
	textareaValueSyncFrame = requestAnimationFrame(syncTextareaValueFromDom);
}

function handleInput(event: Event) {
	if (isComposerDisabled) return;
	const target = event.currentTarget as HTMLTextAreaElement;
	syncTextareaValue(target.value, true);
	updateCommandTrayFromText(
		target.value,
		target.selectionStart ?? target.value.length,
	);
}

function handleSelect() {
	syncTextareaValueFromDom();
}

function handleKeyup() {
	syncTextareaValueFromDom();
}

function handleTextareaScroll(event: Event) {
	linkHighlightScrollTop = (event.currentTarget as HTMLTextAreaElement)
		.scrollTop;
}

/**
 * Global `/` keyboard shortcut to focus the composer (ADR-0043 Slice 10, Fix C).
 *
 * Fires only when the key is the unmodified `/` (no ctrl/meta/alt), and the
 * active element is not already a text-entry surface (input/textarea/
 * contenteditable), so it never hijacks typing in another field. The textarea's
 * own `onkeydown` (`handleKeydown`) handles `/` typed inside the composer, and
 * that is a separate listener; this handler's guards prevent double-firing.
 */
function handleSlashShortcut(event: KeyboardEvent) {
	if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
		return;
	}
	const target = event.target as Element | null;
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	) {
		return;
	}
	event.preventDefault();
	textarea?.focus();
}

function handleTextareaFocus() {
	isComposerFocused = true;
	// First focus dismisses the one-time coach hint for good.
	dismissSlashHint();
}

function handleTextareaBlur() {
	isComposerFocused = false;
}

function dismissSlashHint() {
	if (slashHintDismissed) return;
	slashHintDismissed = true;
	if (browser) {
		try {
			localStorage.setItem(SLASH_SHORTCUT_HINT_KEY, "1");
		} catch {
			// Ignore storage errors (private mode / quota) — hint just won't persist.
		}
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (isComposerDisabled) return;
	if (event.isComposing) return;
	updateCommandTrayFromTextarea();
	if (showCommandTray && event.key === "Escape") {
		event.preventDefault();
		dismissCommandTray();
		return;
	}
	const interactiveCommandRows = getInteractiveCommandRows();
	const shouldSelectCommandWithKeyboard =
		(event.key === "Enter" || event.key === "Tab") && !event.shiftKey;
	if (shouldSelectCommandWithKeyboard && interactiveCommandRows.length > 0) {
		const rows = interactiveCommandRows;
		const row = rows[highlightedCommandIndex] ?? rows[0];
		if (row) {
			event.preventDefault();
			selectCommand(row);
			return;
		}
	}
	if (commandTrayInteractive) {
		if (event.key === "ArrowDown" && visibleCommandTrayRows.length > 0) {
			event.preventDefault();
			highlightedCommandIndex =
				(highlightedCommandIndex + 1) % visibleCommandTrayRows.length;
			return;
		}
		if (event.key === "ArrowUp" && visibleCommandTrayRows.length > 0) {
			event.preventDefault();
			highlightedCommandIndex =
				(highlightedCommandIndex - 1 + visibleCommandTrayRows.length) %
				visibleCommandTrayRows.length;
			return;
		}
	}
	if (
		event.key === "Enter" &&
		(event.metaKey || event.ctrlKey || !event.shiftKey)
	) {
		event.preventDefault();
		const currentTextareaValue = textarea?.value ?? message;
		if (textarea) {
			syncTextareaValue(currentTextareaValue);
			updateCommandTrayFromTextarea();
		}
		if (isGenerating) {
			queue(currentTextareaValue);
			return;
		}
		send(currentTextareaValue);
		return;
	}
	scheduleTextareaValueSync();
}

function getInteractiveCommandRows(): CommandTrayRow[] {
	if (
		!composerCommandRegistryEnabled ||
		!commandTrayMounted ||
		commandTrayClosing ||
		!commandToken ||
		getCommandTokenKey(commandToken) === dismissedCommandTokenKey
	) {
		return [];
	}
	return getCommandTrayRows(commandToken).slice(
		0,
		COMPOSER_COMMAND_VISIBLE_RESULT_LIMIT,
	);
}

function canSubmitMessageText(text: string): boolean {
	return (
		text.trim().length > 0 &&
		text.length <= maxLength &&
		!isUploadingAttachment &&
		!hasUnreadyAttachment
	);
}

function buildSendPayload(nextMessage = message): SendPayload {
	return {
		message: nextMessage.trim(),
		attachmentIds: pendingAttachments.map(
			(attachment) => attachment.artifact.id,
		),
		attachments: pendingAttachmentArtifacts,
		pendingAttachments: pendingAttachments.map((attachment) => ({
			...attachment,
		})),
		linkedSources: composerCommandRegistryEnabled
			? effectiveLinkedSources.map((source) => ({
					...source,
					familyArtifactIds: [...source.familyArtifactIds],
				}))
			: [],
		pendingSkill:
			composerCommandRegistryEnabled && !selectedAtlasProfile
				? pendingSkill
				: null,
		conversationId: resolvedConversationId,
		personalityProfileId: selectedPersonalityId,
		reasoningDepth,
		forceWebSearch: selectedAtlasProfile ? false : forceWebSearch,
		enabledConnectionCapabilities:
			availableCapabilities.length > 0 ? [...activeCapabilities] : undefined,
		atlasMode: Boolean(selectedAtlasProfile),
		atlasProfile: selectedAtlasProfile,
		atlasAction: "create",
		clientAtlasTurnId: selectedAtlasProfile
			? getOrCreateClientAtlasTurnId()
			: null,
	};
}

function clearComposerAfterSubmit() {
	message = "";
	pendingAttachments = [];
	selectedLinkedSources = [];
	pendingSkill = null;
	attachmentError = "";
	queuedSendAfterProcessing = false;
	showToolsMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	documentPickerOpen = false;
	forceWebSearch = false;
	selectedAtlasProfile = null;
	clientAtlasTurnId = null;
	lastEmittedDraftKey = "";
	draftEmissionVersion += 1;
	void emitDraftChange(true);
	adjustHeight();
	if (!isMobile()) {
		textarea?.focus();
	} else {
		textarea?.blur();
	}
}

function dispatchSend(nextMessage: string) {
	message = nextMessage;
	onSend?.(buildSendPayload(nextMessage));
	queuedSendAfterProcessing = false;
	clearComposerAfterSubmit();
}

// Issue 7.4 fix pass — the single gated entry point for actually handing a
// message to onSend. Both send()'s normal path and the queued-send effect
// (fired once an in-flight attachment upload finishes) go through this, and
// both await the page-owned `beforeSend` gate (see the prop doc above) before
// dispatching — so neither can hand a message to onSend without the page's
// cloud-warning check running first. `sendPending` spans the whole await so
// a double-Enter/double-click on this composer while the gate is pending is
// a no-op (see send()'s own guard below), and the composer is NOT cleared
// unless beforeSend resolves truthy — a `false` (cancelled) leaves the text
// and attachments exactly as the user had them.
async function attemptDispatch(nextMessage: string) {
	if (!beforeSend) {
		dispatchSend(nextMessage);
		return;
	}
	sendPending = true;
	try {
		const proceed = await beforeSend();
		if (!proceed) return;
		dispatchSend(nextMessage);
	} finally {
		sendPending = false;
	}
}

function send(nextMessage: string = message) {
	if (isComposerDisabled) return;
	if (isGenerating) return;
	// Issue 7.4 fix pass — C1: while the page-owned gate is pending (either
	// its network check or the warning modal awaiting the user's choice), a
	// re-entrant send() (double Enter, double click) MUST be a no-op rather
	// than falling through to attemptDispatch below — see `sendPending`'s
	// doc above. This guard must run before the canSubmitMessageText early
	// return too, since the pending message may differ from `message`.
	if (sendPending) return;
	if (!canSubmitMessageText(nextMessage)) {
		if (
			nextMessage.trim().length > 0 &&
			nextMessage.length <= maxLength &&
			(isUploadingAttachment || hasUnreadyAttachment)
		) {
			queuedSendAfterProcessing = true;
		}
		return;
	}

	void attemptDispatch(nextMessage);
}

function queue(nextMessage: string = message) {
	if (isComposerDisabled) return;
	if (!isGenerating || hasQueuedMessage || !canSubmitMessageText(nextMessage)) {
		return;
	}
	message = nextMessage;
	onQueue?.(buildSendPayload(nextMessage));
	queuedSendAfterProcessing = false;
	clearComposerAfterSubmit();
}

function stop() {
	if (isComposerDisabled) return;
	if (!canStop) return;
	onStop?.();
	showToolsMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	if (isMobile()) {
		textarea?.blur();
	}
}

onMount(() => {
	isHydrated = true;
	if (browser) {
		try {
			if (localStorage.getItem(SLASH_SHORTCUT_HINT_KEY) === "1") {
				slashHintDismissed = true;
			}
		} catch {
			// Ignore storage errors — hint will just show again next session.
		}
	}
	initViewportTracking();
	if (textarea) {
		if (!isMobile()) {
			textarea.focus();
		}
		adjustHeight();
	}
	syncTextareaValueFromDom();
	window.addEventListener("resize", adjustHeight);
	onUploadReady?.(uploadFiles);
	onCapabilitiesReady?.(ensureCapabilitiesLoaded);
	void ensureCapabilitiesLoaded();
	return () => {
		window.removeEventListener("resize", adjustHeight);
		if (textareaValueSyncFrame !== null) {
			cancelAnimationFrame(textareaValueSyncFrame);
		}
	};
});

function openFilePicker() {
	if (!canAttach) return;
	showToolsMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	fileInput?.click();
}

function toggleToolsMenu() {
	showToolsMenu = !showToolsMenu;
	if (showToolsMenu) {
		sourceManagerOpen = false;
		closeCommandTray();
	}
	toolsMenuInitialOpen = null;
}

function closeToolsMenu() {
	showToolsMenu = false;
	toolsMenuInitialOpen = null;
}

function openSourceManager() {
	sourceManagerOpen = true;
	showToolsMenu = false;
	closeCommandTray();
}

function closeSourceManager() {
	sourceManagerOpen = false;
	requestAnimationFrame(() => textarea?.focus());
}

function setForceWebSearch(enabled: boolean) {
	forceWebSearch = enabled;
}

function atlasProfileLabel(profile: AtlasProfile): string {
	if (profile === "exhaustive") return $t("composerTools.atlasExhaustive");
	if (profile === "in-depth") return $t("composerTools.atlasInDepth");
	return $t("composerTools.atlasOverview");
}

function setAtlasProfile(profile: AtlasProfile) {
	selectedAtlasProfile = profile;
	clientAtlasTurnId ??= createClientAtlasTurnId();
	pendingSkill = null;
	draftEmissionVersion += 1;
	void emitDraftChange();
}

function removeAtlasProfile() {
	selectedAtlasProfile = null;
	clientAtlasTurnId = null;
	draftEmissionVersion += 1;
	void emitDraftChange();
}

async function enableAtlasPushNotifications() {
	const result = await enableBrowserPushNotifications().catch(() => ({
		ok: false as const,
		reason: "service_worker_failed" as const,
	}));
	if (result.ok) {
		atlasPushStatus = "enabled";
		return;
	}
	if (result.reason === "permission_denied") {
		atlasPushStatus = "denied";
		return;
	}
	if (
		result.reason === "missing_vapid_keys" ||
		result.reason === "unsupported"
	) {
		atlasPushStatus = "unavailable";
		return;
	}
	atlasPushStatus = "failed";
}

function atlasPushStatusLabel(): string {
	if (atlasPushStatus === "enabled") return $t("browserPush.enabled");
	if (atlasPushStatus === "denied") return $t("browserPush.denied");
	if (atlasPushStatus === "unavailable") return $t("browserPush.unavailable");
	if (atlasPushStatus === "failed") return $t("browserPush.failed");
	return "";
}

function createClientAtlasTurnId(): string {
	const random =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `atlas-${random}`;
}

function getOrCreateClientAtlasTurnId(): string {
	clientAtlasTurnId ??= createClientAtlasTurnId();
	return clientAtlasTurnId;
}

function commandRowRef(node: HTMLElement, id: string) {
	commandRowElements.set(id, node);
	return {
		update(nextId: string) {
			if (nextId === id) return;
			commandRowElements.delete(id);
			id = nextId;
			commandRowElements.set(id, node);
		},
		destroy() {
			commandRowElements.delete(id);
		},
	};
}

type CommandTrayRow = Omit<
	ComposerCommandDefinition,
	"id" | "labelKey" | "descriptionKey" | "token"
> & {
	id: string;
	token: ComposerCommandDefinition["token"] | "$";
	labelKey: I18nKey;
	descriptionKey: I18nKey;
	disabled: boolean;
	statusKey?: I18nKey;
	skill?: SkillDiscoverySummary;
	tokenLabel?: string;
	label?: string;
	description?: string;
};

function pendingSkillKindLabelKey(
	skill: Pick<PendingSkillSelection, "ownership" | "skillKind">,
) {
	if (skill.skillKind === "skill_variant") return "pendingSkill.variant";
	if (skill.skillKind === "skill_pack" || skill.ownership === "system")
		return "pendingSkill.pack";
	return "pendingSkill.user";
}

function skillDiscoveryDescription(skill: SkillDiscoverySummary): string {
	if (skill.skillKind === "skill_variant" && skill.baseSkillDisplayName) {
		return `${skill.description} · ${$t("pendingSkill.variantBasedOn", {
			name: skill.baseSkillDisplayName,
		})}`;
	}
	return skill.description;
}

function getCommandTokenKey(token: ComposerCommandToken | null): string | null {
	if (!token) return null;
	return `${token.prefix}:${token.start}:${token.end}:${token.token}`;
}

function getCommandTrayRows(
	token: ComposerCommandToken | null,
): CommandTrayRow[] {
	if (!composerCommandRegistryEnabled || !token) return [];
	if (token.prefix === "$") {
		return skillDiscoveryResults.map((skill) => ({
			id: `skill:${skill.id}`,
			token: "$",
			tokenLabel: $t(pendingSkillKindLabelKey(skill)),
			labelKey: "composerCommands.skillDiscovery.label" as I18nKey,
			descriptionKey: "composerCommands.skillDiscovery.description" as I18nKey,
			label: skill.displayName,
			description: skillDiscoveryDescription(skill),
			availability: "available",
			disabled: false,
			skill,
		}));
	}

	const query = token.query.toLowerCase();
	const commandQuery = query.startsWith("document ") ? "document" : query;
	return STATIC_COMPOSER_COMMANDS.filter(
		(command) => commandQuery === "" || command.id.startsWith(commandQuery),
	).map((command) => ({
		...command,
		labelKey: asI18nKey(command.labelKey),
		descriptionKey: asI18nKey(command.descriptionKey),
		disabled:
			command.availability !== "available" ||
			(command.id === "attach" && !canAttach),
		statusKey:
			command.availability !== "available"
				? "composerCommands.comingSoon"
				: command.id === "attach" && !canAttach
					? "composerCommands.unavailable"
					: undefined,
	}));
}

function findDocumentCommandTokenWithQuery(
	text: string,
	cursor: number,
): ComposerCommandToken | null {
	const safeCursor = Math.max(0, Math.min(cursor, text.length));
	const beforeCursor = text.slice(0, safeCursor);
	const match = /(^|\s)\/document(?:\s+([^\n\r]*))?$/.exec(beforeCursor);
	if (!match) return null;
	const start = match.index + match[1].length;
	const queryText = (match[2] ?? "").trim();
	return {
		prefix: "/",
		query: queryText ? `document ${queryText}` : "document",
		start,
		end: safeCursor,
		token: text.slice(start, safeCursor),
	};
}

function updateCommandTrayFromTextarea() {
	if (!composerCommandRegistryEnabled || !textarea) {
		closeCommandTray();
		return;
	}
	const text = textarea.value || message;
	const cursor =
		textarea.value === text
			? (textarea.selectionStart ?? text.length)
			: text.length;
	updateCommandTrayFromText(text, cursor);
}

function updateCommandTrayFromText(text: string, cursor: number) {
	if (!composerCommandRegistryEnabled) {
		closeCommandTray();
		return;
	}
	const nextToken =
		findDocumentCommandTokenWithQuery(text, cursor) ??
		findActiveComposerCommandToken(text, cursor);
	commandTrayMessage = "";
	if (!nextToken) {
		highlightedCommandIndex = 0;
		closeCommandTray();
		return;
	}
	commandToken = nextToken;
	const nextRows = getCommandTrayRows(nextToken);
	if (nextToken.prefix === "$") {
		void loadSkillDiscovery(nextToken.query);
	}
	if (
		getCommandTokenKey(nextToken) !== dismissedCommandTokenKey &&
		(nextRows.length > 0 || nextToken.prefix === "$")
	) {
		openCommandTray();
	}
	if (highlightedCommandIndex >= visibleCommandTrayRows.length) {
		highlightedCommandIndex = 0;
	}
}

async function loadSkillDiscovery(query: string) {
	const normalizedQuery = query.trim();
	if (
		normalizedQuery === skillDiscoveryQuery &&
		(skillDiscoveryLoading || skillDiscoveryResults.length > 0)
	) {
		return;
	}
	skillDiscoveryQuery = normalizedQuery;
	skillDiscoveryRequestId += 1;
	const requestId = skillDiscoveryRequestId;
	skillDiscoveryLoading = true;
	try {
		const skills = await discoverSkills(normalizedQuery);
		if (requestId !== skillDiscoveryRequestId) return;
		skillDiscoveryResults = skills;
	} catch {
		if (requestId !== skillDiscoveryRequestId) return;
		skillDiscoveryResults = [];
		commandTrayMessage = $t("pendingSkill.discoveryError");
	} finally {
		if (requestId === skillDiscoveryRequestId) {
			skillDiscoveryLoading = false;
		}
	}
}

function prefersReducedMotion(): boolean {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clearCommandTrayCloseTimer() {
	if (!commandTrayCloseTimer) return;
	clearTimeout(commandTrayCloseTimer);
	commandTrayCloseTimer = null;
}

function openCommandTray() {
	clearCommandTrayCloseTimer();
	commandTrayMounted = true;
	commandTrayClosing = false;
}

function finishCommandTrayClose() {
	clearCommandTrayCloseTimer();
	commandTrayMounted = false;
	commandTrayClosing = false;
	commandToken = null;
	highlightedCommandIndex = 0;
	commandTrayMessage = "";
	skillDiscoveryResults = [];
	skillDiscoveryQuery = "";
	skillDiscoveryLoading = false;
}

function closeCommandTray() {
	if (!commandTrayMounted) {
		finishCommandTrayClose();
		return;
	}
	if (commandTrayClosing) return;
	if (prefersReducedMotion()) {
		finishCommandTrayClose();
		return;
	}
	commandTrayClosing = true;
	commandTrayCloseTimer = setTimeout(
		finishCommandTrayClose,
		COMMAND_TRAY_CLOSE_DURATION_MS,
	);
}

function dismissCommandTray() {
	dismissedCommandTokenKey = commandTokenKey;
	closeCommandTray();
}

function handleCommandTrayAnimationEnd(event: AnimationEvent) {
	if (event.target !== event.currentTarget || !commandTrayClosing) return;
	finishCommandTrayClose();
}

function consumeActiveCommandToken(): boolean {
	if (!textarea) return false;
	const activeToken = commandToken;
	const result = getMessageWithoutActiveCommandToken(activeToken);
	if (!result) return false;
	message = result.text;
	draftEmissionVersion += 1;
	void emitDraftChange();
	adjustHeight();
	requestAnimationFrame(() => {
		textarea?.setSelectionRange(result.cursor, result.cursor);
		textarea?.focus();
	});
	return true;
}

function getMessageWithoutActiveCommandToken(
	activeToken = commandToken,
): { text: string; cursor: number } | null {
	if (activeToken) {
		return {
			text:
				message.slice(0, activeToken.start) + message.slice(activeToken.end),
			cursor: activeToken.start,
		};
	}
	return replaceActiveComposerCommandToken(
		message,
		textarea?.selectionStart ?? message.length,
		"",
	);
}

function hasClearableComposerState(nextMessage: string): boolean {
	return (
		nextMessage.trim().length > 0 ||
		pendingAttachments.length > 0 ||
		(composerCommandRegistryEnabled && effectiveLinkedSources.length > 0) ||
		(composerCommandRegistryEnabled && Boolean(pendingSkill))
	);
}

function confirmClearComposer(nextMessage: string): boolean {
	if (!hasClearableComposerState(nextMessage)) return true;
	if (typeof window === "undefined" || typeof window.confirm !== "function") {
		return true;
	}
	return window.confirm($t("composerCommands.clear.confirm"));
}

function selectSkill(skill: SkillDiscoverySummary) {
	const consumed = consumeActiveCommandToken();
	finishCommandTrayClose();
	if (!consumed) return;
	pendingSkill = {
		id: skill.id,
		ownership: skill.ownership,
		skillKind: skill.skillKind,
		displayName: skill.displayName,
		baseSkillId:
			skill.skillKind === "skill_variant" && "baseSkillId" in skill
				? skill.baseSkillId
				: null,
		baseSkillDisplayName:
			skill.skillKind === "skill_variant" && "baseSkillDisplayName" in skill
				? skill.baseSkillDisplayName
				: null,
	};
	draftEmissionVersion += 1;
	void emitDraftChange();
}

function openComposerTools(section: "model" | "style" | "depth") {
	toolsMenuInitialOpen = section;
	showToolsMenu = true;
}

function selectCommand(command: CommandTrayRow) {
	if (command.skill) {
		selectSkill(command.skill);
		return;
	}
	if (command.disabled) {
		commandTrayMessage = command.statusKey ? $t(command.statusKey) : "";
		return;
	}

	if (command.id === "clear") {
		const nextMessage = getMessageWithoutActiveCommandToken()?.text ?? message;
		if (!confirmClearComposer(nextMessage)) return;
		const consumed = consumeActiveCommandToken();
		finishCommandTrayClose();
		if (consumed) {
			clearComposerAfterSubmit();
		}
		return;
	}

	const documentQuery =
		command.id === "document" && commandToken?.query.startsWith("document ")
			? commandToken.query.slice("document ".length).trim()
			: "";
	const consumed = consumeActiveCommandToken();
	finishCommandTrayClose();
	if (!consumed) return;

	switch (command.id) {
		case "model":
			openComposerTools("model");
			break;
		case "style":
			openComposerTools("style");
			break;
		case "depth":
			openComposerTools("depth");
			break;
		case "attach":
			openFilePicker();
			break;
		case "document":
			openDocumentPicker(documentQuery);
			break;
		case "source":
			openSourceManager();
			break;
		case "settings":
			void goto("/settings");
			break;
		case "compact":
			onCompact?.();
			break;
		case "web":
			forceWebSearch = true;
			break;
		default:
			break;
	}
}

function closeCommandTrayOnOutsideInteraction(node: HTMLElement) {
	function handlePointerDown(event: PointerEvent) {
		if (!showCommandTray) return;
		const target = event.target;
		if (target instanceof Node && node.contains(target)) return;
		dismissCommandTray();
	}

	document.addEventListener("pointerdown", handlePointerDown, true);

	return {
		destroy() {
			document.removeEventListener("pointerdown", handlePointerDown, true);
		},
	};
}

function sourceOverlapsPendingAttachments(
	source: LinkedContextSource,
): boolean {
	const attachmentIds = new Set<string>();
	for (const attachment of pendingAttachments) {
		attachmentIds.add(attachment.artifact.id);
		if (attachment.promptArtifactId) {
			attachmentIds.add(attachment.promptArtifactId);
		}
	}
	if (attachmentIds.size === 0) return false;
	return linkedContextSourceArtifactIds(source).some((id) =>
		attachmentIds.has(id),
	);
}

function dedupeLinkedSourcesByFamily(
	sources: LinkedContextSource[],
): LinkedContextSource[] {
	const result: LinkedContextSource[] = [];
	for (const source of sources) {
		const canonical = {
			...source,
			familyArtifactIds: [...source.familyArtifactIds],
		};
		const existingIndex = result.findIndex((entry) =>
			linkedContextSourcesOverlap(entry, canonical),
		);
		if (existingIndex >= 0) {
			result[existingIndex] = canonical;
		} else {
			result.push(canonical);
		}
	}
	return result;
}

function isPromptReadyLinkedSource(source: LinkedContextSource): boolean {
	return (
		typeof source.promptArtifactId === "string" &&
		source.promptArtifactId.length > 0
	);
}

async function openDocumentPicker(initialQuery = "") {
	documentPickerOpen = true;
	documentPickerInitialQuery = initialQuery;
	showToolsMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	if (documentPickerDocuments.length > 0 || documentPickerLoading) return;
	documentPickerLoading = true;
	documentPickerError = "";
	try {
		const library = await fetchKnowledgeLibrary();
		documentPickerDocuments = library.documents;
	} catch {
		documentPickerError = $t("linkedSources.picker.error");
	} finally {
		documentPickerLoading = false;
	}
}

function closeDocumentPicker() {
	documentPickerOpen = false;
	requestAnimationFrame(() => textarea?.focus());
}

function applyLinkedSources(sources: LinkedContextSource[]) {
	selectedLinkedSources = dedupeLinkedSourcesByFamily(sources);
	documentPickerOpen = false;
	draftEmissionVersion += 1;
	void emitDraftChange();
	requestAnimationFrame(() => textarea?.focus());
}

function removeLinkedSource(displayArtifactId: string) {
	const target =
		effectiveLinkedSources.find(
			(source) => source.displayArtifactId === displayArtifactId,
		) ??
		selectedLinkedSources.find(
			(source) => source.displayArtifactId === displayArtifactId,
		);
	selectedLinkedSources = target
		? selectedLinkedSources.filter(
				(source) => !linkedContextSourcesOverlap(source, target),
			)
		: selectedLinkedSources.filter(
				(source) => source.displayArtifactId !== displayArtifactId,
			);
	draftEmissionVersion += 1;
	void emitDraftChange();
}

function clearLinkedSources() {
	selectedLinkedSources = [];
	draftEmissionVersion += 1;
	void emitDraftChange();
}

function removePendingSkill() {
	pendingSkill = null;
	draftEmissionVersion += 1;
	void emitDraftChange();
}

async function uploadFiles(files: FileList | null) {
	if (!files) return;
	const selectedFiles = Array.from(files);
	if (selectedFiles.length === 0) return;
	uploadState = "uploading";
	attachmentError = "";
	const failures: string[] = [];
	if (typeof window !== "undefined") {
		preparingTimer = window.setTimeout(() => {
			uploadState = "preparing";
		}, 900);
	}

	try {
		const MAX_FILE_SIZE = 100 * 1024 * 1024;
		for (const file of selectedFiles) {
			if (file.size > MAX_FILE_SIZE) {
				failures.push(
					`${file.name}: ${$t("chat.fileSizeExceeded", { size: (file.size / (1024 * 1024)).toFixed(0), max: 100 })}`,
				);
			}
		}

		const validFiles = selectedFiles.filter(
			(file) => file.size <= MAX_FILE_SIZE,
		);

		// Show size-check failures immediately for oversized files
		if (failures.length > 0) {
			if (validFiles.length === 0) {
				throw new Error($t("chat.allFilesTooLarge", { max: 100 }));
			}
			attachmentError = $t("chat.uploadSomeFailed", { count: failures.length });
		}

		let targetConversationId = resolvedConversationId;
		if (!targetConversationId && ensureConversation) {
			targetConversationId = await ensureConversation();
			resolvedConversationId = targetConversationId;
		}
		if (!targetConversationId) {
			if (preparingTimer) {
				clearTimeout(preparingTimer);
			}
			uploadState = "idle";
			throw new Error($t("chat.uploadError"));
		}

		pendingUploadCount = validFiles.length;
		onUploadFiles?.({
			files: validFiles,
			conversationId: targetConversationId,
			done: addUploadedAttachment,
		});
	} catch (error) {
		if (preparingTimer) {
			clearTimeout(preparingTimer);
			preparingTimer = null;
		}
		uploadState = "idle";
		if (fileInput) fileInput.value = "";
		attachmentError =
			error instanceof Error
				? error.message
				: $t("chat.uploadAttachmentFailed");
	}
}

let pendingUploadCount = $state(0);
let preparingTimer = $state<number | null>(null);

function addUploadedAttachment(
	result:
		| { success: true; attachment: PendingAttachment }
		| { success: false; fileName: string; error: string },
) {
	if (result.success) {
		const next = new Map(
			pendingAttachments.map((attachment) => [
				attachment.artifact.id,
				attachment,
			]),
		);
		next.set(result.attachment.artifact.id, result.attachment);
		pendingAttachments = Array.from(next.values());
		draftEmissionVersion += 1;
		void emitDraftChange();
	} else {
		attachmentError = `${result.fileName}: ${result.error}`;
	}
	pendingUploadCount -= 1;
	if (pendingUploadCount <= 0) {
		if (preparingTimer) {
			clearTimeout(preparingTimer);
			preparingTimer = null;
		}
		uploadState = "idle";
		if (fileInput) fileInput.value = "";
	}
}

function removePendingAttachment(id: string) {
	pendingAttachments = pendingAttachments.filter(
		(attachment) => attachment.artifact.id !== id,
	);
	if (pendingAttachments.length === 0) {
		queuedSendAfterProcessing = false;
	}
	draftEmissionVersion += 1;
	void emitDraftChange();
}

function editQueuedMessage() {
	onEditQueuedMessage?.();
	if (!isMobile()) {
		textarea?.focus();
	}
}

function deleteQueuedMessage() {
	onDeleteQueuedMessage?.();
	if (!isMobile()) {
		textarea?.focus();
	}
}

async function ensureDraftConversationId(): Promise<string | null> {
	if (resolvedConversationId) return resolvedConversationId;
	if (!ensureConversation) return null;
	if (!ensureDraftConversationPromise) {
		ensureDraftConversationPromise = ensureConversation()
			.then((id) => {
				resolvedConversationId = id;
				return id;
			})
			.finally(() => {
				ensureDraftConversationPromise = null;
			});
	}
	return ensureDraftConversationPromise;
}

function getDraftTextForPersistence(): string {
	if (!composerCommandRegistryEnabled || !textarea) return message;
	const cursor = textarea.selectionStart ?? message.length;
	const activeToken =
		findDocumentCommandTokenWithQuery(message, cursor) ??
		findActiveComposerCommandToken(message, cursor);
	if (!activeToken) return message;
	return message.slice(0, activeToken.start) + message.slice(activeToken.end);
}

async function emitDraftChange(force = false) {
	const emissionVersion = draftEmissionVersion;
	const nextMessage = getDraftTextForPersistence();
	const nextPendingAttachments = pendingAttachments.map((attachment) => ({
		...attachment,
	}));
	const nextLinkedSources = composerCommandRegistryEnabled
		? effectiveLinkedSources.map((source) => ({
				...source,
				familyArtifactIds: [...source.familyArtifactIds],
			}))
		: [];
	const nextPendingSkill =
		composerCommandRegistryEnabled && pendingSkill
			? {
					id: pendingSkill.id,
					ownership: pendingSkill.ownership,
					skillKind: pendingSkill.skillKind,
					displayName: pendingSkill.displayName,
					baseSkillId: pendingSkill.baseSkillId ?? null,
					baseSkillDisplayName: pendingSkill.baseSkillDisplayName ?? null,
					unavailable: pendingSkill.unavailable === true,
				}
			: null;
	const hasMeaningfulDraft =
		nextMessage.trim().length > 0 ||
		nextPendingAttachments.length > 0 ||
		nextLinkedSources.length > 0 ||
		Boolean(nextPendingSkill) ||
		Boolean(selectedAtlasProfile);
	let draftConversationId: string | null = resolvedConversationId;
	if (hasMeaningfulDraft) {
		try {
			draftConversationId = await ensureDraftConversationId();
		} catch {
			return;
		}
	}
	if (emissionVersion !== draftEmissionVersion) return;
	const payload = {
		conversationId: draftConversationId,
		draftText: nextMessage,
		selectedAttachmentIds: nextPendingAttachments.map(
			(attachment) => attachment.artifact.id,
		),
		selectedAttachments: nextPendingAttachments,
		selectedLinkedSources: nextLinkedSources,
		pendingSkill: nextPendingSkill,
		atlasMode: Boolean(selectedAtlasProfile),
		atlasProfile: selectedAtlasProfile,
		clientAtlasTurnId: selectedAtlasProfile ? clientAtlasTurnId : null,
	};
	const key = JSON.stringify(payload);
	if (!force && key === lastEmittedDraftKey) return;
	lastEmittedDraftKey = key;
	onDraftChange?.(payload);
}
</script>

<svelte:window onkeydown={handleSlashShortcut} />

<div class="composer-root relative flex w-full flex-col" use:closeCommandTrayOnOutsideInteraction>
	{#if showCommandTray}
		<div
			class="command-tray"
			role="listbox"
			aria-label={$t('composerCommands.trayLabel')}
			id="composer-command-tray"
			data-state={commandTrayClosing ? 'closing' : 'open'}
			onanimationend={handleCommandTrayAnimationEnd}
		>
			{#if visibleCommandTrayRows.length > 0}
				<div class="sr-only" role="status" aria-live="polite">
					{activeCommandAnnouncement}
				</div>
				{#each visibleCommandTrayRows as command, index (command.id)}
					<button
						type="button"
						id={`composer-command-${command.id}`}
						class="command-row"
						class:command-row--active={index === highlightedCommandIndex}
						class:command-row--disabled={command.disabled}
						role="option"
						aria-selected={index === highlightedCommandIndex}
						aria-disabled={command.disabled}
						use:commandRowRef={command.id}
						onmouseenter={() => highlightedCommandIndex = index}
						onclick={() => selectCommand(command)}
					>
						<span class="command-token">{command.tokenLabel ?? command.token}</span>
						<span class="command-copy">
							<span class="command-label">{command.label ?? $t(command.labelKey)}</span>
							<span class="command-description">{command.description ?? $t(command.descriptionKey)}</span>
						</span>
						{#if command.statusKey}
							<span class="command-status">{$t(command.statusKey)}</span>
						{/if}
					</button>
				{/each}
			{:else}
				<div class="command-empty" role="status">
					{$t(commandToken?.prefix === '$' && skillDiscoveryLoading ? 'pendingSkill.discoveryLoading' : 'composerCommands.empty')}
				</div>
			{/if}
			{#if commandTrayMessage}
				<div class="command-message" role="status">{commandTrayMessage}</div>
			{/if}
		</div>
	{/if}

	{#if incognitoOn}
		<div class="composer-incognito-notice" role="status">
			<VenetianMask size={14} strokeWidth={2.1} class="shrink-0" aria-hidden="true" />
			<span class="composer-incognito-notice-text">{$t('chat.incognitoNotice')}</span>
			<button
				type="button"
				class="composer-incognito-off"
				onclick={toggleIncognito}
				disabled={incognitoBusy}
			>
				{$t('chat.incognitoTurnOff')}
			</button>
		</div>
	{/if}

	<div class="message-composer relative z-[2] flex min-h-[70px] flex-col rounded-[1.25rem] border border-border px-[8px] pt-[8px] pb-0 transition-all duration-150 focus-within:border-focus-ring md:min-h-[78px] md:px-[10px] md:pt-[10px]">
		<input
			bind:this={fileInput}
			type="file"
			class="hidden"
			multiple
			disabled={isComposerDisabled}
			onchange={(event) => uploadFiles((event.currentTarget as HTMLInputElement).files)}
		/>
		<textarea
			data-testid="message-input"
			bind:this={textarea}
			bind:value={message}
			oninput={handleInput}
			onselect={handleSelect}
			onscroll={handleTextareaScroll}
			onkeydown={handleKeydown}
			onkeyup={handleKeyup}
			onfocus={handleTextareaFocus}
			onblur={handleTextareaBlur}
			disabled={isComposerDisabled}
			aria-controls={showCommandTray ? 'composer-command-tray' : undefined}
			aria-activedescendant={activeCommandRow ? `composer-command-${activeCommandRow.id}` : undefined}
			placeholder={$t('chat.messagePlaceholder')}
			class="composer-textarea min-h-[72px] w-full resize-none overflow-y-auto border-0 bg-transparent px-[13px] py-[7px] text-left text-[15px] leading-[1.42] font-serif text-text-primary placeholder:font-sans placeholder:text-[14px] placeholder:text-text-muted focus:outline-none focus:ring-0 md:min-h-[88px] md:px-[16px] md:py-[8px] md:text-[15px] md:leading-[1.35]"
			class:composer-textarea--link-overlay-active={composerTextSegments.length > 0}
			rows="1"
		></textarea>
		{#if composerTextSegments.length > 0}
			<div
				class="composer-link-highlights min-h-[72px] px-[13px] py-[7px] text-left text-[15px] leading-[1.42] font-serif md:min-h-[88px] md:px-[16px] md:py-[8px] md:text-[15px] md:leading-[1.35]"
				style={`transform: translateY(-${linkHighlightScrollTop}px);`}
			>
				{#each composerTextSegments as segment}
					{#if segment.kind === 'link'}
						<a href={segment.href} target="_blank" rel="noopener noreferrer">{segment.text}</a>
					{:else}
						<span>{segment.text}</span>
					{/if}
				{/each}
			</div>
		{/if}

	{#if pendingAttachments.length > 0}
		<ul class="linked-source-chips" aria-label={$t('linkedSources.chipsLabel')}>
			{#each pendingAttachments as attachment (attachment.artifact.id)}
				<li>
					<FileAttachment
						attachment={attachment.artifact}
						removable={true}
						compact={true}
						onRemove={() => removePendingAttachment(attachment.artifact.id)}
					/>
				</li>
			{/each}
		</ul>
	{/if}

	{#if composerCommandRegistryEnabled && effectiveLinkedSources.length > 0}
		<ul class="linked-source-chips" aria-label={$t('linkedSources.chipsLabel')}>
			{#each effectiveLinkedSources as source (source.displayArtifactId)}
				<li>
					<FileAttachment
						attachment={{ id: source.displayArtifactId, name: source.name, mimeType: source.mimeType ?? null }}
						removable={true}
						compact={true}
						onRemove={() => removeLinkedSource(source.displayArtifactId)}
					/>
				</li>
			{/each}
		</ul>
	{/if}

		{#if composerCommandRegistryEnabled && pendingSkill}
			<ul class="pending-skill-chips" aria-label={$t('pendingSkill.chipsLabel')}>
				<li class="pending-skill-chip">
					<span class="pending-skill-chip__marker" aria-hidden="true"></span>
					<span class="pending-skill-chip__copy">
						<span class="pending-skill-chip__label">
							{$t(pendingSkillKindLabelKey(pendingSkill))}
						</span>
						<span class="pending-skill-chip__name">{pendingSkill.displayName}</span>
						{#if pendingSkill.unavailable}
							<span class="pending-skill-chip__status">{$t('pendingSkill.unavailable')}</span>
						{/if}
					</span>
					<button
						type="button"
						class="pending-skill-chip__remove"
						aria-label={$t('pendingSkill.removeA11y', { name: pendingSkill.displayName })}
						onclick={removePendingSkill}
					>
					<X size={14} strokeWidth={2} aria-hidden="true" />
					</button>
				</li>
			</ul>
		{/if}

		{#if forceWebSearch}
			<ul class="pending-skill-chips" aria-label={$t('composerTools.activeControls')}>
				<li class="pending-skill-chip">
					<span class="pending-skill-chip__marker" aria-hidden="true"></span>
					<span class="pending-skill-chip__copy">
						<span class="pending-skill-chip__label">{$t('composerTools.webSearch')}</span>
					</span>
					<button
						type="button"
						class="pending-skill-chip__remove"
						aria-label={$t('composerTools.removeWebSearch')}
						onclick={() => setForceWebSearch(false)}
					>
					<X size={14} strokeWidth={2} aria-hidden="true" />
					</button>
				</li>
			</ul>
		{/if}

		{#if selectedAtlasProfile}
			<ul class="pending-skill-chips" aria-label={$t('composerTools.activeControls')}>
				<li class="pending-skill-chip pending-skill-chip--atlas">
					<span class="pending-skill-chip__marker" aria-hidden="true"></span>
					<span class="pending-skill-chip__copy">
						<span class="pending-skill-chip__label">
							{$t('composerTools.atlasChip', { profile: selectedAtlasProfileLabel })}
						</span>
						{#if atlasPushStatus !== "idle"}
							<span class="pending-skill-chip__status">{atlasPushStatusLabel()}</span>
						{/if}
					</span>
					<button
						type="button"
						class="pending-skill-chip__remove"
						aria-label={$t('browserPush.enableAtlasA11y')}
						title={$t('browserPush.enableAtlasA11y')}
						onclick={enableAtlasPushNotifications}
					>
					<Bell size={14} strokeWidth={2} aria-hidden="true" />
					</button>
					<button
						type="button"
						class="pending-skill-chip__remove"
						aria-label={$t('composerTools.removeAtlas')}
						onclick={removeAtlasProfile}
					>
					<X size={14} strokeWidth={2} aria-hidden="true" />
					</button>
				</li>
			</ul>
		{/if}

		{#if hasQueuedMessage}
			<div
				data-testid="queued-message-banner"
				class="mx-[16px] mb-2 flex items-center justify-between gap-3 rounded-[1rem] border border-border-subtle bg-surface-page px-3 py-2"
			>
				<div class="min-w-0">
					<p class="text-[11px] font-sans font-medium uppercase tracking-[0.12em] text-text-muted">
						{$t('chat.queuedNext')}
					</p>
					<p class="truncate text-[13px] font-sans text-text-primary">
						{queuedMessagePreview || $t('chat.nextMessageQueued')}
					</p>
				</div>
				<div class="flex items-center gap-2">
					<button
						data-testid="delete-queued-button"
						type="button"
						class="rounded-full border border-border px-3 py-1 text-[12px] font-sans font-medium text-text-muted transition-colors duration-150 hover:bg-surface-elevated hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
						onclick={deleteQueuedMessage}
					>
						{$t('chat.delete')}
					</button>
					<button
						data-testid="edit-queued-button"
						type="button"
						class="rounded-full border border-border px-3 py-1 text-[12px] font-sans font-medium text-text-primary transition-colors duration-150 hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
						onclick={editQueuedMessage}
					>
						{$t('chat.edit')}
					</button>
				</div>
			</div>
		{/if}

		<div class="composer-actions flex items-center justify-between gap-2 pt-[3px] pb-[4px] md:gap-3 md:pt-[4px] md:pb-[5px]">
			<div class="flex items-center gap-2">
				<div class="relative flex items-center">
					<button
						type="button"
						class="btn-icon-bare composer-icon flex flex-shrink-0 items-center justify-center text-text-muted"
						onclick={toggleToolsMenu}
						disabled={isComposerDisabled}
						aria-label={$t('chat.openComposerTools')}
						aria-expanded={showToolsMenu}
					>
					<Plus size={20} strokeWidth={2.2} aria-hidden="true" />
					</button>

					{#if showToolsMenu}
						<ComposerToolsMenu
							{canAttach}
							{attachmentsEnabled}
							onClose={closeToolsMenu}
							onAttach={openFilePicker}
							{personalityProfiles}
							{selectedPersonalityId}
							{onPersonalityChange}
							{onModelChange}
							{reasoningDepth}
							{onReasoningDepthChange}
							initialOpen={toolsMenuInitialOpen}
							{forceWebSearch}
							onForceWebSearchChange={setForceWebSearch}
							{atlasAvailability}
							atlasProfile={selectedAtlasProfile}
							onAtlasProfileChange={setAtlasProfile}
						/>
					{/if}
				</div>

				<button
					type="button"
					data-testid="incognito-toggle"
					class="btn-icon-bare composer-icon composer-incognito-btn flex flex-shrink-0 items-center justify-center"
					class:composer-incognito-btn--active={incognitoOn}
					onclick={toggleIncognito}
					disabled={incognitoBusy}
					aria-pressed={incognitoOn}
					aria-label={$t('chat.incognitoToggle')}
					title={$t('chat.incognitoToggle')}
				>
					<VenetianMask size={19} strokeWidth={2.1} aria-hidden="true" />
				</button>

				<button
					type="button"
					data-testid="connections-toggle"
					class="btn-icon-bare composer-icon composer-connections-btn flex flex-shrink-0 items-center justify-center"
					class:composer-connections-btn--active={hasConnections && connectionsEnabled}
					class:composer-connections-btn--disabled={!hasConnections}
					onclick={toggleConnections}
					aria-disabled={!hasConnections}
					aria-pressed={hasConnections ? connectionsEnabled : undefined}
					aria-label={!hasConnections
						? $t('chat.connectionsToggleNoConnections')
						: connectionsEnabled
							? $t('chat.connectionsToggleOn')
							: $t('chat.connectionsToggleOff')}
					title={!hasConnections
						? $t('chat.connectionsToggleNoConnections')
						: connectionsEnabled
							? $t('chat.connectionsToggleOn')
							: $t('chat.connectionsToggleOff')}
				>
					<Plug size={19} strokeWidth={2.1} aria-hidden="true" />
				</button>

				<ContextUsageRing
					{contextStatus}
					attachedArtifacts={composerArtifacts}
					{contextDebug}
					{contextSources}
					{totalCostUsd}
					{lastTurnCostUsd}
					{totalTokens}
					{onManageEvidence}
				/>
			</div>

			<div class="action-button-container flex min-h-[42px] items-center justify-end gap-2 flex-shrink-0">
				{#if isGenerating}
					{#if !hasQueuedMessage && canQueue}
						<button
							data-testid="queue-button"
							type="button"
							onclick={() => queue()}
							disabled={isComposerDisabled}
							aria-label={$t('chat.queueMessage')}
							class="queue-button flex h-[40px] items-center justify-center rounded-[10px] border border-border bg-surface-page px-3 text-[13px] font-sans font-medium text-text-primary shadow-sm animate-in"
						>
							{$t('chat.queueMessage')}
						</button>
					{/if}
					{#if canStop}
						<button
							data-testid="stop-button"
							type="button"
							onclick={stop}
							disabled={isComposerDisabled}
							aria-label={$t('chat.stop')}
							class="composer-stop-accent flex h-[40px] w-[40px] items-center justify-center rounded-[10px] shadow-sm animate-in"
						>
							<Square size={18} fill="currentColor" aria-hidden="true" />
						</button>
					{/if}
				{:else}
					<button
						data-testid="send-button"
						type="button"
						onclick={() => send()}
						disabled={!canSend || isComposerDisabled}
						aria-label={$t('chat.sendMessage')}
						class="btn-primary composer-send flex h-[40px] w-[40px] items-center justify-center rounded-[10px] shadow-sm disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-elevated disabled:text-icon-muted animate-in"
					>
					<Send size={18} strokeWidth={2} aria-hidden="true" />
					</button>
				{/if}
			</div>
		</div>
	</div>

	{#if sendDisabledHint}
		<div class="mt-1 flex justify-end px-2">
			<span class="text-[12px] font-sans text-text-muted" data-testid="send-disabled-hint">
				{#if sendDisabledHint === 'uploading'}
					{$t('chat.uploadingFile')}
				{:else if sendDisabledHint === 'checkingPrivacy'}
					{$t('chat.checkingPrivacy')}
				{:else}
					{$t('chat.extractingDocument')}
				{/if}
			</span>
		</div>
	{/if}

	{#if showSlashHint}
		<div class="mt-1 flex justify-end px-2">
			<span class="text-[12px] font-sans text-text-muted" data-testid="slash-shortcut-hint">
				{$t('chat.slashShortcutHint')}
			</span>
		</div>
	{/if}

	{#if isUploadingAttachment || attachmentError || attachmentReadinessErrors.length > 0 || queuedSendAfterProcessing}
		<div class="mt-2 flex flex-col gap-1 px-2 text-xs font-sans">
			{#if (uploadState === 'uploading' && sendDisabledHint !== 'uploading') || (uploadState === 'preparing' && sendDisabledHint !== 'preparing')}
				{#if uploadState === 'uploading'}
					<span class="text-text-muted">{$t('chat.uploadingFile')}</span>
				{:else if uploadState === 'preparing'}
					<span class="text-text-muted">{$t('chat.extractingDocument')}</span>
				{/if}
			{/if}
			{#if queuedSendAfterProcessing && (isUploadingAttachment || hasUnreadyAttachment)}
				<span class="text-text-muted">{$t('chat.messageWillSendAutomatically')}</span>
			{/if}
			{#if attachmentError}
				<span class="text-danger">{attachmentError}</span>
			{/if}
			{#each attachmentReadinessErrors as attachment (attachment.artifact.id)}
				<span class="text-danger">
					{attachment.artifact.name}: {attachment.readinessError}
				</span>
			{/each}
		</div>
	{/if}

	{#if documentPickerOpen}
		<LinkedDocumentPicker
			documents={documentPickerDocuments}
			selectedSources={effectiveLinkedSources}
			initialQuery={documentPickerInitialQuery}
			loading={documentPickerLoading}
			error={documentPickerError}
			onApply={applyLinkedSources}
			onCancel={closeDocumentPicker}
		/>
	{/if}

	{#if sourceManagerOpen}
		<LinkedSourceManager
			sources={effectiveLinkedSources}
			onClose={closeSourceManager}
			onRemove={removeLinkedSource}
			onClear={clearLinkedSources}
			onAddDocument={() => openDocumentPicker()}
		/>
	{/if}

</div>

<style>
	.message-composer {
		background: color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%);
		box-shadow:
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%),
			0 14px 30px color-mix(in srgb, var(--accent) 7%, transparent 93%),
			var(--shadow-lg);
	}

	.composer-root {
		background: transparent;
		border: 0;
		box-shadow: none;
	}

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

	.linked-source-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0;
		padding: 0.25rem 1rem 0.5rem;
		list-style: none;
	}

	.pending-skill-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0;
		padding: 0.25rem 0.25rem 0.55rem;
		list-style: none;
	}

	.pending-skill-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		max-width: 100%;
		border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--border-default) 64%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 13%, var(--surface-overlay) 87%);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--surface-overlay) 86%, transparent 14%) inset;
		padding: 0.28rem 0.34rem 0.28rem 0.58rem;
		color: var(--text-primary);
	}

	.pending-skill-chip__marker {
		width: 0.55rem;
		height: 0.55rem;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 16%, transparent 84%);
	}

	.pending-skill-chip__copy {
		display: inline-grid;
		grid-auto-flow: column;
		align-items: baseline;
		gap: 0.35rem;
		min-width: 0;
	}

	.pending-skill-chip__label {
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 700;
		line-height: 1;
		text-transform: uppercase;
	}

	.pending-skill-chip__name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.pending-skill-chip__status {
		color: var(--danger);
		font-size: var(--text-2xs);
		font-weight: 600;
	}

	.pending-skill-chip__remove {
		width: 1.35rem;
		height: 1.35rem;
		display: inline-grid;
		place-items: center;
		flex: 0 0 auto;
		border: 0;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-page) 64%, transparent 36%);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.pending-skill-chip__remove:hover,
	.pending-skill-chip__remove:focus-visible {
		background: color-mix(in srgb, var(--accent) 18%, var(--surface-page) 82%);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.pending-skill-chip__remove:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
		outline: none;
	}

	:global(.dark) .pending-skill-chip {
		background: color-mix(in srgb, var(--accent) 16%, var(--surface-overlay) 84%);
		box-shadow:
			0 1px 0 color-mix(in srgb, white 6%, transparent 94%) inset,
			0 0 0 1px color-mix(in srgb, var(--accent) 8%, transparent 92%);
	}

	:global(.dark) .pending-skill-chip__remove {
		background: color-mix(in srgb, var(--surface-elevated) 64%, transparent 36%);
	}

	.command-tray {
		position: absolute;
		left: 50%;
		bottom: calc(100% - 0.4rem);
		z-index: 1;
		width: min(95%, 44rem);
		max-height: min(23rem, calc(100vh - 12rem));
		overflow-y: auto;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, transparent 24%);
		border-radius: 1rem 1rem 0.9rem 0.9rem;
		background: color-mix(in srgb, var(--surface-page) 80%, #000 20%);
		box-shadow:
			0 18px 42px rgba(0, 0, 0, 0.28),
			0 0 0 1px color-mix(in srgb, var(--accent) 8%, transparent 92%);
		padding: 0.45rem;
		transform: translateX(-50%) translateY(0);
		animation: commandTrayIn 150ms cubic-bezier(0.22, 1, 0.36, 1);
		backdrop-filter: blur(16px);
	}

	.command-tray[data-state="closing"] {
		pointer-events: none;
		animation: commandTrayOut 150ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}

	:global(.dark) .command-tray {
		background: color-mix(in srgb, var(--surface-page) 90%, #000 10%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	.command-row {
		display: grid;
		width: 100%;
		grid-template-columns: minmax(4.8rem, auto) minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		border: 0;
		border-radius: 0.72rem;
		background: transparent;
		padding: 0.62rem 0.72rem;
		text-align: left;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.command-row + .command-row {
		margin-top: 0.08rem;
	}

	.command-row--active {
		background: color-mix(in srgb, var(--accent) 13%, var(--surface-elevated) 87%);
	}

	.command-row--disabled {
		cursor: default;
		opacity: 0.62;
	}

	.command-token {
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 700;
		color: var(--accent);
		white-space: nowrap;
	}

	.command-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.12rem;
	}

	.command-label {
		font-family: var(--font-sans);
		font-size: var(--text-md);
		font-weight: 650;
		line-height: 1.2;
		color: var(--text-primary);
	}

	.command-description,
	.command-status,
	.command-empty,
	.command-message {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.25;
		color: var(--text-muted);
	}

	.command-description {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-status {
		white-space: nowrap;
		color: color-mix(in srgb, var(--accent) 64%, var(--text-muted) 36%);
	}

	.command-empty,
	.command-message {
		padding: 0.75rem 0.8rem;
	}

	.command-message {
		border-top: 1px solid color-mix(in srgb, var(--border-default) 68%, transparent 32%);
	}

	@keyframes commandTrayIn {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(0.45rem);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}

	@keyframes commandTrayOut {
		from {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
		to {
			opacity: 0;
			transform: translateX(-50%) translateY(0.45rem);
		}
	}

	:global(.dark) .message-composer {
		background: var(--surface-elevated);
		box-shadow:
			0 1px 0 color-mix(in srgb, var(--border-default) 92%, transparent 8%),
			0 18px 38px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent 90%);
	}

	.composer-icon {
		align-self: center;
	}

	/* Incognito toggle: quiet by default; when active only the ICON takes the
	   accent colour (no box fill) so it reads as a state without distracting. */
	.composer-incognito-btn {
		color: var(--icon-muted);
	}

	.composer-incognito-btn--active {
		color: var(--accent);
	}

	.composer-incognito-btn--active:hover {
		color: var(--accent-hover);
		opacity: 1;
	}

	/* Connections master toggle (ADR 0044 Decision 1): icon takes the accent
	   colour while on (the default), muted once turned off for this
	   conversation. Icon-only colouring — the box is never filled. */
	.composer-connections-btn {
		color: var(--icon-muted);
	}

	.composer-connections-btn--active {
		color: var(--accent);
	}

	.composer-connections-btn--active:hover {
		color: var(--accent-hover);
		opacity: 1;
	}

	/* Shown but greyed for users with no connections yet — the tooltip points
	   them to Settings. Still hoverable (aria-disabled, not native disabled)
	   so the title tooltip surfaces. */
	.composer-connections-btn--disabled {
		color: var(--icon-muted);
		opacity: 0.4;
		cursor: default;
	}

	.composer-connections-btn--disabled:hover {
		opacity: 0.4;
		background: transparent;
	}

	/* One-line "incognito on" notice above the input box. */
	.composer-incognito-notice {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0.25rem 0.4rem;
		padding: 0.3rem 0.6rem;
		border-radius: 9999px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page) 92%);
		color: var(--accent);
		font-size: 0.75rem;
		line-height: 1.3;
	}

	.composer-incognito-notice-text {
		min-width: 0;
		flex: 1;
		overflow-wrap: anywhere;
	}

	.composer-incognito-off {
		flex-shrink: 0;
		cursor: pointer;
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		font-size: 0.75rem;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}

	.composer-incognito-off:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.composer-textarea {
		align-self: stretch;
		position: relative;
		z-index: 1;
	}

	.composer-textarea--link-overlay-active {
		color: transparent;
		caret-color: var(--text-primary);
		-webkit-text-fill-color: transparent;
	}

	.composer-textarea--link-overlay-active::selection {
		background: color-mix(in srgb, var(--focus-ring) 34%, transparent);
		-webkit-text-fill-color: transparent;
	}

	.composer-link-highlights {
		position: absolute;
		top: 8px;
		left: 8px;
		right: 8px;
		z-index: 2;
		max-height: 112px;
		overflow: hidden;
		overflow-wrap: anywhere;
		pointer-events: none;
		white-space: pre-wrap;
		color: var(--text-primary);
	}

	.composer-link-highlights a {
		color: var(--accent);
		pointer-events: auto;
		text-decoration-line: underline;
		text-decoration-thickness: 0.08em;
		text-underline-offset: 0.16em;
	}

	.composer-link-highlights a:focus-visible {
		border-radius: 0.18rem;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
		outline: none;
	}

	@media (min-width: 768px) {
		.composer-link-highlights {
			top: 10px;
			left: 10px;
			right: 10px;
			max-height: 240px;
		}
	}

	.composer-actions {
		border-top: 1px solid color-mix(in srgb, var(--border-default) 72%, transparent 28%);
	}

	.composer-send {
		aspect-ratio: 1 / 1;
		align-self: center;
		overflow: hidden;
	}

	.action-button-container {
		align-self: center;
	}

	.composer-stop-accent {
		aspect-ratio: 1 / 1;
		align-self: center;
		overflow: hidden;
		background-color: var(--accent);
		color: white;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.composer-stop-accent:hover {
		background-color: var(--accent-hover);
		transform: scale(1.02);
	}

	.composer-stop-accent:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.queue-button:hover {
		background: color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%);
	}

	.queue-button:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.animate-in {
		animation: buttonFadeIn 200ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}

	@keyframes buttonFadeIn {
		from {
			opacity: 0;
			transform: scale(0.85) rotate(-8deg);
		}
		to {
			opacity: 1;
			transform: scale(1) rotate(0deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.command-tray {
			animation: none;
		}

		.command-tray[data-state="closing"] {
			animation: none;
		}

		.animate-in {
			animation: none;
			opacity: 1;
		}

	}

	@media (max-width: 767px) {
		.animate-in {
			animation: none;
			opacity: 1;
			transform: none;
		}

		.command-tray {
			position: fixed;
			left: max(0.75rem, env(safe-area-inset-left));
			right: max(0.75rem, env(safe-area-inset-right));
			bottom: calc(10.5rem + env(safe-area-inset-bottom));
			width: auto;
			max-height: min(18rem, 40vh);
			border-radius: 1rem;
			transform: translateY(0);
			animation: commandTrayMobileIn 150ms cubic-bezier(0.22, 1, 0.36, 1);
		}

		.command-tray[data-state="closing"] {
			animation: commandTrayMobileOut 150ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
		}

		.command-row {
			grid-template-columns: minmax(4.4rem, auto) minmax(0, 1fr);
		}

		.command-status {
			grid-column: 2;
		}
	}

	@keyframes commandTrayMobileIn {
		from {
			opacity: 0;
			transform: translateY(0.55rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes commandTrayMobileOut {
		from {
			opacity: 1;
			transform: translateY(0);
		}
		to {
			opacity: 0;
			transform: translateY(0.55rem);
		}
	}
</style>
