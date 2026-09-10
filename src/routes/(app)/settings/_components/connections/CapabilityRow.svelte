<script lang="ts">
// Connections redesign — one capability line in the detail dialog.
//
// Two shapes, and which one you get is the point of the whole change. A
// GRANTED capability gets a switch. A DENIED one gets a greyed line and "Ask
// again" — because the dialog used to iterate the provider's catalogue, so a
// Google account that refused Contacts still showed a Contacts switch that
// turned on with no permission behind it. The only thing that can fix that is
// another trip to the consent screen, which is what the button does.
import Toggle from "$lib/components/ui/Toggle.svelte";

let {
	label,
	description,
	granted,
	checked = false,
	busy = false,
	askAgainLabel,
	onChange,
	onAskAgain,
	testId,
}: {
	label: string;
	description: string;
	granted: boolean;
	checked?: boolean;
	busy?: boolean;
	askAgainLabel?: string;
	onChange?: (next: boolean) => void;
	onAskAgain?: () => void;
	testId?: string;
} = $props();
</script>

<div class="capability-row" class:denied={!granted} data-testid={testId}>
	<div class="capability-text">
		<p class="capability-label">{label}</p>
		<p class="capability-description">{description}</p>
	</div>
	{#if granted}
		<Toggle
			{checked}
			disabled={busy}
			ariaLabel={label}
			onChange={(next) => onChange?.(next)}
		/>
	{:else if askAgainLabel}
		<button
			type="button"
			class="ask-again"
			data-testid={testId ? `${testId}-ask-again` : undefined}
			onclick={() => onAskAgain?.()}
		>
			{askAgainLabel}
		</button>
	{/if}
</div>

<style>
	.capability-row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.5625rem 0;
		border-top: 1px solid var(--border-subtle);
	}

	.capability-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.capability-label {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.capability-row.denied .capability-label {
		color: var(--text-muted);
	}

	.capability-description {
		margin: 0.1875rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.ask-again {
		flex-shrink: 0;
		margin-top: 0.0625rem;
		padding: 0.25rem 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard),
			color var(--duration-standard);
	}

	.ask-again:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.ask-again:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
