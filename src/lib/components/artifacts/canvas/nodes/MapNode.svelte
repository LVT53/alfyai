<script lang="ts">
/**
 * A map block: the chat's own route card, given exactly the `map` the chat gives
 * it and no canvas-only prop (`MapRouteCard.svelte` is untouched). Its header is
 * what the chat's own activity row says of the route — the route and its summary
 * — read when the block was inserted. The card, and MapLibre behind it, load when
 * the block mounts, never with the editor; until then the space is held, so the
 * block does not jump. Where WebGL is unavailable the card draws its own
 * inline-SVG fallback, which is also the offline shape.
 *
 * Dragging and scrolling on the map move the MAP, not the board (`nodrag`,
 * `nowheel`, `nopan`); the block is moved by its header and its edge.
 */
import { untrack } from "svelte";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import NodeShell from "../NodeShell.svelte";

type MapData = Extract<CanvasBlockData, { kind: "map" }>;
type MapCard =
	typeof import("$lib/components/chat/MapRouteCard.svelte").default;

let {
	id,
	data,
	selected = false,
}: { id: string; data: MapData; selected?: boolean } = $props();

const minSize = BLOCK_META.map.minSize;

let MapRouteCard = $state.raw<MapCard | null>(null);
$effect(() => {
	if (untrack(() => MapRouteCard)) return;
	let current = true;
	void import("$lib/components/chat/MapRouteCard.svelte").then((module) => {
		if (current) MapRouteCard = module.default;
	});
	return () => {
		current = false;
	};
});
</script>

<NodeShell
	{id}
	kind="map"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	title={data.label || data.route}
	meta={data.meta ?? ""}
	summary={data.label || data.route}
>
	<div class="map nodrag nowheel nopan" data-testid="canvas-map">
		{#if MapRouteCard}
			<MapRouteCard map={data.map} />
		{/if}
	</div>
</NodeShell>

<style>
	.map {
		box-sizing: border-box;
		/* The card is a 180 px map and an attribution line; held while it loads. */
		min-height: 204px;
		padding: 8px 10px 6px;
	}
</style>
