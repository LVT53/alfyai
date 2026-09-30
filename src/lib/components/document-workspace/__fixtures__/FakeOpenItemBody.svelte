<!--
	Test-only fixture for DocumentWorkspace.open-item.test.ts: a body that asks
	the panel to open an item (what a Canvas's File block does), so the test can
	prove the callback reaches the host's own open. Not a real kind body.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let { onOpenItem }: ArtifactBodyProps = $props();
</script>

<button
	type="button"
	data-testid="fake-open-item"
	data-can-open={String(Boolean(onOpenItem))}
	onclick={() =>
		onOpenItem?.({
			id: "chat-file-1",
			source: "chat_generated_file",
			filename: "trip.pdf",
			title: "trip.pdf",
			mimeType: "application/pdf",
		})}
>
	open
</button>
