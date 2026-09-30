<script lang="ts">
/**
 * The head of every comment list (redesign.md §3.2/§8, ruling 61): the title,
 * the number of open threads, the quiet "N resolved" toggle that switches
 * Open to All (and back), and — for the drawer, where nothing else closes it —
 * a close button. One header for every kind's comments (the Document's
 * `MarginPanel`, the Canvas's list): what is in the list is each kind's own,
 * how a list introduces itself is not.
 *
 * Sticky, so it stays put while the list under it scrolls (in the phone sheet,
 * where the sheet's own body is the scroller, `sticky` keeps it in view instead).
 */
import { X } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	openCount,
	resolvedCount,
	filter,
	ontogglefilter,
	onClose,
}: {
	/** Open threads: the number beside the title. Nothing is drawn at zero. */
	openCount: number;
	/** Resolved threads the toggle would bring back (or is showing). The toggle is drawn when there are some, or while All is on. */
	resolvedCount: number;
	filter: "open" | "all";
	ontogglefilter: () => void;
	/** Draws a close button in the header row: the narrow drawer's own way out. */
	onClose?: () => void;
} = $props();
</script>

<div class="margin-panel-header">
	<h2 class="margin-panel-title">{$t('artifacts.document.margin.title')}</h2>
	{#if openCount > 0}
		<span class="margin-panel-count">
			<span aria-hidden="true">{openCount}</span>
			<span class="sr-only">{$t('artifacts.document.margin.countA11y', { count: openCount })}</span>
		</span>
	{/if}
	<span class="margin-panel-header-gap"></span>
	{#if resolvedCount > 0 || filter === 'all'}
		<button
			type="button"
			class="margin-panel-filter-toggle"
			aria-pressed={filter === 'all'}
			onclick={ontogglefilter}
		>
			{filter === 'open'
				? $t('artifacts.document.margin.resolvedToggle', { count: resolvedCount })
				: $t('artifacts.document.margin.showOpenOnly')}
		</button>
	{/if}
	{#if onClose}
		<button
			type="button"
			class="btn-icon-bare margin-panel-close"
			onclick={onClose}
			aria-label={$t('common.close')}
		>
			<X size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	{/if}
</div>

<style>
	.margin-panel-header {
		position: sticky;
		top: 0;
		z-index: 2;
		flex: 0 0 auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		padding: 0.75rem 0.875rem 0.625rem;
		background-color: var(--surface-page);
		border-bottom: 1px solid var(--border-subtle);
	}

	.margin-panel-title {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--text-primary);
	}

	.margin-panel-count {
		display: inline-grid;
		place-items: center;
		min-width: 1.0625rem;
		height: 1.0625rem;
		padding: 0 0.3125rem;
		border-radius: var(--radius-full);
		background-color: var(--comment-mark);
		color: var(--text-primary);
		font-size: 0.65625rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.margin-panel-header-gap {
		flex: 1 1 0;
	}

	.margin-panel-filter-toggle {
		flex-shrink: 0;
		position: relative;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		padding: 0.125rem 0.25rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.71875rem;
		cursor: pointer;
	}

	.margin-panel-filter-toggle:hover {
		color: var(--text-primary);
		text-decoration: underline;
	}

	.margin-panel-filter-toggle:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.margin-panel-close {
		flex-shrink: 0;
		min-height: 32px;
		min-width: 32px;
		margin: -0.25rem -0.375rem -0.25rem 0;
	}

	/* Phone sheet: nothing that is tapped is smaller than 44px (§3.4). The small
	   text control keeps its look and grows an invisible hit area instead. */
	@media (max-width: 767px) {
		.margin-panel-filter-toggle::after {
			content: '';
			position: absolute;
			inset: -0.875rem -0.5rem;
		}
	}
</style>
