<!--
	Test-only fixture for DocumentWorkspace.history.test.ts: a body that asks for
	History on one of its versions (the picture strip's frame does), and shows the
	version number the panel hands it. Not a real kind body.
-->
<script lang="ts">
import { onMount } from "svelte";
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let {
	registerPanelActions,
	onOpenHistory,
	versionNumber = null,
}: ArtifactBodyProps = $props();

onMount(() => {
	registerPanelActions?.({ flush: async () => {}, reload: () => {} });
});
</script>

<div data-testid="fake-history-version-body" data-version={versionNumber ?? ''}>
	<button type="button" data-testid="fake-open-version" onclick={() => onOpenHistory?.('v2')}>
		Open v2
	</button>
</div>
