<script lang="ts">
/**
 * The first-open tour (Feature 2 · Artifacts, Slice 6): three slides about a
 * kind of thing, in a card at the top of the panel's content area, above the
 * artifact it explains. Rulings 4, 32, 33 and 69; the card is one lazy chunk
 * (`DocumentWorkspace.svelte` loads it with `import()` only when a tour is
 * about to show), so nothing here is imported statically by the chat shell.
 *
 * The panel decides WHETHER to show it and what a finished or skipped tour
 * writes; this owns the steps and reports where the reader left it:
 *
 * - `onSeen(lastSlide)` — once, when the last slide's "Got it" is pressed.
 * - `onDismiss(slide)` — once, on Skip or Escape, with the slide the reader was on.
 * - `replay` — the card as the panel's menu shows it again: nothing is
 *   recorded, so neither callback is called, and every way out is `onClose()`.
 *
 * It is a region, not a dialog: it traps no focus and makes nothing inert, so
 * the reader may keep working beside it. It takes focus when it shows (a screen
 * reader then announces "How this kind works, region") unless the reader is
 * already typing somewhere, and gives focus back the moment they leave it. Escape
 * is Skip, but only while focus is inside the card: an Escape pressed in the
 * editor is the editor's. Arrow keys are not bound; the dots are a picture. A
 * live region of its own says the new step's position and title when Next or
 * Back is pressed.
 *
 * `animate` is the host asking for motion: the card then enters and leaves as a
 * height that grows and shrinks (a short transition, instant under
 * prefers-reduced-motion), so what is below it moves with that instead of
 * jumping a whole card's height in one frame. The panel asks; the admin's
 * preview, which is a picture, does not.
 */
import { onMount, tick, untrack } from "svelte";
import type { Component } from "svelte";
import { cubicInOut } from "svelte/easing";
import { slide as slideHeight } from "svelte/transition";
import { t } from "$lib/i18n";
import type {
	LocalizedText,
	ResolvedArtifactTour,
	ShippedArtifactTourType,
} from "$lib/shared/artifacts/tours";
import { uiLanguage } from "$lib/stores/settings";
import {
	MOTION_DURATION,
	MOTION_EASING,
	reducedMotionAnimate,
	reducedMotionAware,
} from "$lib/utils/motion";
import TourArtApp from "./illustrations/TourArtApp.svelte";
import TourArtCanvas from "./illustrations/TourArtCanvas.svelte";
import TourArtDocument from "./illustrations/TourArtDocument.svelte";

let {
	tour,
	startSlide = 0,
	replay = false,
	animate = false,
	onSeen,
	onDismiss,
	onClose = undefined,
}: {
	tour: ResolvedArtifactTour;
	/** 0-based; kept inside the slides. */
	startSlide?: number;
	/** The panel's replay: records nothing and leaves through `onClose`. */
	replay?: boolean;
	/** Enter and leave as a height that grows and shrinks (the host asks for it; see the header). */
	animate?: boolean;
	/** The reader finished the tour; `lastSlide` is the index of its last slide. */
	onSeen: (lastSlide: number) => void;
	/** The reader left before the end; `slide` is the index they were on. */
	onDismiss: (slide: number) => void;
	/** Replay only: the card is done. */
	onClose?: (() => void) | undefined;
} = $props();

const ILLUSTRATIONS: Record<
	ShippedArtifactTourType,
	Component<{ class?: string }>
> = {
	document: TourArtDocument,
	app: TourArtApp,
	canvas: TourArtCanvas,
};

let slides = $derived(tour.slides);
let slideCount = $derived(slides.length);
let slide = $state(
	untrack(() =>
		Math.max(0, Math.min(Math.trunc(startSlide) || 0, tour.slides.length - 1)),
	),
);
let current = $derived(slides[Math.min(slide, slideCount - 1)] ?? null);
let isLast = $derived(slide >= slideCount - 1);
let Illustration = $derived(ILLUSTRATIONS[tour.artifactType]);

let region = $state<HTMLElement | undefined>(undefined);
let slideElement = $state<HTMLElement | undefined>(undefined);
let backButton = $state<HTMLButtonElement | undefined>(undefined);
let primaryButton = $state<HTMLButtonElement | undefined>(undefined);
let ended = false;
/** What the live region says: empty until the reader moves, then the new step's position and title. */
let announcement = $state("");
/** The card's entrance and exit: a short slide of its height, instant under prefers-reduced-motion. */
const reveal = reducedMotionAware(slideHeight);
/** Gives focus back to where it was, once. Set when the card shows; called when the reader leaves and again (harmlessly) when the card is torn down. */
let giveFocusBack = (): void => {};

/** The copy in the reader's language; a language the copy lacks reads in English, never as a hole. */
function localized(text: LocalizedText): string {
	const own = text[$uiLanguage];
	return typeof own === "string" && own.trim().length > 0 ? own : text.en;
}

/** One way out, once: a double click, a held Enter or Escape on top of "Got it" must not write twice. */
function leave(report: () => void): void {
	if (ended) return;
	ended = true;
	// Now, not when the exit has played: until then the card is still in the page,
	// and focus would sit on a button that is on its way out.
	giveFocusBack();
	report();
}

function finish(): void {
	if (replay) leave(() => onClose?.());
	else leave(() => onSeen(Math.max(slideCount - 1, 0)));
}

function skip(): void {
	if (replay) leave(() => onClose?.());
	else leave(() => onDismiss(slide));
}

async function go(to: number): Promise<void> {
	const next = Math.min(Math.max(to, 0), slideCount - 1);
	if (next === slide) return;
	const direction = next > slide ? 1 : -1;
	// Back is not there on the first slide: if it had the keyboard, Next takes it.
	const handBackFocus = next === 0 && document.activeElement === backButton;
	slide = next;
	await tick();
	if (handBackFocus) primaryButton?.focus();
	if (current) {
		announcement = `${$t("artifacts.tour.stepOf", { n: slide + 1, m: slideCount })}. ${localized(current.title)}`;
	}
	// The only motion there is: the words slide in a little. Under
	// prefers-reduced-motion `reducedMotionAnimate` jumps straight to the end.
	if (slideElement) {
		reducedMotionAnimate(
			slideElement,
			[
				{ opacity: 0, transform: `translateX(${direction * 12}px)` },
				{ opacity: 1, transform: "translateX(0)" },
			],
			{ duration: MOTION_DURATION.standard, easing: MOTION_EASING.out },
		);
	}
}

/** Escape is Skip while focus is in the card. Declared as an attachment: a keydown on a plain region is what the a11y lint rule is there to stop, and here it is the point. */
function escapeIsSkip(node: HTMLElement) {
	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		// The panel's own Escape (closing an expanded panel) must not also fire.
		event.preventDefault();
		skip();
	}
	node.addEventListener("keydown", onKeydown);
	return () => node.removeEventListener("keydown", onKeydown);
}

/** Somewhere the reader types: a field, or inside an editable region (the Document's editor). */
function isTextEntry(element: Element | null): boolean {
	if (!(element instanceof HTMLElement)) return false;
	return (
		element.isContentEditable ||
		element.closest(
			'[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
		) !== null ||
		element instanceof HTMLInputElement ||
		element instanceof HTMLTextAreaElement ||
		element instanceof HTMLSelectElement
	);
}

onMount(() => {
	const before = document.activeElement;
	// A card that arrives while the reader is already typing must not take their caret.
	const taking = !isTextEntry(before);
	const returnTo =
		before instanceof HTMLElement && before !== document.body ? before : null;
	if (taking) region?.focus({ preventScroll: true });
	let returned = false;
	giveFocusBack = () => {
		if (returned) return;
		returned = true;
		// Give focus back only if it is still on the card, or on nothing because the
		// control that had it was removed with the card; never pull it off something
		// the reader moved to themselves.
		const active = document.activeElement;
		const onCardOrNothing =
			!active || active === document.body || Boolean(region?.contains(active));
		if (taking && onCardOrNothing && returnTo?.isConnected) {
			returnTo.focus({ preventScroll: true });
		}
	};
	return () => giveFocusBack();
});
</script>

{#if current}
	<!-- The wrapper is what grows and shrinks (the card inside keeps its own size and
	     is revealed, so its words do not reflow while it arrives). Global: the panel
	     removes the card, not this element's own block, and the exit must still play. -->
	<div
		class="tour-reveal"
		transition:reveal|global={{
			duration: animate ? MOTION_DURATION.emphasis : 0,
			easing: cubicInOut,
		}}
	>
	<section
		bind:this={region}
		class="artifact-tour"
		aria-label={$t('artifacts.tour.region')}
		data-testid="artifact-tour"
		data-kind={tour.artifactType}
		data-replay={replay ? 'true' : 'false'}
		tabindex="-1"
		{@attach escapeIsSkip}
	>
		<div class="tour-art" data-testid="artifact-tour-illustration" aria-hidden="true">
			<Illustration />
		</div>

		<div class="tour-main">
			<div class="tour-meta">
				<div
					class="tour-dots"
					role="img"
					aria-label={$t('artifacts.tour.dots', { count: slideCount })}
				>
					{#each slides as _, index (index)}
						<i
							class="tour-dot"
							data-testid="artifact-tour-dot"
							data-active={index === slide ? 'true' : 'false'}
						></i>
					{/each}
				</div>
				<p class="tour-step" data-testid="artifact-tour-step">
					{$t('artifacts.tour.stepOf', { n: slide + 1, m: slideCount })}
				</p>
				<p
					class="sr-only"
					data-testid="artifact-tour-live"
					aria-live="polite"
					aria-atomic="true"
				>
					{announcement}
				</p>
				{#if replay}
					<span class="tour-replaying" data-testid="artifact-tour-replaying">
						{$t('artifacts.tour.replayOpened')}
					</span>
				{/if}
			</div>

			<div class="tour-slide" bind:this={slideElement}>
				<h3 class="tour-title" data-testid="artifact-tour-title">
					{localized(current.title)}
				</h3>
				<p class="tour-body" data-testid="artifact-tour-body">
					{localized(current.body)}
				</p>
			</div>

			<div class="tour-footer">
				{#if isLast && !replay}
					<p class="tour-hint" data-testid="artifact-tour-hint">
						{$t('artifacts.tour.replayHint')}
					</p>
				{/if}
				<div class="tour-actions">
					<button
						type="button"
						class="btn-secondary btn-sm"
						data-testid="artifact-tour-skip"
						onclick={skip}
					>
						{$t('artifacts.tour.skip')}
					</button>
					{#if slide > 0}
						<button
							bind:this={backButton}
							type="button"
							class="btn-ghost btn-sm"
							data-testid="artifact-tour-back"
							onclick={() => go(slide - 1)}
						>
							{$t('artifacts.tour.back')}
						</button>
					{/if}
					<!-- One element for "Next" and "Got it": the keyboard keeps its place when the last slide arrives. -->
					<button
						bind:this={primaryButton}
						type="button"
						class="btn-primary btn-sm"
						data-testid={isLast ? 'artifact-tour-done' : 'artifact-tour-next'}
						onclick={isLast ? finish : () => go(slide + 1)}
					>
						{isLast ? $t('artifacts.tour.done') : $t('artifacts.tour.next')}
					</button>
				</div>
			</div>
		</div>
	</section>
	</div>
{/if}

<style>
	/* A flex item of the panel's content column: it takes the card's height, and
	   that is the height the transition animates. */
	.tour-reveal {
		flex: 0 0 auto;
	}

	/* The card sits in the panel's content area, above the artifact, at its full
	   width — not fixed, not sticky, and never taller than a part of the panel's
	   own height: a long published slide scrolls inside the card instead of
	   pushing the artifact away. */
	.artifact-tour {
		flex: 0 0 auto;
		box-sizing: border-box;
		display: grid;
		grid-template-columns: 6rem minmax(0, 1fr);
		column-gap: 1rem;
		align-items: start;
		margin: 0.75rem 1rem 0;
		padding: 1rem;
		max-height: 40vh;
		overflow-y: auto;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
	}

	.artifact-tour:focus {
		outline: none;
	}

	.artifact-tour:focus-visible {
		box-shadow:
			var(--shadow-sm),
			0 0 0 2px var(--focus-ring);
	}

	/* The picture: a tile with the board's dotted grid behind the drawing,
	   96 px on a wide panel, 64 px above the text on a phone. */
	.tour-art {
		width: 6rem;
		height: 6rem;
		box-sizing: border-box;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-page);
		background-image: radial-gradient(
			color-mix(in srgb, var(--text-primary) 16%, transparent) 1px,
			transparent 1px
		);
		background-size: 8px 8px;
	}

	.tour-main {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.tour-meta {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 1.25rem;
	}

	.tour-dots {
		display: flex;
		gap: 5px;
	}

	.tour-dot {
		width: 7px;
		height: 7px;
		border-radius: var(--radius-full);
		background: var(--surface-page);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 30%, transparent);
	}

	.tour-dot[data-active='true'] {
		background: var(--accent);
		box-shadow: none;
	}

	.tour-step {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
		letter-spacing: 0.03em;
	}

	.tour-replaying {
		margin-left: auto;
		color: var(--text-muted);
		font-size: var(--text-xs);
		font-style: italic;
	}

	.tour-title {
		margin: 0.5rem 0 0.375rem;
		font-family: var(--font-serif);
		font-size: 1.0625rem;
		font-weight: 400;
		line-height: 1.35;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.tour-body {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.84375rem;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.tour-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem 0.75rem;
		margin-top: 0.875rem;
	}

	.tour-hint {
		margin: 0 auto 0 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.tour-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	/* A phone: the 64 px picture floats at the corner and the words wrap under
	   it, so the whole card (picture, three or four lines, both buttons) stays
	   within 45% of the screen's height. A published slide that runs longer
	   scrolls inside the card. */
	@media (max-width: 767.98px) {
		.artifact-tour {
			display: block;
			margin: 0.5rem 0.75rem 0;
			padding: 0.875rem;
			max-height: 45vh;
		}

		.tour-art {
			float: left;
			width: 4rem;
			height: 4rem;
			margin: 0 0.75rem 0.375rem 0;
		}

		.tour-main {
			display: block;
		}

		.tour-footer {
			display: block;
			clear: both;
		}

		.tour-hint {
			margin: 0 0 0.5rem;
		}

		/* Side by side across the whole card: with no Back on the first slide,
		   Next shares its row with Skip alone. */
		.tour-actions {
			width: 100%;
		}

		.tour-actions > :global(button) {
			flex: 1 1 0;
		}
	}
</style>
