<!--
	Test-only fixture for DocumentWorkspace.tour.test.ts: a body that is handed
	the panel's tour replay (`onReplayTour`) and offers it as a button, the way a
	Document's or App's empty state will. Not a real kind body.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let { onReplayTour }: ArtifactBodyProps = $props();
</script>

<div data-testid="fake-replay-body" data-can-replay={String(Boolean(onReplayTour))}>
	{#if onReplayTour}
		<button type="button" data-testid="fake-replay" onclick={() => onReplayTour?.()}>
			replay
		</button>
	{/if}
</div>
