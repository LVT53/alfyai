<script lang="ts">
/**
 * A box a guide row can light, for the spots no other part holds itself: two
 * rows that one row of the guide is about, a whole card, a region of a page.
 * It is the control's own box and nothing more, so the ring sits close around
 * what it rings. `radius` is the corner the content has (in design pixels),
 * since the ring follows it. `bleed` is how far the control's box reaches past
 * its content on each side, the way a Settings row reaches past its text: the
 * box grows by that much and the content stays where it was.
 */
import type { Snippet } from "svelte";
import { isLit } from "./drawing-spot";

let {
	spot,
	lit = null,
	radius = 5,
	bleed = 0,
	children = undefined,
}: {
	spot: string;
	lit?: string | null;
	radius?: number;
	bleed?: number;
	children?: Snippet | undefined;
} = $props();
</script>

<div
	class="drawn-spot"
	data-drawing-spot={spot}
	class:drawing-spot-lit={isLit(spot, lit)}
	style:--spot-radius={radius}
	style:--spot-bleed={bleed}
>
	{@render children?.()}
</div>

<style>
	.drawn-spot {
		min-width: 0;
		margin: 0 calc(var(--u) * var(--spot-bleed) * -1);
		padding: 0 calc(var(--u) * var(--spot-bleed));
		border-radius: calc(var(--u) * var(--spot-radius));
	}
</style>
