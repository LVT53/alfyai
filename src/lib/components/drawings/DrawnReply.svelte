<script lang="ts">
/**
 * Alfy's reply: three grey lines, the Sources row and the row of actions.
 *
 * The Sources row is `MessageEvidenceDetails.svelte`'s toggle (the book, its
 * word, the chevron). The actions are the icons of `MessageBubble.svelte`'s
 * action row, in its order: regenerate, fork, copy.
 */
import { Book, ChevronDown, Copy, GitBranch, RefreshCw } from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";

let {
	lit = null,
	spots = {},
}: {
	lit?: string | null;
	/** The spot ids this reply carries: its Sources row and its row of actions. */
	spots?: { sources?: string; actions?: string };
} = $props();
</script>

<div class="drawn-reply">
	<span class="mark"></span>
	<div class="lines">
		<DrawnBar width="92%" />
		<DrawnBar width="96%" tone="soft" />
		<DrawnBar width="70%" tone="soft" />
	</div>
	<div class="foot">
		<span
			class="sources"
			data-drawing-spot={spots.sources}
			class:drawing-spot-lit={isLit(spots.sources, lit)}
		>
			<span class="copy">
				<span class="drawn-ic book"><Book size="100%" strokeWidth={2} aria-hidden="true" /></span>
				<span class="label">{$t('messageEvidenceDetails.sourcesLabel')}</span>
			</span>
			<span class="drawn-ic chevron"><ChevronDown size="100%" strokeWidth={2} aria-hidden="true" /></span>
		</span>
		<span
			class="actions"
			data-drawing-spot={spots.actions}
			class:drawing-spot-lit={isLit(spots.actions, lit)}
		>
			<span class="drawn-ic"><RefreshCw size="100%" strokeWidth={2} aria-hidden="true" /></span>
			<span class="drawn-ic"><GitBranch size="100%" strokeWidth={2} aria-hidden="true" /></span>
			<span class="drawn-ic"><Copy size="100%" strokeWidth={2} aria-hidden="true" /></span>
		</span>
	</div>
</div>

<style>
	.drawn-reply {
		position: relative;
	}

	/* Where the reply starts: the dot stands for Alfy's mark. */
	.mark {
		position: absolute;
		top: 0;
		left: 0;
		width: calc(var(--u) * 9);
		height: calc(var(--u) * 9);
		border-radius: 50%;
		background: var(--accent);
	}

	.lines {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		margin-left: calc(var(--u) * 16);
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: calc(var(--u) * 7) 0 0 calc(var(--u) * 14);
	}

	.sources {
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--u) * 12);
		min-width: calc(var(--u) * 92);
		padding: calc(var(--u) * 2) calc(var(--u) * 4);
		border-radius: calc(var(--u) * 5);
		color: var(--icon-muted);
	}

	.copy {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 5);
	}

	.book {
		color: var(--accent);
	}

	.label {
		font-size: calc(var(--u) * 9.5);
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.actions {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 7);
		padding: calc(var(--u) * 3) calc(var(--u) * 5);
		border-radius: calc(var(--u) * 5);
		color: var(--icon-muted);
	}
</style>
