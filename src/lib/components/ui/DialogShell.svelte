<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { fade, scale } from "svelte/transition";
import type { Snippet } from "svelte";
import { t } from "$lib/i18n";

let {
	title,
	description,
	onClose,
	children,
	maxWidthClass = "max-w-[480px]",
	zIndexClass = "z-50",
	// Opt-in full-screen overlay mode: edge-to-edge on mobile, still a
	// near-viewport-filling sheet (not width-capped) on wider screens, so it
	// reads as "full screen" rather than "a bigger dialog". Overrides
	// maxWidthClass/height when set; everything else (focus trap, Esc,
	// backdrop) is unchanged. Not currently used by any Connections surface —
	// the Connection Detail modal used this in an earlier iteration (ADR 0044
	// Decision 3) but was revised to the standard centered mode (R3-fix #8);
	// kept as a general DialogShell capability for future full-screen needs.
	fullScreen = false,
}: {
	title: string;
	description?: string;
	onClose?: () => void;
	children: Snippet;
	maxWidthClass?: string;
	zIndexClass?: string;
	fullScreen?: boolean;
} = $props();

let dialogRef: HTMLDivElement | null = $state(null);
let previousFocus: HTMLElement | null = null;

let dialogSizeClass = $derived(
	fullScreen
		? "h-full max-w-full rounded-none border-0 sm:max-w-3xl sm:rounded-lg sm:border"
		: `${maxWidthClass} rounded-lg border`,
);

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		onClose?.();
		return;
	}

	if (e.key === "Tab") {
		const focusableElements = dialogRef?.querySelectorAll(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		if (!focusableElements || focusableElements.length === 0) return;

		const firstElement = focusableElements[0] as HTMLElement;
		const lastElement = focusableElements[
			focusableElements.length - 1
		] as HTMLElement;

		if (e.shiftKey) {
			if (document.activeElement === firstElement) {
				lastElement.focus();
				e.preventDefault();
			}
		} else if (document.activeElement === lastElement) {
			firstElement.focus();
			e.preventDefault();
		}
	}
}

onMount(() => {
	previousFocus = document.activeElement as HTMLElement;
	document.body.style.overflow = "hidden";
});

onDestroy(() => {
	if (previousFocus) previousFocus.focus();
	document.body.style.overflow = "";
});
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class={`fixed inset-0 ${zIndexClass} flex items-center justify-center ${fullScreen ? 'p-0 sm:p-lg' : 'p-md'}`}
  transition:fade={{ duration: 150 }}
  style={`padding-top: max(1rem, env(safe-area-inset-top)); padding-bottom: max(1rem, env(safe-area-inset-bottom)); padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right));`}
>
  <button
    type="button"
    class="absolute inset-0 bg-surface-page opacity-80 backdrop-blur-sm"
    aria-label={$t('common.close')}
    onclick={() => onClose?.()}
  ></button>

  <div
    bind:this={dialogRef}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-shell-title"
    aria-describedby={description ? 'dialog-shell-description' : undefined}
    tabindex="-1"
    class={`relative w-full ${dialogSizeClass} border-border bg-surface-page p-lg shadow-lg`}
    transition:scale={{ duration: 150, start: 0.95 }}
    style={fullScreen ? 'max-height: 100dvh; overflow-y: auto;' : 'max-height: 85dvh; overflow-y: auto;'}
  >
    <h2 id="dialog-shell-title" class="mb-sm text-xl font-semibold text-text-primary">{title}</h2>
    {#if description}
      <p id="dialog-shell-description" class="mb-lg text-text-muted">{description}</p>
    {/if}
    {@render children()}
  </div>
</div>
