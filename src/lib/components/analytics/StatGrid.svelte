<script lang="ts">
import type { Snippet } from "svelte";

interface StatGridProps {
	/** StatCard children. */
	children?: Snippet;
}

let { children }: StatGridProps = $props();
</script>

<!-- The tiles answer to the card they sit in, not to the window. The same grid
     serves a ~590px Settings column and a ~1160px admin panel, and a viewport
     breakpoint puts four across in both — right for one, and cramped enough in
     the other to break a tile's comparison line over three lines. The wrapper
     is the query container; the grid inside it is what the query moves. -->
<div class="stat-grid-shell">
	<div class="stat-grid">
		{@render children?.()}
	</div>
</div>

<style>
	.stat-grid-shell {
		container-type: inline-size;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	@container (min-width: 34rem) {
		.stat-grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	@container (min-width: 58rem) {
		.stat-grid {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
