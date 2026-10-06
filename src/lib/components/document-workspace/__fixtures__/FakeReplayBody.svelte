<!--
	Test-only fixture for DocumentWorkspace.tour.test.ts: a body that is handed
	the panel's tour replay (`onReplayTour`) and the kind's tour summary
	(`tourSummary`), and offers the first as a button and shows the second as
	data, the way a Document's, App's or Canvas's empty state uses them. Not a
	real kind body.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let { onReplayTour, tourSummary }: ArtifactBodyProps = $props();
</script>

<div
	data-testid="fake-replay-body"
	data-can-replay={String(Boolean(onReplayTour))}
	data-tour-summary={tourSummary ? tourSummary.en : "none"}
>
	{#if onReplayTour}
		<button type="button" data-testid="fake-replay" onclick={() => onReplayTour?.()}>
			replay
		</button>
	{/if}
</div>
