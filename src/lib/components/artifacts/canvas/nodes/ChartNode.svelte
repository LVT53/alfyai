<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { LazyShell } from "../_lib/lazy-nodes";

type ChartShellData = Extract<CanvasBlockData, { kind: "chart" }>;

/** How a chart dresses the shell `LazyNode` draws: its label as the title, its subtitle at the header's end. A chart has a form of its own (its title and its data). */
export function chartShell(data: ChartShellData): LazyShell {
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
 * A chart block's content: the chat's own `Chart.svelte`, given exactly the `code`
 * the chat gives it and no canvas-only prop. Chart.js is that component's own lazy
 * import, so a board with no chart never loads it — and now not this either: the
 * block is loaded by `LazyNode` when one is on the board.
 */
import Chart from "$lib/components/chat/Chart.svelte";
import { chartAspectRatio } from "$lib/shared/artifacts/canvas-blocks";
import BlockEditForm from "./BlockEditForm.svelte";

let {
	id,
	data,
	editing = false,
	onclose,
}: {
	id: string;
	data: ChartShellData;
	/** The block's form is open: it takes the place of the plot. */
	editing?: boolean;
	onclose: () => void;
} = $props();

// The box the plot is drawn into, at the ratio Chart.js would draw it at (the
// estimate the model reads is of the same box).
let plotRatio = $derived(chartAspectRatio(data.code));
</script>

{#snippet plot()}
	<div class="chart" data-testid="canvas-chart" style:--plot-ratio={plotRatio}>
		<Chart code={data.code} />
	</div>
{/snippet}

{#if editing}
	<!-- The form takes the plot's place, except on a phone, where it is a sheet and the plot stays. -->
	<BlockEditForm {id} kind="chart" {data} {onclose}>{@render plot()}</BlockEditForm>
{:else}
	{@render plot()}
{/if}

<style>
	.chart {
		box-sizing: border-box;
		padding: 4px 10px 8px;
	}

	/*
	 * Chart.js sizes a plot from its container's box measured ON THE SCREEN the
	 * first time, and the board's camera scales that box: a board opened at 50%
	 * drew every plot half as wide and half as tall as its block, and a chart was
	 * then shorter than the height Alfy had planned it at (RC-3 N1). A box of its
	 * own, at the plot's ratio, is what the library's resize observer reports in
	 * board units, so the plot fills it whatever the zoom.
	 */
	.chart :global(.markdown-chart) {
		aspect-ratio: var(--plot-ratio);
	}
</style>
