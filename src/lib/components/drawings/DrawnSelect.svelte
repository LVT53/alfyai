<script lang="ts">
/**
 * A Settings select (`.settings-select`): the chosen value as a grey line and
 * the chevron at the right.
 */
import { ChevronDown } from "@lucide/svelte";
import DrawnBar from "./DrawnBar.svelte";
</script>

<span class="drawn-select">
	<DrawnBar width="46%" />
	<span class="drawn-ic chevron"><ChevronDown size="100%" strokeWidth={2} aria-hidden="true" /></span>
</span>

<style>
	.drawn-select {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--u) * 6);
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 5) 0 calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.chevron {
		--ic: 9;
		color: var(--icon-muted);
	}
</style>
