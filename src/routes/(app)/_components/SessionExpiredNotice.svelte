<script lang="ts">
/**
 * The row the app shell puts above everything else once the server has told
 * this tab its login session is gone.
 *
 * Deliberately a row and not a floating card like the two server notices next
 * to it: an expired session is not a passing condition the user can wait out,
 * it is the reason nothing on the page works any more, so it takes space at the
 * top of the shell and stays there until they sign in again.
 */
import { LogIn, ShieldAlert } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	visible,
	onSignIn,
}: {
	visible: boolean;
	onSignIn: () => void;
} = $props();
</script>

{#if visible}
	<div
		role="status"
		aria-live="polite"
		aria-labelledby="session-expired-title"
		aria-describedby="session-expired-description"
		class="session-expired flex w-full shrink-0 items-center gap-sm px-md py-sm sm:gap-md"
		data-testid="session-expired-notice"
	>
		<span class="session-expired__mark" aria-hidden="true">
			<ShieldAlert size={16} strokeWidth={2} />
		</span>

		<div class="flex min-w-0 flex-1 flex-col gap-0 sm:flex-row sm:items-baseline sm:gap-sm">
			<span id="session-expired-title" class="session-expired__title">
				{$t('sessionExpired.title')}
			</span>
			<span id="session-expired-description" class="session-expired__description">
				{$t('sessionExpired.description')}
			</span>
		</div>

		<button
			type="button"
			class="session-expired__action"
			onclick={onSignIn}
			data-testid="session-expired-sign-in"
		>
			<LogIn size={14} strokeWidth={2} aria-hidden="true" />
			<span>{$t('sessionExpired.action')}</span>
		</button>
	</div>
{/if}

<style>
	/* The warning tint, mixed over the page surface so the row reads as part of
	   the shell in both themes rather than a coloured strip pasted on top. */
	.session-expired {
		border-bottom: 1px solid color-mix(in srgb, var(--warning) 34%, transparent);
		background: color-mix(in srgb, var(--warning) 10%, var(--surface-page) 90%);
	}

	.session-expired__mark {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-md);
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 14%, var(--surface-elevated) 86%);
	}

	.session-expired__title {
		flex-shrink: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.session-expired__description {
		min-width: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-expired__action {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.375rem;
		min-height: 2rem;
		padding: 0 0.75rem;
		border: 1px solid color-mix(in srgb, var(--warning) 46%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--warning) 14%, transparent);
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) ease,
			border-color var(--duration-standard) ease;
	}

	.session-expired__action:hover {
		background: color-mix(in srgb, var(--warning) 22%, transparent);
		border-color: color-mix(in srgb, var(--warning) 62%, transparent);
	}

	.session-expired__action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* On a phone the sentence would push the button off the row, so the row
	   keeps the title and the action and drops the longer explanation. */
	@media (max-width: 639px) {
		.session-expired__description {
			display: none;
		}
	}
</style>
