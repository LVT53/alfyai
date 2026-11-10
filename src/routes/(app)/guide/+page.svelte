<script lang="ts">
import GuidePage from "$lib/components/guide/GuidePage.svelte";
import { t } from "$lib/i18n";
import type { Snapshot } from "./$types";

let scroller = $state<HTMLDivElement | null>(null);

// The page scrolls inside `guide-scroller` and the window never moves, which is
// all that SvelteKit puts back when Back returns to a page. Nearly every button
// on the guide takes the reader away (Show me, Try it), so without this Back
// would land at the top. The snapshot is SvelteKit's own memory per history
// entry, kept by the framework: it is no key of the app's.
export const snapshot: Snapshot<number> = {
	capture: () => scroller?.scrollTop ?? 0,
	restore: (top) => {
		if (scroller) scroller.scrollTop = top;
	},
};
</script>

<svelte:head>
	<title>{$t('guide.title')}</title>
</svelte:head>

<!-- The frame is the Knowledge page's: one scroller (`main-content`) in a page
     that does not scroll, and a column that is a border box at every width, so
     the padding is part of it and a phone's column never runs past its scroller.
     The route is an adapter: the page's body, its content and its drawings are
     in `src/lib/components/guide/`. -->
<div class="flex h-full min-h-0 flex-col overflow-hidden bg-surface-page">
	<div class="main-content flex flex-1 flex-col overflow-y-auto" data-testid="guide-scroller" bind:this={scroller}>
		<div class="mx-auto box-border flex w-full max-w-[calc(65rem+2*var(--column-pad))] flex-col gap-3 px-(--column-pad) py-6 [--column-pad:--spacing(5)] md:[--column-pad:--spacing(8)]">
			<div class="px-1">
				<!-- One page title across the app: 1.75rem serif, not a per-page size. -->
				<h1 class="page-title font-serif text-text-primary">
					{$t('guide.title')}
				</h1>
			</div>

			<GuidePage />
		</div>
	</div>
</div>

<style>
	.page-title {
		font-size: 1.75rem;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}
</style>
