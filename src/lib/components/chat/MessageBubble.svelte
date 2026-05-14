<script lang="ts">
	import { isDark } from '$lib/stores/theme';
	import { t } from '$lib/i18n';
	import { estimateTokenCount } from '$lib/utils/tokens';
	import { isVisibleThinkingToolCall } from '$lib/utils/tool-calls';
	import type {
		ArtifactSummary,
		ChatMessage,
		DocumentWorkspaceItem,
		FileProductionJob,
	} from '$lib/types';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import ThinkingBlock from './ThinkingBlock.svelte';
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
		readOnly = false,
		onRegenerate = undefined,
		onEdit = undefined,
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
		readOnly?: boolean;
		onRegenerate?: ((payload: { messageId: string }) => void) | undefined;
		onEdit?: ((payload: { messageId: string; newText: string }) => void) | undefined;
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
	let hasToolCalls = $derived(
		(message.thinkingSegments?.some(isVisibleThinkingToolCall)) ?? false
	);
	let thinkingTokenCount = $derived(hasThinking ? estimateTokenCount(message.thinking ?? '') : 0);
	let responseTokenCount = $derived(estimateTokenCount(message.content));
	let totalTokenCount = $derived(thinkingTokenCount + responseTokenCount);
	let hasTokenInfo = $derived(hasThinking || responseTokenCount > 0 || message.costUsd != null);
	let skillDrafts = $derived(message.skillDrafts ?? []);

	// Thinking is definitively done once visible response text has started streaming
	// OR the whole message is complete. This keeps the label as "Thinking" between
	// multi-burst thinking phases (isThinkingStreaming briefly false, but no content yet).
	let isDone = $derived(!message.isStreaming && !message.isThinkingStreaming);
	let isGenerating = $derived(Boolean(message.isStreaming || message.isThinkingStreaming));
	let showLogoBelow = $derived(!isUser && isLast && (hasThinking || isGenerating));
	let thinkingIsDone = $derived(
		hasThinking && !message.isThinkingStreaming && (message.content.trim().length > 0 || isDone)
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

	function formatDuration(ms: number): string {
		if (ms < 1000) {
			return `${ms}ms`;
		}
		const seconds = ms / 1000;
		if (seconds < 60) {
			return `${seconds.toFixed(1)}s`;
		}
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = (seconds % 60).toFixed(1);
		return `${minutes}m ${remainingSeconds}s`;
	}

	function toggleTimestampTooltip(e: MouseEvent) {
		e.stopPropagation();
		showTimestampTooltip = !showTimestampTooltip;
	}

	let timestampLabel = $derived(isUser ? formatTimestamp(message.timestamp) : '');
	let fullTimestampLabel = $derived(isUser ? formatFullTimestamp(message.timestamp) : '');

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
		{#if !isUser && (hasThinking || hasToolCalls)}
			<ThinkingBlock
				content={message.thinking ?? ''}
				thinkingIsDone={thinkingIsDone}
				segments={message.thinkingSegments ?? []}
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
					{message.content}
				</div>
			{/if}
		{:else}
			<div class="prose-container min-w-0 w-full overflow-hidden text-[15px] leading-[1.5] md:leading-[1.55]">
				<MarkdownRenderer
					content={message.content}
					isDark={$isDark}
					isStreaming={Boolean(message.isStreaming)}
				/>
			</div>
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
			{#if !isUser && hasTokenInfo}
				<div class="info-container">
					<button
						type="button"
						class="btn-icon-bare info-button sm:!min-h-[36px] sm:!min-w-[36px]"
						aria-label={$t('messageBubble.messageInfo')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="16" x2="12" y2="12"></line>
							<line x1="12" y1="8" x2="12.01" y2="8"></line>
						</svg>
					</button>
						<div class="info-tooltip">
							<div class="tooltip-content">
								{#if message.modelDisplayName}
									<div class="tooltip-row">
										<span class="tooltip-label">Model</span>
										<span class="tooltip-value">{message.modelDisplayName}</span>
									</div>
								{/if}
								{#if message.generationDurationMs && message.generationDurationMs > 0}
									<div class="tooltip-row">
										<span class="tooltip-label">Response time</span>
										<span class="tooltip-value">{formatDuration(message.generationDurationMs)}</span>
									</div>
								{/if}
								{#if hasThinking}
									<div class="tooltip-row">
										<span class="tooltip-label">Thinking tokens</span>
										<span class="tooltip-value">{thinkingTokenCount.toLocaleString()}</span>
									</div>
								{/if}
								{#if responseTokenCount > 0}
									<div class="tooltip-row">
										<span class="tooltip-label">Response tokens</span>
										<span class="tooltip-value">{responseTokenCount.toLocaleString()}</span>
									</div>
								{/if}
								{#if totalTokenCount > 0}
									<div class="tooltip-row">
										<span class="tooltip-label">Total tokens</span>
										<span class="tooltip-value">{totalTokenCount.toLocaleString()}</span>
									</div>
								{/if}
								{#if message.costUsd != null}
									<div class="tooltip-row">
										<span class="tooltip-label">Cost</span>
										<span class="tooltip-value">${message.costUsd.toFixed(6)}</span>
									</div>
								{/if}
							</div>
						</div>
				</div>
			{/if}

			{#if !isUser && !readOnly}
				<!-- Regenerate button -->
				<button
					type="button"
					class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
					onclick={() => onRegenerate?.({ messageId: message.id })}
					title={$t('messageBubble.regenerate')}
					aria-label={$t('messageBubble.regenerate')}
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 2v6h-6"/>
						<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
						<path d="M3 22v-6h6"/>
						<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
					</svg>
				</button>
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
					<button
						type="button"
						class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
						onclick={startEdit}
						title={$t('messageBubble.editMessage')}
						aria-label={$t('messageBubble.editMessage')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
							<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
						</svg>
					</button>
				{/if}
			{/if}

			<button
				type="button"
				class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
				onclick={copyToClipboard}
				title={$t('messageBubble.copyMessage')}
				aria-label={$t('messageBubble.copyMessage')}
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

	.file-production-inline {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin-top: var(--space-md);
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

	.info-container {
		position: relative;
		display: inline-flex;
	}

	.info-tooltip {
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

	.info-container:hover .info-tooltip,
	.info-button:focus-visible + .info-tooltip {
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

	.tooltip-row + .tooltip-row {
		margin-top: var(--space-xs);
	}

	.tooltip-label {
		color: var(--text-muted);
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

	.timestamp-container:hover .timestamp-tooltip,
	.timestamp-tooltip.visible {
		opacity: 1;
		visibility: visible;
		transform: translateX(-50%) translateY(0);
		pointer-events: auto;
	}

	.logo-signature {
		display: flex;
		justify-content: flex-start;
		margin-top: var(--space-xs);
		opacity: 0.85;
	}

	@media (prefers-reduced-motion: reduce) {
		.info-tooltip,
		.timestamp-tooltip {
			transition: none;
		}
	}
</style>
