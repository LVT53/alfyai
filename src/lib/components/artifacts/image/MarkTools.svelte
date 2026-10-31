<script lang="ts">
// The Mark button and, once a box is drawn on a phone, the way back to the chat:
// there the panel covers the composer, so the marks chip lands out of sight and
// a drawn box looked like nothing happened. One control for an Image and an
// uploaded photo.
import SquareDashed from "@lucide/svelte/icons/square-dashed";
import { t } from "$lib/i18n";

let {
	marking,
	disabled = false,
	canContinue = false,
	onToggle,
	onContinue,
}: {
	marking: boolean;
	disabled?: boolean;
	/** Boxes are drawn and the composer is out of sight. */
	canContinue?: boolean;
	onToggle: () => void;
	onContinue?: (() => void) | undefined;
} = $props();
</script>

{#if canContinue && onContinue}
	<button type="button" class="mark-continue" data-testid="mark-continue" onclick={onContinue}>
		{$t('artifacts.image.panel.markContinue')}
	</button>
{/if}
<button
	type="button"
	class="image-body-mark"
	aria-pressed={marking}
	aria-label={$t('artifacts.image.panel.mark')}
	title={$t('artifacts.image.panel.mark')}
	{disabled}
	data-testid="image-body-mark"
	onclick={onToggle}
>
	<SquareDashed size={16} strokeWidth={2} aria-hidden="true" />
	<span class="image-body-mark-label">{$t('artifacts.image.panel.mark')}</span>
</button>

<style>
	.mark-continue {
		min-height: 44px;
		padding: 0 0.875rem;
		border: 0;
		border-radius: var(--radius-md);
		background: var(--accent);
		color: var(--accent-contrast);
		font-family: var(--font-sans);
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.mark-continue:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.image-body-mark {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		min-height: 2.25rem;
		padding: 0 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
	}

	.image-body-mark[aria-pressed='true'] {
		border-color: var(--text-primary);
		background: var(--text-primary);
		color: var(--surface-page);
	}

	.image-body-mark:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.image-body-mark:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* A phone's row holds the strip, Before / After and Mark at 360 px: Mark is
	   its icon there (named for a screen reader), a 44 px target. */
	@media (hover: none) and (pointer: coarse) {
		.image-body-mark {
			min-width: 44px;
			min-height: 44px;
			justify-content: center;
			padding: 0;
		}

		.image-body-mark-label {
			display: none;
		}
	}
</style>
