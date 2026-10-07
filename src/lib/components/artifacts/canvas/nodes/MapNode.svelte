<script module lang="ts">
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import type { LazyShell } from "../_lib/lazy-nodes";

type MapData = Extract<CanvasBlockData, { kind: "map" }>;

/** How a map block dresses the shell `LazyNode` draws: titled with the route and its summary, as the chat's own row reads them. Its title has a form. */
export function mapShell(data: MapData): LazyShell {
	const title = data.label || data.route;
	return { title, meta: data.meta ?? "", summary: title, editable: true };
}
</script>

<script lang="ts">
/**
 * A map block's content: the chat's own route card, given exactly the `map` the
 * chat gives it and no canvas-only prop (`MapRouteCard.svelte` is untouched). The
 * card, and MapLibre behind it, load when the block mounts, never with the editor;
 * until then the space is held, so the block does not jump. Where WebGL is
 * unavailable the card draws its own inline-SVG fallback, which is also the offline
 * shape.
 *
 * Dragging and scrolling on the map move the MAP, not the board (`nodrag`,
 * `nowheel`, `nopan`); the block is moved by its header and its edge. The shell
 * (header, anchors, resize corners) is `LazyNode`'s; this module never imports it.
 */
import { untrack } from "svelte";
import BlockEditForm from "./BlockEditForm.svelte";

type MapCard = typeof import("$lib/components/chat/MapRouteCard.svelte").default;

let {
	id,
	data,
	editing = false,
	onclose,
}: {
	id: string;
	data: MapData;
	/** The block's title form is open, over the top of the map. */
	editing?: boolean;
	onclose: () => void;
} = $props();

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

{#if editing}
	<BlockEditForm {id} kind="map" {data} {onclose} overlay />
{/if}
<div class="map nodrag nowheel nopan" data-testid="canvas-map">
	{#if MapRouteCard}
		<MapRouteCard map={data.map} />
	{/if}
</div>

<style>
	.map {
		box-sizing: border-box;
		/* The card is a 180 px map and an attribution line; held while it loads. */
		min-height: 204px;
		padding: 8px 10px 6px;
	}
</style>
