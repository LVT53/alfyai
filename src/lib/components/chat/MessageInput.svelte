<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import { currentConversationId } from "$lib/stores/ui";
import ContextUsageRing from "./ContextUsageRing.svelte";
import ComposerToolsMenu from "./ComposerToolsMenu.svelte";
import FileAttachment from "./FileAttachment.svelte";
import type {
	ArtifactSummary,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	PendingAttachment,
	TaskState,
	TaskSteeringPayload,
	ThinkingMode,
} from "$lib/types";

type SendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	pendingAttachments: PendingAttachment[];
	conversationId: string | null;
	personalityProfileId?: string | null;
	deepResearchDepth?: DeepResearchDepth | null;
	thinkingMode?: ThinkingMode;
};

type DraftPayload = {
	conversationId: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
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
	taskState = null,
	contextDebug = null,
	contextSources = null,
	draftText = "",
	draftAttachments = [],
	draftVersion = 0,
	onSend = undefined,
	onQueue = undefined,
	onStop = undefined,
	onSteer = undefined,
	onManageEvidence = undefined,
	onEditQueuedMessage = undefined,
	onDeleteQueuedMessage = undefined,
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
	thinkingMode = "auto",
	onThinkingModeChange = undefined,
	deepResearchEnabled = false,
}: {
	disabled?: boolean;
	maxLength?: number;
	isGenerating?: boolean;
	conversationId?: string | null;
	attachmentsEnabled?: boolean;
	ensureConversation?: (() => Promise<string>) | null;
	contextStatus?: ConversationContextStatus | null;
	attachedArtifacts?: ArtifactSummary[];
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	contextSources?: ContextSourcesState | null;
	draftText?: string;
	draftAttachments?: PendingAttachment[];
	draftVersion?: number;
	onSend?: ((payload: SendPayload) => void) | undefined;
	onQueue?: ((payload: SendPayload) => void) | undefined;
	onStop?: (() => void) | undefined;
	onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
	onManageEvidence?: (() => void) | undefined;
	onEditQueuedMessage?: (() => void) | undefined;
	onDeleteQueuedMessage?: (() => void) | undefined;
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
	personalityProfiles?: Array<{ id: string; name: string; description: string }>;
	selectedPersonalityId?: string | null;
	onPersonalityChange?: ((id: string | null) => void) | undefined;
	thinkingMode?: ThinkingMode;
	onThinkingModeChange?: ((mode: ThinkingMode) => void) | undefined;
	deepResearchEnabled?: boolean;
} = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);
let fileInput = $state<HTMLInputElement | null>(null);
let message = $state("");
let pendingAttachments = $state<PendingAttachment[]>([]);
let uploadState = $state<"idle" | "uploading" | "preparing">("idle");
let attachmentError = $state("");
let resolvedConversationId = $state<string | null>(null);
let showToolsMenu = $state(false);
let showDeepResearchMenu = $state(false);
let selectedDeepResearchDepth = $state<DeepResearchDepth | null>(null);
let queuedSendAfterProcessing = $state(false);
let appliedDraftVersion = -1;
let lastEmittedDraftKey = "";
let ensureDraftConversationPromise: Promise<string> | null = null;
let draftEmissionVersion = 0;

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

$effect(() => {
	resolvedConversationId = conversationId;
	if (!conversationId) {
		ensureDraftConversationPromise = null;
	}
});

$effect(() => {
	if (draftVersion === appliedDraftVersion) return;

	const shouldApplyDraft =
		appliedDraftVersion === -1 ||
		(draftVersion === 0 && draftText.trim().length > 0) ||
		(message.trim().length === 0 &&
			pendingAttachments.length === 0 &&
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
		attachmentError = "";
		uploadState = "idle";
		queuedSendAfterProcessing = false;
		showToolsMenu = false;
		showDeepResearchMenu = false;
		lastEmittedDraftKey = "";
		draftEmissionVersion += 1;
		adjustHeight();
	}
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
		attachmentError = "";
		uploadState = "idle";
		queuedSendAfterProcessing = false;
		showToolsMenu = false;
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

function handleInput() {
	if (disabled) return;
	message = textarea.value;
	draftEmissionVersion += 1;
	adjustHeight();
	void emitDraftChange();
}

function handleKeydown(event: KeyboardEvent) {
	if (disabled) return;
	if (event.isComposing) return;
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		if (isGenerating) {
			queue();
			return;
		}
		send();
	}
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
		conversationId: resolvedConversationId,
		personalityProfileId: selectedPersonalityId,
		deepResearchDepth: deepResearchEnabled ? selectedDeepResearchDepth : null,
		thinkingMode,
	};
}

function clearComposerAfterSubmit() {
	message = "";
	pendingAttachments = [];
	attachmentError = "";
	queuedSendAfterProcessing = false;
	showToolsMenu = false;
	showDeepResearchMenu = false;
	selectedDeepResearchDepth = null;
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
	if (isMobile()) {
		textarea.blur();
	}
}

onMount(() => {
	if (textarea) {
		if (!isMobile()) {
			textarea.focus();
		}
		adjustHeight();
	}
	window.addEventListener("resize", adjustHeight);
	onUploadReady?.(uploadFiles);
	return () => window.removeEventListener("resize", adjustHeight);
});

function openFilePicker() {
	if (!canAttach) return;
	showToolsMenu = false;
	fileInput?.click();
}

function toggleToolsMenu() {
	showToolsMenu = !showToolsMenu;
	if (showToolsMenu) showDeepResearchMenu = false;
}

function closeToolsMenu() {
	showToolsMenu = false;
}

function closeDeepResearchMenu() {
	showDeepResearchMenu = false;
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
	if (showDeepResearchMenu) showToolsMenu = false;
}

function selectDeepResearchDepth(depth: DeepResearchDepth) {
	selectedDeepResearchDepth = selectedDeepResearchDepth === depth ? null : depth;
	showDeepResearchMenu = false;
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
let preparingTimer = $state<ReturnType<typeof setTimeout> | null>(null);

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

function handleSteering(payload: TaskSteeringPayload) {
	onSteer?.(payload);
}

function handleManageEvidence() {
	onManageEvidence?.();
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

async function emitDraftChange(force = false) {
	const emissionVersion = draftEmissionVersion;
	const nextMessage = message;
	const nextPendingAttachments = pendingAttachments.map((attachment) => ({
		...attachment,
	}));
	const hasMeaningfulDraft =
		nextMessage.trim().length > 0 || nextPendingAttachments.length > 0;
	const draftConversationId = hasMeaningfulDraft
		? await ensureDraftConversationId()
		: resolvedConversationId;
	if (emissionVersion !== draftEmissionVersion) return;
	const payload = {
		conversationId: draftConversationId,
		draftText: nextMessage,
		selectedAttachmentIds: nextPendingAttachments.map(
			(attachment) => attachment.artifact.id,
		),
		selectedAttachments: nextPendingAttachments,
	};
	const key = JSON.stringify(payload);
	if (!force && key === lastEmittedDraftKey) return;
	lastEmittedDraftKey = key;
	onDraftChange?.(payload);
}
</script>

<div class="composer-root relative flex w-full flex-col">
	<div class="message-composer flex min-h-[70px] flex-col rounded-[1.25rem] border border-border px-[8px] pt-[8px] pb-0 transition-all duration-150 focus-within:border-focus-ring md:min-h-[78px] md:px-[10px] md:pt-[10px]">
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
			onkeydown={handleKeydown}
			disabled={disabled}
			placeholder={$t('chat.messagePlaceholder')}
			class="composer-textarea min-h-[72px] w-full resize-none overflow-y-auto border-0 bg-transparent px-[13px] py-[7px] text-left text-[15px] leading-[1.42] font-serif text-text-primary placeholder:font-sans placeholder:text-[14px] placeholder:text-text-muted focus:outline-none focus:ring-0 md:min-h-[88px] md:px-[16px] md:py-[8px] md:text-[15px] md:leading-[1.35]"
			rows="1"
		></textarea>

		{#if pendingAttachments.length > 0}
			<div class="flex flex-wrap gap-2 px-[16px] pb-2 pt-1">
				{#each pendingAttachments as attachment (attachment.artifact.id)}
					<FileAttachment
						attachment={attachment.artifact}
						variant="pending"
						removable={true}
						onRemove={(payload) => removePendingAttachment(payload.id)}
					/>
				{/each}
			</div>
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
						class="btn-icon-bare composer-icon flex h-[40px] w-[40px] flex-shrink-0 items-center justify-center text-text-muted"
						onclick={toggleToolsMenu}
						disabled={disabled}
						aria-label={$t('chat.openComposerTools')}
						aria-expanded={showToolsMenu}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="12" x2="12" y1="5" y2="19" />
							<line x1="5" x2="19" y1="12" y2="12" />
						</svg>
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
							{thinkingMode}
							{onThinkingModeChange}
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
							class="btn-icon-bare composer-icon flex h-[40px] w-[40px] flex-shrink-0 items-center justify-center text-text-muted"
							class:composer-icon--active={selectedDeepResearchDepth}
							onclick={toggleDeepResearchMenu}
							disabled={disabled}
							aria-label={$t('composerTools.deepResearch')}
							aria-expanded={showDeepResearchMenu}
							title={$t('composerTools.deepResearch')}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="11" cy="11" r="6" />
								<path d="m16 16 4 4" />
							</svg>
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
					{taskState}
					{contextDebug}
					{contextSources}
					onSteer={handleSteering}
					onManageEvidence={handleManageEvidence}
					{totalCostUsd}
					{totalTokens}
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
						<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
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
						<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="22" x2="11" y1="2" y2="13" />
							<polygon points="22 2 15 22 11 13 2 9 22 2" />
						</svg>
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

	:global(.dark) .message-composer {
		background: color-mix(in srgb, var(--surface-overlay) 88%, #3a3a3a 12%);
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
		bottom: calc(100% + 10px);
		z-index: 40;
		display: flex;
		width: min(14rem, calc(100vw - 2rem));
		flex-direction: column;
		gap: 0.25rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 0.9rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow: var(--shadow-lg);
		padding: 0.45rem;
		backdrop-filter: blur(14px);
	}

	.deep-research-option {
		width: 100%;
		border: 0;
		border-radius: 0.72rem;
		background: transparent;
		padding: 0.58rem 0.68rem;
		text-align: left;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.88rem;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.deep-research-option:hover,
	.deep-research-option:focus-visible {
		background: color-mix(in srgb, var(--surface-page) 78%, var(--surface-elevated) 22%);
		box-shadow: 0 0 0 2px var(--focus-ring);
		outline: none;
	}

	.deep-research-option--selected {
		background: color-mix(in srgb, var(--accent) 14%, var(--surface-elevated) 86%);
		color: var(--accent);
		font-weight: 600;
	}

	.composer-textarea {
		align-self: stretch;
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
		.animate-in {
			animation: none;
			opacity: 1;
		}

		.deep-research-option {
			transition: none;
		}
	}
</style>
