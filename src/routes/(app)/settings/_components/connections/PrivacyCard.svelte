<script lang="ts">
// Connections redesign — the on-device processing control, moved from the
// bottom of the page to the top.
//
// It is the main privacy decision on this screen, and it was the last card
// below the connect list and the add grid. It now reads as one sentence with
// the fuller explanation in the tooltip, and carries a state badge so its
// answer is legible without parsing the switch.
import { Shield } from "@lucide/svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import { t } from "$lib/i18n";

let {
	localDistill,
	loading = false,
	onToggle,
}: {
	localDistill: boolean;
	loading?: boolean;
	onToggle: (next: boolean) => void | Promise<void>;
} = $props();
</script>

<section class="settings-card privacy-card" data-testid="connections-locality">
	<Toggle
		checked={localDistill}
		disabled={loading}
		ariaLabel={$t('connections.locality.headline')}
		onChange={(next) => onToggle(next)}
	/>
	<div class="privacy-text">
		<p class="privacy-headline">{$t('connections.locality.headline')}</p>
		<p class="privacy-summary">
			{$t('connections.locality.summary')}
			<InfoTooltip text={$t('connections.locality.tooltip')} />
		</p>
	</div>
	<span class="privacy-badge" class:on={localDistill} data-testid="connections-locality-state">
		<Shield size={11} strokeWidth={2.2} aria-hidden="true" />
		{localDistill
			? $t('connections.locality.badgeOn')
			: $t('connections.locality.badgeOff')}
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
