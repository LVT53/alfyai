<script module lang="ts">
/** Why the popover is closing; the face only takes focus back for Escape. */
export type IncognitoPopoverCloseReason = "escape" | "dismiss";
</script>

<script lang="ts">
// Incognito redesign — the mask face, opened.
//
// While a conversation is incognito the composer's action row grows a fifth
// face: a mask drawn in ink. This is what that face opens: a small card that
// says what incognito means for this chat, and carries the same switch the
// "+" menu has, so the state can be turned off from the place that shows it.
// It replaced a full-width accent notice above the composer that repeated
// itself on every turn.
//
// Desktop: anchored above the face and portalled to <body>, measured against
// the viewport by composer-placement so it never grows off the top of a
// short window. Phone: the same bottom sheet the connections popover and the
// "+" menu use — scrim, grabber, 44px rows.
import { VenetianMask } from "@lucide/svelte";
import { onMount, tick } from "svelte";
import { fade, fly } from "svelte/transition";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import {
	computeMenuPlacement,
	type MenuPlacement,
	type PlacementRect,
} from "./composer-placement";

let {
	triggerElement = undefined,
	incognitoOn,
	incognitoBusy = false,
	onToggle,
	onClose,
}: {
	/** The mask face this hangs off. Without it the card opens in place. */
	triggerElement?: HTMLElement | undefined;
	incognitoOn: boolean;
	incognitoBusy?: boolean;
	onToggle: () => void;
	onClose: (reason: IncognitoPopoverCloseReason) => void;
} = $props();

/** The card's width on a desktop — `min(292px, …)` in the CSS below. */
const POPOVER_WIDTH = 292;
/**
 * Room above the face the card needs before it flips below it. The card is
 * a title, three lines and a row — about 170px — so it asks for that plus
 * its gap and margin, not the 320px the "+" menu asks for: on the landing
 * page the face sits ~320px from the top, and with the menu's threshold
 * the card landed on top of the textarea.
 */
const POPOVER_MIN_SPACE_ABOVE = 200;

let root = $state<HTMLDivElement | undefined>(undefined);
let switchElement = $state<HTMLButtonElement | undefined>(undefined);
let isPhone = $state(isPhoneViewport());

// Wrapped so the outro plays under reduced motion as a cut rather than a
// slide — Svelte's css transitions bypass the app-wide reduced-motion reset.
const popoverFly = reducedMotionAware(fly);
const scrimFade = reducedMotionAware(fade);

function rectOf(element: Element | null | undefined): PlacementRect | null {
	if (!element) return null;
	const box = element.getBoundingClientRect();
	return {
		top: box.top,
		left: box.left,
		right: box.right,
		bottom: box.bottom,
		width: box.width,
		height: box.height,
	};
}

function measure(): MenuPlacement | null {
	if (typeof window === "undefined" || isPhoneViewport()) return null;
	const triggerRect = rectOf(triggerElement);
	if (!triggerRect) return null;
	return computeMenuPlacement(
		triggerRect,
		{ width: window.innerWidth, height: window.innerHeight },
		POPOVER_WIDTH,
		POPOVER_MIN_SPACE_ABOVE,
	);
}

// Measured before the card is in the DOM — the face is all it needs — so the
// first frame lands in the right place rather than flying in from a corner.
let placement = $state<MenuPlacement | null>(measure());

let anchored = $derived(!isPhone && Boolean(triggerElement));
let portaled = $derived(isPhone || anchored);

let style = $derived.by(() => {
	if (isPhone || !anchored || !placement) return undefined;
	const edge =
		placement.top !== null
			? `top: ${placement.top}px;`
			: `bottom: ${placement.bottom}px;`;
	return `left: ${placement.left}px; ${edge} max-height: ${placement.maxHeight}px;`;
});

function remeasure() {
	placement = isPhone ? null : measure();
}

$effect(() => {
	isPhone;
	void tick().then(remeasure);
});

onMount(() => {
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});

	// A press on the face itself is left to the face: it toggles the card,
	// and closing here first would only reopen it on the click that follows.
	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		const target = event.target as Node;
		if (triggerElement?.contains(target)) return;
		if (root && !root.contains(target)) onClose("dismiss");
	};
	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			onClose("escape");
		}
	};
	const handleReflow = () => remeasure();

	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	window.addEventListener("keydown", handleKeyDown);
	window.addEventListener("resize", handleReflow);
	window.addEventListener("scroll", handleReflow, true);

	remeasure();
	// Opened from the keyboard or the pointer, the switch takes focus so
	// Space and Escape have somewhere to land.
	void tick().then(() => switchElement?.focus({ preventScroll: true }));

	return () => {
		stopWatchingViewport();
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
		window.removeEventListener("keydown", handleKeyDown);
		window.removeEventListener("resize", handleReflow);
		window.removeEventListener("scroll", handleReflow, true);
	};
});
</script>

{#if isPhone}
	<button
		type="button"
		class="incognito-popover__scrim"
		data-testid="incognito-popover-scrim"
		aria-label={$t('composerSheet.close')}
		use:portalToBody
		transition:scrimFade={{ duration: 140 }}
		onclick={() => onClose('dismiss')}
	></button>
{/if}

<div
	bind:this={root}
	class="incognito-popover"
	class:incognito-popover--sheet={isPhone}
	class:incognito-popover--anchored={anchored}
	{style}
	id="incognito-popover"
	data-testid="incognito-popover"
	role="dialog"
	aria-labelledby="incognito-popover-title"
	use:portalToBody={portaled}
	transition:popoverFly={isPhone
		? { duration: 200, y: 24 }
		: { duration: 140, y: 4 }}
>
	{#if isPhone}
		<button
			type="button"
			class="incognito-popover__grip"
			data-testid="incognito-popover-grabber"
			aria-label={$t('composerSheet.close')}
			onclick={() => onClose('dismiss')}
		><span></span></button>
	{/if}

	<div class="incognito-popover__title" id="incognito-popover-title">
		<VenetianMask size={16} strokeWidth={2.1} aria-hidden="true" />
		<span>{$t('chat.incognitoOn')}</span>
	</div>
	<p class="incognito-popover__body">{$t('chat.incognitoPopoverBody')}</p>

	<div class="incognito-popover__divider" role="presentation"></div>

	<!-- The row is the switch, as it is in the "+" menu: the whole line is
	     the target, and the face beside the label is drawn, not a second
	     control. -->
	<button
		type="button"
		role="switch"
		class="incognito-popover__row"
		bind:this={switchElement}
		aria-checked={incognitoOn}
		aria-label={$t('chat.incognitoToggle')}
		data-testid="incognito-popover-toggle"
		disabled={incognitoBusy}
		onclick={() => onToggle()}
	>
		<span class="incognito-popover__row-label">{$t('composerMenu.incognito')}</span>
		<span class="switch-face" class:switch-face--on={incognitoOn} aria-hidden="true">
			<span class="switch-face__thumb"></span>
		</span>
	</button>
</div>

<style>
	.incognito-popover {
		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		z-index: 40;
		width: min(292px, calc(100vw - 2rem));
		padding: 0.75rem 0.875rem 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: 14px;
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
	}

	/* Measured against the viewport, not offset from the composer — the
	   numbers arrive inline; see composer-placement.ts. */
	.incognito-popover--anchored {
		position: fixed;
		bottom: auto;
		z-index: 60;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.incognito-popover__scrim {
		position: fixed;
		inset: 0;
		z-index: 59;
		border: 0;
		padding: 0;
		background: var(--scrim);
		cursor: default;
	}

	/* Phone: a bottom sheet over the page, portalled to <body> so `fixed`
	   means the viewport even under the landing page's translated composer. */
	.incognito-popover--sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		width: auto;
		z-index: 60;
		max-height: min(72vh, 34rem);
		overflow-y: auto;
		padding: 0 1rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
		border-radius: 1rem 1rem 0 0;
		border-bottom: 0;
	}

	/* 44px drag strip holding the 36×4 bar — the same grabber every other
	   sheet in the system draws. */
	.incognito-popover__grip {
		position: sticky;
		top: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: calc(100% + 2rem);
		height: 44px;
		margin: 0 -1rem 0.25rem;
		border: 0;
		padding: 0;
		background: inherit;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.incognito-popover__grip span {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--border-default);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.incognito-popover__grip:hover span,
	.incognito-popover__grip:focus-visible span {
		background: var(--text-muted);
	}

	.incognito-popover__grip:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.incognito-popover__title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
		color: var(--text-primary);
	}

	.incognito-popover__body {
		margin: 0.375rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.incognito-popover__divider {
		height: 1px;
		margin: 0.625rem 0 0.25rem;
		background: var(--border-subtle);
	}

	/* The switch row, drawn as the "+" menu draws its rows: full width, the
	   fill rounded to the row and eased in. */
	.incognito-popover__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: calc(100% + 0.75rem);
		min-height: 2.2rem;
		margin: 0 -0.375rem;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		padding: 0.34rem 0.375rem;
		text-align: left;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.incognito-popover__row:hover:not(:disabled),
	.incognito-popover__row:focus-visible {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		outline: none;
	}

	.incognito-popover__row:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.incognito-popover__row:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.incognito-popover--sheet .incognito-popover__row {
		min-height: 44px;
	}

	.incognito-popover__row-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 500;
	}

	/* ── The switch face ── the one the "+" menu draws, so the two places
	   that show incognito's switch show the same switch. */
	.switch-face {
		position: relative;
		width: 34px;
		height: 20px;
		flex-shrink: 0;
		border-radius: 9999px;
		background: var(--border-default);
		transition: background var(--duration-standard) var(--ease-out);
	}

	.switch-face--on {
		background: var(--accent);
	}

	.switch-face__thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 9999px;
		background: var(--accent-contrast);
		box-shadow: var(--shadow-sm);
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.switch-face--on .switch-face__thumb {
		transform: translateX(14px);
	}

	.incognito-popover--sheet .switch-face {
		width: 44px;
		height: 24px;
	}

	.incognito-popover--sheet .switch-face__thumb {
		width: 20px;
		height: 20px;
	}

	.incognito-popover--sheet .switch-face--on .switch-face__thumb {
		transform: translateX(20px);
	}

	@media (prefers-reduced-motion: reduce) {
		.incognito-popover__row,
		.incognito-popover__grip span,
		.switch-face,
		.switch-face__thumb {
			transition: none;
		}
	}
</style>
