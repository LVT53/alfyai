<script lang="ts">
import GuidePage from "$lib/components/guide/GuidePage.svelte";
import { t } from "$lib/i18n";
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
	<div class="main-content flex flex-1 flex-col overflow-y-auto" data-testid="guide-scroller">
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
