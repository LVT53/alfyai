<script lang="ts">
// A test stand-in for Svelte Flow's `NodeResizeControl` (see StubHandle).
let {
	position,
	minWidth,
	minHeight,
}: { position?: string; minWidth?: number; minHeight?: number } = $props();
</script>

<span
	data-testid="canvas-resize-handle"
	data-position={position}
	data-min-width={minWidth}
	data-min-height={minHeight}
></span>
