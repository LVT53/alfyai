<!--
	Test-only fixture for DocumentWorkspace.test.ts: a body that registers its
	panel actions once on mount, exactly like the real Document body does
	(`DocumentBody.svelte`'s `registerPanelActions` effect runs once — its
	closures never change), so the panel header's version button is a real
	button. Not a real kind body — do not import this outside test files.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let { artifactId, registerPanelActions }: ArtifactBodyProps = $props();

registerPanelActions?.({ openVersions: () => {} });
</script>

<div data-testid="fake-versioned-artifact-body" data-artifact-id={artifactId}></div>
