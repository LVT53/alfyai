<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import { isTouchDevice } from "$lib/utils/viewport.svelte";
import type {
	ArtifactSummary,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	MemoryLayer,
} from "$lib/types";

let {
	contextStatus = null,
	attachedArtifacts = [],
	contextDebug = null,
	contextSources = null,
	totalCostUsd = 0,
	lastTurnCostUsd = 0,
	totalTokens = 0,
	onManageEvidence = undefined,
}: {
	contextStatus?: ConversationContextStatus | null;
	attachedArtifacts?: ArtifactSummary[];
	contextDebug?: ContextDebugState | null;
	contextSources?: ContextSourcesState | null;
	totalCostUsd?: number;
	lastTurnCostUsd?: number;
	totalTokens?: number;
	onManageEvidence?: (() => void) | undefined;
} = $props();

let root = $state<HTMLDivElement | null>(null);
let isOpen = $state(false);
let mobile = $state(false);

const size = 38;
const strokeWidth = 3;
const radius = (size - strokeWidth) / 2;
const circumference = 2 * Math.PI * radius;

function detectMobile() {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		mobile = false;
		return;
	}

	mobile = isTouchDevice();
}

onMount(() => {
	detectMobile();
	window.addEventListener("resize", detectMobile);

	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		if (root && !root.contains(event.target as Node)) {
			isOpen = false;
		}
	};

	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });

	return () => {
		window.removeEventListener("resize", detectMobile);
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
	};
});

function handleClick() {
	isOpen = !isOpen;
}

function handleManageEvidence() {
	onManageEvidence?.();
	isOpen = false;
}

function formatLayer(layer: MemoryLayer): string {
	switch (layer) {
		case "session":
			return $t("contextUsageRing.layer.session");
		case "capsule":
			return $t("contextUsageRing.layer.capsule");
		case "documents":
			return $t("contextUsageRing.layer.documents");
		case "outputs":
			return $t("contextUsageRing.layer.outputs");
		case "working_set":
			return $t("contextUsageRing.layer.workingSet");
		case "task_state":
			return $t("contextUsageRing.layer.taskState");
	}
}

function formatCompactionMode(
	mode: ConversationContextStatus["compactionMode"] | undefined,
): string {
	switch (mode) {
		case "deterministic":
			return $t("contextUsageRing.compaction.deterministic");
		case "llm_fallback":
			return $t("contextUsageRing.compaction.llmFallback");
		default:
			return $t("contextUsageRing.compaction.notNeeded");
	}
}

function formatSourceState(): string {
	if (contextSources?.compacted) return $t("contextSources.compacted");
	if (contextSources?.reduced) return $t("contextSources.reduced");
	return $t("contextSources.full");
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
let costText = $derived(
	showCost
		? `${formatCostUsd(totalCostUsd)} \u00b7 ${formatTokenCount(totalTokens)} ${$t("contextUsageRing.tokens")}`
		: "",
);
let showLastTurnCost = $derived(lastTurnCostUsd > 0);
let lastTurnCostText = $derived(
	showLastTurnCost ? formatCostUsd(lastTurnCostUsd) : "",
);

let promptBudget = $derived(
	contextStatus ? Math.max(contextStatus.targetTokens, 1) : 1,
);
let ratio = $derived(
	contextStatus
		? Math.max(0, Math.min(1, contextStatus.estimatedTokens / promptBudget))
		: 0,
);
let dashOffset = $derived(circumference * (1 - ratio));
let percent = $derived(Math.round(ratio * 100));
let selectedSourceCount = $derived(
	contextSources?.selectedCount ?? contextDebug?.selectedEvidence.length ?? 0,
);
let pinnedSourceCount = $derived(
	contextSources?.pinnedCount ?? contextDebug?.pinnedEvidence.length ?? 0,
);
let excludedSourceCount = $derived(
	contextSources?.excludedCount ?? contextDebug?.excludedEvidence.length ?? 0,
);
let toneClass = $derived(
	!contextStatus
		? "ring-button--idle"
		: contextSources?.compacted ||
				contextStatus.compactionMode === "llm_fallback"
			? "ring-button--compact"
			: contextSources?.reduced ||
					contextStatus.compactionMode === "deterministic"
				? "ring-button--high"
				: ratio >= 0.9
					? "ring-button--high"
					: ratio >= 0.75
						? "ring-button--medium"
						: "ring-button--normal",
);

// Near-trigger heads-up: context is filling up and compaction may run soon.
// Only when not already compacted/reduced (those states already handled).
let isNearTrigger = $derived(
	contextStatus !== null &&
		ratio >= 0.78 &&
		!contextSources?.compacted &&
		!contextSources?.reduced &&
		contextStatus.compactionMode === "none",
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
		{#if showCost}
			<!-- Two cost lines (ADR #6): conversation running total as the hero,
			     plus the last turn's per-message cost (ChatMessage.costUsd) as a
			     muted secondary line. -->
			<div class="popover-section">
				<div class="popover-cost-row">
					<span class="popover-label">{$t('contextUsageRing.conversationCost')}</span>
					<span class="popover-cost-hero">{costText}</span>
				</div>
				{#if showLastTurnCost}
					<div class="popover-cost-row popover-cost-row--secondary">
						<span class="popover-cost-secondary-label">{$t('contextUsageRing.lastTurn')}</span>
						<span class="popover-cost-secondary">{lastTurnCostText}</span>
					</div>
				{/if}
			</div>
		{/if}

		<div class="popover-section">
			<div class="popover-label">{$t('contextUsageRing.context')}</div>
			{#if contextStatus}
				<div
					class={`popover-context-room popover-context-room-tooltip-container${isNearTrigger ? ' popover-context-room--near' : ''}`}
				>
					<div class="popover-context-room-header">
						<span class="popover-label">{$t('contextUsageRing.contextRoom')}</span>
						<span class="popover-context-room-pct">{$t('contextUsageRing.usageFormat', { percent })}</span>
					</div>
					<div class="popover-context-room-bar" aria-hidden="true">
						<div class="popover-context-room-fill" style={`width: ${percent}%`}></div>
					</div>
					{#if isNearTrigger}
						<p class="popover-near-trigger">{$t('contextUsageRing.nearTriggerNote')}</p>
					{/if}
					<div class="popover-context-room-tooltip" role="tooltip">
						<span class="popover-context-room-tooltip-label">{$t('contextUsageRing.promptBudget')}</span>
						<span class="popover-context-room-tooltip-value">{contextStatus.estimatedTokens.toLocaleString()} / {contextStatus.targetTokens.toLocaleString()}</span>
					</div>
				</div>
				<div class="popover-stat">
					<span>{$t('contextUsageRing.compaction')}</span>
					<span class:compaction-active={contextStatus.compactionMode !== 'none'}>
						{formatCompactionMode(contextStatus.compactionMode)}
					</span>
				</div>
				{#if contextSources}
					<div class="popover-stat">
						<span>{$t('contextUsageRing.sourcesIncluded')}</span>
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
						<span>{$t('contextUsageRing.sourcesIncluded')}</span>
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
						<span>{$t('contextUsageRing.whatAlfyRemembers')}</span>
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
			{#if onManageEvidence}
				<button type="button" class="popover-action" onclick={handleManageEvidence}>
					{$t('contextUsageRing.manageEvidence')}
				</button>
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
		color: color-mix(in srgb, var(--accent) 70%, var(--warning) 30%);
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
		font-family: var(--font-sans);
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
		/* Wide enough that the cost hero ("$x · yK tokens") never wraps the
		   "tokens" word onto its own line on desktop. Mobile uses the full-width
		   --mobile variant below, so this only affects the desktop popover. */
		width: min(25rem, calc(100vw - 2rem));
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
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--text-muted);
	}

	.popover-stat {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.55rem;
		font-size: var(--text-sm);
		color: var(--text-primary);
	}

	.popover-cost-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.45rem;
	}

	.popover-cost-hero {
		font-size: var(--text-base, 0.95rem);
		font-weight: 600;
		color: var(--accent);
		/* Keep "$x · yK tokens" together on one line. */
		white-space: nowrap;
	}

	/* Secondary "Last turn" line — muted and smaller than the hero. */
	.popover-cost-row--secondary {
		margin-top: 0.2rem;
	}

	.popover-cost-secondary-label {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-muted);
	}

	.popover-cost-secondary {
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	/* Context room bar — the bar communicates remaining capacity, so the old
	   "plenty left" sub-text is removed; the percent speaks for itself. Sits
	   directly under the "Context" subtitle; the exact estimated/target token
	   figures (formerly a separate "Prompt budget" line) now live in a hover
	   tooltip instead of taking up a permanent row. */
	.popover-context-room {
		position: relative;
		margin-top: 0.55rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-default) 82%);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--accent) 6%, var(--surface-elevated) 94%);
	}

	.popover-context-room-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		width: max-content;
		max-width: 16rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding: var(--space-sm) var(--space-md);
		opacity: 0;
		visibility: hidden;
		transform: translateY(4px);
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		pointer-events: none;
		z-index: 10;
	}

	.popover-context-room-tooltip-container:hover .popover-context-room-tooltip {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
	}

	.popover-context-room-tooltip-label {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.popover-context-room-tooltip-value {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.popover-context-room--near {
		border-color: color-mix(in srgb, var(--warning) 38%, var(--border-default) 62%);
		background: color-mix(in srgb, var(--warning) 9%, var(--surface-elevated) 91%);
	}

	.popover-context-room-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 0.35rem;
	}

	.popover-context-room-pct {
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.popover-context-room--near .popover-context-room-pct {
		color: var(--warning-hover);
		font-weight: 600;
	}

	.popover-context-room-bar {
		height: 5px;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, var(--border-default) 60%, transparent 40%);
	}

	.popover-context-room-fill {
		height: 100%;
		border-radius: 999px;
		background: var(--accent);
		transition: width var(--duration-standard) var(--ease-out);
	}

	.popover-context-room--near .popover-context-room-fill {
		background: var(--warning);
	}

	.popover-near-trigger {
		margin: 0.4rem 0 0;
		font-size: var(--text-xs);
		color: var(--warning-hover);
		line-height: 1.4;
	}

	.compaction-active {
		color: var(--accent);
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
		font-size: var(--text-2xs);
		text-transform: capitalize;
		color: var(--text-muted);
	}

	.popover-empty {
		margin-top: 0.5rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}

	.popover-action {
		margin-top: 0.75rem;
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.65rem;
		background: color-mix(in srgb, var(--surface-page) 72%, var(--surface-elevated) 28%);
		padding: 0.5rem 0.65rem;
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-primary);
		text-align: center;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.popover-action:hover,
	.popover-action:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 48%, var(--border-default) 52%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
		outline: none;
	}
</style>
