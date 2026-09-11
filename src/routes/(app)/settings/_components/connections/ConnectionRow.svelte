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
		<span class="connection-title">
			<span class="connection-name">{entry.displayName}</span>
			{#if connection.accountIdentifier}
				<span class="connection-account">{connection.accountIdentifier}</span>
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

	<!-- The chips get their own full-width line rather than sharing the
	     identity cell. The settings column is far narrower than it looks in a
	     wide mockup, and squeezing three chips beside a fixed status column and
	     a fixed action column truncated the account identifier to two
	     characters. -->
	{#if chips.length > 0}
		<div class="connection-chips">
			{#each chips as chip, index (index)}
				<CapabilityChip {chip} provider={connection.provider} />
			{/each}
		</div>
	{/if}
</div>

<style>
	/* identity | status | actions on the first line, chips spanning the second.
	   The status column is a fixed track so its word and sentence sit in the
	   same place on every row, whatever buttons the row happens to carry. */
	.connection-row {
		display: grid;
		/* BOTH right-hand tracks are fixed. A fixed status WIDTH is not enough
		   on its own: with an auto-sized action track, a row carrying a
		   recovery button pushes the status column left and the word lands in a
		   different place than on the row above it. */
		/* Sized against the REAL settings column (a 672px shell, so ~600px of
		   row), not against a wide mockup: 10.5rem of status + 10.75rem of
		   actions + gaps leaves the identity ~15rem, enough for a provider
		   name and a full "levente@gmail.com" beside it. Buying identity width
		   by narrowing the status column is the right trade — the sentence
		   wraps, which is what it is meant to do; the column never moves. */
		grid-template-columns: minmax(0, 1fr) 10.5rem 10.75rem;
		grid-template-areas:
			"identity status actions"
			"chips chips chips";
		align-items: center;
		column-gap: 0.625rem;
		row-gap: 0.5rem;
		padding: 0.875rem 1rem;
	}

	.connection-row:not(:last-child) {
		border-bottom: 1px solid var(--border-default);
	}

	.connection-identity {
		grid-area: identity;
		display: flex;
		align-items: center;
		gap: 0.6875rem;
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
		transition: background var(--duration-standard) var(--ease-out);
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
		grid-area: chips;
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding-left: 2.6875rem;
	}

	.connection-actions {
		grid-area: actions;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.375rem;
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
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			background var(--duration-standard) var(--ease-out);
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

	/* Below this the shell has stopped being 672px wide and starts eating the
	   identity column, so drop to one track: identity, status, chips, actions,
	   each on its own line. Kept in step with ConnectionStatusCell's own
	   breakpoint — the cell must stop being a fixed track at the same width the
	   row stops having tracks. */
	/* With room to spare (the wide settings shell), the chips sit under the
	   name inside the identity column and the status column widens to the
	   mockup's 15.5rem, so a sentence takes two lines rather than three. */
	@container (min-width: 52rem) {
		.connection-row {
			grid-template-columns: minmax(0, 1fr) 15.5rem 12.5rem;
			grid-template-areas:
				"identity status actions"
				"chips status actions";
			row-gap: 0.375rem;
			column-gap: 1rem;
		}
	}

	@media (max-width: 44rem) {
		.connection-row {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				"identity"
				"status"
				"chips"
				"actions";
		}

		.connection-actions {
			justify-content: flex-start;
		}

		.connection-chips {
			padding-left: 0;
		}
	}
</style>
