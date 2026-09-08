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
}: {
	isAdmin?: boolean;
	pollMs?: number;
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

{#if visible}
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
