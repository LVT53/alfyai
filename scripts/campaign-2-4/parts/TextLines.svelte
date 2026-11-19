<script lang="ts" module>
/** A mark behind a line, from `from` to `to`, in percent of the line. */
export type LineMark = {
	from: number;
	to: number;
	/** `sentence` is the one being read, `word` the word being spoken (read
	 *  aloud's two marks, spec §4.2), `selection` text the person selected. */
	kind: "sentence" | "word" | "selection";
};

export type Line = { width: string; marks?: LineMark[] };
</script>

<script lang="ts">
/**
 * A paragraph of a reply as grey lines (`DrawnBar`), with read aloud's marks
 * behind them: the soft tint of the sentence being read, the stronger one of
 * the word being spoken, or a selection.
 */
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";

let { lines }: { lines: Line[] } = $props();
</script>

<div class="text-lines">
	{#each lines as line}
		<span class="line">
			{#each line.marks ?? [] as mark}
				<span
					class="mark {mark.kind}"
					style:left="{mark.from}%"
					style:width="{mark.to - mark.from}%"
				></span>
			{/each}
			<span class="bar"><DrawnBar width={line.width} tone="soft" /></span>
		</span>
	{/each}
</div>

<style>
	.text-lines {
		display: flex;
		flex-direction: column;
	}

	.line {
		position: relative;
		display: flex;
		align-items: center;
		height: calc(var(--u) * 10);
	}

	.bar {
		position: relative;
		display: flex;
		width: 100%;
	}

	.mark {
		position: absolute;
		top: calc(var(--u) * 1);
		bottom: calc(var(--u) * 1);
		border-radius: calc(var(--u) * 2);
	}

	.sentence {
		background: var(--accent-tint);
	}

	.word {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
	}

	.selection {
		background: color-mix(in srgb, var(--info) 22%, transparent);
	}
</style>
