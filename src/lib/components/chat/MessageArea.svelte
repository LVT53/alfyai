<script lang="ts">
import { tick } from "svelte";
import { browser } from "$app/environment";
import { t } from "$lib/i18n";
import {
	AlertCircle,
	Download,
	GitBranch,
	Layers,
	LoaderCircle,
	Eye,
	EyeOff,
	RotateCw,
} from "@lucide/svelte";
import type {
	ChatMessage,
	ContextDebugState,
	ContextCompressionMarker,
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
	ConversationForkOrigin,
	DocumentWorkspaceItem,
	FileProductionJob,
	TaskSteeringPayload,
} from "$lib/types";
import MessageBubble from "./MessageBubble.svelte";
import LogoMark from "./LogoMark.svelte";
import ConversationJumpRail from "./ConversationJumpRail.svelte";
import { buildJumpRailTurns } from "./jump-rail";

let {
	messages = [],
	conversationId = null,
	isThinkingActive = false,
	contextDebug = null,
	modelIcons = {},
	fileProductionJobs = [],
	atlasJobs = [],
	contextCompressionMarkers = [],
	hasActiveSkillSession = false,
	activeSkillSessionHeight = 0,
	forkOrigin = null,
	forkingMessageId = null,
	readOnly = false,
	onRegenerate = undefined,
	onEdit = undefined,
	onFork = undefined,
	onSteer = undefined,
	onOpenDocument = undefined,
	canPublishSkillDrafts = false,
	skillDraftActionState = {},
	onSaveSkillDraft = undefined,
	onDismissSkillDraft = undefined,
	onPublishSkillDraft = undefined,
	onRetryFileProductionJob = undefined,
	onCancelFileProductionJob = undefined,
	onDismissFileProductionJob = undefined,
	onCancelAtlasJob = undefined,
	onAtlasLifecycleAction = undefined,
	onRetryContextCompression = undefined,
}: {
	messages?: ChatMessage[];
	conversationId?: string | null;
	isThinkingActive?: boolean;
	contextDebug?: ContextDebugState | null;
	modelIcons?: Record<string, string | null | undefined>;
	fileProductionJobs?: FileProductionJob[];
	atlasJobs?: AtlasJobCard[];
	contextCompressionMarkers?: ContextCompressionMarker[];
	hasActiveSkillSession?: boolean;
	activeSkillSessionHeight?: number;
	forkOrigin?: ConversationForkOrigin | null;
	forkingMessageId?: string | null;
	readOnly?: boolean;
	onRegenerate?: ((payload: { messageId: string }) => void) | undefined;
	onEdit?:
		| ((payload: { messageId: string; newText: string }) => void)
		| undefined;
	onFork?:
		| ((payload: { messageId: string }) => void | Promise<void>)
		| undefined;
	onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
	onOpenDocument?:
		| ((
				document: DocumentWorkspaceItem,
				options?: {
					preservePresentation?: boolean;
					presentation?: "docked" | "expanded";
				},
		  ) => void)
		| undefined;
	canPublishSkillDrafts?: boolean;
	skillDraftActionState?: Record<
		string,
		{ busy?: boolean; error?: string | null }
	>;
	onSaveSkillDraft?:
		| ((payload: {
				messageId: string;
				draftId: string;
		  }) => void | Promise<void>)
		| undefined;
	onDismissSkillDraft?:
		| ((payload: {
				messageId: string;
				draftId: string;
		  }) => void | Promise<void>)
		| undefined;
	onPublishSkillDraft?:
		| ((payload: {
				messageId: string;
				draftId: string;
		  }) => void | Promise<void>)
		| undefined;
	onRetryFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelFileProductionJob?: ((jobId: string) => void) | undefined;
	onDismissFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelAtlasJob?: ((jobId: string) => void) | undefined;
	onAtlasLifecycleAction?:
		| ((payload: {
				jobId: string;
				action: AtlasAction;
				message: string;
				profile: AtlasProfile;
		  }) => void)
		| undefined;
	onRetryContextCompression?:
		| ((payload: { markerId: string }) => void | Promise<void>)
		| undefined;
} = $props();

let scrollContainer = $state<HTMLDivElement | null>(null);
let forkBoundaryMarker = $state<HTMLDivElement | null>(null);
let shouldAutoScroll = true;
let lastMessageCount = 0;
let lastFileProductionJobCount = 0;
let lastAtlasJobUpdateKey = "";
let lastContextCompressionMarkerCount = 0;
let lastConversationId: string | null = null;
let shouldJumpToConversationBottom = false;
let pendingForkBoundaryMessageId: string | null = null;
let lastForkBoundaryJumpKey: string | null = null;
let pendingRestoreScroll: number | null = null;
let activeJumpRailTurnId = $state<string | null>(null);
let jumpRailActiveUpdateQueued = false;

function chatScrollKey(cid: string | null): string {
	return `alfyai-chat-scroll:${cid ?? "unknown"}`;
}

$effect(() => {
	// Fork-origin updates only — conversation-change detection
	// now runs in $effect.pre before the scroll dispatch so that
	// shouldJumpToConversationBottom and counters are always
	// correct when the scroll orchestrator evaluates.
	if (conversationId && forkOrigin?.copiedForkPointMessageId) {
		const forkBoundaryJumpKey = `${conversationId}:${forkOrigin.copiedForkPointMessageId}`;
		if (forkBoundaryJumpKey !== lastForkBoundaryJumpKey) {
			pendingForkBoundaryMessageId = forkOrigin.copiedForkPointMessageId;
			shouldJumpToConversationBottom = false;
		}
	}
});

// Persist scroll position on page unload so we can restore it
// after a full-page refresh (browser auto-restoration can't target
// the inner scroll container since body is overflow:hidden).
$effect(() => {
	if (!browser || !conversationId) return;
	const cid = conversationId;
	const container = scrollContainer;

	function saveScroll() {
		if (!container) return;
		sessionStorage.setItem(chatScrollKey(cid), String(container.scrollTop));
	}

	window.addEventListener("beforeunload", saveScroll);
	return () => window.removeEventListener("beforeunload", saveScroll);
});

function handleScroll() {
	if (!scrollContainer) return;
	const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
	const distanceToBottom = scrollHeight - scrollTop - clientHeight;
	shouldAutoScroll = distanceToBottom < 50;
	queueActiveJumpRailTurnUpdate();
}

/**
 * Recomputes which jump-rail turn is nearest the viewport center, throttled
 * to one measurement per animation frame so scroll handling stays cheap.
 */
function queueActiveJumpRailTurnUpdate() {
	if (jumpRailActiveUpdateQueued) return;
	jumpRailActiveUpdateQueued = true;
	requestAnimationFrame(() => {
		jumpRailActiveUpdateQueued = false;
		updateActiveJumpRailTurn();
	});
}

function updateActiveJumpRailTurn() {
	if (!scrollContainer) return;
	const turns = buildJumpRailTurns(dedupedMessages);
	if (turns.length === 0) {
		activeJumpRailTurnId = null;
		return;
	}

	const containerRect = scrollContainer.getBoundingClientRect();
	const centerY = containerRect.top + containerRect.height / 2;
	let closestId: string | null = null;
	let closestDistance = Number.POSITIVE_INFINITY;

	for (const turn of turns) {
		const element = scrollContainer.querySelector(
			`[data-message-id="${CSS.escape(turn.id)}"]`,
		);
		if (!element) continue;
		const rect = element.getBoundingClientRect();
		const distance = Math.abs(rect.top + rect.height / 2 - centerY);
		if (distance < closestDistance) {
			closestDistance = distance;
			closestId = turn.id;
		}
	}

	activeJumpRailTurnId = closestId;
}

// Detect if a new message was added (not just content updates or ID reconciliation on stream end)
function hasNewMessage(currentMessages: ChatMessage[]): boolean {
	return currentMessages.length > lastMessageCount;
}

$effect.pre(() => {
	messages;
	scrollContainer;
	isThinkingActive;
	fileProductionJobs.length;
	atlasJobs;
	contextCompressionMarkers.length;

	if (!scrollContainer) return;

	// Detect conversation change and reset before scroll dispatch.
	// Must happen here (in $effect.pre) rather than in the regular $effect
	// because $effect.pre runs first and needs correct counters/flags before
	// the isNewMessage / shouldJumpToConversationBottom checks below.
	if (conversationId && conversationId !== lastConversationId) {
		lastConversationId = conversationId;
		shouldAutoScroll = true;
		lastMessageCount = 0;
		lastFileProductionJobCount = 0;
		lastAtlasJobUpdateKey = "";
		lastContextCompressionMarkerCount = 0;
		pendingForkBoundaryMessageId = forkOrigin?.copiedForkPointMessageId ?? null;
		if (pendingForkBoundaryMessageId != null) {
			shouldJumpToConversationBottom = false;
		} else if (browser) {
			const key = chatScrollKey(conversationId);
			const saved = sessionStorage.getItem(key);
			if (saved !== null) {
				// Page refresh — restore previous scroll position.
				pendingRestoreScroll = Number(saved);
				sessionStorage.removeItem(key);
				shouldJumpToConversationBottom = false;
			} else {
				shouldJumpToConversationBottom = true;
			}
		} else {
			shouldJumpToConversationBottom = true;
		}
	}

	// Restore saved scroll position on page refresh.
	if (pendingRestoreScroll !== null) {
		void restoreScrollToPosition(pendingRestoreScroll);
		// Update counters so subsequent effect runs don't treat
		// existing messages as "new" and override restored position.
		lastMessageCount = dedupedMessages.length;
		lastFileProductionJobCount = fileProductionJobs.length;
		lastContextCompressionMarkerCount = contextCompressionMarkers.length;
		return;
	}

	if (messages.length === 0) {
		if (shouldJumpToConversationBottom) {
			// Do not consume the first user send as an initial-load jump for empty conversations.
			shouldJumpToConversationBottom = false;
		}
		lastMessageCount = 0;
		lastFileProductionJobCount = fileProductionJobs.length;
		lastContextCompressionMarkerCount = contextCompressionMarkers.length;
		return;
	}

	const isNewMessage = hasNewMessage(dedupedMessages);
	const hasNewFileProductionJobs =
		fileProductionJobs.length > lastFileProductionJobCount;
	const currentAtlasJobUpdateKey = atlasJobs
		.map((job) => `${job.id}:${job.status}:${job.updatedAt}`)
		.join("|");
	const hasAtlasJobUpdates =
		currentAtlasJobUpdateKey !== "" &&
		currentAtlasJobUpdateKey !== lastAtlasJobUpdateKey;
	const hasNewContextCompressionMarkers =
		contextCompressionMarkers.length > lastContextCompressionMarkerCount;

	if (pendingForkBoundaryMessageId) {
		void alignForkBoundaryAfterRender(pendingForkBoundaryMessageId);
	} else if (shouldJumpToConversationBottom) {
		// Switching to another conversation should always reveal the latest response.
		void alignToBottomAfterRender();
		shouldJumpToConversationBottom = false;
	} else if (isNewMessage) {
		// New message added: jump directly to the latest content.
		void alignToBottomAfterRender();
	} else if (hasNewFileProductionJobs && shouldAutoScroll) {
		// File-production cards render inside the latest assistant message; keep that expanded area visible.
		void alignToBottomAfterRender();
	} else if (hasAtlasJobUpdates && shouldAutoScroll) {
		void alignToBottomAfterRender();
	} else if (hasNewContextCompressionMarkers && shouldAutoScroll) {
		void alignToBottomAfterRender();
	} else if (shouldAutoScroll && isThinkingActive) {
		// Only follow during thinking phase; stop once content streaming begins.
		instantScrollToBottom();
	}

	lastMessageCount = dedupedMessages.length;
	lastFileProductionJobCount = fileProductionJobs.length;
	lastAtlasJobUpdateKey = currentAtlasJobUpdateKey;
	lastContextCompressionMarkerCount = contextCompressionMarkers.length;
});

function instantScrollToBottom() {
	if (!scrollContainer) return;
	scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

// Keep the jump-rail's active mark in sync with layout changes that aren't
// user scrolling — new messages, streaming content, or a conversation switch
// all shift what's centered without firing a scroll event.
$effect(() => {
	dedupedMessages;
	scrollContainer;
	if (!browser || !scrollContainer) return;
	void tick().then(() => queueActiveJumpRailTurnUpdate());
});

let pinnedArtifactIds = $derived(
	contextDebug?.pinnedEvidence.map((evidence) => evidence.artifactId) ?? [],
);
let excludedArtifactIds = $derived(
	contextDebug?.excludedEvidence.map((evidence) => evidence.artifactId) ?? [],
);

let dedupedMessages = $derived(
	messages.reduce(
		(acc, msg) => {
			const key = msg.renderKey ?? msg.id;
			if (!acc.seen.has(key)) {
				acc.seen.add(key);
				acc.list.push(msg);
			}
			return acc;
		},
		{ seen: new Set<string>(), list: [] as ChatMessage[] },
	).list,
);

let currentStreamingAssistantMessageId = $derived(
	[...dedupedMessages]
		.reverse()
		.find(
			(message) =>
				message.role === "assistant" &&
				(message.isStreaming || message.isThinkingStreaming),
		)?.id ?? null,
);

let atlasFileProductionJobIds = $derived.by(() => {
	const ids = new Set<string>();
	for (const job of atlasJobs) {
		const fileProductionJobId = job.outputs.fileProductionJobId;
		if (typeof fileProductionJobId === "string" && fileProductionJobId) {
			ids.add(fileProductionJobId);
		}
	}
	return ids;
});

let contextCompressionMarkersBySourceEndMessageId = $derived(
	contextCompressionMarkers.reduce((markersByMessageId, marker) => {
		const markers = markersByMessageId.get(marker.sourceEndMessageId) ?? [];
		markers.push(marker);
		markersByMessageId.set(marker.sourceEndMessageId, markers);
		return markersByMessageId;
	}, new Map<string, ContextCompressionMarker[]>()),
);

function getFileProductionJobsForMessage(
	message: ChatMessage,
): FileProductionJob[] {
	if (getAtlasJobsForMessage(message).length > 0) return [];
	return fileProductionJobs.filter((job) => {
		if (atlasFileProductionJobIds.has(job.id)) return false;
		if (job.assistantMessageId === message.id) return true;
		if (job.assistantMessageId != null) return false;
		if (
			message.role !== "assistant" ||
			message.id !== currentStreamingAssistantMessageId
		)
			return false;
		if (conversationId && job.conversationId !== conversationId) return false;
		return job.createdAt >= message.timestamp - 1000;
	});
}

function getAtlasJobsForMessage(message: ChatMessage): AtlasJobCard[] {
	return atlasJobs.filter((job) => {
		if (job.assistantMessageId === message.id) return true;
		if (job.assistantMessageId != null) return false;
		if (
			message.role !== "assistant" ||
			message.id !== currentStreamingAssistantMessageId
		)
			return false;
		if (conversationId && job.conversationId !== conversationId) return false;
		return job.createdAt >= message.timestamp - 1000;
	});
}

function forkSourceHref(origin: ConversationForkOrigin): string | null {
	if (!origin.sourceConversationIdAvailable) return null;
	const messageAnchor = origin.sourceAssistantMessageIdAvailable
		? `#message-${origin.sourceAssistantMessageId}`
		: "";
	return `/chat/${origin.sourceConversationId}${messageAnchor}`;
}

function shouldShowImportBoundary(
	messages: ChatMessage[],
	index: number,
): boolean {
	const current = messages[index];
	if (current.importSource === "chatgpt") return false;
	const hasPreviousImported = messages
		.slice(0, index)
		.some((m) => m.importSource === "chatgpt");
	if (!hasPreviousImported) return false;
	// Only show before the first non-imported message after imported ones
	const previousNonImportedIndex = messages
		.slice(0, index)
		.findIndex((m) => m.importSource !== "chatgpt");
	return previousNonImportedIndex === -1;
}

function contextCompressionMarkerLabel(
	marker: ContextCompressionMarker,
): string {
	if (marker.status === "running") {
		return $t("contextCompression.summarizing");
	}
	if (marker.status === "failed") {
		return $t("contextCompression.couldNotSummarize");
	}
	const count = marker.sourceMessageCount ?? 0;
	const tokens = contextCompressionSavedTokens(marker).toLocaleString();
	return $t("contextCompression.summarizedFormat", { count, tokens });
}

// Tokens reclaimed by the summary: the source messages' estimated size minus
// the resulting summary's own size. Clamped at 0 in case the estimates ever
// invert (e.g. a very short source with a verbose summary).
function contextCompressionSavedTokens(
	marker: ContextCompressionMarker,
): number {
	const sourceTokens = marker.sourceTokenEstimate ?? 0;
	const summaryTokens = marker.estimatedTokens ?? 0;
	return Math.max(0, sourceTokens - summaryTokens);
}

// Client-only expand state for the "Show what was kept" panel. Keyed by marker
// id; no persistence, no endpoint. One marker expanded at a time per id.
let expandedCompactionMarkerIds = $state<Set<string>>(new Set());

function isCompactionMarkerExpanded(markerId: string): boolean {
	return expandedCompactionMarkerIds.has(markerId);
}

function toggleCompactionMarkerExpanded(markerId: string): void {
	const next = new Set(expandedCompactionMarkerIds);
	if (next.has(markerId)) {
		next.delete(markerId);
	} else {
		next.add(markerId);
	}
	expandedCompactionMarkerIds = next;
}

function compactionMarkerStatusClass(
	status: ContextCompressionMarker["status"],
): string {
	if (status === "running") return "context-compression-chip--running";
	if (status === "failed") return "context-compression-chip--failed";
	return "context-compression-chip--valid";
}

async function restoreScrollToPosition(position: number) {
	if (!scrollContainer) {
		pendingRestoreScroll = null;
		return;
	}
	await tick();
	requestAnimationFrame(() => {
		if (!scrollContainer) {
			pendingRestoreScroll = null;
			return;
		}
		scrollContainer.scrollTop = position;
		// Reflect the restored scroll position in shouldAutoScroll so
		// streaming content won't fight the user's manual scroll.
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		shouldAutoScroll = scrollHeight - scrollTop - clientHeight < 50;
		pendingRestoreScroll = null;
	});
}

async function alignToBottomAfterRender() {
	if (!scrollContainer) return;
	await tick();
	requestAnimationFrame(() => {
		instantScrollToBottom();
		requestAnimationFrame(() => {
			instantScrollToBottom();
		});
	});
}

async function alignForkBoundaryAfterRender(messageId: string) {
	if (!scrollContainer) return;
	await tick();
	requestAnimationFrame(() => {
		if (!scrollContainer || !forkBoundaryMarker) return;
		const scrollContainerRect = scrollContainer.getBoundingClientRect();
		const markerRect = forkBoundaryMarker.getBoundingClientRect();
		scrollContainer.scrollTop += markerRect.top - scrollContainerRect.top;
		pendingForkBoundaryMessageId = null;
		lastForkBoundaryJumpKey = conversationId
			? `${conversationId}:${messageId}`
			: null;
		shouldAutoScroll = false;
	});
}

/**
 * Scroll a specific message into view (used by the conversation jump-rail).
 * Reuses the same rect-delta math as {@link alignForkBoundaryAfterRender}.
 * User-initiated jumps disable auto-scroll-follow so streaming content won't
 * fight the new position.
 */
async function scrollToMessage(messageId: string) {
	if (!scrollContainer) return;
	await tick();
	requestAnimationFrame(() => {
		if (!scrollContainer) return;
		const target = scrollContainer.querySelector(
			`[data-message-id="${CSS.escape(messageId)}"]`,
		) as HTMLElement | null;
		if (!target) return;
		const scrollContainerRect = scrollContainer.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();
		// Center the target vertically within the viewport.
		const offset =
			targetRect.top -
			scrollContainerRect.top -
			(scrollContainer.clientHeight - targetRect.height) / 2;
		const reducedMotion =
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (typeof scrollContainer.scrollBy === "function") {
			scrollContainer.scrollBy({
				top: offset,
				behavior: reducedMotion ? "auto" : "smooth",
			});
		} else {
			scrollContainer.scrollTop += offset;
		}
		shouldAutoScroll = false;
	});
}
</script>

<div class="message-area-surface">
	<div
		bind:this={scrollContainer}
		onscroll={handleScroll}
		class="scroll-container h-full min-h-0 w-full overflow-x-hidden overflow-y-auto"
		style="touch-action: pan-y;"
		aria-live="polite"
		aria-atomic="false"
	>
	<div class="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-lg px-sm py-lg md:px-lg md:py-xl lg:px-xl">
		{#if messages.length === 0}
			<div class="conversation-empty-state">
				<span data-testid="empty-state-logo" class="conversation-empty-logo">
					<LogoMark animated={false} size={64} />
				</span>
				<h2 class="conversation-empty-headline">{$t('chat.emptyHeadline')}</h2>
				<p class="conversation-empty-hint">
					{$t('chat.emptyHint')}
				</p>
			</div>
		{:else}
			{#each dedupedMessages as message, i (message.renderKey ?? message.id)}
				{#if shouldShowImportBoundary(dedupedMessages, i)}
					<div
						class="import-boundary-marker import-lineage-marker"
						data-testid="import-boundary-marker"
						role="note"
						aria-label={$t('import.boundaryMarkerLabel')}
					>
						<div class="import-lineage-icon" aria-hidden="true">
							<Download size={15} strokeWidth={2} aria-hidden="true" />
						</div>
						<span class="import-boundary-title">{$t('import.boundaryTitle')}</span>
					</div>
				{/if}
				<MessageBubble
					{message}
					isLast={i === dedupedMessages.length - 1}
					{pinnedArtifactIds}
					{excludedArtifactIds}
					{modelIcons}
					fileProductionJobs={getFileProductionJobsForMessage(message)}
					atlasJobs={getAtlasJobsForMessage(message)}
					{conversationId}
					{readOnly}
					{onRegenerate}
					{onEdit}
					{onFork}
					forkBusy={forkingMessageId === message.id}
					{onSteer}
					{onOpenDocument}
					{canPublishSkillDrafts}
					{skillDraftActionState}
					{onSaveSkillDraft}
					{onDismissSkillDraft}
					{onPublishSkillDraft}
				{onRetryFileProductionJob}
				{onCancelFileProductionJob}
				{onDismissFileProductionJob}
					{onCancelAtlasJob}
					{onAtlasLifecycleAction}
				/>
				{#if forkOrigin?.copiedForkPointMessageId === message.id}
					<div
						bind:this={forkBoundaryMarker}
						class="fork-boundary-marker"
						data-fork-boundary-message-id={message.id}
						data-testid="fork-boundary-marker"
						role="note"
						aria-label={$t('fork.boundaryMarkerLabel')}
					>
						<div class="fork-boundary-content">
							<div class="fork-boundary-icon-chip" aria-hidden="true">
								<GitBranch size={15} strokeWidth={2} aria-hidden="true" />
							</div>
							<span class="fork-boundary-title">{$t('fork.boundaryTitle')}</span>
							{#if forkSourceHref(forkOrigin)}
								<a
									class="fork-boundary-source"
									href={forkSourceHref(forkOrigin)}
									aria-label={$t('fork.openSourceConversation', { title: forkOrigin.sourceTitle })}
								>
									← {$t('fork.boundarySource', { title: forkOrigin.sourceTitle })}
								</a>
							{:else}
								<span class="fork-boundary-source fork-boundary-source-degraded">
									<span>{$t('fork.boundarySource', { title: forkOrigin.sourceTitle })}</span>
									<span class="fork-boundary-source-status">
										<AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
										{$t('fork.sourceUnavailable')}
									</span>
								</span>
							{/if}
						</div>
					</div>
				{/if}
				{#each contextCompressionMarkersBySourceEndMessageId.get(message.id) ?? [] as marker (marker.id)}
					<div
						class={`context-compression-chip ${compactionMarkerStatusClass(marker.status)}`}
						data-testid={`context-compression-marker-${marker.id}`}
						role="note"
						aria-label={contextCompressionMarkerLabel(marker)}
					>
						<div class="context-compression-chip-row">
							<span class="context-compression-divider-line" aria-hidden="true"></span>
							<div class="context-compression-pill">
								{#if marker.status === 'running'}
									<LoaderCircle class="context-compression-icon" size={13} strokeWidth={2} aria-hidden="true" />
									<span class="context-compression-title context-compression-shimmer">{$t('contextCompression.summarizing')}</span>
									<span class="context-compression-bar-sweep" aria-hidden="true"><span class="context-compression-bar-sweep-fill"></span></span>
								{:else if marker.status === 'failed'}
									<AlertCircle class="context-compression-icon" size={13} strokeWidth={2} aria-hidden="true" />
									<span class="context-compression-title">{$t('contextCompression.couldNotSummarize')}</span>
									<button
										type="button"
										class="btn-icon-bare context-compression-action"
										onclick={() => onRetryContextCompression?.({ markerId: marker.id })}
									>
										<RotateCw size={12} strokeWidth={2} aria-hidden="true" />
										{$t('contextCompression.retry')}
									</button>
								{:else}
									<Layers class="context-compression-icon" size={13} strokeWidth={2} aria-hidden="true" />
									<span class="context-compression-title">
										{$t('contextCompression.summarizedFormat', {
											count: marker.sourceMessageCount ?? 0,
											tokens: contextCompressionSavedTokens(marker).toLocaleString(),
										})}
									</span>
									{#if marker.summaryExcerpt}
										<button
											type="button"
											class="btn-icon-bare context-compression-action context-compression-action--icon-only"
											aria-expanded={isCompactionMarkerExpanded(marker.id)}
											aria-label={isCompactionMarkerExpanded(marker.id)
												? $t('contextCompression.hideWhatWasKept')
												: $t('contextCompression.showWhatWasKept')}
											title={isCompactionMarkerExpanded(marker.id)
												? $t('contextCompression.hideWhatWasKept')
												: $t('contextCompression.showWhatWasKept')}
											onclick={() => toggleCompactionMarkerExpanded(marker.id)}
										>
											{#if isCompactionMarkerExpanded(marker.id)}
												<EyeOff size={13} strokeWidth={2} aria-hidden="true" />
											{:else}
												<Eye size={13} strokeWidth={2} aria-hidden="true" />
											{/if}
										</button>
									{/if}
								{/if}
							</div>
							<span class="context-compression-divider-line" aria-hidden="true"></span>
						</div>
						{#if marker.status === 'valid' && isCompactionMarkerExpanded(marker.id) && marker.summaryExcerpt}
							<div
								class="context-compression-expand-panel"
								data-testid={`context-compression-expand-${marker.id}`}
							>
								<p class="context-compression-kept-body">{marker.summaryExcerpt}</p>
							</div>
						{/if}
					</div>
				{/each}
			{/each}
			<div
				class="scroll-clearance"
				class:scroll-clearance-active-skill={hasActiveSkillSession}
				style={activeSkillSessionHeight > 0 ? `--active-skill-session-height: ${activeSkillSessionHeight}px;` : undefined}
				aria-hidden="true"
				></div>
			{/if}
		</div>
	</div>
	<ConversationJumpRail
		messages={dedupedMessages}
		{scrollToMessage}
		activeTurnId={activeJumpRailTurnId}
	/>
</div>

<style>
	.message-area-surface {
		position: relative;
		height: 100%;
		min-height: 0;
		width: 100%;
	}

	.scroll-container {
		/* Better momentum scrolling on mobile */
		-webkit-overflow-scrolling: touch;
		overflow-x: clip;
	}

	.scroll-clearance {
		/* Extra height accounts for the absolutely-positioned floating composer
		   overlaying the bottom of the scroll area. */
		--scroll-clearance-base: 10.5rem;
		height: var(--scroll-clearance-base);
		flex: 0 0 auto;
	}

	.scroll-clearance-active-skill {
		height: calc(var(--scroll-clearance-base) + var(--active-skill-session-height, 0px));
	}

	.conversation-empty-state {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-2xl) var(--space-sm);
		text-align: center;
	}

	.conversation-empty-headline {
		margin: 0;
		font-family: var(--font-serif);
		font-size: var(--text-lg);
		font-weight: 600;
		line-height: 1.2;
		color: var(--text-primary);
	}

	.conversation-empty-hint {
		margin: 0 auto;
		max-width: 34rem;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.6;
		color: var(--text-muted);
	}

	.conversation-empty-logo {
		margin-bottom: var(--space-xs);
	}

	.fork-boundary-marker {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: center;
		margin: var(--space-sm) 0 var(--space-md);
		border-top: 1px dashed color-mix(in srgb, var(--accent) 40%, transparent);
		border-bottom: 1px dashed color-mix(in srgb, var(--accent) 40%, transparent);
		padding: var(--space-sm) 0;
		text-align: center;
	}

	.fork-boundary-content {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.fork-boundary-icon-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-radius: var(--radius-sm);
		padding: 0.2rem;
		color: var(--accent);
	}

	.fork-boundary-title {
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.fork-boundary-source {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: color-mix(in srgb, var(--surface-elevated) 90%, var(--accent) 10%);
		border-radius: var(--radius-sm);
		padding: 0.2rem 0.4rem;
		color: var(--text-secondary);
		text-decoration: none;
	}

	.fork-boundary-source:hover,
	.fork-boundary-source:focus-visible {
		color: var(--text-primary);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		outline: none;
	}

	.fork-boundary-source-degraded {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}

	.fork-boundary-source-status {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		color: var(--warning);
	}

	/* C1 chip-divider compaction marker. The pill is centered between two
	   hairline gradient lines. Gold tint for done/in-progress, red for failed. */
	.context-compression-chip {
		--compaction-gold: #b8945f;
		display: flex;
		flex-direction: column;
		width: 100%;
		margin: var(--space-xs) 0 var(--space-md);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
		color: var(--text-secondary);
	}

	.context-compression-chip-row {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5rem;
	}

	.context-compression-divider-line {
		flex: 1 1 auto;
		height: 1px;
		background: linear-gradient(
			to right,
			transparent,
			color-mix(in srgb, var(--compaction-gold) 55%, var(--border-default) 45%),
			transparent
		);
	}

	.context-compression-pill {
		display: inline-flex;
		flex: 0 1 auto;
		align-items: center;
		gap: 0.4rem;
		max-width: 100%;
		border: 1px solid color-mix(in srgb, var(--compaction-gold) 32%, var(--border-default) 68%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-elevated) 90%, var(--compaction-gold) 10%);
		padding: 0.42rem 0.7rem;
		color: var(--text-secondary);
	}

	.context-compression-chip--failed {
		--compaction-gold: var(--danger);
	}

	.context-compression-chip--failed .context-compression-pill {
		border-color: color-mix(in srgb, var(--danger) 32%, var(--border-default) 68%);
		background: color-mix(in srgb, var(--surface-elevated) 88%, var(--danger) 12%);
	}

	.context-compression-chip--failed .context-compression-divider-line {
		background: linear-gradient(
			to right,
			transparent,
			color-mix(in srgb, var(--danger) 45%, var(--border-default) 55%),
			transparent
		);
	}

	.context-compression-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--compaction-gold);
	}

	.context-compression-title {
		font-weight: 500;
		color: var(--text-secondary);
	}

	.context-compression-action {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-weight: 600;
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 0.16em;
		white-space: nowrap;
	}

	.context-compression-action--icon-only {
		gap: 0;
		text-decoration: none;
		padding: 0.2rem;
		border-radius: var(--radius-sm);
		color: var(--compaction-gold);
	}

	.context-compression-action--icon-only:hover,
	.context-compression-action--icon-only:focus-visible {
		background: color-mix(in srgb, var(--compaction-gold) 16%, transparent 84%);
		color: var(--accent);
	}

	/* In-progress shimmer: text opacity + indeterminate bar sweep.
	   The global prefers-reduced-motion override (app.css) collapses all
	   animation/transition durations to ~0ms, so this is automatically static
	   under reduced-motion. */
	.context-compression-shimmer {
		animation: context-compression-shimmer 1.4s ease-in-out infinite;
	}

	@keyframes context-compression-shimmer {
		0%,
		100% {
			opacity: 0.6;
		}
		50% {
			opacity: 1;
		}
	}

	.context-compression-bar-sweep {
		position: relative;
		flex: 1 1 auto;
		min-width: 2rem;
		max-width: 6rem;
		height: 3px;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, var(--compaction-gold) 22%, transparent 78%);
	}

	.context-compression-bar-sweep-fill {
		position: absolute;
		top: 0;
		left: 0;
		width: 25%;
		height: 100%;
		border-radius: 999px;
		background: var(--compaction-gold);
		animation: context-compression-bar-sweep 1.6s ease-in-out infinite;
	}

	@keyframes context-compression-bar-sweep {
		0% {
			left: -25%;
		}
		100% {
			left: 100%;
		}
	}

	/* "Show what was kept" excerpt — a small floating card below the pill
	   (not attached to it), so it reads as a popover rather than an
	   extension of the box above. Fades + drops in top-to-bottom on open;
	   the global prefers-reduced-motion override (app.css) collapses the
	   animation duration to ~0ms, same as the shimmer/sweep above. */
	.context-compression-expand-panel {
		align-self: center;
		max-width: min(30rem, 100%);
		margin: 0.4rem 0 0;
		border: 1px solid color-mix(in srgb, var(--compaction-gold) 30%, var(--border-default) 70%);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-elevated) 94%, var(--compaction-gold) 6%);
		box-shadow: var(--shadow-md);
		padding: var(--space-sm) var(--space-md);
		animation: context-compression-panel-reveal 0.26s ease-out both;
	}

	@keyframes context-compression-panel-reveal {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.context-compression-kept-body {
		margin: 0;
		font-family: var(--font-serif);
		font-size: var(--text-xs);
		line-height: 1.55;
		color: var(--text-primary);
	}

	.import-lineage-marker {
		display: flex;
		width: 100%;
		max-width: 100%;
		align-self: stretch;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin: var(--space-sm) 0 var(--space-md);
		border-left: 3px solid color-mix(in srgb, var(--text-muted) 55%, var(--surface-elevated) 45%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-elevated) 92%, var(--text-muted) 8%);
		padding: 0.42rem 0.6rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
		color: var(--text-muted);
	}

	.import-lineage-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.import-boundary-title {
		font-weight: 600;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	@media (min-width: 768px) {
		.scroll-clearance {
			--scroll-clearance-base: 9.5rem;
		}
	}
</style>
