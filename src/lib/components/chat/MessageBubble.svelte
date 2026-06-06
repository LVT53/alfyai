<script lang="ts">
	import { isDark } from '$lib/stores/theme';
	import { t } from '$lib/i18n';
	import { isVisibleThinkingSegment, isVisibleThinkingToolCall } from '$lib/utils/tool-calls';
	import { tokenizeTextLinks } from '$lib/services/linkify';
	import type {
		ArtifactSummary,
		ChatMessage,
		DepthAppliedProfile,
		DocumentWorkspaceItem,
		FileProductionJob,
	} from '$lib/types';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import ThinkingBlock from './ThinkingBlock.svelte';
	import ResponseAuditDetails from './ResponseAuditDetails.svelte';
	import LogoMark from './LogoMark.svelte';
	import FileAttachment from './FileAttachment.svelte';
	import MessageEvidenceDetails from './MessageEvidenceDetails.svelte';
	import FileProductionCard from './FileProductionCard.svelte';
	import SkillDraftCard from './SkillDraftCard.svelte';
	import { onDestroy, tick } from 'svelte';
	import type { TaskSteeringPayload } from '$lib/types';

	let {
		message,
		isLast = false,
		pinnedArtifactIds = [],
		excludedArtifactIds = [],
		fileProductionJobs = [],
		conversationId = null,
		modelIcons = {},
		readOnly = false,
		onRegenerate = undefined,
		onEdit = undefined,
		onFork = undefined,
		forkBusy = false,
		onSteer = undefined,
		onOpenDocument = undefined,
		onRetryFileProductionJob = undefined,
		onCancelFileProductionJob = undefined,
		canPublishSkillDrafts = false,
		skillDraftActionState = {},
		onSaveSkillDraft = undefined,
		onDismissSkillDraft = undefined,
		onPublishSkillDraft = undefined,
	}: {
		message: ChatMessage;
		isLast?: boolean;
		pinnedArtifactIds?: string[];
		excludedArtifactIds?: string[];
		fileProductionJobs?: FileProductionJob[];
		conversationId?: string | null;
		modelIcons?: Record<string, string | null | undefined>;
		readOnly?: boolean;
		onRegenerate?: ((payload: { messageId: string }) => void) | undefined;
		onEdit?: ((payload: { messageId: string; newText: string }) => void) | undefined;
		onFork?: ((payload: { messageId: string }) => void | Promise<void>) | undefined;
		forkBusy?: boolean;
		onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
		onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
		onRetryFileProductionJob?: ((jobId: string) => void) | undefined;
		onCancelFileProductionJob?: ((jobId: string) => void) | undefined;
		canPublishSkillDrafts?: boolean;
		skillDraftActionState?: Record<string, { busy?: boolean; error?: string | null }>;
		onSaveSkillDraft?: ((payload: { messageId: string; draftId: string }) => void | Promise<void>) | undefined;
		onDismissSkillDraft?: ((payload: { messageId: string; draftId: string }) => void | Promise<void>) | undefined;
		onPublishSkillDraft?: ((payload: { messageId: string; draftId: string }) => void | Promise<void>) | undefined;
	} = $props();

	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | undefined;
	let isEditing = $state(false);
	let editText = $state('');
	let editTextarea = $state<HTMLTextAreaElement | null>(null);
	let showTimestampTooltip = $state(false);
	let showForkDetails = $state(false);
	let dedupedFileProductionJobs = $derived(
		fileProductionJobs.reduce(
			(acc, job) => {
				if (!acc.seen.has(job.id)) {
					acc.seen.add(job.id);
					acc.list.push(job);
				}
				return acc;
			},
			{ seen: new Set<string>(), list: [] as FileProductionJob[] },
		).list,
	);
	let isUser = $derived(message.role === 'user');
	let hasAttachments = $derived((message.attachments?.length ?? 0) > 0);
	let hasThinking = $derived(Boolean(message.thinking?.trim()));
	const isStreaming = $derived(
		Boolean(message.isStreaming || message.isThinkingStreaming),
	);
	let liveResponseActivityEntries = $derived(
		!isUser && isStreaming ? (message.responseActivity ?? []) : [],
	);
	let thinkingSegmentsForDisplay = $derived(message.thinkingSegments ?? []);
	let visibleThinkingSegmentsForDisplay = $derived(
		isStreaming
			? (() => {
				const latestDeliberationStatus = [...thinkingSegmentsForDisplay]
					.reverse()
					.find(
						(segment) =>
							segment.type === 'status' &&
							segment.id.startsWith('deliberation-pass-') &&
							segment.label?.trim(),
					);
				if (!latestDeliberationStatus) {
					return thinkingSegmentsForDisplay;
				}

				return thinkingSegmentsForDisplay.filter((segment) =>
					segment.type !== 'status' ||
					!segment.id.startsWith('deliberation-pass-') ||
					segment.id === latestDeliberationStatus.id,
				);
			})()
			: thinkingSegmentsForDisplay,
	);
	let deliberationThinkingStatus = $derived(
		[...thinkingSegmentsForDisplay]
			.reverse()
			.find(
				(segment) =>
					segment.type === "status" &&
					segment.id.startsWith("deliberation-pass-") &&
					segment.label?.trim(),
			),
	);
	let hasVisibleThinkingSegments = $derived(
		thinkingSegmentsForDisplay.some(isVisibleThinkingSegment)
	);
	let hasToolCalls = $derived(
		thinkingSegmentsForDisplay.some(isVisibleThinkingToolCall)
	);
	let hasResponseAuditInfo = $derived(
		!isUser &&
			(message.content.trim().length > 0 ||
				hasThinking ||
				Boolean(message.modelDisplayName) ||
				Boolean(message.providerDisplayName) ||
				message.generationDurationMs != null ||
				message.costUsd != null ||
				message.thinkingTokenCount != null ||
				message.responseTokenCount != null ||
				message.totalTokenCount != null ||
				Boolean(message.depthMetadata))
	);
	let messageModelIconUrl = $derived(
		message.modelId ? (modelIcons[message.modelId] ?? null) : null,
	);
	let auditDetailsId = $derived(`message-info-${message.id}`);
	let skillDrafts = $derived(message.skillDrafts ?? []);
	let sourceForks = $derived(message.sourceForks);
	let userMessageSegments = $derived(isUser ? tokenizeTextLinks(message.content) : []);

	// Thinking is definitively done once visible response text has started streaming
	// OR the whole message is complete. This keeps the label as "Thinking" between
	// multi-burst thinking phases (isThinkingStreaming briefly false, but no content yet).
	let isDone = $derived(!message.isStreaming && !message.isThinkingStreaming);
	let isGenerating = $derived(Boolean(message.isStreaming || message.isThinkingStreaming));
	let hasVisibleContent = $derived(message.content.trim().length > 0);
	let hasFileProductionCards = $derived(fileProductionJobs.length > 0 && Boolean(conversationId));
	let liveDeliberationStatus = $derived(
		isStreaming
			? [...liveResponseActivityEntries]
				.reverse()
				.find((entry) => entry.kind === 'deliberation' && entry.label?.trim())
				?? deliberationThinkingStatus
			: undefined
	);
	let liveDeliberationStatusLabel = $derived(liveDeliberationStatus?.label?.trim() ?? '');
	const liveDeliberationStatusIconType = $derived.by(() => {
		if (!liveDeliberationStatus?.id) {
			return 'search';
		}

		const match = /deliberation-pass-(\d+)/i.exec(liveDeliberationStatus.id);
		const pass = match ? Number.parseInt(match[1], 10) : NaN;

		if (!Number.isInteger(pass)) {
			return 'search';
		}
		if (pass === 1) return 'search';
		if (pass === 2) return 'file';
		return 'check';
	});
	function isDepthAppliedProfile(value: unknown): value is DepthAppliedProfile {
		return value === 'off' || value === 'standard' || value === 'extended' || value === 'maximum';
	}

	let liveDepthProfile = $derived.by(() => {
		const detail = liveResponseActivityEntries.find((entry) => entry.kind === 'depth')?.detail;
		return isDepthAppliedProfile(detail) ? detail : undefined;
	});
	let resolvedDepthProfile = $derived(
		liveDepthProfile ?? message.depthMetadata?.appliedProfile,
	);
	let isDeliberativeDepthProfile = $derived(
		resolvedDepthProfile === 'extended' || resolvedDepthProfile === 'maximum',
	);
	let showPreparingStatus = $derived(
		!isUser &&
			isGenerating &&
			!hasVisibleContent &&
			!hasThinking &&
			!hasVisibleThinkingSegments &&
			!isDeliberativeDepthProfile &&
			!liveDeliberationStatusLabel &&
			skillDrafts.length === 0 &&
			!hasFileProductionCards
	);
	let hasServerPersistedIdentity = $derived(
		message.renderKey === undefined || message.renderKey !== message.id
	);
	let canFork = $derived(
		!isUser &&
			!readOnly &&
			Boolean(onFork) &&
			Boolean(message.id) &&
			hasServerPersistedIdentity &&
			!message.wasStopped &&
			!message.isStreaming &&
			!message.isThinkingStreaming &&
			message.content.trim().length > 0
	);
	let showLogoBelow = $derived(!isUser && isLast && (hasThinking || isGenerating));
	let thinkingIsDone = $derived(
		!message.isThinkingStreaming && (message.content.trim().length > 0 || isDone)
	);
	let reasoningDepthIndicatorProfile = $derived(
		getVisibleReasoningDepthProfile(liveDepthProfile ?? message.depthMetadata?.appliedProfile),
	);
	let reasoningDepthIndicatorLabel = $derived(
		reasoningDepthIndicatorProfile === 'maximum'
			? $t('messageBubble.maxReasoningDepth')
			: reasoningDepthIndicatorProfile === 'extended'
				? $t('messageBubble.extendedReasoningDepth')
				: '',
	);

	function getClipboardText(content: string) {
		return content
			.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
			.replace(/<\/?thinking>/gi, '')
			.trim();
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(getClipboardText(message.content));
			copied = true;
			clearTimeout(copyTimeout);
			copyTimeout = setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	}

	async function startEdit() {
		editText = message.content;
		isEditing = true;
		await tick();
		editTextarea?.focus();
	}

	function cancelEdit() {
		isEditing = false;
		editText = '';
	}

	function submitEdit() {
		const trimmed = editText.trim();
		if (!trimmed || trimmed === message.content) {
			cancelEdit();
			return;
		}
		onEdit?.({ messageId: message.id, newText: trimmed });
		isEditing = false;
		editText = '';
	}

	function formatTimestamp(ts: number): string {
		const date = new Date(ts);
		const now = new Date();
		const isToday = date.toDateString() === now.toDateString();

		if (isToday) {
			const h = String(date.getHours()).padStart(2, '0');
			const m = String(date.getMinutes()).padStart(2, '0');
			return `${h}:${m}`;
		}
		const day = date.getDate();
		const month = date.toLocaleString('en-GB', { month: 'short' });
		return `${day} ${month}`;
	}

	function formatFullTimestamp(ts: number): string {
		const date = new Date(ts);
		const day = date.getDate();
		const month = date.toLocaleString('en-GB', { month: 'long' });
		const year = date.getFullYear();
		const h = String(date.getHours()).padStart(2, '0');
		const m = String(date.getMinutes()).padStart(2, '0');
		return `${day} ${month} ${year}, ${h}:${m}`;
	}

	function toggleTimestampTooltip(e: MouseEvent) {
		e.stopPropagation();
		showTimestampTooltip = !showTimestampTooltip;
	}

	function getVisibleReasoningDepthProfile(
		profile: DepthAppliedProfile | undefined,
	): 'extended' | 'maximum' | null {
		return profile === 'extended' || profile === 'maximum' ? profile : null;
	}

	let timestampLabel = $derived(isUser ? formatTimestamp(message.timestamp) : '');
	let fullTimestampLabel = $derived(isUser ? formatFullTimestamp(message.timestamp) : '');
	let regenerateButtonId = $derived(`regenerate-button-${message.id}`);
	let forkButtonId = $derived(`fork-button-${message.id}`);
	let editButtonId = $derived(`edit-button-${message.id}`);
	let copyButtonId = $derived(`copy-button-${message.id}`);

	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submitEdit();
		}
		if (e.key === 'Escape') {
			cancelEdit();
		}
	}

	$effect(() => {
		if (!showTimestampTooltip) return;

		const handleWindowClick = () => {
			showTimestampTooltip = false;
		};

		window.addEventListener('click', handleWindowClick, { once: true });
		return () => {
			window.removeEventListener('click', handleWindowClick);
		};
	});

	onDestroy(() => {
		if (copyTimeout) {
			clearTimeout(copyTimeout);
		}
	});

	function handleViewAttachment(attachment: ArtifactSummary) {
		if (!onOpenDocument) return;
		onOpenDocument({
			id: `artifact:${attachment.id}`,
			source: 'knowledge_artifact',
			filename: attachment.name,
			title: attachment.name,
			mimeType: attachment.mimeType,
			artifactId: attachment.id,
			conversationId: attachment.conversationId,
		});
	}

	function skillDraftPayload(draftId: string) {
		return { messageId: message.id, draftId };
	}

	function skillDraftState(draftId: string) {
		return skillDraftActionState[`${message.id}:${draftId}`] ?? {};
	}

	function forkLinkLabel(title: string): string {
		return $t('fork.openFork', { title });
	}

	function toggleForkDetails() {
		showForkDetails = !showForkDetails;
	}
</script>

<div class="group flex w-full flex-col {isUser && !isEditing ? 'items-end' : 'items-start'} gap-md py-md fade-in">
	<div
		id={`message-${message.id}`}
		data-message-id={message.id}
		data-testid={isUser ? 'user-message' : 'assistant-message'}
		class="relative flex min-w-0 flex-col font-serif
		{isUser && !isEditing
			? 'max-w-[85%] min-w-0 rounded-md border border-border-subtle bg-surface-elevated p-sm text-text-primary shadow-sm md:max-w-[80%]'
			: isUser
				? 'w-full min-w-0 max-w-full rounded-md border border-border bg-surface-elevated p-md text-text-primary shadow-sm'
			: 'w-full min-w-0 max-w-full rounded-none bg-surface-page p-sm text-text-primary'}"
	>
		{#if !isUser && reasoningDepthIndicatorLabel && (hasThinking || hasVisibleThinkingSegments || hasToolCalls)}
			<div class="reasoning-depth-indicator" data-testid="reasoning-depth-indicator">
				<svg
					class="reasoning-depth-icon"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M12 5a3 3 0 0 0-5.7-1.3 3 3 0 0 0-2.7 5.1 3 3 0 0 0 0 5.4 3 3 0 0 0 2.7 5.1A3 3 0 0 0 12 19Z" />
					<path d="M12 5a3 3 0 0 1 5.7-1.3 3 3 0 0 1 2.7 5.1 3 3 0 0 1 0 5.4 3 3 0 0 1-2.7 5.1A3 3 0 0 1 12 19Z" />
					<path d="M12 5v14" />
					<path d="M8 9h1" />
					<path d="M15 9h1" />
					<path d="M8 15h1" />
					<path d="M15 15h1" />
				</svg>
				<span>{reasoningDepthIndicatorLabel}</span>
			</div>
		{/if}
	{#if !isUser && liveDeliberationStatusLabel}
		{#key `${liveDeliberationStatus?.id ?? 'deliberation'}:${liveDeliberationStatusLabel}`}
			<div class="deliberation-status-line" class:is-running={liveDeliberationStatus?.status === 'running'} data-testid="deliberation-status-line" aria-live="polite">
				{#if liveDeliberationStatusIconType === 'search'}
					<svg
						class="deliberation-status-icon"
						data-deliberation-icon="search"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<circle cx="10.5" cy="10.5" r="7.5" />
						<path d="m20.5 20.5-4.35-4.35" />
					</svg>
				{:else if liveDeliberationStatusIconType === 'file'}
					<svg
						class="deliberation-status-icon"
						data-deliberation-icon="file"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M4 4h10l5 5v13H4Z" />
						<path d="m14 4 5 5h-5Z" />
						<path d="M7 11h9" />
						<path d="M7 15h9" />
					</svg>
				{:else}
					<svg
						class="deliberation-status-icon"
						data-deliberation-icon="check"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="9" />
						<path d="M8 12l2.5 2.5 5-5" />
					</svg>
				{/if}
				<span>{liveDeliberationStatusLabel}</span>
			</div>
			{/key}
		{/if}
		{#if !isUser && (hasThinking || hasVisibleThinkingSegments || hasToolCalls)}
		<ThinkingBlock
			content={message.thinking ?? ''}
			thinkingIsDone={thinkingIsDone}
			segments={visibleThinkingSegmentsForDisplay}
			streaming={isStreaming}
			thinkingDurationSeconds={message.generationDurationMs ? Math.round(message.generationDurationMs / 1000) : 0}
		/>
		{/if}
		{#if isUser}
			{#if isEditing}
				<div class="flex flex-col gap-3">
					<textarea
						bind:this={editTextarea}
						class="w-full resize-none rounded-md border border-border bg-surface-page px-4 py-3 font-serif text-[16px] leading-[1.6] text-text-primary focus:border-focus-ring focus:outline-none focus:ring-2 focus:ring-focus-ring"
						bind:value={editText}
						onkeydown={handleEditKeydown}
						rows={Math.min(10, Math.max(3, editText.split('\n').length))}
					></textarea>
					<div class="flex items-center gap-3 justify-end">
						<span class="text-xs text-text-muted">{$t('messageBubble.sendShortcut')}</span>
						<button type="button" class="btn-secondary" onclick={cancelEdit}>{$t('common.cancel')}</button>
						<button type="button" class="btn-primary" onclick={submitEdit} disabled={!editText.trim()}>{$t('chat.sendMessage')}</button>
					</div>
				</div>
			{:else}
				{#if hasAttachments}
					<div class="mb-3 flex flex-wrap gap-2">
						{#each message.attachments ?? [] as attachment (attachment.id)}
							<FileAttachment
								{attachment}
								variant="compact"
								viewable={Boolean(onOpenDocument)}
								onView={handleViewAttachment}
							/>
						{/each}
					</div>
				{/if}
				<div class="whitespace-pre-wrap break-words text-[15px] leading-[1.5] md:leading-[1.55]">
					{#if userMessageSegments.length > 0}
						{#each userMessageSegments as segment}
							{#if segment.kind === 'link'}
								<a
									class="user-message-link"
									href={segment.href}
									target="_blank"
									rel="noopener noreferrer external"
								>
									{segment.text}
								</a>
							{:else}
								<span>{segment.text}</span>
							{/if}
						{/each}
					{:else}
						{message.content}
					{/if}
				</div>
			{/if}
		{:else}
			<div class="prose-container min-w-0 w-full text-[15px] leading-[1.5] md:leading-[1.55]">
				<MarkdownRenderer
					content={message.content}
					isDark={$isDark}
					isStreaming={Boolean(message.isStreaming)}
					compactExternalLinks
				/>
			</div>
			{#if showPreparingStatus}
				<div class="preparing-status" aria-live="polite">{$t('chat.preparingResponse')}</div>
			{/if}
			{#if skillDrafts.length > 0}
				<div class="skill-draft-list">
					{#each skillDrafts as draft (draft.id)}
						{@const actionState = skillDraftState(draft.id)}
						<SkillDraftCard
							{draft}
							canPublishSystem={canPublishSkillDrafts}
							busy={Boolean(actionState.busy)}
							actionError={actionState.error ?? null}
							onSave={(draftId) => onSaveSkillDraft?.(skillDraftPayload(draftId))}
							onDismiss={(draftId) => onDismissSkillDraft?.(skillDraftPayload(draftId))}
							onPublish={(draftId) => onPublishSkillDraft?.(skillDraftPayload(draftId))}
						/>
					{/each}
				</div>
			{/if}
			{#if fileProductionJobs.length > 0 && conversationId}
				<div class="file-production-inline" data-testid="message-file-production-jobs">
					{#each dedupedFileProductionJobs as job (job.id)}
						<FileProductionCard
							{job}
							onOpenDocument={onOpenDocument}
							onRetry={onRetryFileProductionJob}
							onCancel={onCancelFileProductionJob}
						/>
					{/each}
				</div>
			{/if}
			{#if sourceForks && sourceForks.count > 0}
				<div
					class="fork-origin-marker fork-lineage-marker"
					data-testid="fork-origin-marker"
					role="note"
					aria-label={$t('fork.originMarkerLabel')}
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
					{#if sourceForks.count === 1 && sourceForks.forks[0]}
						{@const childFork = sourceForks.forks[0]}
						<span class="fork-origin-label">{$t('fork.originSingleLabel')}</span>
						<a
							class="fork-origin-link"
							href={`/chat/${childFork.conversationId}`}
							aria-label={forkLinkLabel(childFork.title)}
						>
							{childFork.title}
						</a>
					{:else}
						<div class="fork-origin-details">
							<button
								type="button"
								class="fork-origin-summary"
								aria-expanded={showForkDetails}
								onclick={toggleForkDetails}
							>
								{$t('fork.originCountLabel', { count: sourceForks.count })}
							</button>
							{#if showForkDetails}
								<div class="fork-origin-list">
									{#each sourceForks.forks as childFork (childFork.conversationId)}
										<a
											class="fork-origin-link"
											href={`/chat/${childFork.conversationId}`}
											aria-label={forkLinkLabel(childFork.title)}
										>
											{childFork.title}
										</a>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
			{#if message.evidenceSummary && message.evidenceSummary.groups.length > 0}
				<MessageEvidenceDetails
					evidenceSummary={message.evidenceSummary}
					{pinnedArtifactIds}
					{excludedArtifactIds}
					onSteer={onSteer}
				/>
			{:else if message.evidencePending}
				<div class="evidence-pending">Evidence is loading…</div>
			{/if}
			{/if}

	</div>

	{#if !message.isStreaming && !isEditing}
		<div
			class="copy-action-row flex w-full items-center gap-0.5 opacity-100 transition-opacity duration-[var(--duration-micro)] md:opacity-0 md:group-hover:opacity-100"
			class:justify-end={isUser}
			class:justify-start={!isUser}
		>
			{#if !isUser && hasResponseAuditInfo}
				<div class="info-container">
					<button
						type="button"
						class="btn-icon-bare info-button sm:!min-h-[36px] sm:!min-w-[36px]"
						aria-label={$t('messageBubble.info')}
						aria-describedby={auditDetailsId}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="16" x2="12" y2="12"></line>
							<line x1="12" y1="8" x2="12.01" y2="8"></line>
						</svg>
					</button>
					<div
						id={auditDetailsId}
						class="info-popover"
					>
						<ResponseAuditDetails
							{message}
							modelIconUrl={messageModelIconUrl}
						/>
					</div>
				</div>
			{/if}

			{#if !isUser && !readOnly}
				<!-- Regenerate button -->
				<div class="action-tooltip-container">
					<button
						id={regenerateButtonId}
						type="button"
						class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
						onclick={() => onRegenerate?.({ messageId: message.id })}
						aria-label={$t('messageBubble.regenerate')}
						aria-describedby={`${regenerateButtonId}-tooltip`}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 2v6h-6"/>
							<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
							<path d="M3 22v-6h6"/>
							<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
						</svg>
					</button>
					<div
						id={`${regenerateButtonId}-tooltip`}
						class="action-tooltip"
						role="tooltip"
					>
						<div class="tooltip-content">
							<div class="tooltip-row">
								<span class="tooltip-value">{$t('messageBubble.actionRegenerate')}</span>
							</div>
						</div>
					</div>
				</div>
			{/if}

			{#if canFork}
				<div class="action-tooltip-container">
					<button
						id={forkButtonId}
						type="button"
						class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
						onclick={() => onFork?.({ messageId: message.id })}
						disabled={forkBusy}
						aria-label={forkBusy ? $t('fork.creating') : $t('messageBubble.forkFromHere')}
						aria-describedby={`${forkButtonId}-tooltip`}
					>
						{#if forkBusy}
							<span class="mini-spinner" aria-hidden="true"></span>
						{:else}
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M4 12h5"/>
								<path d="M9 12c4 0 5-6 10-6"/>
								<path d="M16 3l3 3-3 3"/>
								<path d="M9 12c4 0 5 6 10 6"/>
								<path d="M16 15l3 3-3 3"/>
							</svg>
						{/if}
					</button>
					<div
						id={`${forkButtonId}-tooltip`}
						class="action-tooltip"
						role="tooltip"
					>
						<div class="tooltip-content">
							<div class="tooltip-row">
								<span class="tooltip-value">{forkBusy ? $t('fork.creating') : $t('messageBubble.actionFork')}</span>
							</div>
						</div>
					</div>
				</div>
			{/if}

			{#if isUser}
				<div class="timestamp-container">
					<button
						type="button"
						class="timestamp-label font-mono tabular-nums"
						onclick={toggleTimestampTooltip}
					>{timestampLabel}</button>
					<div class="timestamp-tooltip" class:visible={showTimestampTooltip}>
						<div class="tooltip-content">
							<div class="tooltip-row">
								<span class="tooltip-value">{fullTimestampLabel}</span>
							</div>
						</div>
					</div>
				</div>
				{#if !readOnly}
					<!-- Edit button -->
					<div class="action-tooltip-container">
						<button
							id={editButtonId}
							type="button"
							class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
							onclick={startEdit}
							aria-label={$t('messageBubble.editMessage')}
							aria-describedby={`${editButtonId}-tooltip`}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</button>
						<div
							id={`${editButtonId}-tooltip`}
							class="action-tooltip"
							role="tooltip"
						>
							<div class="tooltip-content">
								<div class="tooltip-row">
									<span class="tooltip-value">{$t('messageBubble.actionEdit')}</span>
								</div>
							</div>
						</div>
					</div>
				{/if}
			{/if}

			<div class="action-tooltip-container">
				<button
					id={copyButtonId}
					type="button"
					class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
					onclick={copyToClipboard}
					aria-label={$t('messageBubble.copyMessage')}
					aria-describedby={`${copyButtonId}-tooltip`}
				>
					{#if copied}
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-icon-primary">
							<polyline points="20 6 9 17 4 12"></polyline>
						</svg>
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
						</svg>
					{/if}
				</button>
				<div
					id={`${copyButtonId}-tooltip`}
					class="action-tooltip"
					role="tooltip"
				>
					<div class="tooltip-content">
						<div class="tooltip-row">
							<span class="tooltip-value">{$t('messageBubble.actionCopy')}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	{/if}
	{#if showLogoBelow}
		<div class="logo-signature">
			<LogoMark animated={isGenerating} size={42} />
		</div>
	{/if}
</div>

<style lang="postcss">
	/* Override Tailwind prose base font size to match reduced chat text size */
	.prose-container {
		min-width: 0;
		width: 100%;
		max-width: 100%;
		overflow-x: clip;
		overflow-y: visible;
	}

	.user-message-link {
		color: var(--accent);
		font-weight: 560;
		text-decoration-line: underline;
		text-decoration-thickness: 0.08em;
		text-underline-offset: 0.16em;
	}

	.user-message-link:hover,
	.user-message-link:focus-visible {
		color: var(--accent-hover);
		outline: none;
	}

	.user-message-link:focus-visible {
		border-radius: 0.18rem;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 42%, transparent);
	}

	.reasoning-depth-indicator {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin-bottom: var(--space-xs);
		color: var(--text-muted);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
		font-weight: 700;
		line-height: 1.25;
	}

	.reasoning-depth-icon {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		color: currentColor;
	}

	.deliberation-status-line {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0 0 var(--space-xs);
		color: var(--text-muted);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
		font-weight: 600;
		line-height: 1.25;
		animation: deliberationStatusFade 220ms var(--ease-out) both;
	}

	.deliberation-status-line.is-running {
		color: var(--accent);
	}

	.deliberation-status-icon {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		color: currentColor;
	}

	@keyframes deliberationStatusFade {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	.prose-container :global(.prose) {
		width: 100%;
		min-width: 0;
		max-width: 100%;
	}

	.prose-container :global(.prose) {
		font-size: 15px;
		line-height: 1.5;
	}
	@media (min-width: 768px) {
		.prose-container :global(.prose) {
			font-size: 15px;
			line-height: 1.55;
		}
	}
	.prose-container :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-sm);
		margin: 1rem 0;
		max-height: 400px;
		object-fit: contain;
		background-color: var(--surface-elevated);
	}
	.prose-container :global(.source-link-chip img.source-link-chip__favicon) {
		margin: 0;
	}
	.prose-container :global(p),
	.prose-container :global(li),
	.prose-container :global(blockquote),
	.prose-container :global(h1),
	.prose-container :global(h2),
	.prose-container :global(h3),
	.prose-container :global(h4),
	.prose-container :global(h5),
	.prose-container :global(h6) {
		word-break: break-word;
		overflow-wrap: break-word;
	}
	/* But don't break code — let it scroll */
	.prose-container :global(pre),
	.prose-container :global(code) {
		word-break: normal;
		overflow-wrap: normal;
	}
	.prose-container :global(.markdown-table-wrap) {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		margin: 0 0 var(--space-md);
	}
	.prose-container :global(.markdown-table-wrap[data-overflow='scroll']) {
		overflow-x: auto;
		padding-bottom: 0.15rem;
	}
	.prose-container :global(.markdown-table-wrap[data-overflow='fit']) {
		overflow-x: clip;
	}
	.prose-container :global(.markdown-table-wrap table) {
		width: 100%;
		min-width: 0;
		table-layout: fixed;
		border-collapse: collapse;
	}
	.prose-container :global(.markdown-table-wrap[data-overflow='scroll'] table) {
		width: max-content;
		min-width: 100%;
		table-layout: auto;
	}
	.prose-container :global(.markdown-table-wrap th),
	.prose-container :global(.markdown-table-wrap td) {
		white-space: normal;
		word-break: normal;
		overflow-wrap: break-word;
		hyphens: auto;
		vertical-align: top;
	}
	.prose-container :global(.markdown-table-wrap th a),
	.prose-container :global(.markdown-table-wrap td a),
	.prose-container :global(.markdown-table-wrap th code),
	.prose-container :global(.markdown-table-wrap td code) {
		word-break: break-word;
		overflow-wrap: anywhere;
	}
	.prose-container :global(a),
	.prose-container :global(li code),
	.prose-container :global(p code),
	.prose-container :global(blockquote code) {
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	.prose-container :global(p) {
		margin-top: 0;
		margin-bottom: var(--space-md);
	}
	.prose-container :global(p:last-child) {
		margin-bottom: 0;
	}
	.fade-in {
		animation: fadeIn var(--duration-micro) var(--ease-out) forwards;
	}
	.copy-action-row {
		margin-top: var(--space-sm);
	}

	.mini-spinner {
		width: 1rem;
		height: 1rem;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 999px;
		animation: spin 700ms linear infinite;
	}

	.file-production-inline {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin-top: var(--space-md);
	}

	.preparing-status {
		margin-top: var(--space-xs);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--text-muted);
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

	.fork-lineage-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.fork-origin-label {
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.fork-origin-link {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		overflow-wrap: anywhere;
		color: var(--text-secondary);
		text-decoration: none;
	}

	.fork-origin-link:hover,
	.fork-origin-link:focus-visible {
		color: var(--text-primary);
		text-decoration: underline;
		text-underline-offset: 0.18em;
		outline: none;
	}

	.fork-origin-details {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.fork-origin-summary {
		display: inline-flex;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
		font: inherit;
		font-weight: 700;
		padding: 0;
		text-align: left;
	}

	.fork-origin-summary:hover,
	.fork-origin-summary:focus-visible {
		text-decoration: underline;
		text-underline-offset: 0.18em;
		outline: none;
	}

	.fork-origin-list {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.18rem;
		margin-top: var(--space-xs);
	}

	.evidence-pending {
		margin-top: var(--space-md);
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent 30%);
		padding-top: var(--space-sm);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.76rem;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.info-container {
		position: relative;
		display: inline-flex;
	}

	.info-popover {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
		transform: translateY(4px);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		z-index: 50;
		pointer-events: none;
		max-width: calc(100vw - 2rem);
	}

	.info-container:hover .info-popover,
	.info-container:focus-within .info-popover {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		pointer-events: auto;
	}

	.tooltip-content {
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		padding: var(--space-sm) var(--space-md);
		box-shadow: var(--shadow-lg);
		white-space: nowrap;
	}

	.tooltip-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 12px;
		line-height: 1.4;
	}

	.tooltip-value {
		color: var(--text-primary);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.timestamp-container {
		position: relative;
		display: inline-flex;
	}

	.action-tooltip-container {
		position: relative;
		display: inline-flex;
	}

	.action-tooltip-container {
		position: relative;
		display: inline-flex;
	}

	.action-tooltip-container {
		position: relative;
		display: inline-flex;
	}

	.timestamp-label {
		font-size: 11px;
		color: var(--text-muted);
		padding: 0 0.5rem;
		min-height: 44px;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		background: none;
		border: none;
		cursor: default;
	}

	.timestamp-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%) translateY(4px);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		z-index: 50;
		pointer-events: none;
	}

	.action-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%) translateY(4px);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		z-index: 50;
		pointer-events: none;
	}

	.timestamp-container:hover .timestamp-tooltip,
	.timestamp-tooltip.visible {
		opacity: 1;
		visibility: visible;
		transform: translateX(-50%) translateY(0);
		pointer-events: auto;
	}

	.action-tooltip-container:hover .action-tooltip,
	.action-tooltip-container:focus-within .action-tooltip {
		opacity: 1;
		visibility: visible;
		transform: translateX(-50%) translateY(0);
	}

	.logo-signature {
		display: flex;
		justify-content: flex-start;
		margin-top: var(--space-xs);
		opacity: 0.85;
	}

	@media (prefers-reduced-motion: reduce) {
		.deliberation-status-line {
			animation: none;
		}

		.info-popover,
		.timestamp-tooltip,
		.action-tooltip {
			transition: none;
		}
	}
</style>
