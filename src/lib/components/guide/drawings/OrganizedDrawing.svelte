<script lang="ts">
/**
 * The Stay organized section's drawing: the sidebar beside Home. The sidebar
 * is its search pill and its list (Pinned, Projects, Chats); Home is the
 * incognito mask at its corner and its column: the greeting with the record of
 * your weeks, the composer, the projects row and the Recent list with what is
 * running.
 *
 * The spot ids are the guide's `drawingSpot`s for this section
 * (`section-drawing-spots.ts`): `search` is the pill, `projects` the Projects
 * head, `sidebarList` the whole list (Pinned, Projects and Chats, which the
 * rows of Tidy the sidebar are about), `incognito` the mask and `home` the
 * column. Show me rings the greeting band; the drawing lights the whole
 * column, since the row names what Home holds.
 */
import { VenetianMask } from "@lucide/svelte";
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnComposer from "$lib/components/drawings/DrawnComposer.svelte";
import DrawnHomeBand from "$lib/components/drawings/DrawnHomeBand.svelte";
import DrawnHomeProjects from "$lib/components/drawings/DrawnHomeProjects.svelte";
import DrawnRecent from "$lib/components/drawings/DrawnRecent.svelte";
import DrawnSidebar from "$lib/components/drawings/DrawnSidebar.svelte";
import DrawnSpot from "$lib/components/drawings/DrawnSpot.svelte";
import { isLit } from "$lib/components/drawings/drawing-spot";

let { lit = null }: { lit?: string | null } = $props();
</script>

<DrawingFrame>
	<div class="sidebar">
		<DrawnSidebar {lit} spots={{ search: 'search', projects: 'projects', list: 'sidebarList' }} />
	</div>
	<div class="home">
		<div class="arm">
			<span
				class="incognito"
				data-drawing-spot="incognito"
				class:drawing-spot-lit={isLit('incognito', lit)}
			>
				<span class="drawn-ic" style:--ic="10"><VenetianMask size="100%" strokeWidth={1.8} aria-hidden="true" /></span>
			</span>
		</div>
		<DrawnSpot spot="home" {lit} radius={6}>
			<div class="column">
				<DrawnHomeBand />
				<DrawnComposer />
				<DrawnHomeProjects />
				<DrawnRecent />
			</div>
		</DrawnSpot>
	</div>
</DrawingFrame>

<style>
	.sidebar {
		position: absolute;
		inset: 0 auto 0 0;
		width: 36%;
	}

	.home {
		position: absolute;
		inset: 0 0 0 36%;
		box-sizing: border-box;
		padding: calc(var(--u) * 34) calc(var(--u) * 14) 0 calc(var(--u) * 12);
		background: var(--surface-page);
	}

	/* The mask is at the page's corner, above the column. */
	.arm {
		position: absolute;
		top: calc(var(--u) * 11);
		right: calc(var(--u) * 12);
	}

	.incognito {
		display: flex;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 20);
		height: calc(var(--u) * 20);
		border: 1px solid var(--border-default);
		border-radius: 50%;
		background: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
		color: var(--text-secondary);
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 8);
		padding: calc(var(--u) * 5);
	}
</style>
