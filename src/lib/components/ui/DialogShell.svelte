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
}: {
	title: string;
	description?: string;
	onClose?: () => void;
	children: Snippet;
	maxWidthClass?: string;
	zIndexClass?: string;
} = $props();

let dialogRef = $state<HTMLDivElement | undefined>(undefined);
let previousFocus: HTMLElement | null = null;

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
  class={`fixed inset-0 ${zIndexClass} flex items-center justify-center p-md`}
  transition:fade={{ duration: 150 }}
  style={{
    paddingTop: 'max(1rem, env(safe-area-inset-top))',
    paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
    paddingLeft: 'max(1rem, env(safe-area-inset-left))',
    paddingRight: 'max(1rem, env(safe-area-inset-right))'
  }}
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
    class={`relative w-full ${maxWidthClass} rounded-lg border border-border bg-surface-page p-lg shadow-lg`}
    transition:scale={{ duration: 150, start: 0.95 }}
    style={{
      maxHeight: '85dvh',
      overflowY: 'auto'
    }}
  >
    <h2 id="dialog-shell-title" class="mb-sm text-xl font-semibold text-text-primary">{title}</h2>
    {#if description}
      <p id="dialog-shell-description" class="mb-lg text-text-muted">{description}</p>
    {/if}
    {@render children()}
  </div>
</div>
