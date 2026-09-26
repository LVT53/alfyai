<script lang="ts">
/**
 * The inline "Alfy · Keep · Undo" bar (Feature 2 · Artifacts, Slice 1, T8):
 * the visible half of `marks.ts`'s `AlfyChange` mark. Purely presentational —
 * no `@tiptap/*` import, so it stays outside the lazy editor boundary
 * (T7.8) and is safe for `DocumentBody.svelte` (or a future caller) to import
 * eagerly. The caller owns positioning it next to the marked text; this
 * component only knows its own three states.
 *
 * `status` covers the bar's whole lifecycle: `"pending"` is the live
 * Keep/Undo choice, and `"kept"` / `"undone"` are the brief confirmation the
 * caller shows for a moment before removing the bar entirely (spec:
 * `artifacts.document.change.keptNotice` / `.undoneNotice`).
 */
import { Sparkles } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	status = "pending",
	commentCount = 0,
	onKeep,
	onUndo,
}: {
	status?: "pending" | "kept" | "undone";
	commentCount?: number;
	onKeep: () => void;
	onUndo: () => void;
} = $props();
</script>

<div class="alfy-change-bar" data-testid="alfy-change-bar" role="status">
	<Sparkles size={12} strokeWidth={2} aria-hidden="true" />
	{#if status === 'pending'}
		<span class="alfy-change-bar-label">{$t('artifacts.document.change.alfy')}</span>
		{#if commentCount > 0}
			<span
				class="alfy-change-bar-comments"
				aria-label={$t('artifacts.document.change.commentCountA11y', { count: commentCount })}
			>
				{commentCount}
			</span>
		{/if}
		<span class="alfy-change-bar-sep" aria-hidden="true">·</span>
		<button type="button" class="alfy-change-bar-action" onclick={onKeep}>
			{$t('artifacts.document.change.keep')}
		</button>
		<span class="alfy-change-bar-sep" aria-hidden="true">·</span>
		<button type="button" class="alfy-change-bar-action" onclick={onUndo}>
			{$t('artifacts.document.change.undo')}
		</button>
	{:else if status === 'kept'}
		<span class="alfy-change-bar-notice">{$t('artifacts.document.change.keptNotice')}</span>
	{:else}
		<span class="alfy-change-bar-notice">{$t('artifacts.document.change.undoneNotice')}</span>
	{/if}
</div>

<style>
	.alfy-change-bar {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-elevated);
		color: var(--text-muted);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.alfy-change-bar-label {
		font-weight: 600;
		color: var(--text-primary);
	}

	.alfy-change-bar-comments {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1rem;
		height: 1rem;
		padding: 0 0.25rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-page);
		font-size: var(--text-2xs, 0.66rem);
	}

	.alfy-change-bar-sep {
		color: var(--text-muted);
	}

	.alfy-change-bar-action {
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: inherit;
		cursor: pointer;
	}

	.alfy-change-bar-action:hover {
		text-decoration: underline;
	}

	.alfy-change-bar-action:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.alfy-change-bar-notice {
		color: var(--text-muted);
	}
</style>
