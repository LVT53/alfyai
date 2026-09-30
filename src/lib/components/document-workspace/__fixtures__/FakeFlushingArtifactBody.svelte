<!--
	Test-only fixture for DocumentWorkspace.test.ts: a body that registers a
	`flush` (the way the Canvas body registers its own) so the panel can hand it
	to the page. Not a real kind body — do not import this outside test files.
-->
<script lang="ts">
import { onMount } from "svelte";
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";
import { fakeFlush } from "./fake-flush";

let { artifactId, registerPanelActions }: ArtifactBodyProps = $props();

onMount(() => {
	registerPanelActions?.({ flush: fakeFlush });
});
</script>

<div data-testid="fake-flushing-artifact-body" data-artifact-id={artifactId}></div>
