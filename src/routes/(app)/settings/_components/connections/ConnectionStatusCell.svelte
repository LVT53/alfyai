<script lang="ts">
// Connections redesign — the status column of a connection row: a coloured
// dot, a word, and a sentence saying what happened and when.
//
// The column is a FIXED width on purpose. It used to sit in the row's flex
// flow, so its text shifted sideways depending on how many action buttons the
// row happened to have — a connected row and a broken one put the same word
// in two different places, which is exactly what makes a list hard to scan.
import type { ConnectionStatusGrammar } from "$lib/client/connections/status-grammar";
import { t } from "$lib/i18n";

let {
	grammar,
	compact = false,
}: {
	grammar: ConnectionStatusGrammar;
	// The detail dialog's header shows the word alone; the row shows the word
	// plus its sentence in the fixed column.
	compact?: boolean;
} = $props();
</script>

<div class="status-cell" class:compact data-status-tone={grammar.tone}>
	<span class="status-word">
		<span class="status-dot" aria-hidden="true"></span>
		{$t(grammar.word)}
	</span>
	{#if !compact}
		<p class="status-sentence">{$t(grammar.sentence, grammar.sentenceParams)}</p>
	{/if}
</div>

<style>
	.status-cell {
		/* The fixed width the whole redesign hangs on — see the note above. */
		flex: 0 0 15.5rem;
		width: 15.5rem;
		min-width: 0;
	}

	.status-cell.compact {
		flex: 0 0 auto;
		width: auto;
	}

	.status-word {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.2;
	}

	.status-dot {
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 9999px;
		background: currentColor;
		flex-shrink: 0;
	}

	.status-sentence {
		margin: 0.1875rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	[data-status-tone='ok'] .status-word {
		color: var(--success);
	}

	[data-status-tone='warn'] .status-word {
		color: var(--warning);
	}

	[data-status-tone='danger'] .status-word {
		color: var(--danger);
	}

	[data-status-tone='muted'] .status-word {
		color: var(--text-muted);
	}

	@media (max-width: 40rem) {
		.status-cell {
			flex: 1 1 100%;
			width: auto;
		}
	}
</style>
