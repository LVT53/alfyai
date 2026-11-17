<script lang="ts">
/**
 * The dark pill on a selection in a reply (`read-aloud/ReadFromHere.svelte`):
 * Play and "Read from here", its own key.
 */
import { Play } from "@lucide/svelte";
import { t } from "$lib/i18n";
</script>

<span class="read-from-here">
	<span class="drawn-ic" style:--ic="7"><Play size="100%" strokeWidth={2} fill="currentColor" aria-hidden="true" /></span>
	<span>{$t('readAloud.readFromHere')}</span>
</span>

<style>
	.read-from-here {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 3.5);
		height: calc(var(--u) * 15);
		padding: 0 calc(var(--u) * 8) 0 calc(var(--u) * 7);
		border-radius: calc(var(--u) * 8);
		background: var(--text-primary);
		color: var(--surface-page);
		font-size: calc(var(--u) * 7.5);
		font-weight: 600;
		white-space: nowrap;
		box-shadow: var(--shadow-md);
	}
</style>
