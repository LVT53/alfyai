<script lang="ts">
	import { preserveScrollOnToggle } from '$lib/actions/preserve-scroll';
	import EvidencePreferenceControl from './EvidencePreferenceControl.svelte';
	import { ChevronDown } from '@lucide/svelte';
	import type { EvidencePreference, MessageEvidenceSummary, TaskSteeringPayload } from '$lib/types';

	let {
		evidenceSummary,
		pinnedArtifactIds = [],
		excludedArtifactIds = [],
		onSteer = undefined,
	}: {
		evidenceSummary: MessageEvidenceSummary;
		pinnedArtifactIds?: string[];
		excludedArtifactIds?: string[];
		onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
	} = $props();

	let expanded = $state(false);
	let container = $state<HTMLDivElement | null>(null);
	let groupsPanel = $state<HTMLDivElement | null>(null);

	let totalItems = $derived(
		evidenceSummary.groups.reduce((count, group) => count + group.items.length, 0)
	);
	let pinnedIds = $derived(new Set(pinnedArtifactIds));
	let excludedIds = $derived(new Set(excludedArtifactIds));

	function steer(payload: TaskSteeringPayload) {
		onSteer?.(payload);
	}

	function preferenceFor(artifactId: string): EvidencePreference {
		if (excludedIds.has(artifactId)) {
			return 'excluded';
		}
		if (pinnedIds.has(artifactId)) {
			return 'pinned';
		}
		return 'auto';
	}

	function formatChannel(channel: string): string {
		if (channel === 'attached') return 'Attached';
		if (channel === 'retrieved') return 'Retrieved';
		if (channel === 'web') return 'Web';
		if (channel === 'memory') return 'Memory';
		return 'Tool';
	}

	async function toggle() {
		await preserveScrollOnToggle(container, expanded, () => { expanded = !expanded; });
	}
</script>

<div class="evidence-shell" bind:this={container}>
	<button
		type="button"
		class="evidence-toggle"
		aria-expanded={expanded}
		onclick={toggle}
	>
		<span class="evidence-toggle-copy">
			<span class="evidence-label">Evidence</span>
			<span class="evidence-count">{totalItems}</span>
		</span>
		<ChevronDown size={14} strokeWidth={2} class={`chevron${expanded ? ' expanded' : ''}`} aria-hidden="true" />
	</button>

	{#if expanded}
		<div class="evidence-groups" bind:this={groupsPanel}>
			{#each evidenceSummary.groups as group, groupIndex (`${group.sourceType}-${group.label}-${groupIndex}`)}
				<div class="evidence-group">
					<div class="evidence-group-header">
						<div class="evidence-group-title">{group.label}</div>
						<div class="evidence-group-meta">
							{#if group.reranked}
								<span class="evidence-chip">Reranked{#if group.confidence} {group.confidence}%{/if}</span>
							{/if}
						</div>
					</div>

					<div class="evidence-list">
						{#each group.items as item, itemIndex (`${group.sourceType}-${item.id}-${item.status}-${itemIndex}`)}
							<div class={`evidence-row evidence-row--${item.status}`}>
								<div class="evidence-copy">
									<div class="evidence-title-line">
										{#if item.url}
											<a
												class="evidence-title evidence-link"
												href={item.url}
												target="_blank"
												rel="noopener noreferrer"
											>
												{item.title}
											</a>
										{:else}
											<div class="evidence-title">{item.title}</div>
										{/if}
										<span class={`evidence-status evidence-status--${item.status}`}>{item.status}</span>
									</div>
									{#if item.description}
										<div class="evidence-description">{item.description}</div>
									{/if}
									{#if item.channels && item.channels.length > 0}
										<div class="evidence-channel-row">
											{#each item.channels as channel, channelIndex (`${item.id}-${channel}-${channelIndex}`)}
												<span class="evidence-channel-chip">{formatChannel(channel)}</span>
											{/each}
										</div>
									{/if}
								</div>

								{#if item.artifactId && !item.currentTurnAttachment}
									<div class="evidence-actions">
										<EvidencePreferenceControl
											artifactId={item.artifactId}
											preference={preferenceFor(item.artifactId)}
											onSteer={steer}
										/>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.evidence-shell {
		margin-top: var(--space-md);
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent 30%);
		padding-top: var(--space-sm);
	}

	.evidence-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		width: 100%;
		border: none;
		background: transparent;
		padding: var(--space-xs) 0;
		font-family: 'Nimbus Sans L', sans-serif;
		color: var(--text-muted);
		cursor: pointer;
	}

	.evidence-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.evidence-toggle-copy {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.evidence-label {
		font-size: 0.76rem;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}

	.evidence-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.35rem;
		height: 1.35rem;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--accent) 16%, transparent 84%);
		color: var(--text-primary);
		font-size: 0.7rem;
	}

	.chevron {
		color: var(--icon-muted);
		flex-shrink: 0;
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	.evidence-groups {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		margin-top: var(--space-sm);
	}

	.evidence-group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.evidence-group-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.evidence-group-title {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.evidence-chip {
		border: 1px solid color-mix(in srgb, var(--border-default) 70%, transparent 30%);
		border-radius: 9999px;
		padding: 0.18rem 0.45rem;
		font-size: 0.67rem;
		color: var(--text-muted);
	}

	.evidence-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.evidence-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.85rem;
		padding: 0.55rem 0.65rem;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent 28%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-elevated) 52%, transparent 48%);
	}

	.evidence-row--rejected {
		opacity: 0.78;
	}

	.evidence-copy {
		min-width: 0;
		flex: 1;
	}

	.evidence-title-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
	}

	.evidence-title {
		font-size: 0.82rem;
		line-height: 1.35;
		color: var(--text-primary);
		word-break: break-word;
	}

	.evidence-link {
		text-decoration: underline;
	}

	.evidence-link:hover {
		text-decoration: underline;
	}

	.evidence-status {
		font-size: 0.66rem;
		font-family: 'Nimbus Sans L', sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}

	.evidence-status--selected {
		color: var(--accent);
	}

	.evidence-description {
		margin-top: 0.22rem;
		font-size: 0.76rem;
		line-height: 1.45;
		color: var(--text-secondary);
		word-break: break-word;
	}

	.evidence-actions {
		display: flex;
		flex-shrink: 0;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.evidence-channel-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.4rem;
	}

	.evidence-channel-chip {
		border: 1px solid color-mix(in srgb, var(--border-default) 72%, transparent 28%);
		border-radius: 9999px;
		padding: 0.14rem 0.42rem;
		font-size: 0.64rem;
		font-family: 'Nimbus Sans L', sans-serif;
		color: var(--text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}

</style>
