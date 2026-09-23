<script lang="ts">
/**
 * The slim, dismissible "memories need review" line under the greeting band
 * and above the composer (owner-approved design, then asked slimmer).
 *
 * This component owns its own optimistic dismissal: clicking the dismiss
 * button hides the row immediately and calls `onDismiss`, which the home page
 * wires to the actual persistence call
 * (`$lib/client/api/home.ts dismissMemoryReviewNotice`) plus updating the
 * shared summary so a page reload does not bring the notice straight back.
 * The count/visibility decision above 0 vs not stays with the caller — this
 * component only decides "0 means nothing to draw".
 */
import { Brain, X } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	count,
	href,
	onDismiss,
}: {
	count: number;
	href: string;
	/**
	 * `restoreFocus` is true when the dismiss button was activated from the
	 * keyboard (a click with `detail === 0`): the focused button is about to
	 * disappear, so the caller should move focus somewhere useful. A pointer
	 * tap leaves focus alone so a phone does not pop its keyboard.
	 */
	onDismiss?: (options: { restoreFocus: boolean }) => void;
} = $props();

let locallyDismissed = $state(false);

function handleDismiss(event: MouseEvent) {
	locallyDismissed = true;
	onDismiss?.({ restoreFocus: event.detail === 0 });
}
</script>

{#if count > 0 && !locallyDismissed}
	<div class="memory-review-notice" role="note" data-testid="home-memory-review-notice">
		<span class="memory-review-notice-icon" aria-hidden="true">
			<Brain size={13} strokeWidth={2} />
		</span>
		<span class="memory-review-notice-text">
			{$t('home.memoryReview.notice', { count })}
			<a class="memory-review-notice-link" {href} data-testid="home-memory-review-link">
				{$t(
					count === 1
						? 'home.memoryReview.reviewLinkOne'
						: 'home.memoryReview.reviewLinkOther',
				)}
			</a>
		</span>
		<button
			type="button"
			class="memory-review-notice-dismiss"
			aria-label={$t('home.memoryReview.dismiss')}
			onclick={handleDismiss}
			data-testid="home-memory-review-dismiss"
		>
			<X size={12} strokeWidth={2.1} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	.memory-review-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
		padding: 4px 6px 4px 12px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
		background: color-mix(in srgb, var(--accent) 6%, transparent);
		box-sizing: border-box;
	}

	.memory-review-notice-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--accent);
	}

	.memory-review-notice-text {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.78125rem; /* 12.5px */
		line-height: 1.3;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.memory-review-notice-link {
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}

	.memory-review-notice-link:hover {
		text-decoration: underline;
	}

	.memory-review-notice-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	.memory-review-notice-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: 9999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.memory-review-notice-dismiss:hover {
		background: color-mix(in srgb, var(--text-primary) 8%, transparent);
	}

	.memory-review-notice-dismiss:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Below the desktop composer width, the line wraps instead of clipping —
	   a phone screen has no adjacent controls this row would crowd. */
	@media (max-width: 767px) {
		.memory-review-notice-text {
			white-space: normal;
			overflow: visible;
			text-overflow: clip;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.memory-review-notice-dismiss {
			transition: none;
		}
	}
</style>
