<script lang="ts">
let {
	iconUrl = null,
	displayName = "",
	size = 24,
}: {
	iconUrl?: string | null;
	displayName?: string | null;
	size?: number;
} = $props();

let failed = $state(false);
let initial = $derived((displayName?.trim()?.[0] ?? "M").toUpperCase());
let sizeValue = $derived(`${size}px`);
</script>

<span class="model-icon" style={`--model-icon-size: ${sizeValue};`} aria-hidden="true">
	{#if iconUrl && !failed}
		<img src={iconUrl} alt="" onerror={() => (failed = true)} />
	{:else}
		<span class="model-icon-fallback">{initial}</span>
	{/if}
</span>

<style>
	.model-icon {
		display: inline-flex;
		flex: 0 0 var(--model-icon-size);
		width: var(--model-icon-size);
		height: var(--model-icon-size);
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-overlay);
		color: var(--text-muted);
		font-size: calc(var(--model-icon-size) * 0.46);
		font-weight: 700;
		line-height: 1;
	}

	.model-icon img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		object-position: center;
	}

	.model-icon-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
	}
</style>
