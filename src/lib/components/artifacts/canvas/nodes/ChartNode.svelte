<script lang="ts">
/**
 * A chart block: the chat's own `Chart.svelte`, given exactly the `code` the
 * chat gives it and no canvas-only prop. Chart.js is that component's own lazy
 * import, so a board with no chart never loads it.
 */
import Chart from "$lib/components/chat/Chart.svelte";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import NodeShell from "../NodeShell.svelte";

type ChartData = Extract<CanvasBlockData, { kind: "chart" }>;

let {
	id,
	data,
	selected = false,
}: { id: string; data: ChartData; selected?: boolean } = $props();

const minSize = BLOCK_META.chart.minSize;
</script>

<NodeShell
	{id}
	kind="chart"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	title={data.label ?? ""}
	meta={data.subtitle ?? ""}
	summary={data.label ?? ""}
>
	<div class="chart" data-testid="canvas-chart">
		<Chart code={data.code} />
	</div>
</NodeShell>

<style>
	.chart {
		box-sizing: border-box;
		padding: 4px 10px 8px;
	}
</style>
