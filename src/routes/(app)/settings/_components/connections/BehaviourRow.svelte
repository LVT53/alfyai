<script lang="ts">
// Connections redesign — one "How it behaves" line in the detail dialog:
// label, an explanatory sentence, an optional tooltip for the longer version,
// and the switch.
//
// The sentence is new. "Default on" and "Allow writes" were bare labels whose
// meaning lived entirely in a tooltip, so the two most consequential switches
// on the screen said nothing until hovered — and on touch, never.
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";

let {
	label,
	description = "",
	help = "",
	checked,
	busy = false,
	onChange,
	testId,
}: {
	label: string;
	description?: string;
	help?: string;
	checked: boolean;
	busy?: boolean;
	onChange: (next: boolean) => void;
	testId?: string;
} = $props();
</script>

<div class="behaviour-row" data-testid={testId}>
	<div class="behaviour-text">
		<p class="behaviour-label">
			{label}
			{#if help}
				<InfoTooltip text={help} />
			{/if}
		</p>
		{#if description}
			<p class="behaviour-description">{description}</p>
		{/if}
	</div>
	<Toggle
		{checked}
		disabled={busy}
		ariaLabel={label}
		onChange={(next) => onChange(next)}
	/>
</div>

<style>
	.behaviour-row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.5625rem 0;
		border-top: 1px solid var(--border-subtle);
	}

	.behaviour-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.behaviour-label {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.behaviour-description {
		margin: 0.1875rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}
</style>
