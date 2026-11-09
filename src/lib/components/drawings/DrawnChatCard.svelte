<script lang="ts">
/**
 * What a turn made, as it stands in the chat: `ArtifactCard.svelte`'s card, a
 * bordered head (the kind's tile, its title and facts as grey lines, the way
 * in) and, for a picture, the picture under it. The tile's icon is the one
 * the real card draws (`ARTIFACT_KIND_ICONS`), so a kind that changes its icon
 * changes it here.
 */
import { ChevronRight } from "@lucide/svelte";
import { ARTIFACT_KIND_ICONS } from "$lib/components/artifacts/kind-icons";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";

let {
	kind,
	lit = null,
	spot = undefined,
}: {
	kind: "document" | "image";
	lit?: string | null;
	/** The spot id this card carries, if the drawing points at it. */
	spot?: string | undefined;
} = $props();

let KindIcon = $derived(ARTIFACT_KIND_ICONS[kind]);
</script>

<div
	class="drawn-chat-card"
	data-drawing-spot={spot}
	class:drawing-spot-lit={isLit(spot, lit)}
>
	<div class="head">
		<span class="tile"><span class="drawn-ic" style:--ic="12"><KindIcon size="100%" strokeWidth={1.75} aria-hidden="true" /></span></span>
		<span class="text">
			<DrawnBar width="64%" />
			<DrawnBar width="42%" tone="soft" />
		</span>
		<span class="drawn-ic way-in" style:--ic="10"><ChevronRight size="100%" strokeWidth={2} aria-hidden="true" /></span>
	</div>
	{#if kind === 'image'}
		<div class="picture"></div>
	{/if}
</div>

<style>
	.drawn-chat-card {
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 8);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
	}

	.head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 6);
		padding: calc(var(--u) * 6);
	}

	/* The kind's tile: tinted, with the kind's icon in the accent text colour. */
	.tile {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 20);
		height: calc(var(--u) * 20);
		border-radius: calc(var(--u) * 5);
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 4);
		min-width: 0;
	}

	.way-in {
		color: var(--text-muted);
	}

	/* The picture: a sky tinted by the accent, a box the card reserves. */
	.picture {
		height: calc(var(--u) * 40);
		margin: 0 calc(var(--u) * 6) calc(var(--u) * 6);
		border-radius: calc(var(--u) * 4);
		background: linear-gradient(160deg, var(--accent-tint-strong), var(--surface-elevated));
	}
</style>
