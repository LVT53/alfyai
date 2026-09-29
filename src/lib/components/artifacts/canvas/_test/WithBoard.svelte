<script lang="ts">
// A test host: a node component drawn the way the board draws it — inside the
// element the library wraps every node in, under a board context.
import type { Component } from "svelte";
import {
	type CanvasBoardContext,
	provideBoardContext,
} from "../_lib/board-context";

let {
	component,
	componentProps,
	context,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: a test host renders any node component, whatever its props
	component: Component<any>;
	componentProps: Record<string, unknown>;
	context: CanvasBoardContext;
} = $props();

// The context is fixed for the life of a test host.
// svelte-ignore state_referenced_locally
provideBoardContext(context);

const Node = $derived(component);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- The library's own node wrapper is a focusable group; this stands in for it. -->
<div class="svelte-flow__node" role="group" tabindex="0" data-testid="node-wrapper">
	<Node {...componentProps} />
</div>
