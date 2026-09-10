<script module lang="ts">
import { fade, scale } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";

// Backdrop/panel transitions, wrapped once per module (not per instance) so
// every DialogShell shares the same reduced-motion-aware functions — mirrors
// MessageArea/ThinkingBlock/Toast. Exported so DialogShell.test.ts can assert
// directly that they collapse to an instant, zero-duration transition under
// prefers-reduced-motion instead of only inferring it from rendered markup.
// See motion.ts: Svelte's `css` transitions interpolate styles directly,
// which the app-wide CSS reduced-motion override (app.css) cannot reach.
export const backdropFade = reducedMotionAware(fade);
export const panelScale = reducedMotionAware(scale);

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
	// Opt-in: keep the accessible name (aria-labelledby still points at it)
	// but let the dialog's own content draw the visible heading. Used by the
	// Connections dialogs, whose headers pair the title with a provider mark,
	// an account line and a status word — rendering the shell's own <h2> above
	// that would print the same words twice.
	titleVisuallyHidden = false,
}: {
	title: string;
	description?: string;
	onClose?: () => void;
	children: Snippet;
	maxWidthClass?: string;
	zIndexClass?: string;
	fullScreen?: boolean;
	titleVisuallyHidden?: boolean;
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

// A focusable element counts for the trap only if it is actually rendered.
// The selector matches by attribute alone, so a display:none focusable — e.g.
// ImportChatGPTModal's hidden `<input type="file">` upload proxy — would be
// counted as the "last" element the Tab-wrap keys on, letting focus escape the
// dialog for one press. getClientRects() is the ideal browser signal (empty for
// display:none / detached elements), but jsdom has no layout engine and reports
// an empty list for *every* element, so fall back to a computed-style check
// there: it flags display:none / visibility:hidden (and the [hidden] attribute)
// in both real browsers and jsdom.
function isRendered(el: HTMLElement): boolean {
	if (el.getClientRects().length > 0) return true;
	const style = getComputedStyle(el);
	return style.display !== "none" && style.visibility !== "hidden";
}

function getFocusableElements(): HTMLElement[] {
	return Array.from(
		dialogRef?.querySelectorAll<HTMLElement>(
			'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
		) ?? [],
	).filter(isRendered);
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
	registerDialog(dialogId);
	// Ref-count the body-scroll lock against the open-dialog stack: only the
	// FIRST dialog locks the page. A nested dialog registers while the page is
	// already locked, so re-setting overflow here would be redundant — and,
	// paired with the "last out unlocks" check in onDestroy, this stops a nested
	// dialog's close from clearing the lock while its parent is still open.
	if (openDialogStack.length === 1) {
		document.body.style.overflow = "hidden";
	}
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
	// Release the lock only once the LAST dialog closes. A nested dialog closing
	// while its parent is still open must leave the page locked behind the parent.
	if (openDialogStack.length === 0) {
		document.body.style.overflow = "";
	}
});
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class={`fixed inset-0 ${zIndexClass} flex items-center justify-center ${fullScreen ? 'p-0 sm:p-lg' : 'p-md'}`}
  transition:backdropFade={{ duration: 150 }}
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
    transition:panelScale={{ duration: 150, start: 0.95 }}
    style={fullScreen ? 'max-height: 100dvh; overflow-y: auto;' : 'max-height: 85dvh; overflow-y: auto;'}
  >
    <h2
      id="dialog-shell-title"
      class={titleVisuallyHidden ? 'sr-only' : 'mb-sm text-xl font-semibold text-text-primary'}
    >{title}</h2>
    {#if description}
      <p id="dialog-shell-description" class="mb-lg text-text-muted">{description}</p>
    {/if}
    {@render children()}
  </div>
</div>
