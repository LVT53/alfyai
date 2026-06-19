<script lang="ts">
import { tick } from "svelte";
import { browser } from "$app/environment";
import { t } from "$lib/i18n";
import { AlertCircle, Download, GitBranch, Layers } from "@lucide/svelte";
import type {
	ChatMessage,
	ContextDebugState,
	ContextCompressionMarker,
	ConversationForkOrigin,
	DocumentWorkspaceItem,
	FileProductionJob,
	TaskSteeringPayload,
} from "$lib/types";
import MessageBubble from "./MessageBubble.svelte";

let {
	messages = [],
	conversationId = null,
	isThinkingActive = false,
	contextDebug = null,
	modelIcons = {},
	fileProductionJobs = [],
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
}: {
	messages?: ChatMessage[];
	conversationId?: string | null;
	isThinkingActive?: boolean;
	contextDebug?: ContextDebugState | null;
	modelIcons?: Record<string, string | null | undefined>;
	fileProductionJobs?: FileProductionJob[];
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
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
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
} = $props();

let scrollContainer = $state<HTMLDivElement | null>(null);
let forkBoundaryMarker = $state<HTMLDivElement | null>(null);
let shouldAutoScroll = true;
let lastMessageCount = 0;
let lastFileProductionJobCount = 0;
let lastContextCompressionMarkerCount = 0;
let lastConversationId: string | null = null;
let shouldJumpToConversationBottom = false;
let pendingForkBoundaryMessageId: string | null = null;
let lastForkBoundaryJumpKey: string | null = null;
let pendingRestoreScroll: number | null = null;

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
	} else if (hasNewContextCompressionMarkers && shouldAutoScroll) {
		void alignToBottomAfterRender();
	} else if (shouldAutoScroll && isThinkingActive) {
		// Only follow during thinking phase; stop once content streaming begins.
		instantScrollToBottom();
	}

	lastMessageCount = dedupedMessages.length;
	lastFileProductionJobCount = fileProductionJobs.length;
	lastContextCompressionMarkerCount = contextCompressionMarkers.length;
});

function instantScrollToBottom() {
	if (!scrollContainer) return;
	scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

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
	return fileProductionJobs.filter((job) => {
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
		return marker.trigger === "automatic"
			? $t("contextCompression.automaticRunning")
			: $t("contextCompression.manualRunning");
	}
	if (marker.status === "failed") {
		return $t("contextCompression.failed");
	}
	return marker.trigger === "automatic"
		? $t("contextCompression.automaticValid")
		: $t("contextCompression.manualValid");
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
</script>

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
				<div class="conversation-empty-eyebrow">{$t('chat.conversationReady')}</div>
				<p class="conversation-empty-copy">
					{$t('chat.messagesWillAppearHere')}
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
						class="context-compression-marker"
						class:context-compression-marker-running={marker.status === 'running'}
						class:context-compression-marker-failed={marker.status === 'failed'}
						data-testid={`context-compression-marker-${marker.id}`}
						role="note"
						aria-label={contextCompressionMarkerLabel(marker)}
					>
						<div class="context-compression-icon" aria-hidden="true">
							<Layers size={15} strokeWidth={2} aria-hidden="true" />
						</div>
						<span class="context-compression-title">{contextCompressionMarkerLabel(marker)}</span>
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

<style>
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

	.conversation-empty-eyebrow {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.conversation-empty-copy {
		margin: 0 auto;
		max-width: 34rem;
		font-size: var(--text-base);
		line-height: 1.6;
		color: var(--text-secondary);
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

	.context-compression-marker {
		display: flex;
		width: 100%;
		max-width: 100%;
		align-self: stretch;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin: var(--space-xs) 0 var(--space-md);
		border-left: 3px solid var(--text-muted);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-elevated) 90%, var(--text-muted) 10%);
		padding: 0.42rem 0.6rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
		color: var(--text-secondary);
	}

	.context-compression-marker-running {
		border-left-color: color-mix(in srgb, var(--text-muted) 72%, var(--accent) 28%);
		background: color-mix(in srgb, var(--surface-elevated) 90%, var(--accent) 10%);
	}

	.context-compression-marker-failed {
		border-left-color: var(--danger);
		background: color-mix(in srgb, var(--surface-elevated) 88%, var(--danger) 12%);
	}

	.context-compression-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.context-compression-title {
		font-weight: 600;
		color: var(--text-secondary);
		white-space: nowrap;
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
