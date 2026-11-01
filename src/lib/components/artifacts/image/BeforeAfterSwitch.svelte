<script lang="ts">
// Before / After, as the card and the panel both draw it (plan 2b T2, T3): two
// equal halves and one thumb that slides under the chosen half (transform only,
// MOTION-PARITY 3); the words swap colour at once. One control, so the card's
// switch and the panel's never drift apart.
import { t } from "$lib/i18n";

let {
	showing,
	onChange,
	label,
	size = "sm",
	testIdPrefix,
}: {
	showing: "before" | "after";
	onChange: (next: "before" | "after") => void;
	/** The group's accessible name. */
	label: string;
	/** `md` is the panel's: a 44 px target on a touch screen. */
	size?: "sm" | "md";
	/** `image-card` gives `image-card-before` / `image-card-after`. */
	testIdPrefix: string;
} = $props();
</script>

<div class="flip" class:flip-md={size === 'md'} role="group" aria-label={label} data-testid="{testIdPrefix}-flip">
	<span class="flip-thumb" class:is-after={showing === 'after'} aria-hidden="true"></span>
	<button
		type="button"
		aria-pressed={showing === 'before'}
		data-testid="{testIdPrefix}-before"
		onclick={() => onChange('before')}
	>
		{$t('artifacts.image.card.before')}
	</button>
	<button
		type="button"
		aria-pressed={showing === 'after'}
		data-testid="{testIdPrefix}-after"
		onclick={() => onChange('after')}
	>
		{$t('artifacts.image.card.after')}
	</button>
</div>

<style>
	.flip {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 1fr;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
	}

	.flip-thumb {
		position: absolute;
		inset: 0 auto 0 0;
		width: 50%;
		background: var(--text-primary);
		transform: translateX(0);
		transition: transform var(--duration-standard) var(--ease-out);
		pointer-events: none;
	}

	.flip-thumb.is-after {
		transform: translateX(100%);
	}

	.flip button {
		position: relative;
		min-height: 1.75rem;
		padding: 0 0.625rem;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
	}

	.flip-md button {
		min-height: 2.25rem;
		padding: 0 0.875rem;
		font-size: 0.8125rem;
	}

	/* A 44 px target on a touch screen, in the card and in the panel. */
	@media (hover: none) and (pointer: coarse) {
		.flip button {
			min-height: 44px;
		}
	}

	.flip button[aria-pressed='true'] {
		color: var(--surface-page);
	}

	.flip button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring) inset;
	}
</style>
