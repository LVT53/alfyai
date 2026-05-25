<script lang="ts">
import { tick } from "svelte";
import { t } from "$lib/i18n";
import type {
	ChatMessage,
	ContextDebugState,
	ContextCompressionMarker,
	ConversationForkOrigin,
	DeepResearchJob,
	DeepResearchReportIntent,
	DocumentWorkspaceItem,
	FileProductionJob,
	TaskSteeringPayload,
} from "$lib/types";
import MessageBubble from "./MessageBubble.svelte";
import ResearchCard from "./ResearchCard.svelte";

let {
	messages = [],
	conversationId = null,
	isThinkingActive = false,
	contextDebug = null,
	modelIcons = {},
	fileProductionJobs = [],
	deepResearchJobs = [],
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
	onCancelDeepResearchJob = undefined,
	onEditDeepResearchPlan = undefined,
	onApproveDeepResearchPlan = undefined,
	onDiscussDeepResearchReport = undefined,
	onResearchFurtherFromDeepResearchReport = undefined,
	onAdvanceDeepResearchWorkflow = undefined,
}: {
	messages?: ChatMessage[];
	conversationId?: string | null;
	isThinkingActive?: boolean;
	contextDebug?: ContextDebugState | null;
	modelIcons?: Record<string, string | null | undefined>;
	fileProductionJobs?: FileProductionJob[];
	deepResearchJobs?: DeepResearchJob[];
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
	onFork?: ((payload: { messageId: string }) => void | Promise<void>) | undefined;
	onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	canPublishSkillDrafts?: boolean;
	skillDraftActionState?: Record<string, { busy?: boolean; error?: string | null }>;
	onSaveSkillDraft?: ((payload: { messageId: string; draftId: string }) => void | Promise<void>) | undefined;
	onDismissSkillDraft?: ((payload: { messageId: string; draftId: string }) => void | Promise<void>) | undefined;
	onPublishSkillDraft?: ((payload: { messageId: string; draftId: string }) => void | Promise<void>) | undefined;
	onRetryFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelDeepResearchJob?: ((jobId: string) => void | Promise<void>) | undefined;
	onEditDeepResearchPlan?:
		| ((
				jobId: string,
				instructions: string,
				reportIntent?: DeepResearchReportIntent
			) => void | Promise<void>)
		| undefined;
	onApproveDeepResearchPlan?: ((jobId: string) => void | Promise<void>) | undefined;
	onDiscussDeepResearchReport?: ((jobId: string) => void | Promise<void>) | undefined;
	onResearchFurtherFromDeepResearchReport?:
		| ((jobId: string, options?: { depth?: DeepResearchJob['depth'] }) => void | Promise<void>)
		| undefined;
	onAdvanceDeepResearchWorkflow?: ((jobId: string) => void | Promise<void>) | undefined;
} = $props();

let scrollContainer = $state<HTMLDivElement | null>(null);
let shouldAutoScroll = true;
let lastMessageCount = 0;
let lastFileProductionJobCount = 0;
let lastDeepResearchJobCount = 0;
let lastConversationId: string | null = null;
let shouldJumpToConversationBottom = false;

$effect(() => {
	if (conversationId && conversationId !== lastConversationId) {
		lastConversationId = conversationId;
		shouldAutoScroll = true;
		lastMessageCount = 0;
		lastFileProductionJobCount = 0;
		lastDeepResearchJobCount = 0;
		shouldJumpToConversationBottom = true;
	}
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
	deepResearchJobs.length;

	if (!scrollContainer) return;

	if (messages.length === 0 && deepResearchJobs.length === 0) {
		if (shouldJumpToConversationBottom) {
			// Do not consume the first user send as an initial-load jump for empty conversations.
			shouldJumpToConversationBottom = false;
		}
		lastMessageCount = 0;
		lastFileProductionJobCount = fileProductionJobs.length;
		lastDeepResearchJobCount = 0;
		return;
	}

	const isNewMessage = hasNewMessage(dedupedMessages);
	const hasNewFileProductionJobs =
		fileProductionJobs.length > lastFileProductionJobCount;
	const hasNewDeepResearchJobs = deepResearchJobs.length > lastDeepResearchJobCount;

	if (shouldJumpToConversationBottom) {
		// Switching to another conversation should always reveal the latest response.
		void alignToBottomAfterRender();
		shouldJumpToConversationBottom = false;
	} else if (isNewMessage) {
		// New message added: jump directly to the latest content.
		void alignToBottomAfterRender();
	} else if (hasNewFileProductionJobs && shouldAutoScroll) {
		// File-production cards render inside the latest assistant message; keep that expanded area visible.
		void alignToBottomAfterRender();
	} else if (hasNewDeepResearchJobs && shouldAutoScroll) {
		void alignToBottomAfterRender();
	} else if (shouldAutoScroll && isThinkingActive) {
		// Only follow during thinking phase; stop once content streaming begins.
		instantScrollToBottom();
	}

	lastMessageCount = dedupedMessages.length;
	lastFileProductionJobCount = fileProductionJobs.length;
	lastDeepResearchJobCount = deepResearchJobs.length;
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
		.find((message) => message.role === 'assistant' && (message.isStreaming || message.isThinkingStreaming))
		?.id ?? null,
);

let deepResearchJobsByAnchorMessageKey = $derived(
	deepResearchJobs.reduce((jobsByMessageId, job) => {
		const anchorKey = findDeepResearchAnchorMessageKey(job, dedupedMessages);
		if (!anchorKey) return jobsByMessageId;
		const jobs = jobsByMessageId.get(anchorKey) ?? [];
		jobs.push(job);
		jobsByMessageId.set(anchorKey, jobs);
		return jobsByMessageId;
	}, new Map<string, DeepResearchJob[]>())
);

let contextCompressionMarkersBySourceEndMessageId = $derived(
	contextCompressionMarkers.reduce((markersByMessageId, marker) => {
		const markers = markersByMessageId.get(marker.sourceEndMessageId) ?? [];
		markers.push(marker);
		markersByMessageId.set(marker.sourceEndMessageId, markers);
		return markersByMessageId;
	}, new Map<string, ContextCompressionMarker[]>())
);

let unanchoredDeepResearchJobs = $derived(
	deepResearchJobs.filter((job) => {
		return !findDeepResearchAnchorMessageKey(job, dedupedMessages);
	})
);

function messageRenderKey(message: ChatMessage): string {
	return message.renderKey ?? message.id;
}

function findDeepResearchAnchorMessageKey(
	job: DeepResearchJob,
	messageList: ChatMessage[],
): string | null {
	if (job.triggerMessageId) {
		const exactMatch = messageList.find(
			(message) =>
				message.id === job.triggerMessageId ||
				message.renderKey === job.triggerMessageId,
		);
		if (exactMatch) return messageRenderKey(exactMatch);
	}

	const request = normalizeAnchorText(job.userRequest ?? '');
	if (!request) return null;
	const matchingUserMessage = [...messageList]
		.reverse()
		.find(
			(message) =>
				message.role === 'user' &&
				normalizeAnchorText(message.content) === request,
		);
	return matchingUserMessage ? messageRenderKey(matchingUserMessage) : null;
}

function normalizeAnchorText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function getFileProductionJobsForMessage(message: ChatMessage): FileProductionJob[] {
	return fileProductionJobs.filter((job) => {
		if (job.assistantMessageId === message.id) return true;
		if (job.assistantMessageId != null) return false;
		if (message.role !== 'assistant' || message.id !== currentStreamingAssistantMessageId) return false;
		if (conversationId && job.conversationId !== conversationId) return false;
		return job.createdAt >= message.timestamp - 1000;
	});
}

function forkSourceHref(origin: ConversationForkOrigin): string | null {
	if (!origin.sourceConversationIdAvailable) return null;
	const messageAnchor = origin.sourceAssistantMessageIdAvailable
		? `#message-${origin.sourceAssistantMessageId}`
		: '';
	return `/chat/${origin.sourceConversationId}${messageAnchor}`;
}

function contextCompressionMarkerLabel(marker: ContextCompressionMarker): string {
	if (marker.status === 'running') {
		return marker.trigger === 'automatic'
			? $t('contextCompression.automaticRunning')
			: $t('contextCompression.manualRunning');
	}
	if (marker.status === 'failed') {
		return $t('contextCompression.failed');
	}
	return marker.trigger === 'automatic'
		? $t('contextCompression.automaticValid')
		: $t('contextCompression.manualValid');
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
		{#if messages.length === 0 && deepResearchJobs.length === 0}
			<div class="conversation-empty-state">
				<div class="conversation-empty-eyebrow">{$t('chat.conversationReady')}</div>
				<p class="conversation-empty-copy">
					{$t('chat.messagesWillAppearHere')}
				</p>
			</div>
		{:else}
			{#each unanchoredDeepResearchJobs as job (job.id)}
				<ResearchCard
					job={job}
					onCancel={onCancelDeepResearchJob}
					onEdit={onEditDeepResearchPlan}
					onApprove={onApproveDeepResearchPlan}
					onOpenReport={onOpenDocument}
					onDiscussReport={onDiscussDeepResearchReport}
					onResearchFurther={onResearchFurtherFromDeepResearchReport}
					onAdvanceResearch={onAdvanceDeepResearchWorkflow}
				/>
			{/each}
			{#each dedupedMessages as message, i (message.renderKey ?? message.id)}
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
						class="fork-boundary-marker fork-lineage-marker"
						data-testid="fork-boundary-marker"
						role="note"
						aria-label={$t('fork.boundaryMarkerLabel')}
					>
						<div class="fork-lineage-icon" aria-hidden="true">
							<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M4 12h5"/>
								<path d="M9 12c4 0 5-6 10-6"/>
								<path d="M16 3l3 3-3 3"/>
								<path d="M9 12c4 0 5 6 10 6"/>
								<path d="M16 15l3 3-3 3"/>
							</svg>
						</div>
						<span class="fork-boundary-title">{$t('fork.boundaryTitle')}</span>
						{#if forkSourceHref(forkOrigin)}
							<a
								class="fork-boundary-source fork-lineage-link"
								href={forkSourceHref(forkOrigin)}
								aria-label={$t('fork.openSourceConversation', { title: forkOrigin.sourceTitle })}
							>
								{$t('fork.boundarySource', { title: forkOrigin.sourceTitle })}
							</a>
						{:else}
							<span class="fork-boundary-source fork-boundary-source-degraded">
								<span>{$t('fork.boundarySource', { title: forkOrigin.sourceTitle })}</span>
								<span class="fork-boundary-source-status">{$t('fork.sourceUnavailable')}</span>
							</span>
						{/if}
					</div>
				{/if}
				{#each contextCompressionMarkersBySourceEndMessageId.get(message.id) ?? [] as marker (marker.id)}
					<div
						class="fork-lineage-marker context-compression-marker"
						class:context-compression-marker-running={marker.status === 'running'}
						class:context-compression-marker-failed={marker.status === 'failed'}
						data-testid={`context-compression-marker-${marker.id}`}
						role="note"
						aria-label={contextCompressionMarkerLabel(marker)}
					>
						<span class="context-compression-line" aria-hidden="true"></span>
						<span class="fork-boundary-title">{contextCompressionMarkerLabel(marker)}</span>
					</div>
				{/each}
				{#each deepResearchJobsByAnchorMessageKey.get(messageRenderKey(message)) ?? [] as job (job.id)}
					<ResearchCard
						job={job}
						onCancel={onCancelDeepResearchJob}
						onEdit={onEditDeepResearchPlan}
						onApprove={onApproveDeepResearchPlan}
						onOpenReport={onOpenDocument}
						onDiscussReport={onDiscussDeepResearchReport}
						onResearchFurther={onResearchFurtherFromDeepResearchReport}
						onAdvanceResearch={onAdvanceDeepResearchWorkflow}
					/>
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
		min-height: 100%;
		flex: 1 1 auto;
		flex-direction: column;
		justify-content: center;
		gap: var(--space-sm);
		padding: 0 var(--space-sm) 10rem;
		text-align: center;
	}

	.conversation-empty-eyebrow {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.conversation-empty-copy {
		margin: 0 auto;
		max-width: 34rem;
		font-size: 0.98rem;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.fork-lineage-marker {
		display: flex;
		width: 100%;
		max-width: 100%;
		align-self: stretch;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-top: var(--space-md);
		border-left: 3px solid color-mix(in srgb, var(--accent) 78%, var(--text-primary) 22%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-elevated) 84%, var(--accent) 16%);
		padding: 0.42rem 0.6rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.76rem;
		line-height: 1.35;
		color: var(--text-secondary);
	}

	.fork-boundary-marker {
		margin: var(--space-sm) 0 var(--space-md);
	}

	.fork-lineage-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.fork-boundary-title {
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.fork-boundary-source {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		overflow-wrap: anywhere;
		color: var(--text-secondary);
	}

	.fork-boundary-source-degraded {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}

	.fork-boundary-source-status {
		color: var(--text-subtle);
	}

	.context-compression-marker {
		margin: var(--space-xs) 0 var(--space-md);
		border-left-color: color-mix(in srgb, var(--accent) 88%, var(--text-primary) 12%);
	}

	.context-compression-marker-running {
		border-left-color: color-mix(in srgb, var(--text-muted) 72%, var(--accent) 28%);
		background: color-mix(in srgb, var(--surface-elevated) 90%, var(--accent) 10%);
	}

	.context-compression-marker-failed {
		border-left-color: var(--danger, #c2410c);
		background: color-mix(in srgb, var(--surface-elevated) 88%, var(--danger, #c2410c) 12%);
	}

	.context-compression-line {
		display: block;
		flex: 0 0 2.25rem;
		height: 2px;
		border-radius: 999px;
		background: currentColor;
		opacity: 0.5;
	}

	.context-compression-marker-running .context-compression-line {
		animation: contextCompressionPulse 900ms ease-in-out infinite;
	}

	.fork-lineage-link {
		text-decoration: none;
	}

	.fork-lineage-link:hover,
	.fork-lineage-link:focus-visible {
		color: var(--text-primary);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		outline: none;
	}

	@media (min-width: 768px) {
		.scroll-clearance {
			--scroll-clearance-base: 9.5rem;
		}
	}

	@keyframes contextCompressionPulse {
		0%,
		100% {
			opacity: 0.25;
			transform: scaleX(0.72);
		}
		50% {
			opacity: 0.75;
			transform: scaleX(1);
		}
	}
</style>
