<script module lang="ts">
/** One width for every picker: the Atlas profiles' old `min(19rem, …)`. */
const SUBMENU_WIDTH = 304;
</script>

<script lang="ts">
// The one shell every picker the composer's "+" menu opens is drawn in:
// Model, Style and the Atlas report profile.
//
// They used to be three designs side by side. Model opened its own
// page-coloured panel with collapsible provider rows, Style a bare list of
// names on the menu's tint with no heading, Atlas a titled stack of bordered
// cards with radio dots — and on a desktop the Style and Atlas flyouts were
// placed without their own height, which pinned them to the top edge of the
// window instead of beside the row that opened them. Now all three are this
// shell (the menu's own surface, a title and a muted line under it, the list,
// and an optional footer) holding ComposerSubmenuOption rows:
//
//   * on a desktop, a flyout beside the surface it was opened from — the
//     menu panel — measured with its own height, so its top lines up with the
//     row's top and it is clamped inside the window rather than to its edge;
//   * on a phone, a bottom sheet over the menu's sheet, with the grabber and
//     the 16px top corners every sheet has. The menu draws the one scrim.
//
// Portalled to <body> either way: the "+" menu has a backdrop-filter, which
// makes it the containing block for anything `position: fixed` inside it.
//
// One keyboard for all three, too: focus lands on the chosen option (or the
// first), the arrow keys, Home and End walk the options the way they walk the
// menu's rows, and Escape leaves the picker — and only the picker: the menu
// it was opened from stays, and the opener hands focus back to its row.
import { onMount, type Snippet, tick, untrack } from "svelte";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";
import { nextMenuIndex } from "./composer-bar";
import {
	computeFlyoutPlacement,
	FLYOUT_MARGIN,
	type FlyoutPlacement,
	type PlacementRect,
} from "./composer-placement";

let {
	title,
	subtitle = null,
	listLabel,
	sheet = false,
	rowElement = null,
	surfaceElement = null,
	onDismiss,
	testId,
	panel = $bindable(null),
	headerAction = undefined,
	children,
	footer = undefined,
}: {
	title: string;
	subtitle?: string | null;
	/** The listbox's accessible name. */
	listLabel: string;
	/** A bottom sheet (a phone) rather than a flyout. */
	sheet?: boolean;
	/** The row that opened the picker: the flyout's top lines up with it. */
	rowElement?: HTMLElement | null;
	/** What the flyout hangs beside — the menu panel. Defaults to the row. */
	surfaceElement?: HTMLElement | null;
	/** Escape, or the sheet's grabber. */
	onDismiss: () => void;
	testId: string;
	/** The panel element, for an opener's outside-click test. */
	panel?: HTMLElement | null;
	/** A control at the end of the header (the model guide, on a phone). */
	headerAction?: Snippet | undefined;
	children: Snippet;
	/** The sheet's Cancel / positive pair, for a picker that confirms. */
	footer?: Snippet | undefined;
} = $props();

const id = $props.id();
const titleId = `${id}-title`;
const subtitleId = `${id}-subtitle`;
const panelFly = reducedMotionAware(fly);

let placement = $state<FlyoutPlacement | null>(null);

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

function place() {
	if (sheet || !panel || typeof window === "undefined") {
		placement = null;
		return;
	}
	const row = rectOf(rowElement);
	const surface = rectOf(surfaceElement) ?? row;
	if (!row || !surface) {
		placement = null;
		return;
	}
	const next = computeFlyoutPlacement(
		row,
		surface,
		{ width: window.innerWidth, height: window.innerHeight },
		{
			width:
				panel.offsetWidth ||
				Math.min(SUBMENU_WIDTH, window.innerWidth - FLYOUT_MARGIN * 2),
			height: panel.offsetHeight || undefined,
		},
	);
	const current = untrack(() => placement);
	if (
		current &&
		current.left === next.left &&
		current.top === next.top &&
		current.maxHeight === next.maxHeight
	) {
		return;
	}
	placement = next;
}

// Placed in the flush that renders it, before the first paint, so the
// flyout never shows up somewhere else first.
$effect(() => {
	void sheet;
	void rowElement;
	void surfaceElement;
	if (!panel) return;
	place();
});

// The row it lines up with moves when the window does, and the panel itself
// changes height when its content does (a provider's models expanding).
$effect(() => {
	if (sheet || !panel) return;
	const reflow = () => place();
	window.addEventListener("resize", reflow);
	window.addEventListener("scroll", reflow, true);
	const observer =
		typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reflow);
	observer?.observe(panel);
	return () => {
		window.removeEventListener("resize", reflow);
		window.removeEventListener("scroll", reflow, true);
		observer?.disconnect();
	};
});

let panelStyle = $derived.by(() => {
	if (sheet) return undefined;
	if (!placement) return "visibility: hidden;";
	return `left: ${placement.left}px; top: ${placement.top}px; max-height: ${placement.maxHeight}px;`;
});

function options(): HTMLElement[] {
	if (!panel) return [];
	return Array.from(panel.querySelectorAll<HTMLElement>('[role="option"]'));
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		// Stopped here: the panel is in <body>, so the event would otherwise
		// go straight on to the window listener that closes the whole menu.
		event.preventDefault();
		event.stopPropagation();
		onDismiss();
		return;
	}
	const list = options();
	const next = nextMenuIndex(
		list.map((option) => ({
			disabled: option.hasAttribute("disabled"),
		})),
		list.indexOf(document.activeElement as HTMLElement),
		event.key,
	);
	if (next === null) return;
	event.preventDefault();
	event.stopPropagation();
	list[next]?.focus();
}

// On the panel itself, so a key from anywhere inside it counts — an option,
// the model guide in the header, the sheet's footer buttons. Added here
// rather than as an attribute because the panel is a labelled region, not a
// widget: the listbox inside it is the widget.
$effect(() => {
	const node = panel;
	if (!node) return;
	node.addEventListener("keydown", handleKeydown);
	return () => node.removeEventListener("keydown", handleKeydown);
});

onMount(() => {
	void tick().then(() => {
		const list = options();
		const chosen = list.find(
			(option) => option.getAttribute("aria-selected") === "true",
		);
		(chosen ?? list[0] ?? panel)?.focus();
	});
});
</script>

<section
	bind:this={panel}
	class="composer-submenu"
	class:composer-submenu--sheet={sheet}
	class:composer-submenu--flyout={!sheet}
	style={panelStyle}
	data-testid={testId}
	aria-labelledby={titleId}
	tabindex="-1"
	use:portalToBody
	transition:panelFly={sheet
		? { duration: 250, y: 260, opacity: 1 }
		: { duration: 150, x: -4, y: 0 }}
>
	{#if sheet}
		<button
			type="button"
			class="composer-submenu__grabber"
			data-testid={`${testId}-grabber`}
			aria-label={$t('composerSheet.close')}
			onclick={onDismiss}
		><span class="composer-submenu__grabber-bar"></span></button>
	{/if}

	<header class="composer-submenu__head">
		<span class="composer-submenu__heading">
			<h3 class="composer-submenu__title" id={titleId}>{title}</h3>
			{#if subtitle}
				<p class="composer-submenu__subtitle" id={subtitleId}>{subtitle}</p>
			{/if}
		</span>
		{#if headerAction}
			{@render headerAction()}
		{/if}
	</header>

	<div
		class="composer-submenu__list"
		role="listbox"
		aria-label={listLabel}
		aria-describedby={subtitle ? subtitleId : undefined}
	>
		{@render children()}
	</div>

	{#if footer}
		<div class="composer-submenu__footer">{@render footer()}</div>
	{/if}
</section>

<style>
	/* The menu's own surface, radius and padding (`.tools-menu`), so the
	   flyout reads as more of the menu rather than a panel from elsewhere. */
	.composer-submenu {
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		margin: 0;
		padding: 0.32rem;
		border: 1px solid var(--menu-border);
		border-radius: 0.72rem;
		background: var(--menu-surface);
		box-shadow: var(--menu-shadow);
		backdrop-filter: blur(14px);
		color: var(--text-primary);
	}

	.composer-submenu:focus-visible {
		outline: none;
	}

	.composer-submenu--flyout {
		position: fixed;
		z-index: 140;
		width: min(19rem, calc(100vw - 24px));
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	/* Above the menu's sheet (z 60) and under nothing else: the menu's scrim
	   (z 59) is the one dimmed layer on the screen. */
	.composer-submenu--sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 70;
		max-height: min(80dvh, 40rem);
		padding: 0 0.5rem calc(0.5rem + env(safe-area-inset-bottom));
		border-bottom: 0;
		border-radius: 16px 16px 0 0;
	}

	.composer-submenu__grabber {
		display: grid;
		flex: 0 0 auto;
		place-items: center;
		width: 100%;
		height: 44px;
		border: 0;
		border-radius: 16px 16px 0 0;
		background: transparent;
		cursor: pointer;
	}

	.composer-submenu__grabber-bar {
		width: 36px;
		height: 4px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-muted) 42%, transparent 58%);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.composer-submenu__grabber:hover .composer-submenu__grabber-bar,
	.composer-submenu__grabber:focus-visible .composer-submenu__grabber-bar {
		background: color-mix(in srgb, var(--text-muted) 78%, transparent 22%);
	}

	.composer-submenu__grabber:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.composer-submenu__head {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.42rem 0.5rem 0.36rem;
	}

	.composer-submenu__heading {
		display: flex;
		flex-direction: column;
		gap: 0.14rem;
		min-width: 0;
	}

	.composer-submenu__title {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.25;
	}

	.composer-submenu__subtitle {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		line-height: 1.3;
	}

	.composer-submenu--sheet .composer-submenu__head {
		padding: 0 0.5rem 0.5rem;
	}

	.composer-submenu--sheet .composer-submenu__title {
		font-size: var(--text-base);
		font-weight: 700;
	}

	.composer-submenu--sheet .composer-submenu__subtitle {
		font-size: var(--text-xs);
	}

	.composer-submenu__list {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 0.12rem;
		min-height: 0;
	}

	.composer-submenu--sheet .composer-submenu__list {
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	/* Negative left, positive right, above a hairline: the footer rule every
	   sheet in the system follows (DialogShell). */
	.composer-submenu__footer {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.5rem;
		padding: 0.75rem 0.25rem 0.25rem;
		border-top: 1px solid var(--border-subtle);
	}

	.composer-submenu__footer :global(.dialog-btn) {
		flex: 1 1 0;
		min-height: 44px;
	}

	/* A group of options under a name of its own — the model list's
	   providers. Drawn as the menu's section headings are ("THIS MESSAGE"),
	   with a chevron because a provider folds away. */
	.composer-submenu :global(.composer-submenu__group) {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		margin: 0;
		padding: 0.5rem 0.5rem 0.22rem;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		line-height: 1.2;
		text-align: left;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.composer-submenu :global(.composer-submenu__group:hover),
	.composer-submenu :global(.composer-submenu__group:focus-visible) {
		color: var(--text-primary);
		outline: none;
	}

	.composer-submenu :global(.composer-submenu__group:focus-visible) {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.composer-submenu--sheet :global(.composer-submenu__group) {
		min-height: 44px;
		padding-block: 0.5rem;
	}
</style>
