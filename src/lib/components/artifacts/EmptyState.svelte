<!--
	The one empty state a Document, an App and a Canvas draw (Slice 6 T6): the
	kind's line, and beneath it a quiet link that shows the kind's tour again.
	The line comes from `empty-state.ts` (the tour's summary, else the
	dictionary's), so what the page says when it is empty and what the tour
	says are one sentence. The link is there exactly when the panel supplied a
	replay (`ArtifactBodyProps.onReplayTour`): never for a kind with no tour,
	never in an incognito chat. The host positions the block; this draws it.
-->
<script lang="ts">
import { t } from "$lib/i18n";

let {
	line,
	testId,
	onReplayTour,
}: {
	line: string;
	/** The line's test id; the link's is the same with `-replay`. */
	testId: string;
	onReplayTour?: (() => void) | undefined;
} = $props();
</script>

<div class="artifact-empty">
	<p class="artifact-empty__line" data-testid={testId}>{line}</p>
	{#if onReplayTour}
		<button
			type="button"
			class="artifact-empty__replay"
			data-testid="{testId}-replay"
			onclick={() => onReplayTour()}
		>
			{$t("artifacts.tour.replay")}
		</button>
	{/if}
</div>

<style>
	.artifact-empty {
		display: flex;
		flex-direction: column;
		align-items: inherit;
		gap: var(--space-xs);
		text-align: inherit;
	}

	.artifact-empty__line {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-base);
		line-height: 1.5;
	}

	/* Quiet: the line is the message and this is a way back to the tour, so it
	   reads as a link and not as a button. `pointer-events: auto` because a host
	   may lay the block over something that must stay clickable (the Canvas's
	   empty board), with the block itself letting every click through. */
	.artifact-empty__replay {
		padding: 0.25rem 0;
		border: 0;
		background: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--text-sm);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
		pointer-events: auto;
		border-radius: var(--radius-sm);
	}

	.artifact-empty__replay:hover {
		color: var(--text-primary);
	}

	.artifact-empty__replay:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* A finger's size on a phone, where it is the only way into the tour from
	   here: tall enough to hit (the words are wider than 44 px already), and
	   with no side padding, so a left-aligned host's link stays under its line. */
	@media (max-width: 767.98px), (pointer: coarse) {
		.artifact-empty__replay {
			display: inline-flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}
</style>
