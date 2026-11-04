<script lang="ts">
// A permission question. The thing it is about leads, large, beside the mark of
// the account it lives in, the way an artifact's card leads with its title, and
// the small lines under the name say where and when. What Alfy is asking sits
// above it in one short line. The inline card and the phone sheet draw the same
// one, each in its own frame and with its own buttons.
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import WriteConfirmDetails from "./WriteConfirmDetails.svelte";
import WriteConfirmFacts from "./WriteConfirmFacts.svelte";
import type { WriteCardView } from "./write-card-view";

let {
	view,
	provider,
	error = null,
	footnote = null,
}: {
	view: WriteCardView;
	provider: string;
	error?: string | null;
	/** One quiet line at the end: the sheet says how many more are waiting. */
	footnote?: string | null;
} = $props();
</script>

<div class="write-content">
	{#if view.name}
		<div class="write-content__ask">
			<h3>{view.question}</h3>
			<span class="write-content__account">{view.qualifier}</span>
		</div>
	{/if}

	<div class="write-content__thing">
		<span class="write-content__tile" aria-hidden="true">
			<BrandIcon {provider} size={16} ariaHidden />
		</span>
		<div class="write-content__named">
			{#if view.name}
				<p class="write-content__name">{view.name}</p>
			{:else}
				<h3 class="write-content__name">{view.question}</h3>
				<p class="write-content__account">{view.qualifier}</p>
			{/if}
			<WriteConfirmFacts facts={view.facts} />
		</div>
	</div>

	{#if view.thumbnails.length > 0 || view.message || view.risk || error}
		<div class="write-content__body">
			<WriteConfirmDetails {view} />
			{#if error}
				<p class="write-content__error" role="alert">{error}</p>
			{/if}
		</div>
	{/if}

	{#if footnote}
		<p class="write-content__footnote">{footnote}</p>
	{/if}
</div>

<style>
	/* The card answers to its own width, like ArtifactCard: the chat column
	   beside a docked panel is narrow whatever the window is. */
	.write-content {
		container: write-content / inline-size;
		font-family: var(--font-sans);
		color: var(--text-primary);
	}

	.write-content__ask {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}

	h3 {
		margin: 0;
	}

	.write-content__ask h3 {
		flex: 0 0 auto;
		max-width: 100%;
		font-size: var(--text-xs);
		font-weight: 700;
		line-height: 1.3;
		color: var(--accent-text);
	}

	.write-content__account {
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: var(--text-2xs);
		line-height: 1.3;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ArtifactCard's head: the same tile, a title and what stands under it. */
	.write-content__thing {
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
	}

	.write-content__tile {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 9px;
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.write-content__named {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.write-content__name {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: 1.25;
		letter-spacing: 0.005em;
		overflow-wrap: anywhere;
	}

	/* The rest starts under the name, so the card reads as one column beside
	   its mark. A narrow card has no width to give away for that. */
	.write-content__body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.625rem;
		padding-left: calc(36px + 0.75rem);
	}

	@container write-content (max-width: 26rem) {
		.write-content__body {
			padding-left: 0;
		}
	}

	.write-content__error {
		margin: 0;
		font-size: var(--text-sm);
		line-height: 1.4;
		color: var(--danger);
	}

	.write-content__footnote {
		margin: 0.75rem 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}
</style>
