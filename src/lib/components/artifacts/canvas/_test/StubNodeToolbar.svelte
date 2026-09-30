<script lang="ts">
// A test stand-in for Svelte Flow's `NodeToolbar`, which portals its children
// out of the node; here they stay where they are so a test can find them.
import type { Snippet } from "svelte";

let { children }: { children?: Snippet } = $props();
</script>

<div data-testid="canvas-node-toolbar-host">{@render children?.()}</div>
