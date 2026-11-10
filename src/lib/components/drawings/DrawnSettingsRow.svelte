<script lang="ts">
/**
 * One row of a Settings card (`.settings-row`): the label, a line or two of
 * what it means as grey lines, and the control. The control sits at the right
 * of the label, or under it (`stacked`), as the real row lays it out when a
 * phone gives it a line of its own. As in the real row, its box reaches a
 * little past its text on both sides, so the hairline between rows does too.
 */
import type { Snippet } from "svelte";
import { type I18nKey, t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";

let {
	label,
	help = [],
	stacked = false,
	divider = false,
	children = undefined,
}: {
	/** The label, as its dictionary key. */
	label: I18nKey;
	/** One width per line of the row's help text. */
	help?: readonly string[];
	/** The control goes under the label instead of beside it. */
	stacked?: boolean;
	/** The hairline between this row and the one above it. */
	divider?: boolean;
	/** The control. */
	children?: Snippet | undefined;
} = $props();
</script>

<div class="drawn-settings-row" class:stacked class:divider>
	<div class="text">
		<span class="label">{$t(label)}</span>
		{#each help as width}
			<DrawnBar {width} tone="soft" />
		{/each}
	</div>
	{#if children}
		<div class="control">{@render children()}</div>
	{/if}
</div>

<style>
	.drawn-settings-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: calc(var(--u) * 6);
		margin: 0 calc(var(--u) * -4);
		padding: calc(var(--u) * 3.5) calc(var(--u) * 4);
	}

	.divider {
		border-top: 1px solid var(--border-default);
	}

	.stacked {
		flex-direction: column;
		align-items: stretch;
		gap: calc(var(--u) * 3);
	}

	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 3);
		min-width: 0;
	}

	.label {
		color: var(--text-primary);
		font-size: calc(var(--u) * 8.5);
		font-weight: 500;
		line-height: 1.25;
		white-space: nowrap;
	}

	.control {
		display: flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 5);
	}

	/* Under the label the control has the whole line: a select fills it and a
	   button keeps its own width at the left. */
	.stacked .control {
		display: block;
	}
</style>
