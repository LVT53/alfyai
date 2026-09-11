<script lang="ts">
// Dismissible notice shown above the chat message area / composer when the
// server reports degraded tool backends. Polls /api/system/capabilities on
// mount and every DEGRADED_CAPABILITIES_POLL_MS; dismissal is session-scoped
// and keyed by the set of degraded tools so a new outage re-shows the banner.

import { onMount } from "svelte";
import { t } from "$lib/i18n";
import {
	type DegradedCapability,
	fetchSystemCapabilities,
} from "$lib/client/api/system";
import {
	DEGRADED_CAPABILITIES_POLL_MS,
	degradedSignature,
	degradedToolLabels,
	dismissDegradedBanner,
	isDegradedBannerDismissed,
} from "$lib/client/degraded-capabilities";

let {
	isAdmin = false,
	pollMs = DEGRADED_CAPABILITIES_POLL_MS,
	// The chat home (HomeV4A "Compact") re-homes this banner as the last and
	// quietest line under Recent: same sentence, same capability names, same
	// link, same Hide button, same dismissal — one muted line with a single
	// amber dot instead of a bordered card. It is last because it is about the
	// system rather than about you.
	variant = "card",
}: {
	isAdmin?: boolean;
	pollMs?: number;
	variant?: "card" | "strip";
} = $props();

let degraded: DegradedCapability[] = $state([]);
let dismissedSignature = $state<string | null>(null);

const signature = $derived(degradedSignature(degraded));
const visible = $derived(
	isAdmin && degraded.length > 0 && dismissedSignature !== signature,
);
const toolLabels = $derived(degradedToolLabels(degraded, (key) => $t(key)));

async function refresh() {
	try {
		const response = await fetchSystemCapabilities();
		degraded = response.degraded;
		dismissedSignature = isDegradedBannerDismissed(response.degraded)
			? degradedSignature(response.degraded)
			: null;
	} catch {
		// Capability status is advisory; a failed poll keeps the last state.
	}
}

function dismiss() {
	dismissDegradedBanner(degraded);
	dismissedSignature = signature;
}

// Tool health is operator information: members never see the banner and
// never poll for it. Only admins are told which capabilities are degraded.
onMount(() => {
	if (!isAdmin) return;
	void refresh();
	if (pollMs <= 0) return;
	const timer = setInterval(() => {
		void refresh();
	}, pollMs);
	return () => clearInterval(timer);
});
</script>

{#if visible && variant === 'strip'}
	<div
		role="status"
		aria-live="polite"
		class="degraded-strip"
		data-testid="degraded-capabilities-banner"
	>
		<span class="degraded-strip-dot" aria-hidden="true"></span>
		<span class="degraded-strip-text">
			{$t('chat.degradedBanner.title', { tools: toolLabels.join(', ') })}.
			{$t('chat.degradedBanner.description')}
		</span>
		<a
			class="degraded-strip-link"
			href="/settings?section=tool-health"
			data-testid="degraded-capabilities-admin-link"
		>
			{$t('chat.degradedBanner.adminLink')}
		</a>
		<button
			type="button"
			class="degraded-strip-hide"
			onclick={dismiss}
			aria-label={$t('chat.degradedBanner.dismiss')}
		>
			{$t('chat.degradedBanner.dismiss')}
		</button>
	</div>
{:else if visible}
	<div
		role="status"
		aria-live="polite"
		class="degraded-banner mx-auto mb-2 flex w-full max-w-[780px] items-start gap-3 rounded-md border border-[var(--warning)]/50 bg-surface-page px-3 py-2 text-sm text-text-primary shadow-sm"
		data-testid="degraded-capabilities-banner"
	>
		<div class="min-w-0 flex-1">
			<p class="font-medium">
				{$t('chat.degradedBanner.title', { tools: toolLabels.join(', ') })}
			</p>
			<p class="text-xs text-text-muted">{$t('chat.degradedBanner.description')}</p>
			{#if isAdmin}
				<a
					class="mt-1 inline-block text-xs text-accent underline-offset-2 hover:underline"
					href="/settings?section=tool-health"
					data-testid="degraded-capabilities-admin-link"
				>
					{$t('chat.degradedBanner.adminLink')}
				</a>
			{/if}
		</div>
		<button
			type="button"
			class="btn-sm shrink-0"
			onclick={dismiss}
			aria-label={$t('chat.degradedBanner.dismiss')}
		>
			{$t('chat.degradedBanner.dismiss')}
		</button>
	</div>
{/if}

<style>
	/* The strip is one line at 0.72rem in muted text with the one amber dot —
	   the only warning colour on the home board. It folds at 390px: the
	   sentence takes the full width and the two actions get a row of their own,
	   with Hide keeping a 44px hit area around a 30px face. */
	.degraded-strip {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 0.72rem;
		color: var(--text-muted);
		line-height: 1.5;
		padding: 2px;
	}

	.degraded-strip-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--warning);
	}

	.degraded-strip-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.degraded-strip-link {
		flex-shrink: 0;
		white-space: nowrap;
		color: var(--accent);
		text-decoration: none;
	}

	.degraded-strip-link:hover,
	.degraded-strip-link:focus-visible {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.degraded-strip-hide {
		flex-shrink: 0;
		white-space: nowrap;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-page);
		color: var(--text-muted);
		font-size: 0.7rem;
		padding: 3px 9px;
		cursor: pointer;
	}

	.degraded-strip-hide:hover {
		color: var(--text-primary);
		border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
	}

	@media (max-width: 767px) {
		.degraded-strip {
			flex-wrap: wrap;
			row-gap: 9px;
			align-items: flex-start;
		}

		.degraded-strip-dot {
			margin-top: 5px;
		}

		.degraded-strip-text {
			flex: 1 1 calc(100% - 15px);
		}

		.degraded-strip-link {
			margin-right: auto;
		}

		.degraded-strip-hide {
			position: relative;
			min-height: 30px;
		}

		.degraded-strip-hide::after {
			content: '';
			position: absolute;
			inset: -7px;
		}
	}
</style>
