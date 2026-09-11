<script module lang="ts">
import { fade, fly, scale } from "svelte/transition";
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
// The phone presentation (see `phonePresentation`) slides the panel up from
// the bottom edge and back down again rather than scaling it in the middle
// of the screen. Same wrapper, so a sheet is as instant under
// prefers-reduced-motion as the centred dialog is — a sheet that flies 400px
// is exactly the kind of motion that setting is asking us not to make.
export const panelSlide = reducedMotionAware(fly);

/**
 * The parameters either panel transition understands — `start` belongs to
 * scale, `y` to fly, and both are optional, so one object type can be handed
 * to whichever function the current presentation selected without the call
 * site having to know which one that is.
 */
export type PanelTransitionParams = {
	duration?: number;
	delay?: number;
	opacity?: number;
	start?: number;
	y?: number;
};

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
import {
	type DialogPresentation,
	isPhoneViewport,
	resolveDialogPresentation,
	watchPhoneViewport,
} from "$lib/utils/viewport";

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
	// Phone presentation (everyday redesign — the MobileSheets board). Below
	// 640px a dialog can stop being a centred panel and become a bottom
	// sheet: it starts at the thumb, it keeps the page visible behind it, and
	// it is dismissible three ways — the grabber, a tap on the dimmed page,
	// or the footer's negative button.
	//
	//   "centered"  — unchanged; a centred panel at every width. The default,
	//                 so no existing dialog changes shape until its owner
	//                 opts in.
	//   "sheet"     — a bottom sheet on phones, centred panel above 640px.
	//   "fullSheet" — a sheet that fills the screen under a 30px lip, for
	//                 pickers whose list has its own scroll. Still a sheet:
	//                 same grabber, same three dismissals.
	//
	// Above the breakpoint every value resolves back to "centered", so a
	// caller never has to ask what width it is on.
	phonePresentation = "centered",
	// Optional footer, rendered below a hairline at the foot of the panel.
	// The redesign's one rule for a dialog's buttons is negative LEFT,
	// positive RIGHT — so the shell lays the footer out (the consumer writes
	// its buttons in that order) and, on a phone, every direct button child
	// grows to an equal-width, full-height 44px target.
	footer,
}: {
	title: string;
	description?: string;
	onClose?: () => void;
	children: Snippet;
	maxWidthClass?: string;
	zIndexClass?: string;
	fullScreen?: boolean;
	titleVisuallyHidden?: boolean;
	phonePresentation?: DialogPresentation;
	footer?: Snippet;
} = $props();

const dialogId = Symbol("dialog-shell");

let dialogRef: HTMLDivElement | null = $state(null);
let previousFocus: HTMLElement | null = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;
let stopWatchingViewport: (() => void) | null = null;

// Re-evaluated whenever the viewport crosses the breakpoint (a rotation, or a
// desktop window dragged narrow) so the presentation — and the transition
// that goes with it — follows the viewport instead of being decided once at
// mount and then being wrong.
let isPhone = $state(isPhoneViewport());
let presentation = $derived(
	resolveDialogPresentation(phonePresentation, isPhone),
);
let isSheet = $derived(presentation !== "centered");

// A centred panel scales into the middle of the screen; a sheet slides up
// from the bottom edge and back down on the way out (250ms, the standard
// ease — the board's number). Both go through reducedMotionAware, so both
// collapse to an instant appearance under prefers-reduced-motion. Selected as
// a value rather than with two `{#if}` branches so the panel element — and
// the focus trap bound to it — is the same node in both presentations.
let panelTransition = $derived(isSheet ? panelSlide : panelScale);
let panelTransitionParams: PanelTransitionParams = $derived(
	isSheet
		? { duration: 250, y: 360, opacity: 1 }
		: { duration: 150, start: 0.95 },
);

let dialogSizeClass = $derived(
	isSheet
		? `dialog-sheet ${presentation === "fullSheet" ? "dialog-sheet--full" : ""} max-w-full border`
		: fullScreen
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
	stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
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
	stopWatchingViewport?.();
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
  class={`fixed inset-0 ${zIndexClass} flex justify-center ${isSheet ? 'items-end p-0' : 'items-center'} ${isSheet ? '' : fullScreen ? 'p-0 sm:p-lg' : 'p-md'}`}
  data-presentation={presentation}
  transition:backdropFade={{ duration: 150 }}
  style={isSheet
    ? 'padding: 0;'
    : `padding-top: max(1rem, env(safe-area-inset-top)); padding-bottom: max(1rem, env(safe-area-inset-bottom)); padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right));`}
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
    class={`relative w-full ${dialogSizeClass} border-border bg-surface-page shadow-lg ${isSheet ? '' : 'p-lg'}`}
    transition:panelTransition={panelTransitionParams}
    style={isSheet ? '' : fullScreen ? 'max-height: 100dvh; overflow-y: auto;' : 'max-height: 85dvh; overflow-y: auto;'}
  >
    {#if isSheet}
      <!-- Dismissal #1 of three. Drawn as the 36x4 bar the board specifies,
           inside a 44px strip so the thing you actually aim at is a real
           touch target rather than a 4px line. -->
      <button
        type="button"
        class="dialog-sheet__grabber"
        data-testid="dialog-sheet-grabber"
        aria-label={$t('common.close')}
        onclick={() => onClose?.()}
      ><span class="dialog-sheet__grabber-bar"></span></button>
    {/if}
    <div class={isSheet ? 'dialog-sheet__body' : ''}>
      <h2
        id="dialog-shell-title"
        class={titleVisuallyHidden ? 'sr-only' : 'mb-sm text-xl font-semibold text-text-primary'}
      >{title}</h2>
      {#if description}
        <p id="dialog-shell-description" class="mb-lg text-text-muted">{description}</p>
      {/if}
      {@render children()}
    </div>
    {#if footer}
      <div class="dialog-shell__footer" data-testid="dialog-shell-footer">
        {@render footer()}
      </div>
    {/if}
  </div>
</div>

<style>
  /* ── The phone sheet ──────────────────────────────────────────────
     Radius on the top corners only (Consistency board: "bottom sheet —
     radius 16px top corners only"), flush to the bottom edge, and the page
     stays visible behind it so you can still read what you are approving. */
  .dialog-sheet {
    border-bottom: 0;
    border-radius: 16px 16px 0 0;
    max-height: 88dvh;
    display: flex;
    flex-direction: column;
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* The picker variant: everything below a 30px lip, so the sheet still
     reads as a sheet (and is still dismissible by tapping the page above
     it) rather than as an opaque second app. */
  .dialog-sheet--full {
    height: calc(100dvh - 30px);
    max-height: calc(100dvh - 30px);
  }

  .dialog-sheet__grabber {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 100%;
    height: 44px;
    border: 0;
    border-radius: 16px 16px 0 0;
    background: transparent;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .dialog-sheet__grabber-bar {
    width: 36px;
    height: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 42%, transparent 58%);
    transition: background-color var(--duration-standard) var(--ease-out);
  }

  .dialog-sheet__grabber:hover .dialog-sheet__grabber-bar,
  .dialog-sheet__grabber:focus-visible .dialog-sheet__grabber-bar {
    background: color-mix(in srgb, var(--text-muted) 78%, transparent 22%);
  }

  .dialog-sheet__grabber:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }

  .dialog-sheet__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 var(--space-lg, 1rem) var(--space-lg, 1rem);
  }

  /* ── The footer ───────────────────────────────────────────────────
     One rule, everywhere: negative left, positive right, above a hairline.
     The consumer writes its buttons in that order; this lays them out. */
  .dialog-shell__footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: var(--space-md, 0.75rem);
    padding-top: var(--space-md, 0.75rem);
    border-top: 1px solid var(--border-subtle);
  }

  .dialog-sheet .dialog-shell__footer {
    margin-top: 0;
    padding: var(--space-md, 0.75rem) var(--space-lg, 1rem);
  }

  /* "Nothing you tap here is smaller than 44px" — on a sheet the two
     buttons are equal-width and full-height, which is what stops the
     accidental confirm the stacked inline pair invites. */
  .dialog-sheet .dialog-shell__footer :global(> button) {
    flex: 1 1 0;
    min-height: 44px;
    justify-content: center;
  }
</style>
