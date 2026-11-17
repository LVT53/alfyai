<script lang="ts">
/**
 * The ruler of a long chat (`ConversationJumpRail.svelte`): short ticks, the
 * orange needle where the reader is, and on hover the list of every turn,
 * the current one in the accent. A turn's words are content, so grey lines.
 */
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";

let {
	ticks = 11,
	needle = 6,
	rows = ["70%", "56%", "82%", "48%", "64%", "74%", "58%"],
	current = 4,
}: {
	ticks?: number;
	/** The tick the needle sits on. */
	needle?: number;
	/** One width per turn in the list; none leaves the list shut. */
	rows?: string[];
	current?: number;
} = $props();
</script>

<div class="ruler-and-list">
	<span class="ruler">
		{#each { length: ticks } as _, index}
			<span class="tick" class:needle={index === needle}></span>
		{/each}
	</span>
	{#if rows.length > 0}
		<span class="list">
			{#each rows as width, index}
				<span class="row" class:current={index === current}>
					<DrawnBar {width} tone={index === current ? 'accent' : 'soft'} />
				</span>
			{/each}
		</span>
	{/if}
</div>

<style>
	.ruler-and-list {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 3);
	}

	.ruler {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: calc(var(--u) * 3.5);
		width: calc(var(--u) * 10);
	}

	.tick {
		display: block;
		width: calc(var(--u) * 6);
		height: calc(var(--u) * 1);
		border-radius: calc(var(--u) * 0.5);
		background: color-mix(in srgb, var(--text-primary) 34%, transparent);
	}

	.tick.needle {
		width: calc(var(--u) * 10);
		height: calc(var(--u) * 1.6);
		background: var(--accent);
	}

	.list {
		display: flex;
		flex-direction: column;
		width: calc(var(--u) * 104);
		padding: calc(var(--u) * 3);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
	}

	.row {
		display: flex;
		align-items: center;
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 5);
		border-radius: calc(var(--u) * 3);
	}

	.row.current {
		background: var(--surface-elevated);
	}
</style>
