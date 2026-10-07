<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { LazyShell } from "../_lib/lazy-nodes";

type MermaidShellData = Extract<CanvasBlockData, { kind: "mermaid" }>;

/** How a diagram dresses the shell `LazyNode` draws: its label as the title, its subtitle at the header's end. A diagram has a form of its own (its title and its source). */
export function mermaidShell(data: MermaidShellData): LazyShell {
	return {
		title: data.label ?? "",
		meta: data.subtitle ?? "",
		summary: data.label ?? "",
		editable: true,
	};
}
</script>

<script lang="ts">
/**
 * A diagram block's content: the chat's own `Mermaid.svelte`, given exactly the
 * `code` the chat gives it and no canvas-only prop. Mermaid is that component's
 * own lazy import, so a board with no diagram never loads it, and now not this
 * either: the block is loaded by `LazyNode` when one is on the board. What it
 * draws (sanitised SVG, or the source and a note when the source cannot be
 * drawn) is what the chat draws.
 */
import Mermaid from "$lib/components/chat/Mermaid.svelte";
import BlockEditForm from "./BlockEditForm.svelte";

let {
	id,
	data,
	editing = false,
	onclose,
}: {
	id: string;
	data: MermaidShellData;
	/** The block's form is open: it takes the place of the drawing. */
	editing?: boolean;
	onclose: () => void;
} = $props();
</script>

{#if editing}
	<BlockEditForm {id} kind="mermaid" {data} {onclose} />
{:else}
	<div class="diagram" data-testid="canvas-mermaid">
		<Mermaid code={data.code} />
	</div>
{/if}

<style>
	.diagram {
		box-sizing: border-box;
		padding: 4px 10px 8px;
	}
</style>
