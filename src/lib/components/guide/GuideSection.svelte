<script lang="ts">
/**
 * One section band: the section's name, a line of intro and its drawing, and
 * its rows. On a wide column the name, intro and drawing are the left column and
 * the rows the right; on a narrow one (every phone, and a tablet or a window
 * with its sidebar open) the band stacks, and the drawing stays in view
 * (`position: sticky` inside the band) while the rows scroll past it, so a row
 * tapped far down still shows its spot.
 *
 * The band holds which part of its drawing is lit (`lit`): its rows say, and
 * `SectionDrawing` draws the ring. A click that lands outside the rows puts the
 * light out, which is how a tap is undone (a tap has no leave).
 */
import { t } from "$lib/i18n";
import SectionDrawing from "./drawings/SectionDrawing.svelte";
import {
	type GuideSectionId,
	guideEntriesFor,
	guideSectionKey,
} from "./guide-content";
import GuideRow from "./GuideRow.svelte";

let { section, now }: { section: GuideSectionId; now: Date } = $props();

let lit = $state<string | null>(null);
let rows = $state<HTMLElement | null>(null);

const entries = $derived(guideEntriesFor(section));

function putOutLight(event: MouseEvent) {
	if (lit === null) return;
	if (rows?.contains(event.target as Node | null)) return;
	lit = null;
}
</script>

<svelte:window onclick={putOutLight} />

<section
	id="guide-section-{section}"
	class="guide-band"
	aria-labelledby="guide-section-{section}-title"
	data-testid="guide-section"
>
	<h2 id="guide-section-{section}-title" class="guide-band__name" tabindex="-1">
		{$t(guideSectionKey(section, 'name'))}
	</h2>
	<p class="guide-band__intro">{$t(guideSectionKey(section, 'intro'))}</p>
	<div class="guide-band__drawing">
		<SectionDrawing {section} {lit} />
	</div>
	<ul class="guide-band__rows" bind:this={rows}>
		{#each entries as entry (entry.id)}
			<GuideRow {entry} {now} onLight={(spot) => (lit = spot)} />
		{/each}
	</ul>
</section>

<style>
	.guide-band {
		padding-block: 1.25rem;
		border-top: 1px solid var(--border-default);
		scroll-margin-top: var(--space-md);
		/* What the pinned drawing hides at the top of the scroller: its frame (330
		   by 222, as wide as the column up to 28rem) and the padding around it. The
		   rows keep this much clear when the browser scrolls one into view, so
		   Shift+Tab does not leave a focused button under the picture. */
		--guide-pinned: calc(
			min(100cqw, 28rem) * 222 / 330 + var(--space-sm) * 3
		);
	}

	.guide-band__name {
		margin: 0 0 0.25rem;
		font-size: var(--text-lg);
		font-weight: 600;
		line-height: 1.3;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	/* The jump from a chip puts the keyboard here; the ring shows where for
	   someone who is using it, and a click leaves no ring. */
	.guide-band__name:focus {
		outline: none;
	}

	.guide-band__name:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 4px;
		border-radius: var(--radius-sm);
	}

	.guide-band__intro {
		margin: 0 0 0.5rem;
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	/* Stacked: the drawing is pinned to the top of the scroller for as long as
	   its band is on screen, over the page's own colour so the rows pass beneath
	   it. The frame fills its container, so it is capped (28rem) lest a tablet
	   give half its height to a picture. On a short window there is no room to
	   pin anything. */
	.guide-band__drawing {
		position: sticky;
		top: 0;
		z-index: 1;
		padding-block: var(--space-sm);
		background: var(--surface-page);
	}

	.guide-band__drawing :global(.drawing-frame) {
		max-width: 28rem;
	}

	.guide-band__rows {
		margin: 0.25rem 0 0;
		padding: 0;
		list-style: none;
	}

	@media (max-height: 36rem) {
		.guide-band {
			--guide-pinned: 0px;
		}

		.guide-band__drawing {
			position: static;
		}
	}

	/* Wide: the name, intro and drawing in a column of 330 px, the size the
	   drawings are designed at, and the rows beside it. That needs a column of
	   46rem, so that the rows keep about 380 px. A window under 768 px never has
	   one, nor does a tablet held upright, nor a 1024 px window with its sidebar
	   open: those stack. */
	@container (min-width: 46rem) {
		.guide-band {
			--guide-pinned: 0px;
			display: grid;
			grid-template-columns: 20.625rem minmax(0, 1fr);
			grid-template-rows: auto auto auto 1fr;
			column-gap: 1.75rem;
		}

		.guide-band__name,
		.guide-band__intro,
		.guide-band__drawing {
			grid-column: 1;
		}

		.guide-band__drawing {
			position: static;
			padding-block: 0;
			background: transparent;
		}

		.guide-band__rows {
			grid-column: 2;
			grid-row: 1 / -1;
			margin: 0;
		}
	}
</style>
