<script lang="ts">
// A test stand-in for Svelte Flow's `ViewportPortal`, which moves its children
// into the viewport's own layer; here they stay where they are so a test can
// find them.
import type { Snippet } from "svelte";

let { children }: { target?: string; children?: Snippet } = $props();
</script>

<div data-testid="canvas-viewport-portal">{@render children?.()}</div>
