<script lang="ts">
/**
 * One entry of the guide: its name (with NEW while it is new), one line, and the
 * action at the right, Try it, Show me or nothing.
 *
 * A row lights its part of the section's drawing (`onLight`) while a mouse is
 * over it, while the keyboard is on its button, and after a tap. The row is not
 * a control: a row with no action has nothing to focus, and what it says is
 * said in its words, since the drawing is decoration.
 */
import { t } from "$lib/i18n";
import { showGuidePlace, tryGuideExample } from "./guide-actions";
import {
	type GuideEntry,
	guideEntryKey,
	isGuideEntryNew,
} from "./guide-content";

let {
	entry,
	now,
	onLight,
}: {
	entry: GuideEntry;
	now: Date;
	/** Called with the drawing spot to ring, or `null` to put the ring out. */
	onLight: (spot: string | null) => void;
} = $props();

const name = $derived($t(guideEntryKey(entry.id, "name")));
const line = $derived($t(guideEntryKey(entry.id, "line")));
const isNew = $derived(isGuideEntryNew(entry.added, now));

// Who is holding the light on. Either alone keeps it: a pointer that leaves
// while the keyboard is on the button, or a focus that moves away while the
// pointer is over the row, must not put it out.
let hovered = false;
let focused = false;

function sync() {
	onLight(hovered || focused ? entry.drawingSpot : null);
}

// A finger has no hover. Its pointer events come with a tap (enter, leave, and
// then the click that lights the row) and with the start of a scroll, where a
// ring that flashed on and off would be noise; so only a mouse or a pen lights
// a row by being over it.
function handlePointerEnter(event: PointerEvent) {
	if (event.pointerType === "touch") return;
	hovered = true;
	sync();
}

function handlePointerLeave(event: PointerEvent) {
	if (event.pointerType === "touch") return;
	hovered = false;
	sync();
}

function handleFocusIn() {
	focused = true;
	sync();
}

function handleFocusOut() {
	focused = false;
	sync();
}

// A tap, which ends with a click on the row. The section puts this light out
// when a click lands outside its rows.
function handleClick() {
	onLight(entry.drawingSpot);
}
</script>

<li class="guide-row-item">
	<!-- The row's pointer and focus handlers only light a picture. The row is no
	     control (its button, if it has one, is what the keyboard and a screen
	     reader meet), so it takes the presentation role rather than a widget role. -->
	<div
		class="guide-row"
		role="presentation"
		data-testid="guide-row"
		data-entry-id={entry.id}
		onpointerenter={handlePointerEnter}
		onpointerleave={handlePointerLeave}
		onfocusin={handleFocusIn}
		onfocusout={handleFocusOut}
		onclick={handleClick}
	>
		<div class="guide-row__text">
			<p class="guide-row__name">
				<span>{name}</span>
				{#if isNew}
					<span class="guide-row__new">{$t('guide.new')}</span>
				{/if}
			</p>
			<p class="guide-row__line">{line}</p>
		</div>
		{#if entry.action.kind === 'tryIt'}
			<button
				type="button"
				class="guide-row__action guide-row__action--try"
				aria-label={$t('guide.tryItA11y', { name })}
				onclick={() => void tryGuideExample($t(guideEntryKey(entry.id, 'example')))}
			>
				{$t('guide.tryIt')}
			</button>
		{:else if entry.action.kind === 'showMe'}
			{@const place = entry.action}
			<button
				type="button"
				class="guide-row__action guide-row__action--show"
				aria-label={$t('guide.showMeA11y', { name })}
				onclick={() => void showGuidePlace(place)}
			>
				{$t('guide.showMe')}
			</button>
		{/if}
	</div>
</li>

<style>
	.guide-row-item {
		border-top: 1px solid var(--border-default);
	}

	.guide-row-item:first-child {
		border-top: 0;
	}

	/* The band says how much of the scroller's top its pinned drawing hides
	   (`--guide-pinned`, none when it is not pinned): a row or a button scrolled
	   into view stops below it. */
	.guide-row,
	.guide-row__action {
		scroll-margin-top: var(--guide-pinned, 0px);
	}

	.guide-row {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 0.5rem 0.375rem;
		border-radius: var(--radius-lg);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.guide-row:hover,
	.guide-row:focus-within {
		background: var(--surface-elevated);
	}

	/* The words wrap. Some Hungarian names run to two lines at 360 px, and a
	   long word breaks rather than push the row past the screen. */
	.guide-row__text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.guide-row__name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.375rem;
		margin: 0;
		font-size: var(--text-md);
		font-weight: 600;
		line-height: 1.3;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.guide-row__line {
		margin: 0.125rem 0 0;
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.guide-row__new {
		flex: none;
		padding: 0.125rem 0.3125rem;
		border-radius: var(--radius-sm);
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: 0.625rem;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.04em;
	}

	/* One word on a button: it stays on one line. */
	.guide-row__action {
		position: relative;
		flex: none;
		min-height: 2rem;
		padding: 0 0.75rem;
		border: 0;
		border-radius: var(--radius-full);
		font: inherit;
		font-size: var(--text-xs);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.guide-row__action:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.guide-row__action--try {
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.guide-row__action--try:hover {
		background: var(--accent-tint-strong);
	}

	.guide-row__action--show {
		background: transparent;
		color: var(--text-muted);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.guide-row__action--show:hover {
		color: var(--text-primary);
	}

	/* A finger needs 44 px; the button stays as small as it looks, and the row's
	   own padding (8 px) holds the rest of the target, so rows do not grow. */
	@media (hover: none) and (pointer: coarse) {
		.guide-row__action::after {
			content: "";
			position: absolute;
			inset: -0.375rem -0.25rem;
		}
	}

	/* A tap on the row's words lights its spot through the click that follows it.
	   Safari on iOS sends that click only for an element it counts as clickable,
	   and a handler Svelte delegates to the page does not make one; a cursor
	   does. A finger sees no cursor, and a mouse keeps its arrow. */
	@media (hover: none), (pointer: coarse) {
		.guide-row {
			cursor: pointer;
			-webkit-tap-highlight-color: transparent;
		}
	}
</style>
