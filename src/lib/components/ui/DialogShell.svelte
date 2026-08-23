<script module lang="ts">
// Mount-order stack of currently-open DialogShell instances. The topmost
// dialog is whichever registered last. Nested dialogs (e.g. a ConfirmDialog
// rendered as a DOM *sibling* of its parent modal) each mount their own
// window keydown listener, so a containment/descendant check cannot tell
// which one owns an Escape press. This shared stack lets every instance ask
// "am I the topmost?" so a single Escape closes only the top layer.
const openDialogStack: symbol[] = [];

export function registerDialog(id: symbol): void {
	openDialogStack.push(id);
}

export function deregisterDialog(id: symbol): void {
	const index = openDialogStack.indexOf(id);
	if (index !== -1) {
		openDialogStack.splice(index, 1);
	}
}

export function isTopmostDialog(id: symbol): boolean {
	return (
		openDialogStack.length > 0 &&
		openDialogStack[openDialogStack.length - 1] === id
	);
}
</script>

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

const dialogId = Symbol("dialog-shell");

let dialogRef: HTMLDivElement | null = $state(null);
let previousFocus: HTMLElement | null = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;

let dialogSizeClass = $derived(
	fullScreen
		? "h-full max-w-full rounded-none border-0 sm:max-w-3xl sm:rounded-lg sm:border"
		: `${maxWidthClass} rounded-lg border`,
);

function getFocusableElements(): HTMLElement[] {
	return Array.from(
		dialogRef?.querySelectorAll<HTMLElement>(
			'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
		) ?? [],
	);
}

function trapTabNavigation(e: KeyboardEvent) {
	const focusable = getFocusableElements();
	if (focusable.length === 0) {
		e.preventDefault();
		dialogRef?.focus();
		return;
	}

	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const activeElement = document.activeElement;

	// Focus has escaped the dialog (e.g. it was on the trigger behind the
	// backdrop, or nowhere) — pull it back to the first focusable element.
	if (
		!(activeElement instanceof Node) ||
		!dialogRef?.contains(activeElement)
	) {
		e.preventDefault();
		first.focus();
		return;
	}

	if (e.shiftKey && activeElement === first) {
		e.preventDefault();
		last.focus();
		return;
	}

	if (!e.shiftKey && activeElement === last) {
		e.preventDefault();
		first.focus();
	}
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		// Only the topmost dialog owns Escape. A dialog below the top returns
		// without touching the event so it still reaches the topmost instance's
		// listener (which may have been registered *after* this one). The
		// topmost instance stops immediate propagation so a sibling/parent
		// dialog's listener — and any other window keydown handler — does not
		// also react to the same press.
		if (!isTopmostDialog(dialogId)) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		onClose?.();
		return;
	}

	if (e.key === "Tab") {
		// Only the topmost dialog runs the focus trap. Without this gate a parent
		// DialogShell and a nested one (e.g. a sibling ConfirmDialog) would both
		// trap Tab and fight over focus, breaking navigation inside the nested
		// dialog. Mirrors the Escape gate above.
		if (!isTopmostDialog(dialogId)) return;
		trapTabNavigation(e);
	}
}

onMount(() => {
	previousFocus = document.activeElement as HTMLElement;
	document.body.style.overflow = "hidden";
	registerDialog(dialogId);
	// Move focus into the dialog on open so keyboard/Escape/Tab act on it
	// immediately instead of the trigger behind the backdrop. Deferred a tick
	// so the dialog content (and any focusable child) is mounted first. Skip if
	// a descendant already moved focus inside the dialog (e.g. ConfirmDialog's
	// $effect focuses its confirm button) so we don't override its target.
	focusTimer = setTimeout(() => {
		if (dialogRef && !dialogRef.contains(document.activeElement)) {
			(getFocusableElements()[0] ?? dialogRef).focus();
		}
	}, 0);
});

onDestroy(() => {
	if (focusTimer !== null) clearTimeout(focusTimer);
	deregisterDialog(dialogId);
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
