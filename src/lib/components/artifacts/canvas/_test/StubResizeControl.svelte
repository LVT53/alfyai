<script lang="ts">
import type { Snippet } from "svelte";
// A test stand-in for Svelte Flow's `NodeResizeControl` (see StubHandle).
let {
	position,
	variant,
	minWidth,
	minHeight,
	children,
}: {
	position?: string;
	variant?: string;
	minWidth?: number;
	minHeight?: number;
	children?: Snippet;
} = $props();
</script>

<span
	data-testid="canvas-resize-handle"
	data-position={position}
	data-variant={variant ?? "handle"}
	data-min-width={minWidth}
	data-min-height={minHeight}
>{@render children?.()}</span>
