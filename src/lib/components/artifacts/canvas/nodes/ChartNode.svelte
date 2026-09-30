<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { LazyShell } from "../_lib/lazy-nodes";

type ChartShellData = Extract<CanvasBlockData, { kind: "chart" }>;

/** How a chart dresses the shell `LazyNode` draws: its label as the title, its subtitle at the header's end. */
export function chartShell(data: ChartShellData): LazyShell {
	return {
		title: data.label ?? "",
		meta: data.subtitle ?? "",
		summary: data.label ?? "",
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

let { data }: { data: ChartShellData } = $props();
</script>

<div class="chart" data-testid="canvas-chart">
	<Chart code={data.code} />
</div>

<style>
	.chart {
		box-sizing: border-box;
		padding: 4px 10px 8px;
	}
</style>
