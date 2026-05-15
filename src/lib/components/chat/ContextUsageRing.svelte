<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '$lib/i18n';
	import type {
		ArtifactSummary,
		ContextDebugState,
		ContextSourcesState,
		ConversationContextStatus,
		MemoryLayer,
		TaskState,
		TaskSteeringAction,
		TaskSteeringPayload,
	} from '$lib/types';

	let {
		contextStatus = null,
		attachedArtifacts = [],
		taskState = null,
		contextDebug = null,
		contextSources = null,
		onSteer = undefined,
		onManageEvidence = undefined,
		totalCostUsd = 0,
		totalTokens = 0,
	}: {
		contextStatus?: ConversationContextStatus | null;
		attachedArtifacts?: ArtifactSummary[];
		taskState?: TaskState | null;
		contextDebug?: ContextDebugState | null;
		contextSources?: ContextSourcesState | null;
		onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
		onManageEvidence?: (() => void) | undefined;
		totalCostUsd?: number;
		totalTokens?: number;
	} = $props();

	let root = $state<HTMLDivElement | null>(null);
	let isOpen = $state(false);
	let mobile = $state(false);
	let showNewTaskForm = $state(false);
	let newTaskObjective = $state('');
	let newTaskInput = $state<HTMLInputElement | null>(null);

	const size = 38;
	const strokeWidth = 3;
	const radius = (size - strokeWidth) / 2;
	const circumference = 2 * Math.PI * radius;

	function detectMobile() {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			mobile = false;
			return;
		}

		mobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
	}

	onMount(() => {
		detectMobile();
		window.addEventListener('resize', detectMobile);

		const handlePointerDown = (event: MouseEvent | TouchEvent) => {
			if (root && !root.contains(event.target as Node)) {
				isOpen = false;
				resetNewTaskForm();
			}
		};

		document.addEventListener('mousedown', handlePointerDown);
		document.addEventListener('touchstart', handlePointerDown, { passive: true });

		return () => {
			window.removeEventListener('resize', detectMobile);
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('touchstart', handlePointerDown);
		};
	});

	function handleClick() {
		isOpen = !isOpen;
		if (!isOpen) {
			resetNewTaskForm();
		}
	}

	function formatLayer(layer: MemoryLayer): string {
		switch (layer) {
			case 'session':
				return $t('contextUsageRing.layer.session');
			case 'capsule':
				return $t('contextUsageRing.layer.capsule');
			case 'documents':
				return $t('contextUsageRing.layer.documents');
			case 'outputs':
				return $t('contextUsageRing.layer.outputs');
			case 'working_set':
				return $t('contextUsageRing.layer.workingSet');
			case 'task_state':
				return $t('contextUsageRing.layer.taskState');
		}
	}

	function formatCompactionMode(mode: ConversationContextStatus['compactionMode'] | undefined): string {
		switch (mode) {
			case 'deterministic':
				return $t('contextUsageRing.compaction.deterministic');
			case 'llm_fallback':
				return $t('contextUsageRing.compaction.llmFallback');
			default:
				return $t('contextUsageRing.compaction.notNeeded');
		}
	}

	function formatSourceState(): string {
		if (contextSources?.compacted) return $t('contextSources.compacted');
		if (contextSources?.reduced) return $t('contextSources.reduced');
		return $t('contextSources.full');
	}

	function steer(action: TaskSteeringAction, artifactId?: string, objective?: string) {
		onSteer?.({ action, artifactId, objective });
	}

	function resetNewTaskForm() {
		showNewTaskForm = false;
		newTaskObjective = '';
	}

	function openEvidenceManager() {
		onManageEvidence?.();
		if (mobile) {
			isOpen = false;
			resetNewTaskForm();
		}
	}

	function formatCostUsd(costUsd: number): string {
		return `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
	}

	function formatTokenCount(tokens: number): string {
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
		if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
		return tokens.toLocaleString();
	}

	let showCost = $derived(totalCostUsd > 0 || totalTokens > 0);
	let costText = $derived(showCost ? `${formatCostUsd(totalCostUsd)} \u00b7 ${formatTokenCount(totalTokens)} ${$t('contextUsageRing.tokens')}` : '');

	async function openNewTaskForm() {
		showNewTaskForm = true;
		await tick();
		newTaskInput?.focus();
		newTaskInput?.select();
	}

	function cancelNewTaskForm() {
		resetNewTaskForm();
	}

	function submitNewTask() {
		steer('start_new_task', undefined, newTaskObjective);
		resetNewTaskForm();
		if (mobile) {
			isOpen = false;
		}
	}

	function handleNewTaskKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			submitNewTask();
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			cancelNewTaskForm();
		}
	}

	let promptBudget = $derived(contextStatus ? Math.max(contextStatus.targetTokens, 1) : 1);
	let ratio = $derived(
		contextStatus
		? Math.max(0, Math.min(1, contextStatus.estimatedTokens / promptBudget))
		: 0
	);
	let dashOffset = $derived(circumference * (1 - ratio));
	let percent = $derived(Math.round(ratio * 100));
	let activeObjective = $derived(contextDebug?.activeTaskObjective ?? taskState?.objective ?? null);
	let selectedSourceCount = $derived(
		contextSources?.selectedCount ?? contextDebug?.selectedEvidence.length ?? 0
	);
	let pinnedSourceCount = $derived(
		contextSources?.pinnedCount ?? contextDebug?.pinnedEvidence.length ?? 0
	);
	let excludedSourceCount = $derived(
		contextSources?.excludedCount ?? contextDebug?.excludedEvidence.length ?? 0
	);
	let toneClass = $derived(
		!contextStatus
			? 'ring-button--idle'
			: contextSources?.compacted || contextStatus.compactionMode === 'llm_fallback'
				? 'ring-button--compact'
				: contextSources?.reduced || contextStatus.compactionMode === 'deterministic'
					? 'ring-button--high'
					: ratio >= 0.9
						? 'ring-button--high'
						: ratio >= 0.75
							? 'ring-button--medium'
							: 'ring-button--normal'
	);
</script>

<div
	bind:this={root}
	class="ring-root relative"
>
	<button
		type="button"
		class={`ring-button ${toneClass}`}
		aria-label={contextStatus
			? $t('contextUsageRing.promptBudgetUsage', {
				percent,
				tokens: contextStatus.estimatedTokens.toLocaleString(),
			})
			: $t('contextUsageRing.noContext')}
		aria-expanded={isOpen}
		onclick={handleClick}
	>
		<svg class="ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
			<circle
				class="ring-track"
				cx={size / 2}
				cy={size / 2}
				r={radius}
				stroke-width={strokeWidth}
			/>
			<circle
				class="ring-progress"
				cx={size / 2}
				cy={size / 2}
				r={radius}
				stroke-width={strokeWidth}
				stroke-dasharray={circumference}
				stroke-dashoffset={dashOffset}
			/>
		</svg>
		<span class="ring-value">{contextStatus ? `${percent}` : '0'}</span>
	</button>

	<div
		class="ring-popover"
		class:ring-popover--mobile={mobile}
		class:ring-popover--mobile-visible={mobile && isOpen}
		class:ring-popover--open={!mobile && isOpen}
		role="dialog"
		aria-label={$t('contextUsageRing.focusPanel')}
	>
		<div class="popover-section">
			<div class="popover-label">{$t('contextUsageRing.focus')}</div>
			{#if activeObjective}
				<div class="popover-copy">{activeObjective}</div>
			{:else}
				<div class="popover-empty">{$t('contextUsageRing.noActiveTask')}</div>
			{/if}

			<div class="popover-actions">
				<button
					type="button"
					class="popover-action-button"
					onclick={() => steer(contextDebug?.taskLocked ? 'unlock_task' : 'lock_task')}
				>
					{contextDebug?.taskLocked ? $t('contextUsageRing.unlockTask') : $t('contextUsageRing.lockTask')}
				</button>
				{#if showNewTaskForm}
					<div class="task-form">
						<label class="task-form-label" for="new-task-objective">{$t('contextUsageRing.optionalTaskName')}</label>
						<input
							bind:this={newTaskInput}
							id="new-task-objective"
							class="task-form-input"
							type="text"
							placeholder={$t('contextUsageRing.placeholder')}
							bind:value={newTaskObjective}
							onkeydown={handleNewTaskKeydown}
						/>
						<div class="task-form-actions">
							<button
								type="button"
								class="popover-action-button"
								onclick={submitNewTask}
							>
								{$t('contextUsageRing.start')}
							</button>
							<button
								type="button"
								class="popover-action-button popover-action-button--ghost"
								onclick={cancelNewTaskForm}
							>
								{$t('common.cancel')}
							</button>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="popover-action-button"
						onclick={openNewTaskForm}
					>
						{$t('contextUsageRing.startNewTask')}
					</button>
				{/if}
				<button
					type="button"
					class="popover-action-button"
					onclick={openEvidenceManager}
				>
					{$t('contextUsageRing.manageEvidence')}
				</button>
			</div>
		</div>

		{#if showCost}
			<div class="popover-section">
				<div class="popover-label">{$t('contextUsageRing.cost')}</div>
				<div class="popover-cost">{costText}</div>
			</div>
		{/if}

		<div class="popover-section">
			<div class="popover-label">{$t('contextUsageRing.context')}</div>
			{#if contextStatus}
				<div class="popover-stat">
					<span>{$t('contextUsageRing.promptBudget')}</span>
					<span>{contextStatus.estimatedTokens.toLocaleString()} / {contextStatus.targetTokens.toLocaleString()}</span>
				</div>
				<div class="popover-stat">
					<span>{$t('contextUsageRing.compaction')}</span>
					<span class:compaction-active={contextStatus.compactionMode !== 'none'}>
						{formatCompactionMode(contextStatus.compactionMode)}
					</span>
				</div>
				{#if contextSources}
					<div class="popover-stat">
						<span>{$t('contextSources.currentSelection')}</span>
						<span>{selectedSourceCount}</span>
					</div>
					<div class="popover-stat">
						<span>{$t('contextSources.state')}</span>
						<span class:compaction-active={contextSources.reduced || contextSources.compacted}>
							{formatSourceState()}
						</span>
					</div>
					{#if pinnedSourceCount > 0}
						<div class="popover-stat">
							<span>{$t('contextSources.pinned')}</span>
							<span>{pinnedSourceCount}</span>
						</div>
					{/if}
					{#if excludedSourceCount > 0}
						<div class="popover-stat">
							<span>{$t('contextSources.excluded')}</span>
							<span>{excludedSourceCount}</span>
						</div>
					{/if}
				{:else if contextDebug}
					<div class="popover-stat">
						<span>{$t('contextUsageRing.selectedEvidence')}</span>
						<span>{contextDebug.selectedEvidence.length}</span>
					</div>
					{#if contextDebug.pinnedEvidence.length > 0}
						<div class="popover-stat">
							<span>{$t('contextUsageRing.pinned')}</span>
							<span>{contextDebug.pinnedEvidence.length}</span>
						</div>
					{/if}
					{#if contextDebug.excludedEvidence.length > 0}
						<div class="popover-stat">
							<span>{$t('contextUsageRing.excluded')}</span>
							<span>{contextDebug.excludedEvidence.length}</span>
						</div>
					{/if}
				{/if}
				{#if attachedArtifacts.length > 0}
					<div class="popover-stat">
						<span>{$t('contextUsageRing.attachedFiles')}</span>
						<span>{attachedArtifacts.length}</span>
					</div>
				{/if}
				<div class="popover-stat">
					<span>{$t('contextUsageRing.recentTurns')}</span>
					<span>{contextStatus.recentTurnCount}</span>
				</div>
				{#if contextStatus.layersUsed.length > 0}
					<div class="popover-chips">
						{#each contextStatus.layersUsed as layer}
							<span class="popover-chip">{formatLayer(layer)}</span>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="popover-empty">{$t('contextUsageRing.noContext')}</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.ring-root {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.ring-button {
		position: relative;
		display: flex;
		height: 44px;
		width: 44px;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--border-default) 80%, transparent 20%);
		border-radius: 9999px;
		background: color-mix(in srgb, var(--surface-page) 76%, var(--surface-elevated) 24%);
		color: var(--text-muted);
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.ring-button:hover,
	.ring-button:focus-visible {
		transform: translateY(-1px);
		outline: none;
	}

	.ring-button--normal {
		color: var(--accent);
	}

	.ring-button--medium {
		color: color-mix(in srgb, var(--accent) 70%, #b88a2f 30%);
	}

	.ring-button--high {
		color: var(--danger);
	}

	.ring-button--compact {
		color: color-mix(in srgb, var(--accent) 62%, var(--danger) 38%);
	}

	.ring-button--idle {
		color: var(--text-muted);
	}

	.ring-svg {
		transform: rotate(-90deg);
	}

	.ring-track,
	.ring-progress {
		fill: none;
	}

	.ring-track {
		stroke: color-mix(in srgb, var(--border-default) 72%, transparent 28%);
	}

	.ring-progress {
		stroke: currentColor;
		stroke-linecap: round;
		transition: stroke-dashoffset 180ms ease-out;
	}

	.ring-value {
		position: absolute;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 9px;
		font-weight: 600;
		line-height: 1;
		color: var(--text-primary);
		text-transform: lowercase;
	}

	.ring-popover {
		position: absolute;
		left: 0;
		bottom: calc(100% + 10px);
		z-index: 40;
		width: min(22rem, calc(100vw - 2rem));
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow: var(--shadow-lg);
		padding: 0.9rem;
		backdrop-filter: blur(14px);
		opacity: 0;
		transform: translateY(6px);
		pointer-events: none;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.ring-root:hover .ring-popover,
	.ring-root:focus-within .ring-popover,
	.ring-popover--mobile-visible,
	.ring-popover--open {
		opacity: 1;
		transform: translateY(0);
		pointer-events: auto;
	}

	.ring-popover--mobile {
		position: fixed;
		left: 0.25rem;
		right: 0.25rem;
		bottom: calc(env(safe-area-inset-bottom) + 5.5rem);
		width: auto;
		max-height: min(70vh, 30rem);
		overflow-y: auto;
		transform: translateY(6px);
	}

	.ring-popover--mobile.ring-popover--mobile-visible {
		transform: translateY(0);
	}

	.popover-section + .popover-section {
		margin-top: 0.85rem;
		padding-top: 0.85rem;
		border-top: 1px solid color-mix(in srgb, var(--border-default) 75%, transparent 25%);
	}

	.popover-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--text-muted);
	}

	.popover-stat {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.55rem;
		font-size: 0.82rem;
		color: var(--text-primary);
	}

	.popover-cost {
		margin-top: 0.5rem;
		font-size: 0.84rem;
		font-weight: 500;
		color: var(--accent);
	}

	.compaction-active {
		color: var(--accent);
	}

	.popover-copy {
		margin-top: 0.5rem;
		font-size: 0.84rem;
		line-height: 1.45;
		color: var(--text-primary);
	}

	.popover-copy--muted {
		color: var(--text-secondary);
	}

	.popover-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.65rem;
	}

	.popover-action-button {
		cursor: pointer;
		min-height: 1.8rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--surface-page) 64%, var(--surface-elevated) 36%);
		color: var(--text-primary);
		font-family: 'Nimbus Sans L', sans-serif;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.1;
		padding: 0.34rem 0.5rem;
	}

	.popover-action-button:hover,
	.popover-action-button:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 35%, var(--border-default) 65%);
		background: rgba(194, 166, 106, 0.22);
		color: var(--text-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 34%, transparent 66%);
		transform: translateY(-1px);
		outline: none;
	}

	.popover-action-button--ghost {
		background: transparent;
		color: var(--text-muted);
	}

	:global(.dark) .popover-action-button {
		background: color-mix(in srgb, var(--surface-overlay) 82%, var(--surface-elevated) 18%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .popover-action-button:hover,
	:global(.dark) .popover-action-button:focus-visible {
		background: rgba(194, 166, 106, 0.3);
	}

	.popover-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.65rem;
	}

	.popover-chip {
		border: 1px solid color-mix(in srgb, var(--border-default) 75%, transparent 25%);
		border-radius: 9999px;
		padding: 0.25rem 0.5rem;
		font-size: 0.7rem;
		text-transform: capitalize;
		color: var(--text-muted);
	}

	.popover-sublist {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin-top: 0.55rem;
	}

	.popover-empty {
		margin-top: 0.5rem;
		font-size: 0.82rem;
		color: var(--text-muted);
	}

	.popover-label--subtle {
		margin-bottom: -0.15rem;
		font-size: 0.68rem;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.task-form {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: min(17rem, calc(100vw - 4rem));
	}

	.task-form-label {
		font-size: 0.68rem;
		font-family: 'Nimbus Sans L', sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}

	.task-form-input {
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-page) 84%, var(--surface-elevated) 16%);
		padding: 0.5rem 0.65rem;
		font-size: 0.76rem;
		color: var(--text-primary);
	}

	.task-form-input::placeholder {
		color: var(--text-muted);
	}

	.task-form-input:focus-visible {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border-default) 55%);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent 75%);
	}

	.task-form-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
</style>
