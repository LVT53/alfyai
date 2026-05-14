<script lang="ts">
	import EvidencePreferenceControl from './EvidencePreferenceControl.svelte';
	import { t } from '$lib/i18n';
	import type {
		ContextDebugState,
		ContextSourceGroupKind,
		ContextSourceItem,
		ContextSourcesState,
		EvidencePreference,
		TaskSteeringPayload,
	} from '$lib/types';

	let {
		open = false,
		contextDebug = null,
		contextSources = null,
		onClose = undefined,
		onSteer = undefined,
	}: {
		open?: boolean;
		contextDebug?: ContextDebugState | null;
		contextSources?: ContextSourcesState | null;
		onClose?: (() => void) | undefined;
		onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
	} = $props();

	function close() {
		onClose?.();
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			close();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			close();
		}
	}

	function preferenceFor(artifactId: string): EvidencePreference {
		if (contextDebug?.excludedEvidence.some((item) => item.artifactId === artifactId)) {
			return 'excluded';
		}
		if (contextDebug?.pinnedEvidence.some((item) => item.artifactId === artifactId)) {
			return 'pinned';
		}
		return 'auto';
	}

	let pinnedIds = $derived(new Set(contextDebug?.pinnedEvidence.map((item) => item.artifactId) ?? []));
	let excludedIds = $derived(
		new Set(contextDebug?.excludedEvidence.map((item) => item.artifactId) ?? [])
	);
	let selectedRows = $derived(
		contextSources
			? contextSources.groups
				.filter((group) => group.state === 'active')
				.flatMap((group) => group.items)
				.filter((item) => item.state === 'active')
			: contextDebug?.selectedEvidence.filter(
				(item) => !pinnedIds.has(item.artifactId) && !excludedIds.has(item.artifactId)
			) ?? []
	);
	let inferredRows = $derived(
		contextSources
			? contextSources.groups
				.filter((group) => group.state === 'inferred')
				.flatMap((group) => group.items)
				.filter((item) => item.state === 'inferred')
			: []
	);
	let pinnedRows = $derived(
		contextSources?.groups.find((group) => group.kind === 'pinned')?.items ??
			contextDebug?.pinnedEvidence ??
			[]
	);
	let excludedRows = $derived(
		contextSources?.groups.find((group) => group.kind === 'excluded')?.items ??
			contextDebug?.excludedEvidence ??
			[]
	);

	function steer(payload: TaskSteeringPayload) {
		onSteer?.(payload);
	}

	function itemId(item: ContextSourceItem | { artifactId: string }): string {
		return 'id' in item ? item.id : item.artifactId;
	}

	function itemArtifactId(item: ContextSourceItem | { artifactId: string }): string | null {
		return item.artifactId ?? null;
	}

	function itemTitle(item: ContextSourceItem | { name: string }): string {
		return 'title' in item ? item.title : item.name;
	}

	function itemSourceType(item: ContextSourceItem | { sourceType: string }): string {
		return item.sourceType;
	}

	function itemReason(item: ContextSourceItem | { reason?: string | null }): string | null {
		return item.reason ?? null;
	}

	function formatSourceState(): string {
		if (contextSources?.compacted) return $t('contextSources.compacted');
		if (contextSources?.reduced) return $t('contextSources.reduced');
		return $t('contextSources.full');
	}

	function formatGroupKind(kind: ContextSourceGroupKind): string {
		switch (kind) {
			case 'attachments':
				return $t('contextSources.group.attachments');
			case 'linked_source':
				return $t('contextSources.group.linkedSource');
			case 'working_set':
				return $t('contextSources.group.workingSet');
			case 'task_evidence':
				return $t('contextSources.group.taskEvidence');
			case 'pinned':
				return $t('contextSources.pinned');
			case 'excluded':
				return $t('contextSources.excluded');
			case 'memory':
				return $t('contextSources.group.memory');
			case 'project_folder':
				return $t('contextSources.group.projectFolder');
			case 'project_continuity':
				return $t('contextSources.group.projectContinuity');
			case 'conversation':
				return $t('contextSources.group.conversation');
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div
		class="evidence-overlay"
		role="dialog"
		aria-label={$t('contextSources.title')}
		aria-modal="true"
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
	>
		<div class="evidence-panel">
			<div class="panel-header">
				<h2 class="panel-title">{$t('contextSources.manage')}</h2>
				<button type="button" class="panel-close" aria-label={$t('contextSources.close')} onclick={close}>
					<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
						<path d="M6 6 18 18" />
						<path d="M18 6 6 18" />
					</svg>
				</button>
			</div>

			<div class="panel-body">
				{#if contextSources}
					<div class="source-summary">
						<div>
							<div class="summary-label">{$t('contextSources.activeSources')}</div>
							<div class="summary-value">{contextSources.activeCount}</div>
						</div>
						<div>
							<div class="summary-label">{$t('contextSources.state')}</div>
							<div
								class="summary-value"
								class:summary-value--reduced={contextSources.reduced || contextSources.compacted}
							>
								{formatSourceState()}
							</div>
						</div>
					</div>
				{/if}

				<div class="section">
					<div class="section-header">
						<h3>{$t('contextSources.currentSelection')}</h3>
						<span>{selectedRows.length}</span>
					</div>
					{#if selectedRows.length > 0}
						<div class="row-list">
							{#each selectedRows as item (itemId(item))}
								<div class="evidence-row">
									<div class="row-copy">
										<div class="row-title">{itemTitle(item)}</div>
										<div class="row-meta">
											<span class="row-chip">{itemSourceType(item)}</span>
											{#if contextSources && 'id' in item}
												<span>{formatGroupKind(item.id.split(':')[0] as ContextSourceGroupKind)}</span>
											{/if}
											{#if itemReason(item)}
												<span>{itemReason(item)}</span>
											{/if}
										</div>
									</div>
									{#if itemArtifactId(item) && contextDebug}
										<EvidencePreferenceControl
											artifactId={itemArtifactId(item) ?? ''}
											preference={preferenceFor(itemArtifactId(item) ?? '')}
											label={$t('contextSources.sourcePreference')}
											onSteer={steer}
										/>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div class="empty-state">{$t('contextSources.noActiveSources')}</div>
					{/if}
				</div>

				{#if inferredRows.length > 0}
					<div class="section">
						<div class="section-header">
							<h3>{$t('contextSources.inferredSources')}</h3>
							<span>{contextSources?.inferredCount ?? inferredRows.length}</span>
						</div>
						<div class="row-list">
							{#each inferredRows as item (itemId(item))}
								<div class="evidence-row">
									<div class="row-copy">
										<div class="row-title">{itemTitle(item)}</div>
										<div class="row-meta">
											<span class="row-chip">{itemSourceType(item)}</span>
											{#if contextSources && 'id' in item}
												<span>{formatGroupKind(item.id.split(':')[0] as ContextSourceGroupKind)}</span>
											{/if}
											{#if itemReason(item)}
												<span>{itemReason(item)}</span>
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<div class="section">
					<div class="section-header">
						<h3>{$t('contextSources.pinned')}</h3>
						<span>{contextSources?.pinnedCount ?? pinnedRows.length}</span>
					</div>
					{#if pinnedRows.length > 0}
						<div class="row-list">
							{#each pinnedRows as item (itemId(item))}
								<div class="evidence-row">
									<div class="row-copy">
										<div class="row-title">{itemTitle(item)}</div>
										<div class="row-meta">
											<span class="row-chip">{itemSourceType(item)}</span>
											<span>{$t('contextSources.pinnedByYou')}</span>
										</div>
									</div>
									{#if itemArtifactId(item) && contextDebug}
										<EvidencePreferenceControl
											artifactId={itemArtifactId(item) ?? ''}
											preference="pinned"
											label={$t('contextSources.sourcePreference')}
											onSteer={steer}
										/>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div class="empty-state">{$t('contextSources.noPinnedSources')}</div>
					{/if}
				</div>

				<div class="section">
					<div class="section-header">
						<h3>{$t('contextSources.excluded')}</h3>
						<span>{contextSources?.excludedCount ?? excludedRows.length}</span>
					</div>
					{#if excludedRows.length > 0}
						<div class="row-list">
							{#each excludedRows as item (itemId(item))}
								<div class="evidence-row">
									<div class="row-copy">
										<div class="row-title">{itemTitle(item)}</div>
										<div class="row-meta">
											<span class="row-chip">{itemSourceType(item)}</span>
											<span>{$t('contextSources.excludedFromAutoSelection')}</span>
										</div>
									</div>
									{#if itemArtifactId(item) && contextDebug}
										<EvidencePreferenceControl
											artifactId={itemArtifactId(item) ?? ''}
											preference="excluded"
											label={$t('contextSources.sourcePreference')}
											onSteer={steer}
										/>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div class="empty-state">{$t('contextSources.noExcludedSources')}</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.evidence-overlay {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		justify-content: flex-end;
		background: rgba(8, 10, 13, 0.22);
		backdrop-filter: blur(2px);
	}

	.evidence-panel {
		display: flex;
		height: 100%;
		width: min(26rem, 100vw);
		flex-direction: column;
		background: color-mix(in srgb, var(--surface-overlay) 96%, var(--surface-page) 4%);
		box-shadow: var(--shadow-lg);
	}

	.panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		border-bottom: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		padding: 1rem 1rem 0.85rem;
	}

	.panel-title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.panel-close {
		cursor: pointer;
		display: inline-flex;
		height: 2.25rem;
		width: 2.25rem;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 9999px;
		background: transparent;
		color: var(--text-muted);
	}

	.panel-body {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
	}

	.source-summary {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.summary-label {
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	.summary-value {
		margin-top: 0.2rem;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.summary-value--reduced {
		color: var(--danger);
	}

	.section + .section {
		margin-top: 1rem;
	}

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.55rem;
	}

	.section-header h3 {
		margin: 0;
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.section-header span {
		font-size: 0.74rem;
		color: var(--text-muted);
	}

	.row-list {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.evidence-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent 25%);
		border-radius: 0.9rem;
		background: color-mix(in srgb, var(--surface-elevated) 55%, transparent 45%);
		padding: 0.75rem;
	}

	.row-copy {
		min-width: 0;
		flex: 1;
	}

	.row-title {
		font-size: 0.84rem;
		line-height: 1.35;
		color: var(--text-primary);
		word-break: break-word;
	}

	.row-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.45rem;
		margin-top: 0.28rem;
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--text-muted);
	}

	.row-chip {
		border: 1px solid color-mix(in srgb, var(--border-default) 72%, transparent 28%);
		border-radius: 9999px;
		padding: 0.12rem 0.42rem;
		text-transform: capitalize;
	}

	.empty-state {
		border: 1px dashed color-mix(in srgb, var(--border-default) 72%, transparent 28%);
		border-radius: 0.9rem;
		padding: 0.8rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	@media (max-width: 767px) {
		.evidence-panel {
			width: 100vw;
		}
	}
</style>
