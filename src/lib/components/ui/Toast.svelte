<script lang="ts">
import { CircleAlert, CircleCheck, X } from "@lucide/svelte";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import { dismissToast, toasts } from "$lib/stores/toast";
import { reducedMotionAware } from "$lib/utils/motion";

// One mount point for the whole app (see (app)/+layout.svelte). Renders
// every active $toasts entry as a stacked, top-right region so it never
// competes for the same corner as ServerDrainingNotice (top-center) or
// ServerUpdateNotice (bottom-right).
const flyIn = reducedMotionAware(fly);
</script>

<div
	class="pointer-events-none fixed right-md top-md z-[10100] flex w-full max-w-[360px] flex-col gap-sm"
	data-testid="toast-region"
>
	{#each $toasts as toast (toast.id)}
		<div
			class="toast-entry pointer-events-auto flex items-start gap-sm rounded-lg border p-md shadow-lg"
			class:toast-entry-success={toast.type === 'success'}
			class:toast-entry-error={toast.type === 'error'}
			role={toast.type === 'error' ? 'alert' : 'status'}
			data-testid="toast-entry"
			data-toast-type={toast.type}
			in:flyIn={{ y: -12, duration: 200 }}
		>
			{#if toast.type === 'success'}
				<CircleCheck size={18} strokeWidth={2} class="mt-[1px] shrink-0 text-success" aria-hidden="true" />
			{:else}
				<CircleAlert size={18} strokeWidth={2} class="mt-[1px] shrink-0 text-danger" aria-hidden="true" />
			{/if}
			<p class="flex-1 text-sm leading-5 text-text-primary">{toast.message}</p>
			<button
				type="button"
				class="btn-icon-bare -m-1.5 shrink-0"
				aria-label={$t('common.close')}
				onclick={() => dismissToast(toast.id)}
			>
				<X size={14} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
	{/each}
</div>

<style>
	.toast-entry {
		background: var(--surface-elevated);
		border-color: var(--border-default);
	}

	.toast-entry-success {
		border-color: color-mix(in srgb, var(--success) 45%, transparent);
	}

	.toast-entry-error {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
	}
</style>
