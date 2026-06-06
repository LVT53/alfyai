<script lang="ts">
	import { t } from '$lib/i18n';
	import type {
		ChatMessage,
		DepthAppliedProfile,
		ReasoningDepth,
	} from '$lib/types';
	import { estimateTokenCount } from '$lib/utils/tokens';
	import ModelIcon from '$lib/components/ui/ModelIcon.svelte';

	let {
		message,
		modelIconUrl = null,
	}: {
		message: ChatMessage;
		modelIconUrl?: string | null;
	} = $props();

	type AuditRow = {
		label: string;
		value: string;
		kind?: 'model';
		iconUrl?: string | null;
	};

	let hasThinkingText = $derived(Boolean(message.thinking?.trim()));
	let thinkingTokenCount = $derived(
		message.thinkingTokenCount ?? (hasThinkingText ? estimateTokenCount(message.thinking ?? '') : 0),
	);
	let responseTokenCount = $derived(
		message.responseTokenCount ?? estimateTokenCount(message.content),
	);
	let totalTokenCount = $derived(
		message.totalTokenCount ?? thinkingTokenCount + responseTokenCount,
	);
	let primaryRows = $derived(buildPrimaryRows());

	function formatRequestedDepth(depth: ReasoningDepth): string {
		if (depth === 'off') return $t('composerTools.reasoningDepthOff');
		if (depth === 'max') return $t('composerTools.reasoningDepthMax');
		return $t('composerTools.reasoningDepthAuto');
	}

	function formatAppliedDepthProfile(profile: DepthAppliedProfile): string {
		if (profile === 'off') return $t('messageBubble.depthProfileOff');
		if (profile === 'extended') return $t('messageBubble.depthProfileExtended');
		if (profile === 'maximum') return $t('messageBubble.depthProfileMaximum');
		return $t('messageBubble.depthProfileStandard');
	}

	function formatDepthMetadata(metadata: ChatMessage['depthMetadata']): string {
		if (!metadata) return '';
		const requested = formatRequestedDepth(metadata.requested);
		const applied = formatAppliedDepthProfile(metadata.appliedProfile);
		const label =
			requested === applied
				? requested
				: $t('messageBubble.depthValue', { requested, applied });
		return metadata.fallback
			? `${label} ${$t('messageBubble.depthFallbackSuffix')}`
			: label;
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

	function buildPrimaryRows(): AuditRow[] {
		const rows: AuditRow[] = [];
		if (message.providerDisplayName) {
			rows.push({
				label: $t('messageBubble.auditProvider'),
				value: message.providerDisplayName,
				kind: 'model',
				iconUrl: message.providerIconUrl ?? null,
			});
		}
		if (message.modelDisplayName) {
			rows.push({
				label: $t('messageBubble.auditModel'),
				value: message.modelDisplayName,
				kind: 'model',
				iconUrl: modelIconUrl,
			});
		}
		const depthLabel = formatDepthMetadata(message.depthMetadata);
		if (depthLabel) {
			rows.push({ label: $t('messageBubble.reasoningDepth'), value: depthLabel });
		}
		if (message.generationDurationMs && message.generationDurationMs > 0) {
			rows.push({
				label: $t('messageBubble.auditResponseTime'),
				value: formatDuration(message.generationDurationMs),
			});
		}
		if (thinkingTokenCount > 0) {
			rows.push({
				label: $t('messageBubble.auditThinkingTokens'),
				value: thinkingTokenCount.toLocaleString(),
			});
		}
		if (responseTokenCount > 0) {
			rows.push({
				label: $t('messageBubble.auditResponseTokens'),
				value: responseTokenCount.toLocaleString(),
			});
		}
		if (totalTokenCount > 0) {
			rows.push({
				label: $t('messageBubble.auditTotalTokens'),
				value: totalTokenCount.toLocaleString(),
			});
		}
		if (message.costUsd != null) {
			rows.push({
				label: $t('messageBubble.auditCost'),
				value: `$${message.costUsd.toFixed(6)}`,
			});
		}
		return rows;
	}
</script>

<div class="audit-panel" role="tooltip" aria-labelledby={`response-audit-title-${message.id}`}>
	<div class="audit-heading" id={`response-audit-title-${message.id}`}>
		{$t('messageBubble.info')}
	</div>

	{#if primaryRows.length > 0}
		<div class="audit-section">
			{#each primaryRows as row (`primary-${row.label}`)}
				<div class="audit-row">
					<span class="audit-label">{row.label}</span>
					<span class="audit-value" class:audit-model-value={row.kind === 'model'}>
						{#if row.kind === 'model'}
							<ModelIcon iconUrl={row.iconUrl ?? null} displayName={row.value} size={18} />
						{/if}
						<span>{row.value}</span>
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.audit-panel {
		width: min(20rem, calc(100vw - 2rem));
		max-height: min(72vh, 32rem);
		overflow-y: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding: var(--space-sm) var(--space-md);
		font-family: 'Nimbus Sans L', sans-serif;
		color: var(--text-primary);
	}

	.audit-heading {
		margin-bottom: var(--space-xs);
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.audit-section {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.audit-row {
		display: flex;
		min-width: 0;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-md);
		font-size: 12px;
		line-height: 1.4;
	}

	.audit-label {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.audit-value {
		display: inline-flex;
		min-width: 0;
		justify-content: flex-end;
		text-align: right;
		overflow-wrap: anywhere;
		word-break: break-word;
		color: var(--text-primary);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.audit-model-value {
		align-items: center;
		gap: var(--space-xs);
	}

	@media (max-width: 640px) {
		.audit-panel {
			width: min(20rem, calc(100vw - 1rem));
			max-height: 70vh;
		}

		.audit-row {
			gap: var(--space-sm);
		}
	}
</style>
