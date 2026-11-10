<script lang="ts">
/**
 * The top of Home (`.home-band` in `HomeSurface.svelte`): the greeting at the
 * left, as a thick grey line, and the record of your weeks at its right
 * (`HomeWeeklyBars.svelte`): twelve ticks in the accent, taller for a busier
 * week, and the count beside them as a grey line.
 */
import DrawnBar from "./DrawnBar.svelte";

/** A tick's height, in design pixels, for each of the twelve weeks. */
const WEEKS = [3, 5, 4, 8, 6, 3, 9, 7, 5, 10, 8, 11] as const;
</script>

<div class="drawn-home-band">
	<span class="greeting"><DrawnBar width="62%" thick /></span>
	<span class="record">
		<span class="ticks">
			{#each WEEKS as height}
				<i style:height="calc(var(--u) * {height})"></i>
			{/each}
		</span>
		<DrawnBar width="calc(var(--u) * 13)" tone="soft" />
	</span>
</div>

<style>
	.drawn-home-band {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: calc(var(--u) * 10);
	}

	.greeting {
		display: flex;
		flex: 1;
		min-width: 0;
		padding-bottom: calc(var(--u) * 1);
	}

	.record {
		display: inline-flex;
		flex: none;
		align-items: flex-end;
		gap: calc(var(--u) * 5);
	}

	.ticks {
		display: inline-flex;
		align-items: flex-end;
		gap: calc(var(--u) * 2);
	}

	.ticks i {
		display: block;
		width: calc(var(--u) * 1.5);
		border-radius: calc(var(--u) * 1);
		background: var(--accent);
	}
</style>
