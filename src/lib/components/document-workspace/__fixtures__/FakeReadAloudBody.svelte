<!--
	Test-only fixture for DocumentWorkspace.read-aloud.test.ts: a Document body
	that hands the panel a read-aloud source and reports what its readability
	hangs on, as DocumentBody.svelte does. Not a real kind body.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";
import { fakeReadAloudSource } from "./fake-read-aloud";

let { registerPanelActions, onReadAloudChange }: ArtifactBodyProps = $props();

$effect(() => {
	registerPanelActions?.({ readAloud: fakeReadAloudSource });
	onReadAloudChange?.("page-1");
});
</script>

<p data-testid="fake-read-aloud-body">Weekend plan</p>
