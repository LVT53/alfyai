<script lang="ts">
import { CircleAlert, CircleCheck, X } from "@lucide/svelte";
import { cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import { dismissToast, toasts } from "$lib/stores/toast";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import { toastExit } from "./toast-motion";

// One mount point for the whole app (see (app)/+layout.svelte). Renders
// every active $toasts entry as a stacked, top-right region so it never
// competes for the same corner as ServerDrainingNotice (top-center) or
// ServerUpdateNotice (bottom-right).
//
// `--app-top-row-height` is how a full-width row pinned to the top of the shell
// (today: SessionExpiredNotice) pushes this region below itself. Without it the
// first toast lands on that row and swallows the clicks meant for the row's own
// button — the shell publishes the row's measured height, and 0 when there is
// no row.
//
// Wave 2.5 review (F2), redesign §7.2 #33 ("rises 12px and fades in... in
// emphasis · ease-emphasis"): `fly`'s `y` is the starting offset for `in:`,
// not a literal direction — a POSITIVE value starts the toast 12px BELOW its
// resting spot and animates it up into place, which is what "rises" means
// here. The previous `y: -12` did the opposite (started above, descended).
// Duration/easing now read from the shared tokens instead of a bare 200.
//
// Exit (polish G1-B, redesign §7.2 #33 "out standard · ease-in"): the toast
// sinks the 12px it rose and fades, over the standard duration — see
// `toast-motion.ts`, whose numbers are tested directly (jsdom never runs an
// outro to its end). Reduced motion: it leaves at once. An outro keeps the
// element in the DOM until it ends, so a dismissed toast is gone a moment
// later, not synchronously.
const flyIn = reducedMotionAware(fly);
</script>

<div
	class="pointer-events-none fixed right-md z-[10100] flex w-full max-w-[360px] flex-col gap-sm"
	style="top: calc(var(--space-md) + var(--app-top-row-height, 0px));"
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
			in:flyIn={{ y: 12, duration: MOTION_DURATION.emphasis, easing: cubicOut }}
			out:toastExit
		>
			{#if toast.type === 'success'}
				<CircleCheck size={18} strokeWidth={2} class="mt-[1px] shrink-0 text-success" aria-hidden="true" />
			{:else}
				<CircleAlert size={18} strokeWidth={2} class="mt-[1px] shrink-0 text-danger" aria-hidden="true" />
			{/if}
			<p class="flex-1 text-sm leading-5 text-text-primary">{toast.message}</p>
			{#if toast.actionLabel && toast.onAction}
				<button
					type="button"
					class="toast-entry-action shrink-0"
					onclick={() => {
						toast.onAction?.();
						dismissToast(toast.id);
					}}
				>
					{toast.actionLabel}
				</button>
			{/if}
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

	.toast-entry-action {
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent-text);
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.toast-entry-action:hover {
		opacity: 0.85;
	}

	.toast-entry-action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: var(--radius-sm, 4px);
	}
</style>
