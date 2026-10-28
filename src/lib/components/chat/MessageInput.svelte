<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import {
	Ban,
	Bell,
	Brain,
	Clock,
	Paperclip,
	Plug,
	Plus,
	RotateCw,
	Send,
	Square,
	VenetianMask,
	X,
} from "@lucide/svelte";
import { goto } from "$app/navigation";
import { enableBrowserPushNotifications } from "$lib/client/api/browser-push";
import {
	type ActiveCapabilitiesConnection,
	fetchActiveCapabilities,
} from "$lib/client/api/connections";
import {
	capabilitiesForSelection,
	masterIsOn,
	persistDisabledIds,
	readDisabledIds,
	readyCount,
	toggleAccount,
	toggleMaster,
} from "$lib/client/connections/composer-selection";
import ConnectionsPopover from "./ConnectionsPopover.svelte";
import {
	fetchAvailableModels,
	type ModelProvider,
} from "$lib/client/api/models";
import {
	fetchConversationMarkdownExport,
	setConversationMemoryIncognito,
} from "$lib/client/api/conversations";
import { addMemoryNote } from "$lib/client/api/memory-notes";
import { saveBlobAsDownload } from "$lib/client/api/settings";
import { startNewChat } from "$lib/client/new-chat";
import { recordComposerCommandUsed } from "$lib/client/composer-command-analytics";
import { selectedModel } from "$lib/stores/settings";
import { showToast } from "$lib/stores/toast";
import {
	cancelExtraction,
	fetchKnowledgeLibrary,
	retryExtraction,
} from "$lib/client/api/knowledge";
import { createExtractionAnnouncer } from "$lib/client/extraction-announcements";
import {
	createExtractionPoller,
	type ExtractionPoller,
	readExtractionJobDTO,
} from "$lib/client/extraction-poll";
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
	HIDDEN_COMPOSER_COMMAND_ALIASES,
	STATIC_COMPOSER_COMMANDS,
	type ComposerCommandDefinition,
} from "$lib/composer-commands";
import { t, type I18nKey } from "$lib/i18n";
import { tokenizeTextLinks } from "$lib/services/linkify";
import { currentConversationId } from "$lib/stores/ui";
import {
	maxFileUploadSizeBytes,
	maxFileUploadSizeMb,
} from "$lib/stores/upload-limits";
import { disabledFileTypeIds } from "$lib/stores/upload-format-gate";
import {
	admitUpload,
	buildAcceptAttribute,
	fileExtension,
} from "$lib/shared/file-types";
import {
	decideClipboardAttachment,
	UPLOAD_REJECT_I18N_KEYS,
} from "$lib/utils/clipboard-attachments";
import {
	isPhoneViewport,
	isTouchDevice,
	initViewportTracking,
	viewportStore,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import { chordsAreDrawn } from "$lib/components/artifacts/document/keyboard-shortcuts";
import { portalToBody } from "$lib/utils/portal";
import {
	clearComposerQuoteRequest,
	composerQuoteRequest,
} from "$lib/stores/composer-quote";
import ContextUsageRing from "./ContextUsageRing.svelte";
import { followAnchor } from "./anchored-popup";
import AttachmentOutline from "./AttachmentOutline.svelte";
import AttachmentPickerSheet from "./AttachmentPickerSheet.svelte";
import ComposerToolsMenu from "./ComposerToolsMenu.svelte";
import IncognitoPopover, {
	type IncognitoPopoverCloseReason,
} from "./IncognitoPopover.svelte";
import SkillsPicker from "./SkillsPicker.svelte";
import {
	accountsBadge,
	accountsIsOn,
	accountsTooltip,
	attachIsOn,
	attachTooltip,
	type ComposerTooltip,
	thinkingTooltip,
} from "./composer-bar";
import {
	attachmentReadinessReasonKey,
	type AttachmentReadinessSnapshot,
} from "$lib/shared/attachment-readiness";
import { imageFileUrl } from "$lib/client/api/images";
import type {
	ImageMarksRequest,
	PictureRef,
	UserPicturesMetadata,
} from "$lib/shared/artifacts/image-body";
import ComposerChip from "./ComposerChip.svelte";
import ComposerChipFailureDetails from "./ComposerChipFailureDetails.svelte";
import ComposerChipRow from "./ComposerChipRow.svelte";
import {
	arrangePictureChips,
	type ComposerMarks,
	type ComposerPictureRef,
	markedPictureNumber,
	numberPictures,
	pictureKey,
	reconcilePictureOrder,
} from "./composer-pictures";
import {
	fieldTextRoom,
	fitPlaceholder,
	placeholderMeasurer,
} from "./placeholder-fit";
import {
	attachmentChipFailure,
	attachmentChipKind,
	attachmentChipMeta,
	attachmentReadinessStatusKey,
	attachmentThumbnailUrl,
	extractionChipState,
	extractionReasonKey,
	isPictureForModel,
	quoteChipLabel,
	type AttachmentChipFailure,
} from "./composer-chip-presentation";
import LinkedDocumentPicker from "./LinkedDocumentPicker.svelte";
import LinkedSourceManager from "./LinkedSourceManager.svelte";
import {
	findActiveComposerCommandToken,
	findActiveComposerCommandTokenWithArgument,
	replaceActiveComposerCommandToken,
	type ComposerCommandToken,
	type ComposerCommandTokenWithArgument,
} from "./composer-command-parser";
import { browser } from "$app/environment";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type {
	AtlasAvailability,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type {
	ArtifactSummary,
	KnowledgeDocumentItem,
	PendingAttachment,
} from "$lib/server/services/knowledge/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";

type SendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	pendingAttachments: PendingAttachment[];
	// Card pictures attached to this message, under the numbers the chips showed,
	// and the same pictures with their names for the sent bubble (plan 2b T5).
	pictureRefs?: PictureRef[];
	pictures?: UserPicturesMetadata;
	// The marks drawn on one picture (plan 2b T6), and, client-only, the item
	// they were drawn on and whether the send added that picture as a ref, so a
	// turn put back in the composer gets its marks chip back (never on the wire).
	imageMarks?: ImageMarksRequest;
	markedPicture?: { artifactId: string; name: string; addedRef: boolean };
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
	placeholder = null,
	autofocus = false,
	isGenerating = false,
	canStopStreaming = undefined,
	conversationId = null,
	attachmentsEnabled = false,
	ensureConversation = null,
	contextStatus = null,
	attachedArtifacts = [],
	contextDebug = null,
	draftText = "",
	draftAttachments = [],
	draftLinkedSources = [],
	draftPendingSkill = null,
	draftAtlasMode = false,
	draftAtlasProfile = null,
	draftClientAtlasTurnId = null,
	draftVersion = 0,
	pictureRefs = [],
	draftPictureOrder = [],
	onRemovePictureRef = undefined,
	imageMarks = null,
	onClearMarks = undefined,
	focusRequest = 0,
	onSend = undefined,
	onQueue = undefined,
	onStop = undefined,
	onEditQueuedMessage = undefined,
	onDeleteQueuedMessage = undefined,
	onCompact = undefined,
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
	reasoningDepth = "thorough",
	onReasoningDepthChange = undefined,
	composerCommandRegistryEnabled = false,
	onInstructionCommand = undefined,
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
	/**
	 * The empty box's text. Unset means the ordinary chat placeholder; the
	 * project page names the project it will start a chat in, which is the
	 * only place the box can belong to something before the chat exists.
	 * Incognito always wins over it: that state is about the conversation,
	 * not about where it is being started.
	 */
	placeholder?: string | null;
	/**
	 * Whether this mount should land the caret in the box. Unset everywhere the
	 * composer is one part of a page the user is reading; the project page sets
	 * it when it was opened by the sidebar's "New chat" item, whose whole point
	 * is "start typing here" — and only then, because focusing on the phone
	 * would raise the keyboard over a page the user may have opened to read.
	 */
	autofocus?: boolean;
	isGenerating?: boolean;
	canStopStreaming?: boolean | undefined;
	conversationId?: string | null;
	attachmentsEnabled?: boolean;
	ensureConversation?: (() => Promise<string>) | null;
	contextStatus?: ConversationContextStatus | null;
	attachedArtifacts?: ArtifactSummary[];
	contextDebug?: ContextDebugState | null;
	draftText?: string;
	draftAttachments?: PendingAttachment[];
	draftLinkedSources?: LinkedContextSource[];
	draftPendingSkill?: PendingSkillSelection | null;
	draftAtlasMode?: boolean;
	draftAtlasProfile?: AtlasProfile | null;
	draftClientAtlasTurnId?: string | null;
	draftVersion?: number;
	/**
	 * Card, strip and History pictures waiting in this message (Attach), held by
	 * the page. They are numbered with the uploaded photos in the order they
	 * were added; the send carries them as `pictureRefs`. Optional: a composer
	 * with none (the landing page) draws and sends exactly as before.
	 */
	pictureRefs?: readonly ComposerPictureRef[];
	/**
	 * The order a restored turn's pictures were numbered in (keys from
	 * `pictureKey`), applied together with the draft so the numbers the person's
	 * own text names come back unchanged. Empty: the order is the order added.
	 */
	draftPictureOrder?: readonly string[];
	onRemovePictureRef?: ((imageFileId: string) => void) | undefined;
	/**
	 * The marks drawn on one picture in the panel (plan 2b T6), held by the
	 * page: one `image` chip ("Marks A, B") under the number the marked picture
	 * goes by. The send carries them as `imageMarks` and adds the picture as a
	 * ref when it is not attached already (F14).
	 */
	imageMarks?: ComposerMarks | null;
	/** The marks chip's x: the page lets the marks go (and the panel's boxes with them). */
	onClearMarks?: (() => void) | undefined;
	/** Rises when the page wants the box focused (a picture was just attached). */
	focusRequest?: number;
	onSend?: ((payload: SendPayload) => void) | undefined;
	onQueue?: ((payload: SendPayload) => void) | undefined;
	onStop?: (() => void | Promise<void>) | undefined;
	onEditQueuedMessage?: (() => void) | undefined;
	onDeleteQueuedMessage?: (() => void) | undefined;
	onCompact?: (() => void) | undefined;
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
						| {
								success: true;
								/**
								 * The upload's extraction job rides on
								 * `PendingAttachment.extraction`. One shape, so the
								 * composer and the draft restore read the same field.
								 */
								attachment: PendingAttachment;
						  }
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
	/**
	 * `/instruction <text>` hands the text to the host surface, which owns the
	 * instructions dialog. The composer never opens it itself: which scopes can
	 * be offered depends on the conversation's project, and only the page knows
	 * that — the same reason `/skill` and `/document` delegate upward.
	 */
	onInstructionCommand?: ((text: string) => void) | undefined;
	atlasAvailability?: AtlasAvailability | null;
	/**
	 * Whether the current conversation is excluded from the memory pipeline —
	 * OR, on the landing page before a conversation exists, whether the
	 * incognito mask button has been armed. One-way: the composer only ever
	 * reads this as "on"; there is no path left that flips it back to "off"
	 * once it has been true.
	 */
	memoryIncognito?: boolean;
	/**
	 * Emitted after the one remaining server round trip that can arm
	 * incognito from inside the composer — the empty-conversation PATCH
	 * fallback described in docs/plans/incognito-one-way-spec.md §1, for a
	 * conversation that already exists (with no messages yet) but was not
	 * created with the flag. The id travels with it because on the landing
	 * page the prepared conversation can be cleared between the arm and the
	 * persist landing.
	 */
	onMemoryIncognitoChange?:
		| ((value: boolean, conversationId: string) => void)
		| undefined;
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
let toolsMenuTrigger = $state<HTMLButtonElement | null>(null);
let isHydrated = $state(false);
let message = $state("");
let pendingAttachments = $state<PendingAttachment[]>([]);
let selectedLinkedSources = $state<LinkedContextSource[]>([]);
let pendingSkill = $state<PendingSkillSelection | null>(null);
// Chips redesign — a section picked from a document's outline, held as a
// chip instead of pasted into the textarea. Composer-local and ephemeral
// (see `expandQuotesIntoMessage`), the same way the command tray's own
// transient state is: they are expanded into the message on send and
// cleared with every other per-turn selection.
let pendingQuotes = $state<{ id: string; text: string; label: string }[]>([]);
let quoteIdSeed = 0;
// "preparing" is gone. It used to arrive on a fixed delay after an upload
// started, from a timer that knew nothing about the file, and it lied in both
// directions: a one-line .txt was called "preparing" for as long as a scanned
// 40 MB PDF, and a PDF that took a minute stopped saying anything the moment
// the HTTP response landed. The extraction ledger answers the real question
// per file, so the composer asks it instead of guessing.
let uploadState = $state<"idle" | "uploading">("idle");
// Per-artifact extraction state, keyed on the source artifact id. Seeded from
// the upload response and kept current by the poller.
let extractionJobs = $state<Record<string, DocumentExtractionJobDTO>>({});
// OQ6 — a chip the instant the user picks a file, before the upload POST has
// resolved and before there is an artifact id to key one on. Keyed on a
// client-generated id and swapped for the real chip when the response lands,
// the same trick `buildPendingFileProductionJobPlaceholder` plays for a
// generated file. Without it the composer shows nothing at all for the whole
// round trip, which on a 40 MB file is the longest it ever shows nothing.
let optimisticUploads = $state<{ id: string; name: string }[]>([]);
let optimisticUploadSeed = 0;
let extractionActionError = $state("");
let extractionPoller: ExtractionPoller | null = null;
// Artifacts whose Retry or Cancel is in flight. A second click on a control
// the first click has not finished with would fire a second request and, for
// Retry, burn a second attempt on the same document.
let extractionActionIds = $state<Set<string>>(new Set());
// The polite live region's text. Set only when a document's state really
// moved (see `extraction-announcements`), because the poller answers every
// second and a region bound straight to the DTO would read the same sentence
// back at a screen-reader user for the whole length of a read.
let extractionAnnouncement = $state("");
const extractionAnnouncer = createExtractionAnnouncer();
// The paste-to-attach live region's text. Its own region rather than a second
// writer on the extraction one: that region is driven by the poller and would
// overwrite this the moment the first chip moved to "Reading…".
let pasteAnnouncement = $state("");
let attachmentError = $state("");
let documentPickerOpen = $state(false);
let sourceManagerOpen = $state(false);
let documentPickerInitialQuery = $state("");
let documentPickerDocuments = $state<KnowledgeDocumentItem[]>([]);
let documentPickerLoading = $state(false);
let documentPickerError = $state("");
let resolvedConversationId = $state<string | null>(null);
let showToolsMenu = $state(false);
// Everyday redesign — the phone-only surfaces the bar and the menu open.
let attachmentSheetOpen = $state(false);
let skillsPickerOpen = $state(false);
let skillCount = $state<number | null>(null);
let isPhone = $state(isPhoneViewport());
/** The most the tray grows before its rows scroll: 23rem, 18rem on a phone. */
const COMMAND_TRAY_MAX_HEIGHT = 368;
const COMMAND_TRAY_PHONE_MAX_HEIGHT = 288;
/** 44rem, and never wider than 95% of the composer it opens from. */
const COMMAND_TRAY_MAX_WIDTH = 704;
/** Until it has been measured and placed the tray is not seen anywhere. */
const COMMAND_TRAY_UNPLACED_STYLE = "visibility:hidden;";
let commandTrayElement = $state<HTMLDivElement | undefined>(undefined);
let commandTrayStyle = $state(COMMAND_TRAY_UNPLACED_STYLE);
let composerBox = $state<HTMLDivElement | undefined>(undefined);
let longPressLabel = $state<string | null>(null);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let commandToken = $state<
	ComposerCommandToken | ComposerCommandTokenWithArgument | null
>(null);
let commandTrayMounted = $state(false);
let commandTrayClosing = $state(false);
let dismissedCommandTokenKey = $state<string | null>(null);
let highlightedCommandIndex = $state(0);
let commandTrayMessage = $state("");
// The token the current message was written for. A message is about one
// command in one position ("you typed /instruction with nothing after it"),
// so it is retired when that token changes rather than on every re-sync.
let commandTraySyncedTokenKey: string | null = null;
let skillDiscoveryQuery = $state("");
let skillDiscoveryResults = $state<SkillDiscoverySummary[]>([]);
let skillDiscoveryLoading = $state(false);
let skillDiscoveryRequestId = 0;
let toolsMenuInitialOpen = $state<"model" | "style" | null>(null);
let forceWebSearch = $state(false);
// ADR-0061 — the thinking toggle hides itself for a model whose recorded
// capabilities explicitly mark reasoning controls unsupported. Loaded once
// on mount (same models list ModelSelector fetches independently) and
// looked up by the currently selected model id from the settings store.
let modelProviders = $state<ModelProvider[]>([]);
let currentModelSupportsReasoningControls = $derived.by(() => {
	const currentModelId = $selectedModel;
	for (const provider of modelProviders) {
		const found = provider.models.find((model) => model.id === currentModelId);
		if (found) return found.supportsReasoningControls;
	}
	// Not loaded yet (or not found): default to showing the toggle rather
	// than hiding it on every cold load.
	return true;
});
// A model the admin marked "Can see images" needs no extracted text to be shown
// a picture, so with one selected a photo the reader found no text in does not
// hold Send (the server's send gate lets it through the same way). Read from
// the same list, for the same selected model. The cautious default is the
// opposite of the toggle's: until the list says the model can see, it cannot.
let selectedModelSupportsImages = $derived.by(() => {
	const currentModelId = $selectedModel;
	for (const provider of modelProviders) {
		const found = provider.models.find((model) => model.id === currentModelId);
		if (found) return found.supportsImages === true;
	}
	return false;
});
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
// Connections redesign — the plug opens an account list instead of being an
// all-or-nothing switch, so the composer now tracks WHICH accounts this
// conversation deviates on. An account starts at its own "Use it without
// asking" setting; `connectionsFlippedIds` holds the ones the user flipped
// away from it here (composer-selection's isAccountOn). `connectionAccounts`
// comes from the same active-capabilities fetch; when the server doesn't send
// it (older build), everything below falls back to the master switch above.
let connectionAccounts = $state<ActiveCapabilitiesConnection[]>([]);
let connectionsFlippedIds = $state<Set<string>>(new Set());
let showConnectionsPopover = $state(false);
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
// Plan 2b T5 — one numbering for the uploaded photos and the card pictures,
// in the order they were added (the server numbers the same way). `pictureOrder`
// remembers the order; the live list is worked out in the same pass as the
// chips, so a new chip never draws without its number and a removal renumbers
// the rest in the frame it happens.
let pictureOrder = $state.raw<readonly string[]>([]);
let uploadPictureKeys = $derived(
	pendingAttachments.map((attachment) =>
		attachmentChipKind(attachment.artifact) === "image"
			? pictureKey({ kind: "upload", artifactId: attachment.artifact.id })
			: null,
	),
);
let refPictureKeys = $derived(
	pictureRefs.map((ref) =>
		pictureKey({ kind: "ref", imageFileId: ref.imageFileId }),
	),
);
let livePictureOrder = $derived(
	reconcilePictureOrder(pictureOrder, [
		...uploadPictureKeys.filter((key): key is string => key !== null),
		...refPictureKeys,
	]),
);
$effect(() => {
	if (livePictureOrder !== pictureOrder) pictureOrder = livePictureOrder;
});
let pictureNumbers = $derived(numberPictures(livePictureOrder, () => true));
let pictureChipSlots = $derived(
	arrangePictureChips(livePictureOrder, uploadPictureKeys, refPictureKeys),
);
let markedNumber = $derived(
	imageMarks
		? markedPictureNumber(pictureNumbers, imageMarks.imageFileId)
		: null,
);
$effect(() => {
	const request = focusRequest;
	if (request > 0 && !isMobile()) untrack(() => textarea?.focus());
});
let effectiveLinkedSources = $derived(
	dedupeLinkedSourcesByFamily(
		selectedLinkedSources.filter(
			(source) =>
				isPromptReadyLinkedSource(source) &&
				!sourceOverlapsPendingAttachments(source),
		),
	),
);
// What the chips ask to know whether a picture will be shown to the model. With
// an Atlas profile selected the server reads the sources as text (its send gate
// is the old one), so no picture is excused there whatever the model can see.
let pictureOptions = $derived({
	selectedModelSupportsImages:
		selectedModelSupportsImages && !selectedAtlasProfile,
});
// The ledger decides, when it has an opinion. One pure state per pending
// attachment drives BOTH the chip and the send gate, so a chip that shows a
// spinner and a Send button that is open cannot disagree: `busy` is "not yet"
// and any failure is "not like this". A terminal ledger success with no
// readiness problem at all is the only state that lets Send through.
let pendingAttachmentStates = $derived(
	pendingAttachments.map((attachment) =>
		attachmentChipFailure(
			extractionJobs[attachment.artifact.id],
			attachment,
			pictureOptions,
		),
	),
);
// Some work is genuinely in flight — the only case a queued send will ever
// resolve on its own.
let hasBusyAttachment = $derived(
	pendingAttachmentStates.some((failure) => failure.kind === "busy"),
);
let hasUnreadyAttachment = $derived(
	pendingAttachmentStates.some((failure) => failure.kind !== "none"),
);
// A failure is not "still processing". A queued send waiting for the last busy
// attachment would never fire while a terminal failure is on screen, so the
// composer neither promises nor queues one for such a turn.
let hasAttachmentFailure = $derived(
	pendingAttachmentStates.some(
		(failure) =>
			failure.kind === "job" ||
			failure.kind === "readiness" ||
			failure.kind === "raw",
	),
);

// "Long-document comfort" (owner-approved mockup, 2026-09-06): an outline
// row clicked from a *past* message (MessageBubble) routes its quote
// request here via a small store, since that component has no direct
// handle on this composer. Rows clicked from the composer's own pending
// attachments call insertQuoteAtCursor directly instead — see the
// pending-attachment list below.
let handledComposerQuoteNonce = -1;
$effect(() => {
	const request = $composerQuoteRequest;
	if (!request || request.nonce === handledComposerQuoteNonce) return;
	handledComposerQuoteNonce = request.nonce;
	insertQuoteAtCursor(request.text);
	clearComposerQuoteRequest();
});

// Issue 7.4 fix pass — C1's guarantee (re-entrant send() must not dispatch
// while a gate check is outstanding) is now enforced via `sendPending`, which
// spans the whole `beforeSend()` await (the page's network round-trip AND,
// if it opens, the warning modal), so the Send button (and, via send()'s own
// guard below, the Enter-key path) stays disabled the whole time.
let canSend = $derived(canSubmitMessageText(message) && !sendPending);
// Reason the send button is disabled despite non-empty, non-overlength text
// (ADR-0043 Slice 10, Fix B). The blocking flags come from canSubmitMessageText,
// plus the Issue 7.4 cloud-warning gate (see canSend above).
//
// "preparing" used to be a third reason here, rendered as a gray "Extracting
// document text…" line. The pending chip's spinner says the same thing without
// promising a duration, so the reason is gone — the gate itself is not: Send
// stays disabled while `hasUnreadyAttachment`.
let sendDisabledHint = $derived(
	!canSend && message.trim().length > 0 && !isOverMaxLength
		? sendPending && checkingCloudWarning
			? "checkingPrivacy"
			: isUploadingAttachment
				? "uploading"
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
// Both of the composer's accept surfaces — the hidden `<input>` below and the
// phone sheet's "Files on this phone" row — publish THIS string and nothing
// else. `buildAcceptAttribute` is deliberately not memoised (the disabled set
// moves with backend health), so it is derived once per gate change instead of
// once per render. An open gate (the default, and the failure mode) returns
// the memoised full string unchanged.
let chatAcceptAttribute = $derived(
	buildAcceptAttribute("chat", $disabledFileTypeIds),
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

/**
 * The chip's short danger clause for one blocked attachment, in the user's
 * language — or null when nothing has gone wrong.
 *
 * The chip is the surface now. A terminal ledger row's own error clause is
 * already the most specific thing to say and is reused rather than re-worded;
 * a no-job readiness refusal gets a deliberately short clause here, because
 * its full sentence belongs in the details popover one hover away.
 */
function attachmentChipStatus(failure: AttachmentChipFailure): string | null {
	if (failure.kind === "job") return $t(asI18nKey(failure.errorKey));
	if (failure.kind === "readiness") {
		return $t(asI18nKey(attachmentReadinessStatusKey(failure.reason)));
	}
	if (failure.kind === "raw") return $t("composerChips.failureGeneric");
	return null;
}

/**
 * The full sentence a failed chip reveals on hover/focus.
 *
 * Three sources, in order of how specific they are:
 *
 *  1. A terminal ledger row: its own `ExtractionErrorCode` names the cause, and
 *     the sentence says what the user can do about it (Retry where Retry can
 *     help, remove/re-upload where it cannot). A canceled read gets its own
 *     sentence, because "could not be read" is not what happened.
 *  2. Otherwise the server's `readinessErrorCode`, whose `chat.attachmentReadiness.*`
 *     sentence is the full explanation in the user's language.
 *  3. Otherwise the server's own sentence. English, but a server that predates
 *     the codes should still say something specific rather than nothing.
 */
function attachmentFailureDetail(
	attachment: PendingAttachment,
	failure: AttachmentChipFailure,
	translate: (key: I18nKey, params?: Record<string, string | number>) => string,
): string | null {
	if (failure.kind === "job") {
		if (failure.canceled) {
			return translate(asI18nKey("chat.extraction.failureDetailCanceled"));
		}
		if (failure.errorCode) {
			return translate(
				asI18nKey(
					failure.retryable
						? "chat.extraction.failureDetailRetryable"
						: "chat.extraction.failureDetail",
				),
				{
					reason: translate(
						asI18nKey(`chat.extraction.error.${failure.errorCode}`),
					),
				},
			);
		}
		return failure.retryable
			? translate(asI18nKey("chat.attachmentReadiness.extraction_retryable"))
			: translate(asI18nKey("chat.extraction.failureDetailNoReason"));
	}
	if (failure.kind === "readiness") {
		return translate(asI18nKey(attachmentReadinessReasonKey(failure.reason)));
	}
	if (failure.kind === "raw") return attachment.readinessError ?? null;
	return null;
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
// Chips redesign — the Atlas profile moves OUT of the label and into the
// muted meta clause ("Atlas · In-Depth · ~10-20 min"), so the pill reads as
// one kind with a setting rather than three different chips.
let atlasChipMeta = $derived(
	selectedAtlasProfile
		? $t("composerChips.atlasMeta", {
				profile: selectedAtlasProfileLabel,
				time: $t(atlasProfileTimeKey(selectedAtlasProfile)),
			})
		: null,
);
// Does the composer have anything to say about the next turn? Drives the
// single chip row's existence; the over-length counter can bring the row
// back on its own, since it now lives inside it.
let hasComposerChips = $derived(
	(composerCommandRegistryEnabled && Boolean(pendingSkill)) ||
		(forceWebSearch && !selectedAtlasProfile) ||
		Boolean(selectedAtlasProfile) ||
		pendingAttachments.length > 0 ||
		pictureRefs.length > 0 ||
		Boolean(imageMarks) ||
		optimisticUploads.length > 0 ||
		pendingQuotes.length > 0 ||
		(composerCommandRegistryEnabled && effectiveLinkedSources.length > 0),
);
// One-time "Press / to start typing" coach hint (ADR-0043 Slice 10, Fix C).
// Persists dismissal across sessions via localStorage; SSR-guarded.
const SLASH_SHORTCUT_HINT_KEY = "alfyai:composer:slashHintDismissed";
let slashHintDismissed = $state(false);
let isComposerFocused = $state(false);
// Not on a touch screen (FB-9): there is no "/" key to press, only wasted space.
let showSlashHint = $derived(
	showSlashHintProp &&
		isHydrated &&
		!slashHintDismissed &&
		!isComposerFocused &&
		chordsAreDrawn(),
);

$effect(() => {
	resolvedConversationId = conversationId;
	if (!conversationId) {
		ensureDraftConversationPromise = null;
	}
});

// Per-conversation incognito state — ONE-WAY (docs/plans/incognito-one-way-
// spec.md). `incognitoOn` mirrors the conversation's stored value, held
// locally so a landing-page arm (before the conversation exists) survives
// the null → id creation step without waiting on a round trip, and so
// switching between an incognito and a normal conversation on the chat page
// still reads each conversation's own flag rather than sticking on the last
// one shown. There is no toggle any more: this can only ever become true.
let incognitoOn = $state(false);
// Tracks the conversation id the current `incognitoOn` value was synced
// against, so a `memoryIncognito` flip while still bound to the SAME id
// (armed locally on the landing page while conversationId is still null) is
// picked up without waiting for the id itself to change.
let incognitoSyncedConversationId = $state<string | null>(null);

$effect(() => {
	const boundId = conversationId ?? null;
	if (incognitoSyncedConversationId !== boundId) {
		// The conversation identity changed, including the null → newly-
		// created-id step. A landing-page arm rides on `memoryIncognito` all
		// the way through the creation call (see +page.svelte), so by the
		// time boundId updates the new binding's own prop is normally already
		// true — but if it is not (a caller that does not wire the flag
		// through creation, or a prop update lagging one tick behind), fall
		// back to a direct PATCH rather than silently dropping the arm.
		const wasArmedBeforeConversationExisted =
			incognitoSyncedConversationId === null && incognitoOn;
		incognitoSyncedConversationId = boundId;
		if (
			boundId !== null &&
			wasArmedBeforeConversationExisted &&
			!memoryIncognito
		) {
			void persistIncognitoFallback(boundId);
			return;
		}
		incognitoOn = memoryIncognito;
		return;
	}
	// Same binding. Bound to NO conversation — the landing composer before
	// one exists — the prop is the whole truth and this mirrors it in both
	// directions: there is no stored flag to protect yet, only the landing
	// page's own armed state, and "New chat" can disarm that (it is the way
	// out of an incognito landing that has not sent anything). Without this
	// the mask face and the incognito placeholder survived the disarm and
	// the composer went on claiming incognito over a page that had let it
	// go. One-way is untouched: for a conversation that exists the flip to
	// true still wins and nothing can bring it back down, because nothing
	// can — the server refuses to disarm a conversation at all.
	if (boundId === null) {
		incognitoOn = memoryIncognito;
		return;
	}
	if (memoryIncognito && !incognitoOn) {
		incognitoOn = true;
	}
});

/**
 * The fallback described in spec §1: PATCHes `memoryIncognito: true` for a
 * conversation that already exists, with no messages yet, but was not
 * created with the flag. Best-effort — the face and the stage tint already
 * reflect the local arm regardless of whether this round trip lands, and the
 * server's empty-conversation guard means it is always safe to retry.
 */
async function persistIncognitoFallback(id: string): Promise<void> {
	try {
		await setConversationMemoryIncognito(id);
		onMemoryIncognitoChange?.(true, id);
	} catch {
		// See above — nothing else to do with a failure here.
	}
}

// Incognito redesign — while the flag is on the action row grows a fifth
// face, a mask in ink, and the placeholder says what the mask means. The
// face opens a small card that says what incognito means for this chat and,
// one-way, offers a new chat instead of a switch back to normal.
let showIncognitoPopover = $state(false);
let incognitoFaceTrigger = $state<HTMLButtonElement | undefined>(undefined);

function toggleIncognitoPopover() {
	showIncognitoPopover = !showIncognitoPopover;
	if (showIncognitoPopover) {
		showToolsMenu = false;
		showConnectionsPopover = false;
		closeCommandTray();
	}
}

function closeIncognitoPopover(reason: IncognitoPopoverCloseReason) {
	showIncognitoPopover = false;
	// Escape hands focus back to the face it came from; a click elsewhere
	// already put focus where the user wanted it.
	if (reason === "escape") incognitoFaceTrigger?.focus({ preventScroll: true });
}

// The card and the face it hangs off both leave the DOM when the composer
// switches to a conversation that is not incognito (sidebar navigation away
// from an incognito chat — the one direction `incognitoOn` still moves).
// Focus may have been on either, and left alone it would fall to <body>, so
// it moves to the textarea, which is where the next thing the user does
// happens anyway. A pre-effect, because it has to see where focus is before
// the DOM update takes the face and the card away.
$effect.pre(() => {
	if (incognitoOn || !untrack(() => showIncognitoPopover)) return;
	showIncognitoPopover = false;
	const active = document.activeElement;
	const focusWasOnIncognito =
		active === incognitoFaceTrigger ||
		Boolean(active?.closest('[data-testid="incognito-popover"]'));
	if (focusWasOnIncognito) {
		void tick().then(() => textarea?.focus({ preventScroll: true }));
	}
});

/**
 * The popover's "New chat" pill — the one-way exit. Not a way to turn THIS
 * chat back to normal (it cannot be), but literally the same "start fresh"
 * the sidebar's own New chat button runs: the shared helper, not a fourth
 * copy of its four lines. This is the one New chat button that can be
 * pressed while standing on the landing page — the armed landing has a mask
 * face too — which is exactly where a copy that only navigated did nothing,
 * because `goto("/")` from "/" is a navigation to nowhere.
 */
function startNewChatFromIncognito() {
	showIncognitoPopover = false;
	void startNewChat((href) => goto(href));
}

let composerPlaceholder = $derived(
	incognitoOn
		? $t(
				isPhone
					? "chat.incognitoPlaceholderShort"
					: "chat.incognitoPlaceholder",
			)
		: (placeholder ?? $t("chat.messagePlaceholder")),
);

// The placeholder on one line (RC-A, the owner's principle: short words that do not
// crowd a row). Beside a docked panel the field is 290-370 px and the placeholder
// that names the open item wrapped to two lines when its title was long: the text
// is cut at a word and ends in an ellipsis to fit the field's width, measured in
// the placeholder's own font, again whenever the field changes width (the panel
// animates it) or the fonts arrive. Without a width or a canvas (a test renderer)
// it is left as it is.
let textareaWidth = $state(0);
let placeholderFontEpoch = $state(0);
let fittedPlaceholder = $state<string | null>(null);
$effect(() => {
	const full = composerPlaceholder;
	const width = textareaWidth;
	void placeholderFontEpoch;
	const field = textarea;
	if (!field || width <= 0) {
		fittedPlaceholder = null;
		return;
	}
	const measure = placeholderMeasurer(field);
	fittedPlaceholder = measure
		? fitPlaceholder(full, fieldTextRoom(field), measure)
		: null;
});
$effect(() => {
	const field = textarea;
	if (!field || typeof ResizeObserver === "undefined") return;
	textareaWidth = field.clientWidth;
	const observer = new ResizeObserver(() => {
		textareaWidth = field.clientWidth;
	});
	observer.observe(field);
	return () => observer.disconnect();
});
$effect(() => {
	void document.fonts?.ready.then(() => {
		placeholderFontEpoch += 1;
	});
});

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
		connectionAccounts = result.connections ?? [];
	} catch {
		availableCapabilities = [];
		defaultOnCapabilities = new Set();
		connectionAccounts = [];
	} finally {
		activeCapabilities = computeActiveCapabilities();
	}
}

// The payload the composer sends as `enabledConnectionCapabilities`.
//
// With a per-account list it is the union of the accounts this conversation
// has left ON; without one (an older server) it falls back to the previous
// all-or-nothing behaviour. Either way the server intersects the result with
// what the user is actually served, so this can only ever narrow access.
function computeActiveCapabilities(): Set<string> {
	if (connectionAccounts.length > 0) {
		return new Set(
			capabilitiesForSelection(connectionAccounts, connectionsFlippedIds),
		);
	}
	return connectionsEnabled ? new Set(defaultOnCapabilities) : new Set();
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

	// Connections redesign — the per-account half of the same memory. A draft
	// whose accounts were flipped carries the flips across creation, exactly
	// as the master switch above does.
	if (wasDraft && connectionsFlippedIds.size > 0) {
		persistDisabledIds(boundId, connectionsFlippedIds);
	} else {
		connectionsFlippedIds = readDisabledIds(boundId);
	}
});

// Derives the active capability set from the current selection. Also covers
// the initial load via `loadActiveCapabilities` above (redundant assignment
// there, kept for the race-safety note on that function).
$effect(() => {
	// Read every dependency so the effect re-runs on any of them.
	void connectionsEnabled;
	void defaultOnCapabilities;
	void connectionAccounts;
	void connectionsFlippedIds;
	activeCapabilities = computeActiveCapabilities();
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

// Connections redesign — the plug now OPENS the account list rather than
// flipping a single switch. It still opens on a server that doesn't send the
// account list; the popover then just shows the master switch.
function openConnectionsPopover() {
	if (!hasConnections) return;
	showConnectionsPopover = !showConnectionsPopover;
	if (showConnectionsPopover) showIncognitoPopover = false;
}

function rememberConnectionSelection() {
	const id = conversationId ?? resolvedConversationId;
	if (id) persistDisabledIds(id, connectionsFlippedIds);
}

function handleToggleConnectionsMaster() {
	if (connectionAccounts.length === 0) {
		toggleConnections();
		return;
	}
	connectionsFlippedIds = toggleMaster(
		connectionAccounts,
		connectionsFlippedIds,
	);
	connectionsEnabled = masterIsOn(connectionAccounts, connectionsFlippedIds);
	rememberConnectionSelection();
}

function handleToggleConnectionAccount(id: string) {
	connectionsFlippedIds = toggleAccount(connectionsFlippedIds, id);
	connectionsEnabled = masterIsOn(connectionAccounts, connectionsFlippedIds);
	rememberConnectionSelection();
}

// The count on the plug, so the composer says how much is reaching this
// message without opening anything.
const activeConnectionCount = $derived(
	connectionAccounts.length > 0
		? readyCount(connectionAccounts, connectionsFlippedIds).on
		: connectionsEnabled
			? defaultOnCapabilities.size
			: 0,
);

// The denominator the tooltip reads. With no per-account list from the server
// the honest total is how many capabilities the user is served, which is what
// the old all-or-nothing switch was counting all along.
const totalConnectionCount = $derived(
	connectionAccounts.length > 0
		? readyCount(connectionAccounts, connectionsFlippedIds).total
		: availableCapabilities.length,
);

// ── Direction B: the three icons on the bar ──────────────────────────
//
// Everything the bar draws comes from composer-bar.ts, so the on-states, the
// badge and the wording are one set of rules rather than three sets of
// conditions in the markup. `resolveTooltip` is the only local piece: it
// turns the key-and-parameters the module returns into a sentence.
function resolveTooltip(tooltip: ComposerTooltip): string {
	return $t(tooltip.key, tooltip.params);
}

let attachedCount = $derived(pendingAttachments.length);
let linkedCount = $derived(
	composerCommandRegistryEnabled ? effectiveLinkedSources.length : 0,
);
let attachOn = $derived(attachIsOn(attachedCount, linkedCount));
let accountsOn = $derived(accountsIsOn(hasConnections, activeConnectionCount));
let accountsCountBadge = $derived(
	hasConnections ? accountsBadge(activeConnectionCount) : null,
);
let thinkingIsOn = $derived(reasoningDepth === "thorough");

let attachLabel = $derived(
	resolveTooltip(attachTooltip(canAttach, attachedCount, linkedCount)),
);
let accountsLabel = $derived(
	resolveTooltip(
		accountsTooltip(
			hasConnections,
			activeConnectionCount,
			totalConnectionCount,
		),
	),
);
let thinkingLabel = $derived(resolveTooltip(thinkingTooltip(thinkingIsOn)));

// The ring is a measurement, not a switch — so it appears once there is
// something to measure and stays away until then. A ring reading "0" with a
// full outline is a control that looks live and answers nothing.
let hasContextToShow = $derived(
	contextStatus !== null ||
		composerArtifacts.length > 0 ||
		totalTokens > 0 ||
		totalCostUsd > 0,
);

// The `autofocus` prop's one job: put the caret in the box after the textarea
// exists. It reads `textarea` so the effect waits for `bind:this` rather than
// firing into a null ref on the first pass, and it never re-fires afterwards
// because neither value changes again on a page the user is already typing in.
$effect(() => {
	if (!autofocus || !textarea) return;
	const field = textarea;
	const frame = requestAnimationFrame(() => field.focus());
	return () => cancelAnimationFrame(frame);
});

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

// Where the command tray stands. It used to be an offset from the composer: on
// a desktop it hung `bottom: calc(100% - 0.4rem)` above it, as tall as 23rem
// (or the window less 12rem) whatever room there really was up there; on a
// phone it was pinned 10.5rem above the window's bottom edge. Both were drawn
// for a composer at the bottom of a conversation. The new-chat and project
// pages put the greeting band above the composer and the board below it, so on
// a desktop the tray ran off the top of the window — the highlighted first row
// with it — and on a phone it lay over the composer it was being typed into.
//
// So it is painted in <body> and placed like the composer's other popups
// (`followAnchor`, anchored-popup.ts), from the composer's own rectangle: above
// it when it fits there, below it when it does not and there is more room on
// screen (the part of the window under a phone's keyboard is not room), always
// inside the window, its rows scrolling in whatever height it is given. It
// follows the composer while it is open: the home page's composer glides.
$effect(() => {
	const tray = commandTrayElement;
	if (!showCommandTray || !tray) return;
	const maxHeight = isPhone
		? COMMAND_TRAY_PHONE_MAX_HEIGHT
		: COMMAND_TRAY_MAX_HEIGHT;
	const stopFollowing = followAnchor({
		anchor: () => composerBox,
		popup: tray,
		maxHeight,
		width: (composer) =>
			Math.min(COMMAND_TRAY_MAX_WIDTH, composer.width * 0.95),
		align: "center",
		visibleViewport: true,
		onPlace: (style) => {
			commandTrayStyle = style;
		},
	});
	return () => {
		stopFollowing();
		commandTrayStyle = COMMAND_TRAY_UNPLACED_STYLE;
	};
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
			// A draft restored mid-extraction carries the ledger row. Adopting it
			// here is what makes the chip come back as "Reading…" and dashed
			// rather than as an ordinary attached file with a red readiness line
			// under it, for the second or so before the first poll lands.
			applyExtractionJob(readExtractionJobDTO(attachment.extraction));
		}

		pendingAttachments = Array.from(merged.values());
		if (draftPictureOrder.length > 0) pictureOrder = [...draftPictureOrder];
		// A restored draft can carry a terminal success whose content verdict
		// never travelled with it. The poller will not ask again for a finished
		// job, so this is the moment to fetch that verdict once. Untracked: the
		// draft effect must not start depending on the poller's state.
		untrack(() => refreshStaleReadiness());
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
		extractionActionError = "";
		uploadState = "idle";
		optimisticUploads = [];
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

// A queued send is a promise that the file processing will finish on its own.
// If a terminal failure appears — the last busy attachment failing, or a second
// attachment arriving already failed — nothing will finish: the user has to
// retry or remove it. Leaving the flag set made it fire later, when removing
// the failed chip happened to reopen the gate — sending a message the user had
// queued for a file that was never used. A successful busy attachment still
// auto-sends above; only the failure state clears here.
$effect(() => {
	if (hasAttachmentFailure || (hasUnreadyAttachment && !hasBusyAttachment)) {
		queuedSendAfterProcessing = false;
	}
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
		extractionJobs = {};
		// The next conversation gets a fresh one-shot guard: an artifact the
		// caller re-adds later must be allowed to ask for its verdict again.
		readinessRefreshRequested.clear();
		optimisticUploads = [];
		selectedLinkedSources = [];
		pendingSkill = null;
		pendingQuotes = [];
		attachmentError = "";
		extractionActionError = "";
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
		// The height just changed, so the scrollbar may have appeared or gone.
		// Re-read the client box here instead of waiting on a resize callback.
		textareaWidth = textarea.clientWidth;
	});
}

// Paste-to-attach (phase5-6 spec §3.6). The composer's FIRST paste handler:
// before this, the textarea had only the browser's native behaviour, and
// `insertQuoteAtCursor` below — which is an in-app outline pick and never
// touches the clipboard — is what must keep working unchanged.
//
// The rule lives in `decideClipboardAttachment`, deliberately: a clipboard
// carrying any `text/plain` flavour is a text paste, so copying from Word,
// Excel or a web page (all of which put an image on the clipboard beside the
// text) still pastes text exactly as it did yesterday. Only files with no text
// — a screenshot, a Finder/Explorer copy — become attachments, and only then
// is the event's default prevented.
function handlePaste(event: ClipboardEvent) {
	// A composer that cannot attach must still paste TEXT normally, so every
	// early return here leaves the event alone rather than swallowing it.
	// NOT gated on `canAttach`: that goes false while an upload is in flight,
	// and pasting during an upload is exactly the case the batch counter in
	// `uploadFiles` was fixed to survive.
	if (isComposerDisabled || !attachmentsEnabled) return;

	const decision = decideClipboardAttachment(event.clipboardData, {
		disabledEntryIds: $disabledFileTypeIds,
	});

	if (decision.preventDefault) {
		event.preventDefault();
		// Nothing to look at on this attach path: no picker closed, no drop
		// overlay faded out, just chips that appeared. So it is spoken.
		pasteAnnouncement =
			decision.files.length === 1
				? $t("chat.pasteAttached", { name: decision.files[0].name })
				: $t("chat.pasteAttachedMany", { count: decision.files.length });
		// Synchronous up to its first await, and it clears `attachmentError` —
		// which is why the refusal below is applied AFTER it, and only if it
		// left the line empty.
		void uploadFiles(decision.files);
	}

	const refusal = decision.refused[0];
	if (refusal && !attachmentError) {
		attachmentError = $t(refusal.errorKey as I18nKey, {
			name: refusal.name,
			ext: refusal.ext,
		});
	}
}

// Chips redesign (owner-approved boards, 2026-09-15): picking a section
// from a document's outline no longer pastes ~90 characters of the
// document's prose into the middle of the sentence the user is writing. It
// becomes its own chip, so the words in the textarea stay theirs.
//
// The quote itself is not thrown away: `expandQuotesIntoMessage` below
// splices every pending quote back in at send time, in pick order, exactly
// the text the old paste produced — so what reaches the model is unchanged.
function insertQuoteAtCursor(quote: string) {
	const text = quote.trim();
	if (!text) return;
	// Picking the same section twice is a no-op rather than two identical
	// pills, which the old paste could not avoid.
	if (pendingQuotes.some((entry) => entry.text === text)) return;
	quoteIdSeed += 1;
	pendingQuotes = [
		...pendingQuotes,
		{ id: `quote-${quoteIdSeed}`, text, label: quoteChipLabel(text) },
	];
	draftEmissionVersion += 1;
	void emitDraftChange();
	requestAnimationFrame(() => textarea?.focus());
}

function removePendingQuote(id: string) {
	pendingQuotes = pendingQuotes.filter((entry) => entry.id !== id);
	draftEmissionVersion += 1;
	void emitDraftChange();
}

/**
 * The message as the model sees it: every quote chip expanded above the
 * typed text, separated the way the old cursor-splice separated them. With
 * no quote chips this returns the typed text untouched, so the ordinary
 * send path is byte-identical to before.
 */
function expandQuotesIntoMessage(text: string): string {
	if (pendingQuotes.length === 0) return text;
	const quoted = pendingQuotes.map((entry) => entry.text).join("\n\n");
	const typed = text.trim();
	return typed ? `${quoted}\n\n${typed}` : quoted;
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
	const field = event.currentTarget as HTMLTextAreaElement;
	linkHighlightScrollTop = field.scrollTop;
	// A scrollbar that just took space narrowed the textarea's client box;
	// keep the mirrored viewport in step even if the ResizeObserver has not
	// reported the content-box change yet.
	textareaWidth = field.clientWidth;
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
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
		// A turn made only of quote chips is a real turn: the chips expand
		// into the message on send, so "nothing typed" is not "nothing to
		// send" any more.
		(text.trim().length > 0 || pendingQuotes.length > 0) &&
		text.length <= maxLength &&
		!isUploadingAttachment &&
		!hasUnreadyAttachment
	);
}

// What the message carries of its pictures: the card pictures under the numbers
// the chips showed (the server keeps them), and the same numbers for the bubble
// so its thumbnails exist from its first paint (F13). Nothing without a card
// picture: the server records picture metadata only then, so the bubble the
// server sends back looks the same.
function picturePayload(): {
	pictureRefs?: PictureRef[];
	pictures?: UserPicturesMetadata;
	imageMarks?: ImageMarksRequest;
	markedPicture?: SendPayload["markedPicture"];
} {
	// The marks ride with their picture: one not attached already is added as a
	// ref under the number its chip showed (F14), so the server paints the marks
	// whether or not the panel is still open on it when the turn is sent.
	const marked = imageMarks;
	const addMarkedRef =
		marked !== null &&
		!pictureRefs.some((ref) => ref.imageFileId === marked.imageFileId);
	const marksPart = marked
		? {
				imageMarks: {
					imageFileId: marked.imageFileId,
					marks: marked.marks.map((mark) => ({ ...mark })),
				},
				markedPicture: {
					artifactId: marked.artifactId,
					name: marked.name,
					addedRef: addMarkedRef,
				},
			}
		: {};
	if (pictureRefs.length === 0 && !addMarkedRef) return marksPart;
	const refs = pictureRefs.flatMap((ref) => {
		const number = pictureNumbers.get(
			pictureKey({ kind: "ref", imageFileId: ref.imageFileId }),
		);
		return number === undefined
			? []
			: [{ imageFileId: ref.imageFileId, number, name: ref.name }];
	});
	const uploads = pendingAttachments.flatMap((attachment) => {
		const number = pictureNumbers.get(
			pictureKey({ kind: "upload", artifactId: attachment.artifact.id }),
		);
		return number === undefined
			? []
			: [{ artifactId: attachment.artifact.id, number }];
	});
	if (marked && addMarkedRef && markedNumber !== null) {
		refs.push({
			imageFileId: marked.imageFileId,
			number: markedNumber,
			name: marked.name,
		});
	}
	refs.sort((a, b) => a.number - b.number);
	return {
		...marksPart,
		pictureRefs: refs.map(({ imageFileId, number }) => ({
			imageFileId,
			number,
		})),
		pictures: {
			refs,
			...(uploads.length > 0 ? { uploads } : {}),
			open: null,
			marks: null,
		},
	};
}

function buildSendPayload(nextMessage = message): SendPayload {
	return {
		// Chips redesign — quote chips expand back into the message here,
		// at the last moment before it leaves the composer, so everything
		// downstream (the send gate, the page, the server) keeps seeing one
		// plain string exactly as the old cursor-paste produced.
		message: expandQuotesIntoMessage(nextMessage).trim(),
		attachmentIds: pendingAttachments.map(
			(attachment) => attachment.artifact.id,
		),
		attachments: pendingAttachmentArtifacts,
		pendingAttachments: pendingAttachments.map((attachment) => ({
			...attachment,
		})),
		...picturePayload(),
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
	extractionJobs = {};
	// A sent attachment's guard is consumed; re-attaching the same artifact (a
	// duplicate byte-identical upload reuses its id) must ask again.
	readinessRefreshRequested.clear();
	selectedLinkedSources = [];
	pendingSkill = null;
	pendingQuotes = [];
	attachmentError = "";
	extractionActionError = "";
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
			(nextMessage.trim().length > 0 || pendingQuotes.length > 0) &&
			nextMessage.length <= maxLength &&
			(isUploadingAttachment || hasBusyAttachment) &&
			// A turn carrying a terminally failed attachment can never become
			// sendable by waiting, so there is nothing honest to promise.
			!hasAttachmentFailure
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

// Returns the host's stop promise (the page awaits its runtime going idle)
// so callers that must not race the in-flight turn — `/new`, which navigates
// away straight after — can await it. The Stop button ignores the result.
function stop(): void | Promise<void> {
	if (isComposerDisabled) return;
	if (!canStop) return;
	const stopped = onStop?.();
	showToolsMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	if (isMobile()) {
		textarea?.blur();
	}
	return stopped;
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
	isPhone = isPhoneViewport();
	// Which presentation "attach" and the "+" menu use follows the window, so
	// a desktop window dragged narrow gets the phone treatment without a
	// reload — and gives it back when widened.
	const stopWatchingPhoneViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
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
	// One poller for the composer's whole attachment list, armed by the
	// effect below only while something it holds is unfinished. Created here
	// rather than in that effect so there is exactly one for the component's
	// lifetime, and exactly one thing to stop on teardown.
	extractionPoller = createExtractionPoller({
		getArtifactIds: () =>
			pendingAttachments.map((attachment) => attachment.artifact.id),
		onJobs: (jobs, readiness) => {
			const next = { ...extractionJobs };
			for (const job of jobs) {
				if (job.sourceArtifactId) next[job.sourceArtifactId] = job;
			}
			extractionJobs = next;
			applyAttachmentReadiness(readiness);
		},
		// A poll that fails is retried on the next tick; telling the user their
		// network hiccuped under a chip that is still correct would be noise.
		onError: () => undefined,
	});
	// A draft restored on the first render may already hold a terminal success
	// whose content verdict only the status endpoint can supply. The draft
	// effect ran before this poller existed, so ask now that it does.
	refreshStaleReadiness();
	void ensureCapabilitiesLoaded();
	void fetchAvailableModels()
		.then((response) => {
			modelProviders = response.providers;
		})
		.catch(() => {
			// Non-fatal: the thinking toggle just stays visible by default.
		});
	return () => {
		window.removeEventListener("resize", adjustHeight);
		stopWatchingPhoneViewport();
		clearLongPress();
		extractionPoller?.stop();
		extractionPoller = null;
		if (textareaValueSyncFrame !== null) {
			cancelAnimationFrame(textareaValueSyncFrame);
		}
	};
});

// Arm or disarm the poller whenever the tracked set changes. The poller does
// the rest itself: it stops as soon as every job it has seen is terminal, so
// a composer holding three finished attachments costs nothing.
$effect(() => {
	const trackedIds = pendingAttachments
		.map((attachment) => attachment.artifact.id)
		.join(",");
	void trackedIds;
	extractionPoller?.sync();
});

// The polite live region's one sentence. `changed()` is what keeps this from
// firing on every poll: it answers only for the documents whose state really
// moved, and a batch of them becomes ONE string, so five files finishing
// together is one announcement rather than five.
$effect(() => {
	const changed = extractionAnnouncer.changed(
		pendingAttachments.flatMap((attachment) => {
			const job = extractionJobs[attachment.artifact.id];
			return job
				? [
						{
							artifactId: attachment.artifact.id,
							name: attachment.artifact.name,
							job,
						},
					]
				: [];
		}),
	);
	if (changed.length === 0) return;
	extractionAnnouncement = changed
		.map((entry) => {
			const attachment = pendingAttachments.find(
				(pending) => pending.artifact.id === entry.artifactId,
			);
			return `${entry.name}: ${$t(
				asI18nKey(
					extractionReasonKey(
						{
							status: entry.job.status,
							errorCode: entry.job.error?.code ?? null,
							retryable: entry.job.retryable,
						},
						{
							// The same rule the chip reads, so what a screen reader is
							// told is what the chip says.
							picture:
								attachment !== undefined &&
								isPictureForModel(attachment.artifact, pictureOptions),
						},
					),
				),
			)}`;
		})
		.join(". ");
});

// Everyday redesign — where "attach" goes.
//
// On a desktop it still hands straight to the OS, because a sheet offering
// one row that says "open the file picker" is a speed bump. On a phone the
// picker sheet adds three routes the OS hand-off cannot express in one tap —
// photos, the camera, and the document Library — so it is shown there and
// only there. See AttachmentPickerSheet.
function openFilePicker() {
	if (!canAttach) return;
	showToolsMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	if (isPhone) {
		attachmentSheetOpen = true;
		return;
	}
	fileInput?.click();
}

function closeAttachmentSheet() {
	attachmentSheetOpen = false;
}

function openSkillsPicker() {
	showToolsMenu = false;
	closeCommandTray();
	skillsPickerOpen = true;
}

function closeSkillsPicker() {
	skillsPickerOpen = false;
	requestAnimationFrame(() => textarea?.focus());
}

// The same landing as the "$" tray's selectSkill, minus the token surgery:
// nothing was typed, so there is no token to consume.
function selectSkillFromPicker(skill: SkillDiscoverySummary) {
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
	closeSkillsPicker();
}

// ── Long-press labels ────────────────────────────────────────────────
//
// A phone has no hover, so the tooltip that names each bar icon and its
// state has no way to arrive. Holding one for half a second shows the same
// sentence, which is the only affordance left that does not cost a tap.
function startLongPress(label: string) {
	clearLongPress();
	longPressTimer = setTimeout(() => {
		longPressLabel = label;
	}, 450);
}

function clearLongPress() {
	if (longPressTimer !== null) {
		clearTimeout(longPressTimer);
		longPressTimer = null;
	}
	longPressLabel = null;
}

/**
 * Keep the browser's own long-press gesture out of the way.
 *
 * Holding a bar icon is how a phone asks for the tooltip it has no hover to
 * show — but a hold on a button is also what every mobile browser reads as
 * "open the context menu", and Android Chrome raises one at ~500ms, right on
 * top of the label we just drew. iOS answers the same hold with the callout
 * and the selection magnifier. Both cancel the pointer, so the label can be
 * torn down by the very gesture that asked for it.
 *
 * These three faces carry an icon and nothing selectable, so there is nothing
 * the context menu could usefully offer on either pointer — a desktop
 * right-click on them has no items worth keeping either.
 */
function suppressLongPressMenu(event: Event) {
	event.preventDefault();
}

function toggleToolsMenu() {
	showToolsMenu = !showToolsMenu;
	if (showToolsMenu) {
		sourceManagerOpen = false;
		showConnectionsPopover = false;
		showIncognitoPopover = false;
		closeCommandTray();
		// The Skills row says how many are active. Fetched when the menu opens
		// rather than on mount: most sessions never open it, and a count that
		// is one visit stale is worse than one that is fetched on the visit.
		void loadSkillCount();
	}
	toolsMenuInitialOpen = null;
}

// The menu is a real menu, so closing it returns focus to the control that
// opened it rather than dropping focus on the body.
function closeToolsMenu() {
	showToolsMenu = false;
	toolsMenuInitialOpen = null;
	requestAnimationFrame(() => toolsMenuTrigger?.focus());
}

async function loadSkillCount() {
	try {
		const skills = await discoverSkills("");
		skillCount = skills.length;
	} catch {
		// A row that simply says "Skills" is a fine outcome; a row that says
		// "0 active" because a fetch failed is a lie.
		skillCount = null;
	}
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

// Forced web search has no switch in the "+" menu any more — the owner read
// it as saying the web was off until you turned it on, which it never was.
// Two ways in survive, and they are the two that only appear once you have
// asked for the force: `/web` sets it, and the chip above the composer shows
// it and calls this to clear it. Grounding without the force is unaffected;
// the model still searches whenever a question needs it.
function setForceWebSearch(enabled: boolean) {
	forceWebSearch = enabled;
}

function atlasProfileLabel(profile: AtlasProfile): string {
	if (profile === "exhaustive") return $t("composerTools.atlasExhaustive");
	if (profile === "in-depth") return $t("composerTools.atlasInDepth");
	return $t("composerTools.atlasOverview");
}

function atlasProfileTimeKey(profile: AtlasProfile): I18nKey {
	if (profile === "exhaustive") return "composerTools.atlasExhaustiveTime";
	if (profile === "in-depth") return "composerTools.atlasInDepthTime";
	return "composerTools.atlasOverviewTime";
}

// The muted "24 pp · 18k tok" clause. The numbers and the template key come
// from the pure presentation helper; only the localization happens here.
function chipMetaText(artifact: {
	name: string;
	mimeType?: string | null;
	tokenEstimate?: number;
	pageCount?: number;
	pageCountKind?: string | null;
}): string | null {
	const meta = attachmentChipMeta(artifact);
	if (!meta) return null;
	// A count clause and a token clause, or one of the two. The key already
	// names the unit the count is in; only the interpolation happens here.
	if ("pages" in meta && "tokens" in meta) {
		return $t(meta.key, { pages: meta.pages, tokens: meta.tokens });
	}
	if ("pages" in meta) return $t(meta.key, { pages: meta.pages });
	return $t(meta.key, { tokens: meta.tokens });
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
	argumentPlaceholderKey?: I18nKey;
};

// Commands that accept `/id rest of line` free text (currently /document's
// search query and /remember's note). Computed once — STATIC_COMPOSER_COMMANDS
// is a static, module-level catalog.
const COMMAND_IDS_WITH_ARGUMENT = STATIC_COMPOSER_COMMANDS.filter(
	(command) => command.argument,
).map((command) => command.id);

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

function getCommandTokenKey(
	token: ComposerCommandToken | ComposerCommandTokenWithArgument | null,
): string | null {
	if (!token) return null;
	return `${token.prefix}:${token.start}:${token.end}:${token.token}`;
}

function getCommandTrayRows(
	token: ComposerCommandToken | ComposerCommandTokenWithArgument | null,
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

	// A parsed `/cmd rest of line` token carries its own canonical `command`
	// id directly; a bare `findActiveComposerCommandToken` result (still
	// typing the command name, no argument text yet) does not.
	const commandQuery =
		"command" in token ? token.command : token.query.toLowerCase();
	const rows: CommandTrayRow[] = STATIC_COMPOSER_COMMANDS.filter(
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
		argumentPlaceholderKey: command.argument
			? asI18nKey(command.argument.placeholderKey)
			: undefined,
	}));

	// ADR-0061's `/depth` -> `/think` rename kept `/depth` working as a
	// hidden alias: it never appears while browsing `/` or filtering by a
	// partial prefix (no STATIC_COMPOSER_COMMANDS id starts with "depth"),
	// but typing it out in full still resolves to the aliased command so
	// Enter can select it.
	if (rows.length === 0) {
		const aliasTargetId = HIDDEN_COMPOSER_COMMAND_ALIASES[commandQuery];
		const aliasedCommand = STATIC_COMPOSER_COMMANDS.find(
			(command) => command.id === aliasTargetId,
		);
		if (aliasedCommand) {
			rows.push({
				...aliasedCommand,
				tokenLabel: `/${commandQuery}`,
				labelKey: asI18nKey(aliasedCommand.labelKey),
				descriptionKey: asI18nKey(aliasedCommand.descriptionKey),
				disabled: aliasedCommand.availability !== "available",
				statusKey:
					aliasedCommand.availability !== "available"
						? "composerCommands.comingSoon"
						: undefined,
				argumentPlaceholderKey: aliasedCommand.argument
					? asI18nKey(aliasedCommand.argument.placeholderKey)
					: undefined,
			});
		}
	}

	return rows;
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
		findActiveComposerCommandTokenWithArgument(
			text,
			cursor,
			COMMAND_IDS_WITH_ARGUMENT,
		) ?? findActiveComposerCommandToken(text, cursor);
	// Retire the message only when the token under the cursor has actually
	// changed. Every keystroke ends with a re-sync, including the keyup that
	// closes the very keystroke which set the message — clearing there made
	// every "missing argument" hint (and the skill-discovery error) blink out
	// of existence in the same press that produced it.
	const nextTokenKey = getCommandTokenKey(nextToken);
	if (nextTokenKey !== commandTraySyncedTokenKey) {
		commandTrayMessage = "";
		commandTraySyncedTokenKey = nextTokenKey;
	}
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

function consumeActiveCommandToken(replacement = ""): boolean {
	if (!textarea) return false;
	const activeToken = commandToken;
	const result = getMessageWithoutActiveCommandToken(activeToken, replacement);
	if (!result) return false;
	message = result.text;
	draftEmissionVersion += 1;
	void emitDraftChange();
	adjustHeight();
	requestAnimationFrame(() => {
		textarea?.setSelectionRange(result.cursor, result.cursor);
		textarea?.focus();
		// A non-empty replacement (currently only "$", for /skill) leaves a new
		// trigger character in the composer — refresh the tray from it instead
		// of leaving it closed.
		if (replacement) updateCommandTrayFromTextarea();
	});
	return true;
}

function getMessageWithoutActiveCommandToken(
	activeToken = commandToken,
	replacement = "",
): { text: string; cursor: number } | null {
	if (activeToken) {
		return {
			text:
				message.slice(0, activeToken.start) +
				replacement +
				message.slice(activeToken.end),
			cursor: activeToken.start + replacement.length,
		};
	}
	return replaceActiveComposerCommandToken(
		message,
		textarea?.selectionStart ?? message.length,
		replacement,
	);
}

function hasClearableComposerState(nextMessage: string): boolean {
	return (
		nextMessage.trim().length > 0 ||
		pendingAttachments.length > 0 ||
		pendingQuotes.length > 0 ||
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

function openComposerTools(section: "model" | "style") {
	toolsMenuInitialOpen = section;
	showToolsMenu = true;
}

// ADR-0061: /depth used to open the reasoning-depth picker in the composer
// tools menu; that ladder collapsed into the single thinking toggle, so the
// slash command now flips it directly instead of opening anything.
function toggleThinking() {
	onReasoningDepthChange?.(reasoningDepth === "quick" ? "thorough" : "quick");
}

// The `/new` command is a New chat button like any other, so it runs the
// same helper Header.svelte and Sidebar.svelte do — including the landing
// reset, which is what makes "/new" typed into an armed landing composer
// mean something rather than navigate to the page it is already on.
async function startNewConversationFromCommand() {
	// `/new` fired mid-turn used to navigate away with the stream still
	// running. Interrupt it first through the very same path the Stop button
	// uses, awaited so the abort has actually settled before the route
	// changes (the host resolves it once its runtime reports idle).
	await stop();
	await startNewChat((href) => goto(href));
}

async function submitMemoryNoteCommand(text: string) {
	try {
		await addMemoryNote(text);
		showToast({
			type: "success",
			message: $t("composerCommands.remember.saved"),
		});
	} catch {
		showToast({
			type: "error",
			message: $t("composerCommands.remember.error"),
		});
	}
}

async function exportConversationCommand() {
	const id = conversationId ?? resolvedConversationId;
	if (!id) {
		showToast({
			type: "error",
			message: $t("composerCommands.export.noConversation"),
		});
		return;
	}
	try {
		const { markdown, filename } = await fetchConversationMarkdownExport(id);
		saveBlobAsDownload(
			new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
			filename,
		);
	} catch {
		showToast({ type: "error", message: $t("composerCommands.export.error") });
	}
}

// Analytics is reported once, at the point a command actually RUNS — never
// on selection alone: a confirm-cancelled /clear, a /remember with no note,
// and a selection whose token could not be consumed are all no-ops and must
// not be counted. `postActivityEvent` drops an event with no conversation
// id, so the id has to be threaded through every call site (the composer's
// own prop wins, with the resolved id as the landing-page fallback — the
// same pair /export uses).
function recordCommandRun(commandName: string) {
	recordComposerCommandUsed(
		commandName,
		conversationId ?? resolvedConversationId,
	);
}

function selectCommand(command: CommandTrayRow) {
	if (command.skill) {
		selectSkill(command.skill);
		recordCommandRun("skill");
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
			recordCommandRun(command.id);
			clearComposerAfterSubmit();
		}
		return;
	}

	// /skill opens $ discovery mode instead of consuming the token outright:
	// the "/skill" text is replaced with "$" (leaving the trigger character
	// in place) and the tray reopens against it, matching typing "$" by hand.
	if (command.id === "skill") {
		const consumed = consumeActiveCommandToken("$");
		if (consumed) recordCommandRun(command.id);
		return;
	}

	const commandArgument =
		commandToken && "argument" in commandToken
			? commandToken.argument?.trim()
			: undefined;

	if (command.id === "remember" && !commandArgument) {
		commandTrayMessage = $t("composerCommands.remember.missingArgument");
		return;
	}

	// Same guard, before the token is consumed: a bare /instruction must say
	// what it is missing instead of swallowing the token and leaving the user
	// with an empty box and no dialog.
	if (command.id === "instruction" && !commandArgument) {
		commandTrayMessage = $t("composerCommands.instruction.missingArgument");
		return;
	}

	const consumed = consumeActiveCommandToken();
	finishCommandTrayClose();
	if (!consumed) return;
	recordCommandRun(command.id);

	switch (command.id) {
		case "model":
			openComposerTools("model");
			break;
		case "style":
			openComposerTools("style");
			break;
		case "think":
			toggleThinking();
			break;
		case "quick":
			onReasoningDepthChange?.("quick");
			break;
		case "thorough":
			onReasoningDepthChange?.("thorough");
			break;
		case "attach":
			openFilePicker();
			break;
		case "document":
			openDocumentPicker(commandArgument ?? "");
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
		case "new":
			void startNewConversationFromCommand();
			break;
		case "remember":
			void submitMemoryNoteCommand(commandArgument as string);
			break;
		case "instruction":
			onInstructionCommand?.(commandArgument as string);
			break;
		case "export":
			void exportConversationCommand();
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
		// On a phone the tray is moved to <body> so its `position: fixed`
		// means the viewport, which puts it outside this node — without this
		// every tap on a command row would dismiss the tray before the click
		// that chooses the command ever landed.
		if (target instanceof Node && commandTrayElement?.contains(target)) {
			return;
		}
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

/**
 * The refusal the upload endpoints would answer this file with, already
 * translated — or `null` when they would take it.
 *
 * Same table, same reasons, one round trip earlier. The `<input accept>` has
 * already filtered a PICKED file, so this is what covers the two paths that
 * hand over whatever the user had: a drop (the chat pages pass the raw
 * `FileList` straight through) and a paste. It is also the only place the
 * MinerU-4 gate reaches those two paths — an open gate (the default, and the
 * failure mode) disables nothing.
 */
function uploadTypeRefusal(file: File): string | null {
	const admission = admitUpload(file.name, file.type || null);
	const reason = !admission.allowed
		? admission.reason
		: admission.entry && $disabledFileTypeIds.has(admission.entry.id)
			? ("formatNotEnabled" as const)
			: null;
	if (!reason) return null;
	return $t(UPLOAD_REJECT_I18N_KEYS[reason] as I18nKey, {
		name: file.name,
		ext: fileExtension(file.name).toUpperCase(),
	});
}

async function uploadFiles(files: FileList | readonly File[] | null) {
	if (!files) return;
	const selectedFiles = Array.from(files);
	if (selectedFiles.length === 0) return;
	uploadState = "uploading";
	attachmentError = "";
	extractionActionError = "";
	const optimisticIds: string[] = [];

	try {
		// The limit the server reports, seeded by the SSR shell and refreshed by
		// every upload intent. One number, not four copies of 100 MB.
		const maxFileSize = $maxFileUploadSizeBytes;
		const maxFileSizeMb = $maxFileUploadSizeMb;

		// Two failure buckets, because they read differently: a file the
		// server would refuse outright gets the sentence the server would have
		// sent ("Archives can't be opened on upload. Unpack it…"), where an
		// oversized one keeps the existing count line.
		const refused: string[] = [];
		const tooLarge: string[] = [];
		const validFiles: File[] = [];
		for (const file of selectedFiles) {
			const refusal = uploadTypeRefusal(file);
			if (refusal) {
				refused.push(refusal);
				continue;
			}
			if (file.size > maxFileSize) {
				tooLarge.push(
					`${file.name}: ${$t("chat.fileSizeExceeded", { size: (file.size / (1024 * 1024)).toFixed(0), max: maxFileSizeMb })}`,
				);
				continue;
			}
			validFiles.push(file);
		}
		const failureCount = refused.length + tooLarge.length;

		// Show the check failures immediately.
		if (failureCount > 0) {
			if (validFiles.length === 0) {
				throw new Error(
					refused.length === 0
						? $t("chat.allFilesTooLarge", { max: maxFileSizeMb })
						: failureCount === 1
							? refused[0]
							: $t("chat.uploadAllFailed", { count: failureCount }),
				);
			}
			attachmentError = $t("chat.uploadSomeFailed", { count: failureCount });
		}

		// OQ6 — the chip goes up now, not when the round trip ends. Creating a
		// conversation, storing 40 MB of bytes and getting an artifact id back
		// is exactly the stretch the composer used to spend showing nothing.
		for (const file of validFiles) {
			optimisticUploadSeed += 1;
			const id = `optimistic-upload:${optimisticUploadSeed}`;
			optimisticIds.push(id);
			optimisticUploads = [...optimisticUploads, { id, name: file.name }];
		}

		let targetConversationId = resolvedConversationId;
		if (!targetConversationId && ensureConversation) {
			targetConversationId = await ensureConversation();
			resolvedConversationId = targetConversationId;
		}
		if (!targetConversationId) {
			throw new Error($t("chat.uploadError"));
		}

		if (!onUploadFiles) {
			// No host to do the uploading. Without this the optimistic chips would
			// stand there forever and the composer would stay in `uploading`.
			throw new Error($t("chat.uploadError"));
		}

		// Increment, never assign: the file picker is closed while an upload is
		// in flight (`canAttach` goes false), but a DROP is not — the drop handler
		// only checks read-only and sending. Dropping two files while three are
		// uploading used to clobber the counter to 2, which the first batch's
		// three callbacks then drove to -1, retiring the "Uploading…" line and
		// opening the send gate while the second batch was still in flight.
		pendingUploadCount += validFiles.length;
		onUploadFiles({
			files: validFiles,
			conversationId: targetConversationId,
			done: addUploadedAttachment,
		});
	} catch (error) {
		dropOptimisticUploads(optimisticIds);
		uploadState = "idle";
		if (fileInput) fileInput.value = "";
		// No attachment will appear for this request. A queued "send when the
		// file is ready" has nothing left to wait for, so it must not fire the
		// moment the upload state goes idle.
		queuedSendAfterProcessing = false;
		attachmentError =
			error instanceof Error
				? error.message
				: $t("chat.uploadAttachmentFailed");
	}
}

let pendingUploadCount = $state(0);

function dropOptimisticUploads(ids: string[]) {
	if (ids.length === 0) return;
	const dropped = new Set(ids);
	optimisticUploads = optimisticUploads.filter(
		(upload) => !dropped.has(upload.id),
	);
}

/**
 * Retires ONE optimistic chip now that a file has finished, preferring the one
 * wearing the same name. A name match is not guaranteed — the server may have
 * auto-renamed the artifact on a collision — so the fallback retires the
 * oldest, which keeps the count right even when the labels cannot be paired.
 */
function retireOptimisticUpload(name: string | null) {
	if (optimisticUploads.length === 0) return;
	const index = name
		? optimisticUploads.findIndex((upload) => upload.name === name)
		: -1;
	const target = index >= 0 ? index : 0;
	optimisticUploads = optimisticUploads.filter(
		(_, position) => position !== target,
	);
}

function applyExtractionJob(job: DocumentExtractionJobDTO | null | undefined) {
	if (!job?.sourceArtifactId) return;
	extractionJobs = { ...extractionJobs, [job.sourceArtifactId]: job };
	extractionPoller?.observe(job);
}

function forgetExtractionJob(artifactId: string) {
	if (!(artifactId in extractionJobs)) return;
	const { [artifactId]: _removed, ...rest } = extractionJobs;
	extractionJobs = rest;
}

/**
 * Adopt the content verdicts the status endpoint returned beside the jobs.
 *
 * Keyed on the display artifact id the poll asked about, exactly like the
 * upload response seeded `promptReady`/`readinessError`. This is what turns a
 * terminal `succeeded` job with unusable text into the failure the chip and
 * the send gate already know how to draw — and what restores the X and Send
 * when the verdict is ready. The verdict is part of the attachment the draft
 * persists, so a reload is not sent back to the upload-time sentence.
 */
function applyAttachmentReadiness(snapshots: AttachmentReadinessSnapshot[]) {
	if (snapshots.length === 0) return;
	const byArtifactId = new Map(
		snapshots.map((snapshot) => [snapshot.artifactId, snapshot]),
	);
	let changed = false;
	pendingAttachments = pendingAttachments.map((attachment) => {
		const snapshot = byArtifactId.get(attachment.artifact.id);
		if (!snapshot) return attachment;
		// An answer is what the one-shot refresh was waiting for, whether or
		// not it changed anything.
		readinessRefreshRequested.delete(attachment.artifact.id);
		if (
			attachment.promptReady === snapshot.promptReady &&
			(attachment.promptArtifactId ?? null) === snapshot.promptArtifactId &&
			(attachment.readinessError ?? null) === snapshot.readinessError &&
			(attachment.readinessErrorCode ?? null) === snapshot.readinessErrorCode
		) {
			return attachment;
		}
		changed = true;
		return {
			...attachment,
			promptReady: snapshot.promptReady,
			promptArtifactId: snapshot.promptArtifactId,
			readinessError: snapshot.readinessError,
			readinessErrorCode: snapshot.readinessErrorCode,
		};
	});
	if (changed) {
		draftEmissionVersion += 1;
		void emitDraftChange();
	}
}

// Artifacts already asked for the one readiness read the poller cannot make on
// its own. A terminal `succeeded` job disarms the poller, so an upload response
// (or a restored draft) carrying that job is the only place its content
// verdict has not arrived yet. One refresh per artifact closes the gap; the
// set is what keeps a best-effort readiness read from becoming a retry loop.
const readinessRefreshRequested = new Set<string>();

/**
 * Ask once for the verdict the poller cannot see.
 *
 * A `succeeded` ledger row says the read finished, not that what it produced
 * is usable. The upload route mints its `still_preparing` sentence before the
 * job runs and (now) re-resolves readiness after a terminal verdict, so this
 * is mainly the mixed-version/deploy-window defense: an upload response from
 * an older route — or one that answered before the readiness write landed —
 * can still carry that pre-job sentence, or no code at all, beside a terminal
 * success. The status endpoint supplies the real verdict, and the poller will
 * never ask again for a terminal job, so the composer asks here: after the
 * upload response, a restored draft, or the poller exists in `onMount`.
 *
 * Deliberately not an effect: it must not retry on every render. The set
 * above, cleared when a verdict arrives, on a reset, and when the composer is
 * sent, is the one-shot guard.
 */
function refreshStaleReadiness(): void {
	const poller = extractionPoller;
	if (!poller) return;
	let requested = false;
	for (const attachment of pendingAttachments) {
		const job = extractionJobs[attachment.artifact.id];
		if (!job || job.status !== "succeeded") continue;
		if (attachment.promptReady) continue;
		const code = attachment.readinessErrorCode ?? null;
		if (code !== null && code !== "still_preparing") continue;
		if (readinessRefreshRequested.has(attachment.artifact.id)) continue;
		readinessRefreshRequested.add(attachment.artifact.id);
		requested = true;
	}
	if (requested) void poller.refresh();
}

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
		applyExtractionJob(readExtractionJobDTO(result.attachment.extraction));
		retireOptimisticUpload(result.attachment.artifact.name);
		extractionPoller?.sync();
		// The upload response can already carry a terminal success while the
		// content verdict lives only on the status endpoint.
		refreshStaleReadiness();
		draftEmissionVersion += 1;
		void emitDraftChange();
	} else {
		attachmentError = `${result.fileName}: ${result.error}`;
		retireOptimisticUpload(result.fileName);
		// A send queued while this file was uploading promised "when processing
		// finishes" — but it failed, and no chip exists to retry or remove. If
		// the flag stayed set, the auto-send effect would fire as soon as the
		// upload state went idle and send the message without the file.
		queuedSendAfterProcessing = false;
	}
	pendingUploadCount -= 1;
	if (pendingUploadCount <= 0) {
		uploadState = "idle";
		if (fileInput) fileInput.value = "";
	}
}

function removePendingAttachment(id: string) {
	pendingAttachments = pendingAttachments.filter(
		(attachment) => attachment.artifact.id !== id,
	);
	forgetExtractionJob(id);
	readinessRefreshRequested.delete(id);
	extractionPoller?.sync();
	if (pendingAttachments.length === 0) {
		queuedSendAfterProcessing = false;
	}
	draftEmissionVersion += 1;
	void emitDraftChange();
}

/**
 * Retry and Cancel act on the artifact, so a document with no row yet (one
 * that predates the ledger) needs no special case here — the endpoint
 * materialises one. A failure to reach the endpoint is shown as its own line
 * rather than mutating the chip: the chip still reflects the last state the
 * SERVER reported, which is the only state that is true.
 */
async function retryAttachmentExtraction(
	event: MouseEvent,
	artifactId: string,
	name: string,
) {
	await runChipExtractionAction(event, artifactId, async () => {
		try {
			applyExtractionJob(await retryExtraction(artifactId));
			extractionPoller?.sync();
		} catch {
			extractionActionError = $t("chat.extraction.retryFailed", { name });
		}
	});
}

async function cancelAttachmentExtraction(
	event: MouseEvent,
	artifactId: string,
	name: string,
) {
	await runChipExtractionAction(event, artifactId, async () => {
		try {
			applyExtractionJob(await cancelExtraction(artifactId));
			extractionPoller?.sync();
		} catch {
			extractionActionError = $t("chat.extraction.cancelFailed", { name });
		}
	});
}

/**
 * The in-flight guard and the focus rescue, shared by both chip controls.
 *
 * Pressing Retry or Cancel usually makes the button that was pressed
 * disappear — Retry requeues the job, so the chip swaps Retry for Cancel —
 * and a keyboard user was then left on `<body>`, at the top of the document,
 * with no idea where they had been. Focus moves to the chip's own control,
 * its ×, which is the one thing in that `<li>` that is always there.
 */
async function runChipExtractionAction(
	event: MouseEvent,
	artifactId: string,
	run: () => Promise<void>,
) {
	if (extractionActionIds.has(artifactId)) return;
	const item = (event.currentTarget as HTMLElement | null)?.closest("li");
	extractionActionError = "";
	extractionActionIds = new Set(extractionActionIds).add(artifactId);
	try {
		await run();
	} finally {
		const next = new Set(extractionActionIds);
		next.delete(artifactId);
		extractionActionIds = next;
		await tick();
		restoreChipFocus(item);
	}
}

function restoreChipFocus(item: Element | null | undefined) {
	if (!item?.isConnected) return;
	const active = document.activeElement;
	// Still somewhere inside the chip (the button survived, or the user moved
	// on themselves): leave it alone.
	if (active && active !== document.body && item.contains(active)) return;
	// Retry requeues the job, which puts the chip into its busy state — and a
	// busy chip has no × to land on. The chip root is a programmatic focus
	// stop (tabindex -1) exactly for this: focus stays beside the file the
	// action was about instead of falling to <body>.
	const target =
		item.querySelector<HTMLElement>(".composer-chip__remove") ??
		item.querySelector<HTMLElement>(".composer-chip");
	target?.focus();
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
		findActiveComposerCommandTokenWithArgument(
			message,
			cursor,
			COMMAND_IDS_WITH_ARGUMENT,
		) ?? findActiveComposerCommandToken(message, cursor);
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
			bind:this={commandTrayElement}
			class="command-tray"
			role="listbox"
			aria-label={$t('composerCommands.trayLabel')}
			id="composer-command-tray"
			data-state={commandTrayClosing ? 'closing' : 'open'}
			style={commandTrayStyle}
			use:portalToBody
			onanimationend={handleCommandTrayAnimationEnd}
		>
			{#if visibleCommandTrayRows.length > 0}
				<div
					class="sr-only"
					role="status"
					aria-live="polite"
					data-testid="composer-command-announcer"
				>
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
						{#if command.argumentPlaceholderKey}
							<span class="command-argument-hint">{$t(command.argumentPlaceholderKey)}</span>
						{/if}
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

	<div bind:this={composerBox} class="message-composer relative z-[2] flex min-h-[70px] flex-col rounded-[1.25rem] border border-border px-[8px] pt-[8px] pb-0 transition-all duration-150 focus-within:border-focus-ring md:min-h-[78px] md:px-[10px] md:pt-[10px]">
		<input
			bind:this={fileInput}
			type="file"
			class="hidden"
			multiple
			accept={chatAcceptAttribute}
			disabled={isComposerDisabled}
			onchange={(event) => uploadFiles((event.currentTarget as HTMLInputElement).files)}
		/>
		<!-- The field wrapper exactly matches the textarea's border box, so the
		     clipping viewport can be pinned to it and never move. Only the
		     mirrored content INSIDE the viewport follows the scroll; moving the
		     clipping box itself is what blanked a full, scrolled composer. -->
		<div class="composer-field">
			<textarea
				data-testid="message-input"
				bind:this={textarea}
				bind:value={message}
				oninput={handleInput}
				onselect={handleSelect}
				onscroll={handleTextareaScroll}
				onkeydown={handleKeydown}
				onkeyup={handleKeyup}
				onpaste={handlePaste}
				onfocus={handleTextareaFocus}
				onblur={handleTextareaBlur}
				disabled={isComposerDisabled}
				aria-controls={showCommandTray ? 'composer-command-tray' : undefined}
				aria-activedescendant={activeCommandRow ? `composer-command-${activeCommandRow.id}` : undefined}
				placeholder={fittedPlaceholder ?? composerPlaceholder}
				class="composer-textarea min-h-[72px] w-full resize-none overflow-y-auto border-0 bg-transparent px-[13px] py-[7px] text-left text-[15px] leading-[1.42] font-serif text-text-primary placeholder:font-sans placeholder:text-[14px] placeholder:text-text-muted focus:outline-none focus:ring-0 md:min-h-[88px] md:px-[16px] md:py-[8px] md:text-[15px] md:leading-[1.35]"
				class:composer-textarea--link-overlay-active={composerTextSegments.length > 0}
				rows="1"
			></textarea>
			{#if composerTextSegments.length > 0}
				<!-- The viewport's width is the textarea's clientWidth, so when a
				     scrollbar takes space the mirrored lines wrap where the real
				     ones do. `width: 100%` is the pre-measurement fallback. -->
				<div
					class="composer-link-overlay"
					data-testid="composer-link-overlay"
					style:width={textareaWidth > 0 ? `${textareaWidth}px` : undefined}
				>
					<div
						class="composer-link-highlights"
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
				</div>
			{/if}
		</div>

	<!-- Chips redesign (owner-approved boards, 2026-09-15). Five stacked
	     lists — one per feature — become ONE wrapping row between the
	     textarea and the action row. The order is stable and deliberate:
	     behaviour chips (skill, web, Atlas) lead, material (files, images,
	     quotes, linked Library documents) follows, so removing one chip
	     never moves another, and on a phone the expensive, turn-changing
	     ones are the chips you can always see without scrolling.

	     Each chip carries exactly one control, its ×. The Atlas notify bell,
	     which used to be a second, identical-looking button INSIDE the chip,
	     is now a disclosure beside it; so is a document's outline. -->
	{#if hasComposerChips || isOverMaxLength}
		<ComposerChipRow
			label={$t('composerChips.rowLabel')}
			scrollOnPhone={isPhone}
			focusFallback={() => textarea?.focus()}
		>
			{#snippet children()}
				{#if composerCommandRegistryEnabled && pendingSkill}
					<li class="composer-chip-item">
						<ComposerChip
							kind="skill"
							label={pendingSkill.displayName}
							status={pendingSkill.unavailable ? $t('pendingSkill.unavailable') : null}
							removable
							removeLabel={$t('pendingSkill.removeA11y', { name: pendingSkill.displayName })}
							onRemove={removePendingSkill}
							testId="composer-chip-skill"
						/>
					</li>
				{/if}

				<!-- Owner decision (1): with an Atlas profile selected the server
				     ignores web search entirely, so the composer stops promising
				     it rather than drawing a chip that means nothing. -->
				{#if forceWebSearch && !selectedAtlasProfile}
					<li class="composer-chip-item">
						<ComposerChip
							kind="web"
							label={$t('composerTools.webSearch')}
							removable
							removeLabel={$t('composerTools.removeWebSearch')}
							onRemove={() => setForceWebSearch(false)}
							testId="composer-chip-web"
						/>
					</li>
				{/if}

				{#if selectedAtlasProfile}
					<li class="composer-chip-item">
						<ComposerChip
							kind="atlas"
							label={$t('composerTools.atlas')}
							meta={atlasChipMeta}
							status={atlasPushStatus !== 'idle' ? atlasPushStatusLabel() : null}
							removable
							removeLabel={$t('composerTools.removeAtlas')}
							onRemove={removeAtlasProfile}
							testId="composer-chip-atlas"
						/>
						<button
							type="button"
							class="composer-chip-disclosure"
							data-testid="composer-chip-atlas-notify"
							aria-label={$t('browserPush.enableAtlasA11y')}
							title={$t('browserPush.enableAtlasA11y')}
							onclick={enableAtlasPushNotifications}
						>
							<Bell size={13} strokeWidth={2} aria-hidden="true" />
						</button>
					</li>
				{/if}

				<!-- The extraction ledger speaks here. A running job's clause is
				     the MUTED meta after the middle dot, because nothing has
				     gone wrong; only a failure takes the chip's danger slot.
				     Retry and Cancel stand BESIDE the pill, like the Atlas
				     bell and the outline disclosure — a chip still has exactly
				     one control of its own, its ×.
				     While the file cannot be sent yet — bytes still moving, or
				     the read pending — the ×'s slot wears a spinner instead:
				     there is nothing useful to remove. A failed chip keeps its
				     ×, wears a short danger clause, and reveals the full
				     explanation on hover/focus. -->
				{#each pictureChipSlots as slot (slot.type === 'ref' ? `ref:${pictureRefs[slot.index].imageFileId}` : `att:${pendingAttachments[slot.index].artifact.id}`)}
				{#if slot.type === 'ref'}
					{@const pictureRef = pictureRefs[slot.index]}
					<li class="composer-chip-item">
						<ComposerChip
							kind="image"
							label={pictureRef.name}
							thumbnailUrl={imageFileUrl(pictureRef.imageFileId, { variant: 'thumb', conversationId: resolvedConversationId })}
							number={pictureNumbers.get(pictureKey({ kind: 'ref', imageFileId: pictureRef.imageFileId })) ?? null}
							removable
							removeLabel={$t('composerChips.removePicture', { name: pictureRef.name })}
							onRemove={() => onRemovePictureRef?.(pictureRef.imageFileId)}
							testId="composer-chip-picture"
						/>
					</li>
				{:else}
					{@const attachment = pendingAttachments[slot.index]}
					{@const extraction = extractionJobs[attachment.artifact.id] ?? null}
					{@const chip = extractionChipState(extraction, {
						picture: isPictureForModel(attachment.artifact, pictureOptions),
					})}
					{@const failure = attachmentChipFailure(extraction, attachment, pictureOptions)}
					{@const attachmentBusy = failure.kind === 'busy'}
					{@const extractionBusy = extractionActionIds.has(attachment.artifact.id)}
					{@const failureDetail = attachmentFailureDetail(attachment, failure, $t)}
					<li class="composer-chip-item">
						<ComposerChipFailureDetails detail={failureDetail}>
							{#snippet children(detailsId)}
								<ComposerChip
									kind={attachmentChipKind(attachment.artifact)}
									label={attachment.artifact.name}
									meta={chip.progressKey
										? $t(asI18nKey(chip.progressKey))
										: chipMetaText(attachment.artifact)}
									status={attachmentChipStatus(failure)}
									dashed={chip.dashed || attachmentBusy}
									busy={attachmentBusy}
									busyLabel={attachmentBusy
										? $t('composerChips.busyPreparing', { name: attachment.artifact.name })
										: ''}
									detailsId={detailsId}
									thumbnailUrl={attachmentThumbnailUrl(attachment.artifact)}
									number={pictureNumbers.get(pictureKey({ kind: 'upload', artifactId: attachment.artifact.id })) ?? null}
									removable
									removeLabel={$t('composerChips.removeAttachment', { name: attachment.artifact.name })}
									onRemove={() => removePendingAttachment(attachment.artifact.id)}
									testId="composer-chip-attachment"
								/>
							{/snippet}
						</ComposerChipFailureDetails>
						{#if chip.canRetry}
							<button
								type="button"
								class="composer-chip-disclosure"
								data-testid="composer-chip-extraction-retry"
								aria-label={$t('chat.extraction.retryA11y', { name: attachment.artifact.name })}
								title={extractionBusy ? $t('chat.extraction.busy') : $t('chat.extraction.retry')}
								disabled={extractionBusy}
								aria-busy={extractionBusy}
								onclick={(event) => void retryAttachmentExtraction(event, attachment.artifact.id, attachment.artifact.name)}
							>
								<RotateCw size={13} strokeWidth={2} aria-hidden="true" />
							</button>
						{/if}
						{#if chip.canCancel}
							<button
								type="button"
								class="composer-chip-disclosure"
								data-testid="composer-chip-extraction-cancel"
								aria-label={$t('chat.extraction.cancelA11y', { name: attachment.artifact.name })}
								title={extractionBusy ? $t('chat.extraction.busy') : $t('chat.extraction.cancel')}
								disabled={extractionBusy}
								aria-busy={extractionBusy}
								onclick={(event) => void cancelAttachmentExtraction(event, attachment.artifact.id, attachment.artifact.name)}
							>
								<Ban size={13} strokeWidth={2} aria-hidden="true" />
							</button>
						{/if}
						{#if attachment.artifact.outline && attachment.artifact.outline.length > 0}
							<AttachmentOutline
								outline={attachment.artifact.outline}
								onQuote={insertQuoteAtCursor}
								variant="disclosure"
								disclosureLabel={$t('composerChips.outlineDisclosure', { name: attachment.artifact.name })}
							/>
						{/if}
					</li>
				{/if}
				{/each}

				<!-- Plan 2b T6 — the marks drawn on one picture: ONE image chip,
				     named by its letters, with the picture's thumbnail and the
				     number the picture goes by in this message. -->
				{#if imageMarks}
					{@const markLabel = $t('composerChips.marks', { letters: imageMarks.marks.map((mark) => mark.letter).join(', ') })}
					<li class="composer-chip-item">
						<ComposerChip
							kind="image"
							label={markLabel}
							thumbnailUrl={imageFileUrl(imageMarks.imageFileId, { variant: 'thumb', conversationId: resolvedConversationId })}
							number={markedNumber}
							removable
							removeLabel={$t('composerChips.removeMarks')}
							onRemove={() => onClearMarks?.()}
							testId="composer-chip-marks"
						/>
					</li>
				{/if}

				<!-- OQ6 — a file whose bytes are still moving. No artifact id
				     exists yet, so it cannot be removed or cancelled; it is a
				     promise that a real chip is coming, in the place the real
				     chip will take. The spinner stands where the × will be. -->
				{#each optimisticUploads as upload (upload.id)}
					<li class="composer-chip-item">
						<ComposerChip
							kind="queued"
							label={upload.name}
							meta={$t('chat.extraction.uploading')}
							dashed
							busy
							busyLabel={$t('composerChips.busyUploading', { name: upload.name })}
							testId="composer-chip-upload"
						/>
					</li>
				{/each}

				{#each pendingQuotes as quote (quote.id)}
					<li class="composer-chip-item">
						<ComposerChip
							kind="quote"
							label={quote.label}
							removable
							removeLabel={$t('composerChips.removeQuote', { name: quote.label })}
							onRemove={() => removePendingQuote(quote.id)}
							testId="composer-chip-quote"
						/>
					</li>
				{/each}

				{#if composerCommandRegistryEnabled}
					{#each effectiveLinkedSources as source (source.displayArtifactId)}
						<li class="composer-chip-item">
							<ComposerChip
								kind="library"
								label={source.name}
								removable
								removeLabel={$t('composerChips.removeLinkedDocument', { name: source.name })}
								onRemove={() => removeLinkedSource(source.displayArtifactId)}
								testId="composer-chip-linked"
							/>
						</li>
					{/each}
				{/if}
			{/snippet}
			{#snippet counter()}
				{#if isOverMaxLength}
					<span class="composer-chip-counter" data-testid="over-length-counter">
						{$t('chat.overLengthCounter', {
							current: message.length.toLocaleString(),
							max: maxLength.toLocaleString(),
						})}
					</span>
				{/if}
			{/snippet}
		</ComposerChipRow>
	{/if}

		<!-- The chips' extraction state, spoken once per real change. A chip
		     that says "Reading…" is invisible to a screen reader otherwise,
		     and binding this to the DTO itself would re-announce the same
		     sentence on every one-second poll. -->
		<div
			class="sr-only"
			role="status"
			aria-live="polite"
			data-testid="composer-extraction-announcer"
		>
			{extractionAnnouncement}
		</div>

		<!-- Paste-to-attach. Every other attach path has something visible
		     happen at the same moment — a picker closes, a drop overlay
		     fades — so a paste is the one that needs saying out loud. -->
		<div
			class="sr-only"
			role="status"
			aria-live="polite"
			data-testid="composer-attachment-announcer"
		>
			{pasteAnnouncement}
		</div>

		<!-- The queued-message banner keeps its own shape, because it has a
		     sentence to hold, but inherits the chip's dashed edge, 999px
		     radius and clock mark — "a chip with a sentence in it" rather
		     than a separate card. -->
		{#if hasQueuedMessage}
			<div class="composer-queued-strip" data-testid="queued-message-banner">
				<span class="composer-queued-strip__icon" aria-hidden="true">
					<Clock size={14} strokeWidth={2} />
				</span>
				<span class="composer-queued-strip__label">{$t('chat.queuedNext')}</span>
				<span class="composer-queued-strip__preview">
					{queuedMessagePreview || $t('chat.nextMessageQueued')}
				</span>
				<button
					data-testid="delete-queued-button"
					type="button"
					class="composer-queued-strip__btn composer-queued-strip__btn--quiet"
					onclick={deleteQueuedMessage}
				>
					{$t('chat.delete')}
				</button>
				<button
					data-testid="edit-queued-button"
					type="button"
					class="composer-queued-strip__btn"
					onclick={editQueuedMessage}
				>
					{$t('chat.edit')}
				</button>
			</div>
		{/if}

		<!-- Everyday redesign, Direction B — "+", attach, accounts, thinking,
		     send. The three in the middle are the ones reached for
		     mid-sentence; everything else lives behind the plus, incognito
		     included. An icon that is on is a filled accent disc, and the
		     count appears only above zero. -->
		<div class="composer-actions flex items-center justify-between gap-2 pt-[3px] pb-[4px] md:gap-3 md:pt-[4px] md:pb-[5px]">
			<div class="composer-bar flex items-center gap-1 md:gap-1.5">
				<div class="relative flex items-center">
					<button
						type="button"
						bind:this={toolsMenuTrigger}
						data-testid="composer-tools-trigger"
						class="composer-face composer-face--plus"
						class:composer-face--on={showToolsMenu}
						onclick={toggleToolsMenu}
						disabled={isComposerDisabled}
						aria-label={$t('chat.openComposerTools')}
						aria-haspopup="menu"
						aria-expanded={showToolsMenu}
					>
						<Plus size={isPhone ? 18 : 20} strokeWidth={2.2} aria-hidden="true" />
					</button>

					{#if showToolsMenu}
						<ComposerToolsMenu
							triggerElement={toolsMenuTrigger}
							{canAttach}
							{attachmentsEnabled}
							onClose={closeToolsMenu}
							onAttach={openFilePicker}
							{personalityProfiles}
							{selectedPersonalityId}
							{onPersonalityChange}
							{onModelChange}
							initialOpen={toolsMenuInitialOpen}
							{atlasAvailability}
							atlasProfile={selectedAtlasProfile}
							onAtlasProfileChange={setAtlasProfile}
							thinkingAvailable={currentModelSupportsReasoningControls}
							thinkingOn={thinkingIsOn}
							onToggleThinking={toggleThinking}
							{skillCount}
							pendingSkillName={pendingSkill?.displayName ?? null}
							onOpenSkills={openSkillsPicker}
						/>
					{/if}
				</div>

				<button
					type="button"
					data-testid="attach-toggle"
					class="composer-face"
					class:composer-face--on={attachOn}
					onclick={openFilePicker}
					disabled={isComposerDisabled || !canAttach}
					aria-pressed={attachOn}
					aria-label={attachLabel}
					title={attachLabel}
					onpointerdown={() => startLongPress(attachLabel)}
					onpointerup={clearLongPress}
					onpointerleave={clearLongPress}
					onpointercancel={clearLongPress}
					oncontextmenu={suppressLongPressMenu}
				>
					<Paperclip size={isPhone ? 16 : 18} strokeWidth={2.1} aria-hidden="true" />
				</button>

				<!-- Connections redesign — the plug opens the account list instead of
				     being an all-or-nothing switch, and carries the count so the
				     composer says how much is reaching this message. -->
				<div class="relative flex items-center">
					<button
						type="button"
						data-testid="connections-toggle"
						class="composer-face"
						class:composer-face--on={accountsOn}
						class:composer-face--muted={!hasConnections}
						onclick={openConnectionsPopover}
						aria-disabled={!hasConnections}
						aria-pressed={accountsOn}
						aria-expanded={hasConnections ? showConnectionsPopover : undefined}
						aria-label={accountsLabel}
						title={accountsLabel}
						onpointerdown={() => startLongPress(accountsLabel)}
						onpointerup={clearLongPress}
						onpointerleave={clearLongPress}
						onpointercancel={clearLongPress}
						oncontextmenu={suppressLongPressMenu}
					>
						<Plug size={isPhone ? 16 : 18} strokeWidth={2.1} aria-hidden="true" />
						{#if accountsCountBadge !== null}
							<span class="composer-connections-count" aria-hidden="true">
								{accountsCountBadge}
							</span>
						{/if}
					</button>

					{#if showConnectionsPopover}
						<ConnectionsPopover
							connections={connectionAccounts}
							flippedIds={connectionsFlippedIds}
							masterOn={connectionAccounts.length > 0
								? masterIsOn(connectionAccounts, connectionsFlippedIds)
								: connectionsEnabled}
							onToggleMaster={handleToggleConnectionsMaster}
							onToggleAccount={handleToggleConnectionAccount}
							onManage={() => {
								showConnectionsPopover = false;
								goto('/settings?section=connections');
							}}
							onClose={() => (showConnectionsPopover = false)}
						/>
					{/if}
				</div>

				{#if currentModelSupportsReasoningControls}
					<button
						type="button"
						data-testid="thinking-bar-toggle"
						class="composer-face"
						class:composer-face--on={thinkingIsOn}
						onclick={toggleThinking}
						aria-pressed={thinkingIsOn}
						aria-label={thinkingLabel}
						title={thinkingLabel}
						onpointerdown={() => startLongPress(thinkingLabel)}
						onpointerup={clearLongPress}
						onpointerleave={clearLongPress}
						onpointercancel={clearLongPress}
						oncontextmenu={suppressLongPressMenu}
					>
						<Brain size={isPhone ? 16 : 18} strokeWidth={2.1} aria-hidden="true" />
					</button>
				{/if}

				<!-- Incognito redesign — the fifth face, only while the flag is on
				     (one-way: it can never turn back off for this conversation).
				     Drawn with a dashed ring rather than the other faces' filled
				     accent-on-nothing, so the composer's own dashed hairline and
				     this face read as the same idea. -->
				{#if incognitoOn}
					<div class="relative flex items-center">
						<button
							type="button"
							bind:this={incognitoFaceTrigger}
							data-testid="incognito-face"
							class="composer-face composer-face--on composer-face--incognito"
							onclick={toggleIncognitoPopover}
							aria-label={$t('chat.incognitoOn')}
							title={$t('chat.incognitoOn')}
							aria-haspopup="dialog"
							aria-expanded={showIncognitoPopover}
							aria-controls={showIncognitoPopover ? 'incognito-popover' : undefined}
							onpointerdown={() => startLongPress($t('chat.incognitoOn'))}
							onpointerup={clearLongPress}
							onpointerleave={clearLongPress}
							onpointercancel={clearLongPress}
							oncontextmenu={suppressLongPressMenu}
						>
							<VenetianMask size={isPhone ? 16 : 18} strokeWidth={2.1} aria-hidden="true" />
						</button>

						{#if showIncognitoPopover}
							<IncognitoPopover
								triggerElement={incognitoFaceTrigger}
								onNewChat={startNewChatFromIncognito}
								onClose={closeIncognitoPopover}
							/>
						{/if}
					</div>
				{/if}

				{#if hasContextToShow}
					<ContextUsageRing
						{contextStatus}
						attachedArtifacts={composerArtifacts}
						{contextDebug}
						{totalCostUsd}
						{lastTurnCostUsd}
						{totalTokens}
					/>
				{/if}

				{#if longPressLabel}
					<!-- The hover sentence, on a device that has no hover. -->
					<span class="composer-longpress-label" role="status">{longPressLabel}</span>
				{/if}
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
				{:else}
					{$t('chat.checkingPrivacy')}
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

	{#if isUploadingAttachment || attachmentError || extractionActionError || queuedSendAfterProcessing}
		<div class="mt-2 flex flex-col gap-1 px-2 text-xs font-sans">
			{#if uploadState === 'uploading' && sendDisabledHint !== 'uploading'}
				<span class="text-text-muted">{$t('chat.uploadingFile')}</span>
			{/if}
			{#if queuedSendAfterProcessing && !hasAttachmentFailure && (isUploadingAttachment || hasBusyAttachment)}
				<span class="text-text-muted">{$t('chat.messageWillSendAutomatically')}</span>
			{/if}
			{#if attachmentError}
				<span class="text-danger" data-testid="attachment-error">{attachmentError}</span>
			{/if}
			{#if extractionActionError}
				<span class="text-danger" data-testid="extraction-action-error">{extractionActionError}</span>
			{/if}
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

	{#if attachmentSheetOpen}
		<AttachmentPickerSheet
			onFiles={(files) => void uploadFiles(files)}
			onOpenLibrary={() => {
				attachmentSheetOpen = false;
				void openDocumentPicker();
			}}
			onCancel={closeAttachmentSheet}
		/>
	{/if}

	{#if skillsPickerOpen}
		<SkillsPicker
			onSelect={selectSkillFromPicker}
			onCancel={closeSkillsPicker}
			onManage={() => {
				skillsPickerOpen = false;
				goto('/settings?section=skills');
			}}
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

	/* Chips redesign — what is left in this file is the row's own furniture.
	   The pill itself lives in ComposerChip.svelte; the row, its phone
	   side-scroll and its `+N` disclosure live in ComposerChipRow.svelte. */

	/* One <li> can hold a chip AND a disclosure beside it (the Atlas notify
	   bell, a document's outline), which is the whole point: a chip has one
	   control, and everything else stands next to it. */
	.composer-chip-item {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		max-width: 100%;
	}

	.composer-chip-disclosure {
		display: inline-grid;
		place-items: center;
		position: relative;
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	/* 44px of touch target without touching the drawn 24px. */
	.composer-chip-disclosure::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		width: 44px;
		height: 44px;
		transform: translate(-50%, -50%);
	}

	@media (pointer: fine) {
		.composer-chip-disclosure::after {
			width: 24px;
			height: 24px;
		}
	}

	.composer-chip-disclosure:hover {
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--warning) 14%, var(--surface-page) 86%);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}

	.composer-chip-disclosure:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.composer-chip-counter {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 600;
		color: var(--danger);
	}

	/* The queued strip: the chip grammar stretched to hold a preview. Same
	   dashed edge, same 999px radius, same clock mark as the queued chip on
	   the system sheet — it is not attached to this turn, it is waiting for
	   the next one. */
	.composer-queued-strip {
		display: flex;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		margin: 2px 6px 8px;
		min-height: 34px;
		padding: 3px 4px 3px 10px;
		border: 1px dashed color-mix(in srgb, var(--text-muted) 34%, var(--border-default) 66%);
		border-radius: var(--radius-full);
		background: transparent;
	}

	.composer-queued-strip__icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.composer-queued-strip__label {
		flex: 0 0 auto;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 600;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.composer-queued-strip__preview {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.composer-queued-strip__btn {
		display: inline-grid;
		place-items: center;
		flex: 0 0 auto;
		height: 26px;
		padding: 0 11px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 500;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.composer-queued-strip__btn--quiet {
		color: var(--text-muted);
	}

	.composer-queued-strip__btn:hover {
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.composer-queued-strip__btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@media (max-width: 767px) {
		/* Phone: the row's controls keep the app's 44px minimum. */
		.composer-queued-strip__btn {
			min-height: 34px;
			min-width: 44px;
		}
	}

	/* Painted in <body> and placed from the composer's rectangle at every
	   width (the effect that follows it): `width`, `left`, the vertical edge
	   and `max-height` arrive inline. In <body> because a fixed box is only
	   the window's while no ancestor has a transform, and the new-chat page
	   centres its composer with one. What is here does not depend on where
	   the composer is. */
	.command-tray {
		position: fixed;
		z-index: 60;
		box-sizing: border-box;
		max-height: 23rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, transparent 24%);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--surface-page) 80%, #000 20%);
		box-shadow:
			0 18px 42px rgba(0, 0, 0, 0.28),
			0 0 0 1px color-mix(in srgb, var(--accent) 8%, transparent 92%);
		padding: 0.45rem;
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

	.command-argument-hint {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		white-space: nowrap;
		color: var(--text-muted);
		font-style: italic;
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
			transform: translateY(0.45rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes commandTrayOut {
		from {
			opacity: 1;
			transform: translateY(0);
		}
		to {
			opacity: 0;
			transform: translateY(0.45rem);
		}
	}

	:global(.dark) .message-composer {
		background: var(--surface-elevated);
		box-shadow:
			0 1px 0 color-mix(in srgb, var(--border-default) 92%, transparent 8%),
			0 18px 38px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent 90%);
	}

	.composer-bar {
		position: relative;
	}

	/* ── Direction B: one face, three states ──────────────────────────
	   Every icon on the bar is the same object: a glyph on nothing, in a
	   34px box (44px on a phone, which is the hit area). Nothing paints a
	   disc behind it in any state — the accent-tinted hover disc and the
	   filled accent on-state were two solid shapes competing with the text
	   you are writing, for a row of controls that is mostly at rest.

	   So the state is carried by the glyph alone:

	     rest   the muted icon colour
	     hover  the icon colour goes to full strength, nothing else moves
	     ON     the glyph is the accent; hovering an on icon deepens it

	   There used to be a 4px dot under an on glyph as well. On a bar whose
	   icons sit a few pixels above the text you are typing it read as a
	   fleck of dirt on the screen, and with the accounts count badge beside
	   it the same icon could carry two marks at once. The accent glyph is
	   the whole of "on" now. */
	.composer-face {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		align-self: center;
		flex-shrink: 0;
		width: 34px;
		height: 34px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		/* Paired with `oncontextmenu`: the hold that asks for the label must
		   not also raise iOS's callout, start a selection, or flash the
		   Android tap highlight over the icon. */
		-webkit-touch-callout: none;
		user-select: none;
		-webkit-tap-highlight-color: transparent;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.composer-face:hover:not(:disabled) {
		color: var(--icon-primary);
	}

	.composer-face:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* ON: the glyph in the accent. No fill, no dot. */
	.composer-face--on {
		color: var(--accent);
	}

	.composer-face--on:hover:not(:disabled) {
		color: var(--accent-hover);
	}

	/* The plus rests a shade quieter than the three controls beside it — it
	   is a way in, not a state — but it takes the same on-treatment while
	   its menu is open, so the bar says which surface you are looking at. */
	.composer-face--plus {
		color: var(--text-muted);
	}

	.composer-face--plus.composer-face--on {
		color: var(--accent);
	}

	/* The incognito face draws a dashed ring rather than sitting on bare
	   nothing like every other face — it echoes the composer's own dashed
	   hairline, so the one face that can never turn off reads differently
	   from the ones that can. */
	.composer-face--incognito {
		border: 1px dashed var(--accent);
	}

	.composer-face--incognito[aria-expanded='true'] {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	/* Shown but greyed for users with no connections yet — the tooltip
	   points them to Settings. Still hoverable (aria-disabled, not native
	   disabled) so the label surfaces. */
	.composer-face--muted {
		opacity: 0.42;
		cursor: default;
	}

	.composer-face--muted:hover {
		color: var(--icon-muted);
		opacity: 0.42;
	}

	.composer-face:disabled {
		cursor: not-allowed;
		opacity: 0.42;
	}

	/* A phone grows the whole face to the 44px hit area. There is no disc to
	   inset any more, so the glyph simply centres in it. */
	@media (max-width: 639px) {
		.composer-face {
			width: 44px;
			height: 44px;
		}
	}

	/* The hover sentence, on a device with no hover: held for ~450ms, the
	   same words the tooltip would have said. */
	.composer-longpress-label {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 0;
		z-index: 30;
		max-width: calc(100vw - 3rem);
		border-radius: 0.4rem;
		background: var(--text-primary);
		color: var(--surface-page);
		padding: 0.3rem 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.75rem;
		line-height: 1.25;
		pointer-events: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Connections redesign — how many accounts are reaching this message.
	   Decorative (aria-hidden): the button's own label already says what the
	   state is, and a screen reader shouldn't hear a bare number. */
	.composer-connections-count {
		position: absolute;
		top: 1px;
		right: 1px;
		z-index: 1;
		min-width: 0.875rem;
		padding: 0 0.1875rem;
		border-radius: 9999px;
		border: 1.5px solid var(--surface-elevated);
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: 0.5625rem;
		font-weight: 700;
		line-height: 0.875rem;
		text-align: center;
		pointer-events: none;
	}

	/* The badge reads the same in both states now that nothing is painted
	   behind the glyph — it always sits on the composer's own surface. */

	@media (max-width: 639px) {
		/* The face is the full 44px target here, so the badge tucks in to
		   the glyph rather than floating at the corner of the hit area. */
		.composer-connections-count {
			top: 7px;
			right: 7px;
		}
	}

	.composer-field {
		position: relative;
	}

	.composer-textarea {
		display: block;
		align-self: stretch;
		position: relative;
		z-index: 1;
		/* The mirror layer wraps with these; state them on the real field too so
		   an unbroken long URL breaks at the same points in both layers instead
		   of relying on each browser's textarea defaults. */
		overflow-wrap: break-word;
		white-space: pre-wrap;
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

	/* The clipping viewport: pinned to the textarea's border box (the field
	   wrapper) at the same left/top and full height, with the textarea's
	   clientWidth set inline. It is never transformed — only the layer inside
	   it moves, so scrolling cannot carry the clipping box out of view. */
	.composer-link-overlay {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 2;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		overflow: hidden;
		pointer-events: none;
	}

	/* The full mirrored text, with no max-height and no clipping of its own.
	   Its padding, font and line height mirror the textarea's classes so the
	   lines wrap and sit exactly where the transparent real text does. */
	.composer-link-highlights {
		width: 100%;
		box-sizing: border-box;
		padding: 7px 13px;
		overflow-wrap: break-word;
		pointer-events: none;
		white-space: pre-wrap;
		text-align: left;
		font-family: var(--font-serif);
		font-size: 15px;
		line-height: 1.42;
		color: var(--text-primary);
	}

	@media (max-width: 767px) {
		/* app.css holds the composer at 16px below 768px so iOS does not zoom
		   on focus; the mirrored text must take the same size or its lines
		   wrap somewhere else. The two classes also outrank a Tailwind
		   text-size utility if one is ever put back on this layer. */
		.composer-link-overlay .composer-link-highlights {
			font-size: 16px;
		}
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
			padding: 8px 16px;
			line-height: 1.35;
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
		.composer-face {
			transition: none;
		}

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

		.command-row {
			grid-template-columns: minmax(4.4rem, auto) minmax(0, 1fr);
		}

		.command-status {
			grid-column: 2;
		}
	}
</style>
