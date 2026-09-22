<script module lang="ts">
/** Why the popover is closing; the face only takes focus back for Escape. */
export type IncognitoPopoverCloseReason = "escape" | "dismiss";
</script>

<script lang="ts">
// Incognito redesign (one-way) — the mask face, opened.
//
// While a conversation is incognito the composer's action row grows a fifth
// face: a mask drawn in ink. This is what that face opens: a small card that
// says what incognito means for this chat. It USED to carry the same switch
// the "+" menu had, so the state could be turned off from the place that
// showed it — that switch is gone from both places now. The flag is one-way:
// once a conversation is incognito it stays that way for its whole life, so
// there is nothing left to toggle here. What is left is the same information
// the switch row used to carry, plus a way out that is honest about what
// "out" means: not turning this chat back to normal, but starting a new one.
//
// Desktop: anchored above the face and portalled to <body>, measured against
// the viewport by composer-placement so it never grows off the top of a
// short window. Phone: the same bottom sheet the connections popover and the
// "+" menu use — scrim, grabber, 44px rows.
import { Plus, VenetianMask } from "@lucide/svelte";
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
	onNewChat,
	onClose,
}: {
	/** The mask face this hangs off. Without it the card opens in place. */
	triggerElement?: HTMLElement | undefined;
	/** Runs the same "New chat" navigation the sidebar's button does. */
	onNewChat: () => void;
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
let newChatElement = $state<HTMLButtonElement | undefined>(undefined);
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
	// Opened from the keyboard or the pointer, "New chat" takes focus — the
	// only actionable thing left in a card that is otherwise information —
	// so Escape has somewhere to land.
	void tick().then(() => newChatElement?.focus({ preventScroll: true }));

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

	<!-- One-way: there is no switch here any more, only the way out that is
	     honest about what "out" means — not this chat, a new one. -->
	<div class="incognito-popover__footer">
		<span class="incognito-popover__hint">{$t('chat.incognitoNewChatHint')}</span>
		<button
			type="button"
			class="incognito-popover__new-chat"
			bind:this={newChatElement}
			data-testid="incognito-popover-new-chat"
			onclick={() => onNewChat()}
		>
			<Plus size={14} strokeWidth={2.2} aria-hidden="true" />
			<span>{$t('chat.incognitoNewChat')}</span>
		</button>
	</div>
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

	/* One-way: no switch, so no row that reads as a control. Just the hint
	   and the one actionable thing left in the card, on the same line the
	   switch row used to occupy. */
	.incognito-popover__footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.incognito-popover__hint {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	/* The "dark pill" — ink on the popover's own surface, which is light in
	   light mode and light-on-dark automatically once the theme flips, since
	   both colours are the same pair the rest of the page inverts by. */
	.incognito-popover__new-chat {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.375rem;
		height: 30px;
		border: 0;
		border-radius: 9999px;
		background: var(--text-primary);
		padding: 0 0.75rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--surface-page);
		cursor: pointer;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.incognito-popover__new-chat:hover {
		opacity: 0.85;
	}

	.incognito-popover__new-chat:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.incognito-popover--sheet .incognito-popover__new-chat {
		height: 44px;
		padding: 0 1rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.incognito-popover__grip span,
		.incognito-popover__new-chat {
			transition: none;
		}
	}
</style>
