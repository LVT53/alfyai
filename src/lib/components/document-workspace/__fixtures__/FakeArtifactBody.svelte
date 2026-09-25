<!--
	Test-only fixture for DocumentWorkspace.test.ts: proves the panel's
	type→body registry dispatch (Slice 0 Task S5) without a real editor, none
	of which exist yet (the registry ships empty). Not a real kind body — do
	not import this outside that test file.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let { artifactId, kind, title }: ArtifactBodyProps = $props();
</script>

<div data-testid="fake-artifact-body" data-artifact-id={artifactId} data-kind={kind}>
	{title}
</div>
