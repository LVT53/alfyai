<script lang="ts">
import { Pencil } from "@lucide/svelte";
import ScopeToken from "$lib/components/instructions/ScopeToken.svelte";
import { t } from "$lib/i18n";
import type { InstructionSuggestion } from "$lib/shared/instructions";

/**
 * One instruction the model offered, under the reply that prompted it.
 *
 * The row is the whole of the offer: the text the model wrote, in its own
 * words, quoted, and which scope it would go into. Review is not an accept
 * button — it opens the same dialog `/instruction` opens, so the offer is
 * read in full before anything is written. That is why this component's only
 * jobs are to draw the row and to say which of the two answers the user
 * gave; what each answer means belongs to the page that owns the dialog.
 */
let {
	suggestion,
	onReview,
	onDismiss,
	dismissing = false,
	error = null,
}: {
	suggestion: InstructionSuggestion;
	onReview: (suggestion: InstructionSuggestion) => void;
	onDismiss: (suggestion: InstructionSuggestion) => void;
	/** True while the dismiss request is in flight. */
	dismissing?: boolean;
	/** A failed answer, already localized by the surface that owns the call. */
	error?: string | null;
} = $props();

// The scope's full name, for the accessible label only: the token beside it
// says "You" in short, which does not read as a scope inside a sentence.
let scopeName = $derived(
	suggestion.scope.kind === "project"
		? (suggestion.scope.name ?? "")
		: $t("instructions.scopePersonal"),
);
</script>

<div
	class="instruction-suggestion"
	data-testid="instruction-suggestion"
	role="group"
	aria-label={$t('instructions.suggestionA11y', {
		scope: scopeName,
		text: suggestion.text,
	})}
>
	<span class="instruction-suggestion__icon" aria-hidden="true">
		<Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
	</span>
	<span class="instruction-suggestion__body">
		<span class="instruction-suggestion__prefix">
			{$t('instructions.suggestionPrefix')}
		</span>
		<ScopeToken scope={suggestion.scope} />
		<span class="instruction-suggestion__dot" aria-hidden="true">·</span>
		<span class="instruction-suggestion__text">“{suggestion.text}”</span>
	</span>
	<span class="instruction-suggestion__actions">
		<button
			type="button"
			class="instruction-suggestion__review"
			disabled={dismissing}
			onclick={() => onReview(suggestion)}
		>
			{$t('instructions.suggestionReview')}
		</button>
		<button
			type="button"
			class="instruction-suggestion__dismiss"
			disabled={dismissing}
			onclick={() => onDismiss(suggestion)}
		>
			{$t('instructions.suggestionDismiss')}
		</button>
	</span>
</div>

{#if error}
	<p class="instruction-suggestion__error" role="alert">{error}</p>
{/if}

<style>
	.instruction-suggestion {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: var(--space-sm, 0.5rem);
		padding: 9px 12px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		font-size: var(--text-xs);
	}

	.instruction-suggestion__icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--accent);
	}

	.instruction-suggestion__body {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1 1 auto;
		min-width: 12rem;
		flex-wrap: wrap;
		color: var(--text-primary);
		line-height: 1.5;
	}

	.instruction-suggestion__prefix,
	.instruction-suggestion__dot {
		color: var(--text-muted);
	}

	.instruction-suggestion__text {
		overflow-wrap: anywhere;
	}

	.instruction-suggestion__actions {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: 0 0 auto;
	}

	.instruction-suggestion__actions button {
		border: 1px solid transparent;
		border-radius: var(--radius-sm, 6px);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.instruction-suggestion__review {
		padding: 3px 10px;
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.instruction-suggestion__review:hover:not(:disabled),
	.instruction-suggestion__review:focus-visible:not(:disabled) {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
	}

	.instruction-suggestion__dismiss {
		padding: 3px 6px;
		background: transparent;
		color: var(--text-muted);
	}

	.instruction-suggestion__dismiss:hover:not(:disabled),
	.instruction-suggestion__dismiss:focus-visible:not(:disabled) {
		color: var(--text-primary);
		text-decoration: underline;
	}

	.instruction-suggestion__actions button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.instruction-suggestion__actions button:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.instruction-suggestion__error {
		margin: var(--space-xs, 0.25rem) 0 0;
		font-size: var(--text-xs);
		color: var(--danger);
	}
</style>
