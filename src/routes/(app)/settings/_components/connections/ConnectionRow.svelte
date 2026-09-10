<script lang="ts">
// Connections redesign — one row of the connections list.
//
// Layout is identity · chips | fixed-width status | actions. The status
// column's width is fixed (see ConnectionStatusCell) so its text never shifts
// with the number of buttons on the right — a row with a recovery action and
// one without must put the same word in the same place.
//
// The whole row is no longer a single giant button: the identity block opens
// the detail dialog, and the actions sit outside it, so a recovery action is
// a real button rather than a click target nested inside another one.
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	capabilityChipsOf,
	connectionStatusGrammar,
	type GrammarFormatters,
} from "$lib/client/connections/status-grammar";
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import { t } from "$lib/i18n";
import CapabilityChip from "./CapabilityChip.svelte";
import ConnectionStatusCell from "./ConnectionStatusCell.svelte";

let {
	connection,
	formatters,
	onOpenDetail,
	onRecover,
}: {
	connection: ConnectionPublic;
	formatters: GrammarFormatters;
	onOpenDetail: (id: string) => void;
	onRecover: (id: string) => void;
} = $props();

const entry = $derived(getProviderCatalogEntry(connection.provider));
const grammar = $derived(connectionStatusGrammar(connection, formatters));
const chips = $derived(capabilityChipsOf(connection));
</script>

<div class="connection-row" data-testid={`connection-row-${connection.id}`}>
	<button
		type="button"
		class="connection-identity"
		aria-label={`${$t('connections.actions.details')} — ${entry.displayName}`}
		onclick={() => onOpenDetail(connection.id)}
	>
		<span class="connection-mark" data-provider={connection.provider}>
			<BrandIcon provider={connection.provider} size={17} ariaHidden />
		</span>
		<span class="connection-text">
			<span class="connection-title">
				<span class="connection-name">{entry.displayName}</span>
				{#if connection.accountIdentifier}
					<span class="connection-account">{connection.accountIdentifier}</span>
				{/if}
			</span>
			{#if chips.length > 0}
				<span class="connection-chips">
					{#each chips as chip, index (index)}
						<CapabilityChip {chip} provider={connection.provider} />
					{/each}
				</span>
			{/if}
		</span>
	</button>

	<ConnectionStatusCell {grammar} />

	<div class="connection-actions">
		{#if grammar.recovery}
			<button
				type="button"
				class="row-action"
				class:danger={grammar.tone === 'danger'}
				class:accent={grammar.tone === 'warn'}
				data-testid={`connection-recover-${connection.id}`}
				onclick={() => onRecover(connection.id)}
			>
				{$t(grammar.recovery.label)}
			</button>
		{/if}
		<button
			type="button"
			class="row-action"
			data-testid={`connection-details-${connection.id}`}
			aria-label={`${$t('connections.actions.details')} — ${entry.displayName}`}
			onclick={() => onOpenDetail(connection.id)}
		>
			{$t('connections.actions.details')}
		</button>
	</div>
</div>

<style>
	.connection-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1rem;
	}

	.connection-row:not(:last-child) {
		border-bottom: 1px solid var(--border-default);
	}

	.connection-identity {
		display: flex;
		align-items: flex-start;
		gap: 0.6875rem;
		flex: 1 1 auto;
		min-width: 0;
		padding: 0.25rem;
		margin: -0.25rem;
		border: none;
		background: transparent;
		border-radius: var(--radius-md);
		text-align: left;
		font: inherit;
		color: inherit;
		cursor: pointer;
		transition: background var(--duration-standard);
	}

	.connection-identity:hover {
		background: color-mix(in srgb, var(--surface-page) 70%, transparent);
	}

	.connection-identity:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.connection-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-secondary);
	}

	.connection-text {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}

	.connection-title {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.connection-name {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.connection-account {
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.connection-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	/* Fixed like the status column so the two together form a stable right
	   edge — the buttons never push the sentence sideways. */
	.connection-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.375rem;
		flex: 0 0 12.5rem;
	}

	.row-action {
		padding: 0.3125rem 0.6875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard),
			color var(--duration-standard),
			background var(--duration-standard);
	}

	.row-action:hover {
		border-color: var(--accent);
		color: var(--text-primary);
	}

	.row-action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.row-action.accent {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	.row-action.accent:hover {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	.row-action.danger {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
	}

	.row-action.danger:hover {
		border-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 8%, transparent);
	}

	@media (max-width: 40rem) {
		.connection-row {
			flex-wrap: wrap;
		}

		.connection-identity {
			flex: 1 1 100%;
		}

		.connection-actions {
			flex: 1 1 100%;
			justify-content: flex-start;
		}
	}
</style>
