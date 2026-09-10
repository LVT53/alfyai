<script lang="ts">
// Connections redesign — the on-device processing control, moved from the
// bottom of the page to the top.
//
// It is the main privacy decision on this screen, and it was the last card
// below the connect list and the add grid. It now reads as one sentence with
// the fuller explanation in the tooltip, and carries a state badge so its
// answer is legible without parsing the switch.
import { RefreshCw, Shield } from "@lucide/svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import { t } from "$lib/i18n";

let {
	localDistill,
	loading = false,
	// Connections redesign — the read failed, so we do NOT know where this
	// user's connected data goes. The switch used to fall back to showing
	// "off", which is a definite answer we did not have; the card now says so
	// and offers the one action that fixes it. Reading it wrong here is a
	// privacy answer read wrong, so it gets its own state rather than a
	// default.
	loadFailed = false,
	onRetry,
	onToggle,
}: {
	localDistill: boolean;
	loading?: boolean;
	loadFailed?: boolean;
	onRetry?: () => void | Promise<void>;
	onToggle: (next: boolean) => void | Promise<void>;
} = $props();
</script>

<section class="settings-card privacy-card" data-testid="connections-locality">
	<Toggle
		checked={localDistill}
		disabled={loading || loadFailed}
		ariaLabel={$t('connections.locality.headline')}
		onChange={(next) => onToggle(next)}
	/>
	<div class="privacy-text">
		<p class="privacy-headline">{$t('connections.locality.headline')}</p>
		<p class="privacy-summary">
			{$t('connections.locality.summary')}
			<InfoTooltip text={$t('connections.locality.tooltip')} />
		</p>
		{#if loadFailed}
			<p class="privacy-unknown" data-testid="connections-locality-failed">
				{$t('connections.locality.unknown')}
				<button type="button" class="privacy-retry" onclick={() => onRetry?.()}>
					<RefreshCw size={12} strokeWidth={2.2} aria-hidden="true" />
					{$t('connections.actions.tryAgain')}
				</button>
			</p>
		{/if}
	</div>
	<span
		class="privacy-badge"
		class:on={localDistill && !loadFailed}
		class:unknown={loadFailed}
		data-testid="connections-locality-state"
	>
		<Shield size={11} strokeWidth={2.2} aria-hidden="true" />
		{#if loadFailed}
			{$t('connections.locality.badgeUnknown')}
		{:else if localDistill}
			{$t('connections.locality.badgeOn')}
		{:else}
			{$t('connections.locality.badgeOff')}
		{/if}
	</span>
</section>

<style>
	.privacy-card {
		display: flex;
		align-items: flex-start;
		gap: 0.875rem;
		padding: 1rem 1.125rem;
	}

	.privacy-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.privacy-headline {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.3;
	}

	.privacy-summary {
		margin: 0.3125rem 0 0 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	/* Keeps the tooltip trigger on the sentence's last line instead of
	   dropping to a line of its own. */
	.privacy-summary :global(.info-tooltip) {
		vertical-align: middle;
	}

	.privacy-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		flex-shrink: 0;
		margin-top: 0.125rem;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		border: 1px solid var(--border-default);
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--text-muted);
		transition:
			color var(--duration-standard),
			border-color var(--duration-standard),
			background var(--duration-standard);
	}

	.privacy-unknown {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.5rem 0 0 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--danger);
	}

	.privacy-retry {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.25rem 0.5625rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		background: transparent;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--danger);
		cursor: pointer;
		transition:
			background var(--duration-standard),
			border-color var(--duration-standard);
	}

	.privacy-retry:hover {
		border-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 8%, transparent);
	}

	.privacy-retry:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.privacy-badge.unknown {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 38%, transparent);
		background: color-mix(in srgb, var(--danger) 8%, transparent);
	}

	.privacy-badge.on {
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 38%, transparent);
		background: color-mix(in srgb, var(--success) 8%, transparent);
	}

	@media (max-width: 34rem) {
		.privacy-badge {
			display: none;
		}
	}
</style>
