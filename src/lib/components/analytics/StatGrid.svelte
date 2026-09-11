<script lang="ts">
import type { Snippet } from "svelte";

interface StatGridProps {
	/** StatCard children. */
	children?: Snippet;
}

let { children }: StatGridProps = $props();
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
	{@render children?.()}
</div>
