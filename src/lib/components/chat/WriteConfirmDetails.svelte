<script lang="ts">
// What goes with the name of a pending write: the text going out, and what it
// costs. The same block on the card, in the phone sheet, and under the row a
// settled write folds into, which adds the small lines the card keeps by the
// name.
import { AlertTriangle } from "@lucide/svelte";
import { t } from "$lib/i18n";
import WriteConfirmFacts from "./WriteConfirmFacts.svelte";
import type { WriteCardView } from "./write-card-view";

let {
	view,
	note = null,
	settled = false,
}: {
	view: WriteCardView;
	note?: string | null;
	/** Under a settled row: the row's own type size, and the consequences are behind us. */
	settled?: boolean;
} = $props();

// Past about six lines of a chat column the text folds, and the whole of it is
// one press away: this is what the person is agreeing to send.
const FOLD_LINES = 6;
const FOLD_CHARACTERS = 360;

const uid = $props.id();
let expanded = $state(false);

const isLong = $derived(
	view.message !== null &&
		(view.message.length > FOLD_CHARACTERS ||
			view.message.split("\n").length > FOLD_LINES),
);
const risks = $derived(settled ? [] : view.risks);
</script>

<div class="write-details" class:write-details--settled={settled}>
	{#if note}
		<p class="write-details__note">{note}</p>
	{/if}

	{#if settled}
		<WriteConfirmFacts facts={view.facts} />
	{/if}

	{#if view.message}
		<div class="write-details__message" data-testid="write-confirm-message">
			<p id="{uid}-message" class:is-folded={isLong && !expanded}>{view.message}</p>
			{#if isLong}
				<button
					type="button"
					class="write-details__toggle"
					aria-expanded={expanded}
					aria-controls="{uid}-message"
					onclick={() => (expanded = !expanded)}
				>
					{expanded
						? $t('connections.writeConfirm.showLess')
						: $t('connections.writeConfirm.showAll')}
				</button>
			{/if}
		</div>
	{/if}

	{#if risks.length > 0}
		<ul class="write-details__risks" role="status" aria-live="polite">
			{#each risks as risk (risk.key)}
				<li class="write-details__risk write-details__risk--{risk.tone}">
					<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
					<span>{risk.text}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.write-details {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		min-width: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.45;
		color: var(--text-primary);
	}

	.write-details--settled {
		gap: 0.5rem;
		font-size: var(--text-xs);
	}

	p,
	ul {
		margin: 0;
	}

	.write-details__note {
		color: var(--text-muted);
	}

	.write-details__message {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		min-width: 0;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.write-details--settled .write-details__message {
		background: var(--surface-page);
	}

	.write-details__message p {
		width: 100%;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.write-details__message p.is-folded {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		overflow: hidden;
	}

	.write-details__toggle {
		border: none;
		border-radius: 4px;
		background: none;
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--accent-text);
		cursor: pointer;
	}

	.write-details__toggle:hover {
		text-decoration: underline;
	}

	.write-details__toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* The text stays in the reading colour on a soft ground, and only the mark
	   carries the tone: this sentence is the one on the card to read twice. */
	.write-details__risks {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0;
		list-style: none;
	}

	.write-details__risk {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
	}

	.write-details__risk :global(svg) {
		flex: 0 0 auto;
		margin-top: 0.1rem;
	}

	.write-details__risk--danger {
		background: color-mix(in srgb, var(--danger) 8%, transparent);
	}

	.write-details__risk--danger :global(svg) {
		color: var(--danger);
	}

	.write-details__risk--caution {
		background: var(--warning-tint);
	}

	.write-details__risk--caution :global(svg) {
		color: var(--warning-text);
	}
</style>
