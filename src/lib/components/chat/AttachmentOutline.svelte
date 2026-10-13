<script lang="ts">
import { ChevronDown, ChevronRight, List } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { DocumentOutlineEntry } from "$lib/server/services/knowledge/types";
import { focusTrap } from "$lib/utils/focus-trap";
import { portalToBody } from "$lib/utils/portal";
import { buildOutlineQuote } from "./composer-chip-presentation";
import {
	computeMenuPlacement,
	MENU_GAP,
	MENU_MARGIN,
} from "./composer-placement";

// "Long-document comfort" (owner-approved mockup, 2026-09-06): renders the
// heading outline extracted from a long attachment. Clicking a row hands
// the caller a ready-to-send quote ("Section 2.3 Break clause: <preview>…")
// instead of inserting text itself, so this component works the same way
// whether it sits in the composer's own pending-attachment list (which can
// splice straight into the textarea) or under an already-sent message in
// the chat history (which has to route the request back to the composer
// through $lib/stores/composer-quote).
const DISPLAY_CAP = 40;

let {
	outline,
	onQuote,
	variant = "panel",
	disclosureLabel = "",
}: {
	outline: DocumentOutlineEntry[];
	onQuote: (quote: string) => void;
	// Chips redesign (owner-approved boards, 2026-09-15): in the composer
	// the outline is no longer a bordered panel stacked under a file card —
	// every chip has exactly one × and everything else is a disclosure
	// BESIDE it. "disclosure" draws a 24px pill button next to the chip that
	// opens the same list in a popover; "panel" is the original, still used
	// under an already-sent message in the stream, where there is room.
	variant?: "panel" | "disclosure";
	disclosureLabel?: string;
} = $props();

// A panel starts open (it is the whole surface); a disclosure starts closed
// (it is a button beside a pill). `null` means "the user has not decided
// yet", so the default follows the variant without capturing it once.
let collapsedOverride = $state<boolean | null>(null);
let collapsed = $derived(collapsedOverride ?? variant === "disclosure");
let showAll = $state(false);

// The disclosure's popover is positioned against the VIEWPORT, not the
// chip: on a phone the chip row is a side-scrolling rail whose `overflow`
// clips everything inside it, and an absolutely positioned popover in there
// is simply never seen.
//
// A `position: fixed` box is only the viewport's while no ancestor has a
// transform, and the home page (and a project's) centres its composer with
// `transform: translateY(-50%)`: measured from the button's rect, the popover
// was laid out from THAT layer instead and opened a few hundred pixels from
// its icon. So the popover is painted in <body> (`portalToBody`, the remedy
// the other composer popovers use), where fixed means the window whatever
// the composer sits in, and is placed by the composer's own
// `computeMenuPlacement` from the button's rect and the popover's own size:
// above the button when it fits there, below it when it does not and there is
// more room, always inside the window.
//
// Because it is no longer next to its button in the page's order, Tab could
// not reach it: focus goes in when it opens, Tab and Shift+Tab stay in it,
// and Escape closes it and gives the button its focus back. A tap outside
// closes it too, and it follows its button for as long as it is open.
const uid = $props.id();
const popoverId = `attachment-outline-popover-${uid}`;
/** The most the popover grows before its list scrolls: the CSS caps it at the same number. */
const POPOVER_MAX_HEIGHT = 260;
/** Until it has been measured and placed the popover is not seen anywhere. */
const UNPLACED_STYLE = "visibility:hidden;";

let rootElement = $state<HTMLDivElement | null>(null);
let disclosureButton = $state<HTMLButtonElement | null>(null);
let popoverElement = $state<HTMLDivElement | null>(null);
let popoverStyle = $state(UNPLACED_STYLE);

function placePopover() {
	const button = disclosureButton;
	const popover = popoverElement;
	if (!button || !popover || typeof window === "undefined") return;
	// Its own size decides where it can go: the width is its widest row
	// (between the CSS minimum and maximum), the height is its list up to the
	// cap. Neither is a number this file could write down, and a width that is
	// guessed leaves a short list standing a phone's width away from its icon.
	const width = popover.getBoundingClientRect().width;
	const height = Math.min(
		popover.scrollHeight + popover.offsetHeight - popover.clientHeight,
		POPOVER_MAX_HEIGHT,
	);
	const placement = computeMenuPlacement(
		button.getBoundingClientRect(),
		{ width: window.innerWidth, height: window.innerHeight },
		width,
		// The room it needs above the button to hang there whole.
		height + MENU_GAP + MENU_MARGIN,
	);
	const edge =
		placement.top !== null
			? `top:${placement.top}px;`
			: `bottom:${placement.bottom}px;`;
	popoverStyle = `left:${placement.left}px;${edge}max-height:${Math.min(POPOVER_MAX_HEIGHT, placement.maxHeight)}px;`;
}

function closePopover() {
	collapsedOverride = true;
}

const popoverFocusTrap = focusTrap({
	onEscape: (event) => {
		event.preventDefault();
		closePopover();
		disclosureButton?.focus();
	},
	focus: {},
	preventScroll: true,
});

// While it is open, a press outside the button and the popover closes it.
// The popover is not inside `rootElement` any more, so the check names both.
$effect(() => {
	if (variant !== "disclosure" || collapsed) return;
	if (typeof document === "undefined") return;
	const onPointerdown = (event: PointerEvent) => {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (rootElement?.contains(target) || popoverElement?.contains(target)) {
			return;
		}
		closePopover();
	};
	document.addEventListener("pointerdown", onPointerdown, true);
	return () => document.removeEventListener("pointerdown", onPointerdown, true);
});

/** What the placement was made for: where the button is, and how big the window is. */
function anchorKey(): string {
	const rect = disclosureButton?.getBoundingClientRect();
	return [rect?.left, rect?.top, window.innerWidth, window.innerHeight].join(
		"|",
	);
}

// Placed once its own box exists (`bind:this` lands after the effect above
// first runs), again whenever the list changes size, and again whenever the
// button is not where the placement was made for. The button can move with no
// event at all: the home page's composer glides to its place for 420ms after
// a resize, the chip row reflows when another file finishes its read and its
// pill grows, a banner arrives above the composer. So while the popover is
// open the button is looked at once a frame (one rectangle read; a resize and
// a scroll are covered by the same look). Left hidden again on the way out,
// so the next opening is never seen where the last one stood.
$effect(() => {
	const popover = popoverElement;
	if (variant !== "disclosure" || collapsed || !popover) return;
	let placedFor = "";
	const place = () => {
		placePopover();
		placedFor = anchorKey();
	};
	let frame = 0;
	const follow = () => {
		if (anchorKey() !== placedFor) place();
		frame = requestAnimationFrame(follow);
	};
	place();
	frame = requestAnimationFrame(follow);
	const observer =
		typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
	observer?.observe(popover);
	return () => {
		cancelAnimationFrame(frame);
		observer?.disconnect();
		popoverStyle = UNPLACED_STYLE;
	};
});

// "Outline · 4 sections": the panel's header, the popover's caption and the
// popover's accessible name are one sentence.
let heading = $derived(
	[
		$t("attachmentOutline.outline"),
		$t("attachmentOutline.sectionsLabel", { count: outline.length }),
	].join(" · "),
);
let visibleEntries = $derived(
	showAll ? outline : outline.slice(0, DISPLAY_CAP),
);
let hiddenCount = $derived(Math.max(0, outline.length - DISPLAY_CAP));

// The quote's text is built by the shared presentation helper so the sent
// bubble can recognise it again byte for byte (splitUserMessageQuotes).
function handleQuote(entry: DocumentOutlineEntry) {
	onQuote(buildOutlineQuote(entry));
}

function toggleCollapsed() {
	collapsedOverride = !collapsed;
}

function handleQuoteAndClose(entry: DocumentOutlineEntry) {
	handleQuote(entry);
	// Picking a section from the disclosure produces a chip in the row
	// behind it; leaving the popover open would cover the chip it just made.
	if (variant === "disclosure") collapsedOverride = true;
}

function showRemaining() {
	showAll = true;
}
</script>

{#if outline.length > 0}
	<div
		bind:this={rootElement}
		class="attachment-outline"
		class:attachment-outline--disclosure={variant === 'disclosure'}
	>
		{#if variant === 'disclosure'}
			<button
				bind:this={disclosureButton}
				type="button"
				class="attachment-outline-disclosure"
				data-testid="attachment-outline-disclosure"
				aria-haspopup="dialog"
				aria-expanded={!collapsed}
				aria-controls={collapsed ? undefined : popoverId}
				aria-label={disclosureLabel || $t('attachmentOutline.outline')}
				title={disclosureLabel || $t('attachmentOutline.outline')}
				onclick={toggleCollapsed}
			>
				<List size={13} strokeWidth={2} aria-hidden="true" />
			</button>
		{:else}
			<button
				type="button"
				class="attachment-outline-header"
				onclick={toggleCollapsed}
				aria-expanded={!collapsed}
			>
				{#if collapsed}
					<ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
				{:else}
					<ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
				{/if}
				<span>{heading}</span>
			</button>
		{/if}
		{#if !collapsed}
			<div
				bind:this={popoverElement}
				id={variant === 'disclosure' ? popoverId : undefined}
				class="attachment-outline-body"
				class:attachment-outline-body--popover={variant === 'disclosure'}
				data-testid={variant === 'disclosure' ? 'attachment-outline-popover' : undefined}
				role={variant === 'disclosure' ? 'dialog' : undefined}
				aria-label={variant === 'disclosure' ? heading : undefined}
				style={variant === 'disclosure' ? popoverStyle : undefined}
				use:portalToBody={variant === 'disclosure'}
				{@attach variant === 'disclosure' ? popoverFocusTrap : undefined}
			>
				{#if variant === 'disclosure'}
					<p class="attachment-outline-caption">{heading}</p>
				{/if}
				<ul class="attachment-outline-list">
					{#each visibleEntries as entry, index (`${entry.offset}-${index}`)}
						<li>
							<button
								type="button"
								class="attachment-outline-row"
								class:indented={entry.level > 1}
								onclick={() => handleQuoteAndClose(entry)}
							>
								<span class="attachment-outline-title">{entry.title}</span>
								<span class="attachment-outline-quote">{$t('attachmentOutline.quote')}</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if hiddenCount > 0 && !showAll}
					<button type="button" class="attachment-outline-more" onclick={showRemaining}>
						{$t('attachmentOutline.more', { count: hiddenCount })}
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style lang="postcss">
	.attachment-outline {
		margin-top: 4px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-page);
		overflow: hidden;
	}

	/* Chips redesign — beside a chip the outline is a 24px pill button that
	   opens the same list in a popover, so the composer's chip row stays one
	   row high whatever is attached to it. */
	.attachment-outline--disclosure {
		position: relative;
		margin-top: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		overflow: visible;
	}

	.attachment-outline-disclosure {
		display: inline-grid;
		place-items: center;
		position: relative;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.attachment-outline-disclosure::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		width: 44px;
		height: 44px;
		transform: translate(-50%, -50%);
	}

	@media (pointer: fine) {
		.attachment-outline-disclosure::after {
			width: 24px;
			height: 24px;
		}
	}

	.attachment-outline-disclosure:hover {
		border-radius: var(--radius-full);
		background-color: var(--surface-elevated);
		color: var(--text-primary);
	}

	.attachment-outline-disclosure:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* `left`, `top` or `bottom`, and `max-height` arrive inline from
	   placePopover(). The box lives in <body> (portalToBody), so it is styled by
	   its own class, not as a descendant of the disclosure's wrapper; it is
	   fixed to the window and stands above the app's own chrome, as the
	   incognito card does. */
	.attachment-outline-body--popover {
		position: fixed;
		z-index: 60;
		width: max-content;
		min-width: 220px;
		max-width: min(320px, calc(100vw - 2 * 16px));
		max-height: 260px;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding-top: 4px;
	}

	.attachment-outline-caption {
		margin: 0;
		padding: 4px 10px 2px;
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.attachment-outline-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}

	.attachment-outline-header:hover {
		color: var(--text-primary);
	}

	.attachment-outline-header:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.attachment-outline-list {
		list-style: none;
		margin: 0;
		padding: 0 4px 4px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.attachment-outline-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 4px 8px;
		border-radius: 5px;
		border: none;
		background: transparent;
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
	}

	.attachment-outline-row.indented {
		padding-left: 20px;
	}

	.attachment-outline-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.attachment-outline-quote {
		flex-shrink: 0;
		color: var(--accent);
		font-size: 0.7rem;
		font-weight: 500;
		opacity: 0;
	}

	.attachment-outline-row:hover,
	.attachment-outline-row:focus-visible {
		background-color: var(--surface-elevated);
		color: var(--text-primary);
	}

	.attachment-outline-row:hover .attachment-outline-quote,
	.attachment-outline-row:focus-visible .attachment-outline-quote {
		opacity: 1;
	}

	.attachment-outline-row:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.attachment-outline-more {
		width: 100%;
		padding: 4px 8px 6px;
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		text-align: left;
		cursor: pointer;
	}

	.attachment-outline-more:hover {
		color: var(--text-primary);
	}
</style>
