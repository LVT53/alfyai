<script lang="ts">
/**
 * A Settings choice between a few words (`.settings-seg`): the options side by
 * side in one bordered box, the chosen one lifted.
 */
import { type I18nKey, t } from "$lib/i18n";

let {
	options,
	active = 0,
}: {
	/** The options, left to right, each with its dictionary key. */
	options: readonly I18nKey[];
	/** The index of the chosen option. */
	active?: number;
} = $props();
</script>

<span class="drawn-segmented">
	{#each options as word, index (word)}
		<span class="option" class:on={index === active}>{$t(word)}</span>
	{/each}
</span>

<style>
	.drawn-segmented {
		display: inline-flex;
		padding: calc(var(--u) * 1.5);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.option {
		display: inline-flex;
		align-items: center;
		height: calc(var(--u) * 10);
		padding: 0 calc(var(--u) * 5);
		border-radius: calc(var(--u) * 3);
		color: var(--text-secondary);
		font-size: calc(var(--u) * 7.5);
		white-space: nowrap;
	}

	.option.on {
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-weight: 600;
	}
</style>
