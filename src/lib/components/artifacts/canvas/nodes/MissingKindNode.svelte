<script lang="ts">
/**
 * A stored block of a kind this build has no component for yet (the blocks
 * made from the chat arrive with their own slice): a card that says so. It is
 * a real node — selectable, movable, deletable — and it stays in the body, so
 * opening and saving a board never loses it.
 */
import { metaFor } from "../_lib/block-meta";
import NodeShell from "../NodeShell.svelte";

let {
	id,
	type,
	selected = false,
}: { id: string; type: string; selected?: boolean } = $props();

let minSize = $derived(metaFor(type).minSize);
</script>

<NodeShell
	{id}
	kind={type}
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
>
	<span class="missing" data-testid="canvas-missing-kind"></span>
</NodeShell>

<style>
	.missing {
		display: block;
		min-height: 20px;
	}
</style>
