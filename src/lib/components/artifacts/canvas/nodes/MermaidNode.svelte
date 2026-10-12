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
 *
 * Two things are the block's own (F11): a flowchart written left to right that
 * would be scaled below what a reader can read in a block this wide is drawn top to
 * bottom (`readableDiagramSource`: the very layout the board reserves its height
 * from, so the block is as tall as was reserved), and until the drawing is ready the
 * block shows a quiet bar, never the raw source.
 */
import Mermaid from "$lib/components/chat/Mermaid.svelte";
import { readableDiagramSource } from "$lib/shared/artifacts/mermaid-size";
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

// The block's own width, as laid out: the picture is drawn inside it. A diagram is
// handed over once it is known, so a flowchart is never drawn across and then down.
let boxWidth = $state(0);
// The block's frame and the box's own: what the box's width leaves out of the block's.
const FRAME = 2;
let drawn = $derived(
	boxWidth > 0 ? readableDiagramSource(data.code, boxWidth + FRAME) : "",
);
</script>

{#snippet drawing()}
	<div class="diagram" bind:clientWidth={boxWidth} data-testid="canvas-mermaid">
		{#if boxWidth > 0}<Mermaid code={drawn} quiet />{/if}
	</div>
{/snippet}

{#if editing}
	<!-- The form takes the drawing's place, except on a phone, where it is a sheet and the drawing stays. -->
	<BlockEditForm {id} kind="mermaid" {data} {onclose}>{@render drawing()}</BlockEditForm>
{:else}
	{@render drawing()}
{/if}

<style>
	.diagram {
		box-sizing: border-box;
		padding: 4px 10px 8px;
	}
</style>
