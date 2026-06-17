<script lang="ts">
import { onMount } from "svelte";
import { Plus, Search, Send, Square, X } from "@lucide/svelte";
import { goto } from "$app/navigation";
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
import type {
	ArtifactSummary,
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
	deepResearchDepth?: DeepResearchDepth | null;
	reasoningDepth?: ReasoningDepth;
	linkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
	forceWebSearch?: boolean;
};

type DraftPayload = {
	conversationId: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
};

type DeepResearchDepth = "focused" | "standard" | "max";

let {
	disabled = false,
	maxLength = 10000,
	isGenerating = false,
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
	totalTokens = 0,
	personalityProfiles = [],
	selectedPersonalityId = null,
	onPersonalityChange = undefined,
	onModelChange = undefined,
	reasoningDepth = "auto",
	onReasoningDepthChange = undefined,
	deepResearchEnabled = false,
	composerCommandRegistryEnabled = false,
}: {
	disabled?: boolean;
	maxLength?: number;
	isGenerating?: boolean;
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
	deepResearchEnabled?: boolean;
	composerCommandRegistryEnabled?: boolean;
} = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);
let fileInput = $state<HTMLInputElement | null>(null);
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
let showDeepResearchMenu = $state(false);
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
let selectedDeepResearchDepth = $state<DeepResearchDepth | null>(null);
let forceWebSearch = $state(false);
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
let showCharCount = $derived(message.length > maxLength * 0.8);
let charCountColor = $derived(
	isOverMaxLength ? "text-danger" : "text-text-muted",
);
let isUploadingAttachment = $derived(uploadState !== "idle");
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

let canSend = $derived(
	!isEmpty &&
		!isOverMaxLength &&
		!isUploadingAttachment &&
		!hasUnreadyAttachment,
);
let canQueue = $derived(canSend && isGenerating && !hasQueuedMessage);
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

$effect(() => {
	resolvedConversationId = conversationId;
	if (!conversationId) {
		ensureDraftConversationPromise = null;
	}
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
		showDeepResearchMenu = false;
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

$effect(() => {
	if (isGenerating || !queuedSendAfterProcessing || !canSend) return;
	onSend?.(buildSendPayload());
	queuedSendAfterProcessing = false;
	clearComposerAfterSubmit();
});

function isMobile(): boolean {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}
	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
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
		const isMobileDevice = window.innerWidth < 768;
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
	if (disabled || !textarea) return;
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
	if (disabled) return;
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

function handleKeydown(event: KeyboardEvent) {
	if (disabled) return;
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
		if (isGenerating) {
			queue();
			return;
		}
		send();
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

function buildSendPayload(): SendPayload {
	return {
		message: message.trim(),
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
			composerCommandRegistryEnabled && !selectedDeepResearchDepth
				? pendingSkill
				: null,
		conversationId: resolvedConversationId,
		personalityProfileId: selectedPersonalityId,
		deepResearchDepth: deepResearchEnabled ? selectedDeepResearchDepth : null,
		reasoningDepth,
		forceWebSearch,
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
	showDeepResearchMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	documentPickerOpen = false;
	selectedDeepResearchDepth = null;
	forceWebSearch = false;
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

function send() {
	if (disabled) return;
	if (isGenerating) return;
	if (!canSend) {
		if (
			!isEmpty &&
			!isOverMaxLength &&
			(isUploadingAttachment || hasUnreadyAttachment)
		) {
			queuedSendAfterProcessing = true;
		}
		return;
	}
	onSend?.(buildSendPayload());
	queuedSendAfterProcessing = false;
	clearComposerAfterSubmit();
}

function queue() {
	if (disabled) return;
	if (!canQueue) return;
	onQueue?.(buildSendPayload());
	queuedSendAfterProcessing = false;
	clearComposerAfterSubmit();
}

function stop() {
	if (disabled) return;
	onStop?.();
	showToolsMenu = false;
	showDeepResearchMenu = false;
	sourceManagerOpen = false;
	closeCommandTray();
	if (isMobile()) {
		textarea?.blur();
	}
}

onMount(() => {
	if (textarea) {
		if (!isMobile()) {
			textarea.focus();
		}
		adjustHeight();
	}
	syncTextareaValueFromDom();
	window.addEventListener("resize", adjustHeight);
	onUploadReady?.(uploadFiles);
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
		showDeepResearchMenu = false;
		sourceManagerOpen = false;
		closeCommandTray();
	}
	toolsMenuInitialOpen = null;
}

function closeToolsMenu() {
	showToolsMenu = false;
	toolsMenuInitialOpen = null;
}

function closeDeepResearchMenu() {
	showDeepResearchMenu = false;
}

function openSourceManager() {
	sourceManagerOpen = true;
	showToolsMenu = false;
	showDeepResearchMenu = false;
	closeCommandTray();
}

function closeSourceManager() {
	sourceManagerOpen = false;
	requestAnimationFrame(() => textarea?.focus());
}

function closeDeepResearchMenuOnOutsideInteraction(node: HTMLElement) {
	function handlePointerDown(event: PointerEvent) {
		if (!showDeepResearchMenu) return;
		const target = event.target;
		if (target instanceof Node && node.contains(target)) return;
		closeDeepResearchMenu();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!showDeepResearchMenu || event.key !== "Escape") return;
		closeDeepResearchMenu();
	}

	document.addEventListener("pointerdown", handlePointerDown, true);
	document.addEventListener("keydown", handleKeydown);

	return {
		destroy() {
			document.removeEventListener("pointerdown", handlePointerDown, true);
			document.removeEventListener("keydown", handleKeydown);
		},
	};
}

function toggleDeepResearchMenu() {
	if (selectedDeepResearchDepth) {
		selectedDeepResearchDepth = null;
		showDeepResearchMenu = false;
		return;
	}
	showDeepResearchMenu = !showDeepResearchMenu;
	if (showDeepResearchMenu) {
		showToolsMenu = false;
		sourceManagerOpen = false;
		closeCommandTray();
	}
}

function selectDeepResearchDepth(depth: DeepResearchDepth) {
	selectedDeepResearchDepth =
		selectedDeepResearchDepth === depth ? null : depth;
	showDeepResearchMenu = false;
}

function setForceWebSearch(enabled: boolean) {
	forceWebSearch = enabled;
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
			(command.id === "attach" && !canAttach) ||
			(command.id === "research" && !deepResearchEnabled),
		statusKey:
			command.availability !== "available"
				? "composerCommands.comingSoon"
				: command.id === "attach" && !canAttach
					? "composerCommands.unavailable"
					: command.id === "research" && !deepResearchEnabled
						? "composerCommands.deepResearchUnavailable"
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
		(composerCommandRegistryEnabled && Boolean(pendingSkill)) ||
		Boolean(selectedDeepResearchDepth)
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
	showDeepResearchMenu = false;
}

function toggleStandardDeepResearchFromCommand() {
	if (!deepResearchEnabled) {
		commandTrayMessage = $t("composerCommands.deepResearchUnavailable");
		return;
	}
	selectedDeepResearchDepth = selectedDeepResearchDepth ? null : "standard";
	showDeepResearchMenu = false;
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
		case "research":
			toggleStandardDeepResearchFromCommand();
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
	showDeepResearchMenu = false;
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
		Boolean(nextPendingSkill);
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
	};
	const key = JSON.stringify(payload);
	if (!force && key === lastEmittedDraftKey) return;
	lastEmittedDraftKey = key;
	onDraftChange?.(payload);
}
</script>

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

	<div class="message-composer relative z-[2] flex min-h-[70px] flex-col rounded-[1.25rem] border border-border px-[8px] pt-[8px] pb-0 transition-all duration-150 focus-within:border-focus-ring md:min-h-[78px] md:px-[10px] md:pt-[10px]">
		<input
			bind:this={fileInput}
			type="file"
			class="hidden"
			multiple
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
			disabled={disabled}
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
						disabled={disabled}
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
						/>
					{/if}
				</div>

				{#if deepResearchEnabled}
					<div
						class="deep-research-trigger relative flex items-center"
						use:closeDeepResearchMenuOnOutsideInteraction
					>
						<button
							type="button"
							class="btn-icon-bare composer-icon flex flex-shrink-0 items-center justify-center text-text-muted"
							class:composer-icon--active={selectedDeepResearchDepth}
							onclick={toggleDeepResearchMenu}
							disabled={disabled}
							aria-label={$t('composerTools.deepResearch')}
							aria-expanded={showDeepResearchMenu}
							title={$t('composerTools.deepResearch')}
						>
							<Search size={20} strokeWidth={2.1} aria-hidden="true" />
						</button>

						{#if showDeepResearchMenu}
							<div
								class="deep-research-menu"
								role="group"
								aria-label={$t('composerTools.deepResearchDepth')}
							>
								<button
									type="button"
									class="deep-research-option"
									class:deep-research-option--selected={selectedDeepResearchDepth === 'focused'}
									aria-pressed={selectedDeepResearchDepth === 'focused'}
									onclick={() => selectDeepResearchDepth('focused')}
								>
									{$t('composerTools.deepResearchFocused')}
								</button>
								<button
									type="button"
									class="deep-research-option"
									class:deep-research-option--selected={selectedDeepResearchDepth === 'standard'}
									aria-pressed={selectedDeepResearchDepth === 'standard'}
									onclick={() => selectDeepResearchDepth('standard')}
								>
									{$t('composerTools.deepResearchStandard')}
								</button>
								<button
									type="button"
									class="deep-research-option"
									class:deep-research-option--selected={selectedDeepResearchDepth === 'max'}
									aria-pressed={selectedDeepResearchDepth === 'max'}
									onclick={() => selectDeepResearchDepth('max')}
								>
									{$t('composerTools.deepResearchMax')}
								</button>
							</div>
						{/if}
					</div>
				{/if}

				<ContextUsageRing
					{contextStatus}
					attachedArtifacts={composerArtifacts}
					{contextDebug}
					{contextSources}
					{totalCostUsd}
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
							onclick={queue}
							disabled={disabled}
							aria-label={$t('chat.queueMessage')}
							class="queue-button flex h-[40px] items-center justify-center rounded-[10px] border border-border bg-surface-page px-3 text-[13px] font-sans font-medium text-text-primary shadow-sm animate-in"
						>
							{$t('chat.queueMessage')}
						</button>
					{/if}
					<button
						data-testid="stop-button"
						type="button"
						onclick={stop}
						disabled={disabled}
						aria-label={$t('chat.stop')}
						class="composer-stop-accent flex h-[40px] w-[40px] items-center justify-center rounded-[10px] shadow-sm animate-in"
					>
					<Square size={18} fill="currentColor" aria-hidden="true" />
					</button>
				{:else}
					<button
						data-testid="send-button"
						type="button"
						onclick={send}
						disabled={!canSend || disabled}
						aria-label={$t('chat.sendMessage')}
						class="btn-primary composer-send flex h-[40px] w-[40px] items-center justify-center rounded-[10px] shadow-sm disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-elevated disabled:text-icon-muted animate-in"
					>
					<Send size={18} strokeWidth={2} aria-hidden="true" />
					</button>
				{/if}
			</div>
		</div>
	</div>

	{#if showCharCount}
		<div class="mt-1 flex justify-end px-2">
			<span class="text-[12px] font-sans {charCountColor}">
				{$t('chat.characterCount', { current: message.length, max: maxLength })}
			</span>
		</div>
	{/if}

	{#if isUploadingAttachment || attachmentError || attachmentReadinessErrors.length > 0 || queuedSendAfterProcessing}
		<div class="mt-2 flex flex-col gap-1 px-2 text-xs font-sans">
			{#if uploadState === 'uploading'}
				<span class="text-text-muted">{$t('chat.uploadingFile')}</span>
			{:else if uploadState === 'preparing'}
				<span class="text-text-muted">{$t('chat.extractingDocument')}</span>
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

	.composer-icon--active {
		background: color-mix(in srgb, var(--accent) 12%, transparent 88%);
		color: var(--accent);
	}

	.deep-research-menu {
		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		z-index: 40;
		display: flex;
		width: min(12.75rem, calc(100vw - 2rem));
		flex-direction: column;
		gap: 0.12rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		border-radius: 0.72rem;
		background: color-mix(in srgb, var(--surface-overlay) 88%, var(--surface-page) 12%);
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
		padding: 0.32rem;
		backdrop-filter: blur(14px);
	}

	.deep-research-option {
		width: 100%;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		padding: 0.42rem 0.52rem;
		text-align: left;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.15;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.deep-research-option:hover,
	.deep-research-option:focus-visible {
		background: color-mix(in srgb, var(--accent) 24%, transparent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 34%, transparent 66%);
		transform: translateY(-1px);
		outline: none;
	}

	.deep-research-option--selected {
		background: color-mix(in srgb, var(--accent) 14%, var(--surface-elevated) 86%);
		color: var(--accent);
		font-weight: 600;
	}

	:global(.dark) .deep-research-menu {
		background: color-mix(in srgb, var(--surface-page) 90%, #000 10%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 16px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	:global(.dark) .deep-research-option:hover,
	:global(.dark) .deep-research-option:focus-visible {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
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

	.deep-research-trigger {
		margin-right: 3px;
	}

	.attachment-chip {
		background: color-mix(in srgb, var(--surface-page) 88%, var(--surface-elevated) 12%);
	}

	.composer-send {
		aspect-ratio: 1 / 1;
		align-self: center;
		overflow: hidden;
	}

	.action-button-container {
		align-self: center;
	}

	.composer-stop {
		aspect-ratio: 1 / 1;
		align-self: center;
		overflow: hidden;
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

		.deep-research-option {
			transition: none;
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
