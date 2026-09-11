<script lang="ts">
// Connections redesign — "Add a connection" as a grid of cards, each saying
// what the provider actually brings ("Your files and contacts"), rather than
// a row of pills that only showed a logo and a name. Choosing between nine
// services by brand alone is a memory test.
//
// The custom-integration group keeps its own heading, reworded from the
// abstract "Custom integrations" to "Set one up yourself" — the distinction
// being made is who supplies the server, not what category the adapter is in.
import { Check } from "@lucide/svelte";
import {
	type ConnectionProvider,
	getProviderCatalogEntry,
	groupConnectableProviders,
} from "$lib/client/connections/provider-catalog";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import { t } from "$lib/i18n";

let {
	connectedProviders,
	onStartConnect,
}: {
	connectedProviders: Set<string>;
	onStartConnect: (provider: ConnectionProvider) => void;
} = $props();

const groups = $derived(groupConnectableProviders());

function blurbFor(provider: ConnectionProvider): string {
	return $t(
		`connections.provider.${provider}.blurb` as Parameters<typeof $t>[0],
	);
}
</script>

{#snippet providerCard(provider: ConnectionProvider)}
	{@const entry = getProviderCatalogEntry(provider)}
	{@const already = connectedProviders.has(provider)}
	<button
		type="button"
		class="provider-card"
		class:connected={already}
		data-testid={`connections-add-${provider}`}
		aria-label={`${$t('connections.actions.connect')} ${entry.displayName}`}
		onclick={() => onStartConnect(provider)}
	>
		<span class="provider-mark">
			<BrandIcon {provider} size={14} ariaHidden />
		</span>
		<span class="provider-text">
			<span class="provider-name">
				{entry.displayName}
				{#if already}
					<span
						class="provider-check"
						role="img"
						aria-label={$t('connections.addConnection.alreadyConnected')}
					>
						<Check size={12} strokeWidth={2.6} aria-hidden="true" />
					</span>
				{/if}
			</span>
			<span class="provider-blurb">{blurbFor(provider)}</span>
		</span>
	</button>
{/snippet}

<section class="settings-card add-card" data-testid="connections-add">
	<p class="add-title">{$t('connections.addConnection.title')}</p>
	<div class="provider-grid" data-testid="connections-add-products">
		{#each groups.product as provider (provider)}
			{@render providerCard(provider)}
		{/each}
	</div>
	{#if groups.custom.length > 0}
		<div class="group-rule" data-testid="connections-add-divider">
			<span class="group-label">{$t('connections.addConnection.setUpYourself')}</span>
			<span class="group-line"></span>
		</div>
		<div class="provider-grid" data-testid="connections-add-custom">
			{#each groups.custom as provider (provider)}
				{@render providerCard(provider)}
			{/each}
		</div>
	{/if}
</section>

<style>
	.add-card {
		padding: 1.125rem;
	}

	.add-title {
		margin: 0 0 0.75rem 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.provider-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.625rem;
	}

	.provider-card {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.6875rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		text-align: left;
		cursor: pointer;
		min-width: 0;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.provider-card:hover {
		border-color: var(--accent);
		box-shadow: var(--shadow-sm);
	}

	.provider-card:active {
		transform: translateY(1px);
	}

	.provider-card:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.provider-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		color: var(--text-secondary);
	}

	.provider-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.provider-name {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.provider-check {
		display: inline-flex;
		color: var(--success);
	}

	.provider-blurb {
		font-size: 0.6875rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	.group-rule {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin: 0.875rem 0 0.625rem;
	}

	.group-label {
		flex: 0 0 auto;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.group-line {
		flex: 1 1 auto;
		height: 1px;
		background: var(--border-default);
	}

	@media (max-width: 56rem) {
		.provider-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 34rem) {
		.provider-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
