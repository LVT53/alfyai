<!--
	Test-only fixture for HistoryMode.test.ts: stands in for a kind's History preview
	(`HistoryPreviewProps`), so a test can see which version History shows without
	fetching bodies. Not for production code.
-->
<script lang="ts">
import type { HistoryPreviewProps } from "../history-previews";

let { versionId, onState }: HistoryPreviewProps = $props();

$effect(() => {
	onState({ status: "ready", changeCount: 0 });
});
</script>

<div data-testid="fake-version-preview" data-version-id={versionId}></div>
