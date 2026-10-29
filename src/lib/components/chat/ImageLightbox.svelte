<script lang="ts">
// Full-view overlay for a picture: an image embedded in an assistant message
// (MarkdownRenderer), a Canvas photo block (PhotoNode) and, since plan 2b Task 22,
// the Image kind's picture from its card and its panel ("it should be possible to
// actually enlarge the picture"). Ported from Sweetie's gallery MediaLightbox
// and adapted to plain image URLs: prev/next across the pictures handed in, a
// counter, and close via the button, a click on the backdrop, or Escape. A pure,
// index-driven component: the host owns which picture is "open".
//
// The picture is shown fitted to the screen and can be enlarged: the wheel or a
// trackpad pinch, two fingers, a double click or tap (fit <-> 100%), + / - / 0,
// and the zoom buttons; a zoomed picture pans by drag. That arithmetic is
// `image-lightbox-zoom.ts`'s; only `transform` moves. A see-through picture lies
// on the shared checkerboard (`artifacts/image/checkerboard.css`). Nothing is
// drawn on the picture here (no marks): the viewer is for looking.
//
// The overlay is portaled to <body> (use:portal) so its position: fixed
// fills the real viewport rather than being trapped by a transformed chat
// message ancestor. It opens on the family's emphasis curve and closes on
// ease-in (opacity and transform only); reduced motion makes both instant. The
// transitions are `|global`: a host that mounts the viewer together with its
// first picture (the first open, once the lazy chunk is here) still sees it
// open, and one that unmounts it still sees it close.
//
// It is a modal dialog, so it behaves as one: it takes focus when it opens,
// keeps Tab and Shift+Tab inside, hands focus back to what had it when it
// closes, and joins the DialogShell open-dialog stack so that Escape, the
// arrows and the zoom keys belong to it alone while it is the layer on top.
//
// Hosts load it lazily (`image-lightbox-loader.ts`): it is never part of the
// chat page's first paint.
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "@lucide/svelte";
import { untrack } from "svelte";
import { fade, scale } from "svelte/transition";
import { portal } from "$lib/actions/portal";
import "$lib/components/artifacts/image/checkerboard.css";
import {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import { focusTrap } from "$lib/utils/focus-trap";
import { MOTION_DURATION, MOTION_EASE } from "$lib/utils/motion";
import { reducedMotionAware } from "$lib/utils/motion";
import {
	createLightboxZoom,
	type ZoomFrame,
	type ZoomView,
	zoomPercent,
} from "./image-lightbox-zoom";

// prefers-reduced-motion: the CSS reset in app.css cannot reach these
// JS-driven transitions (see motion.ts), so wrap them explicitly.
const backdropFade = reducedMotionAware(fade);
const figureScale = reducedMotionAware(scale);

export type LightboxImage = {
	src: string;
	alt: string;
	/** The picture's own size, when known: its box is reserved before it loads. */
	width?: number;
	height?: number;
	/** A see-through picture: drawn on the checkerboard. */
	checkerboard?: boolean;
};

let {
	images,
	index,
	onClose,
	onNavigate,
}: {
	images: LightboxImage[];
	index: number | null;
	onClose: () => void;
	onNavigate: (nextIndex: number) => void;
} = $props();

let isOpen = $derived(index !== null && index >= 0 && index < images.length);
let current = $derived(isOpen && index !== null ? images[index] : null);
let counterLabel = $derived(
	isOpen && index !== null
		? $t("imageLightbox.counter", {
				current: index + 1,
				total: images.length,
			})
		: "",
);

/**
 * The source that has loaded: a picture is shown (faded in) once its own file is
 * here, so paging to another hides the box until that one has loaded too.
 */
let loadedSrc = $state<string | null>(null);
let loaded = $derived(current !== null && loadedSrc === current.src);
let sized = $derived(
	Boolean(
		current?.width && current.height && current.width > 0 && current.height > 0,
	),
);

function pictureLoaded(src: string): void {
	loadedSrc = src;
	zoom.refresh();
}

/** A file that cannot be read says so, instead of a box that waits forever (round 2, N1). */
let failedSrc = $state<string | null>(null);
let failed = $derived(current !== null && failedSrc === current.src);

let zoomState = $state.raw<{ view: ZoomView; frame: ZoomFrame } | null>(null);
let zoomed = $derived((zoomState?.view.scale ?? 1) > 1);
let percent = $derived(
	zoomState ? zoomPercent(zoomState.view, zoomState.frame) : 100,
);
const zoom = createLightboxZoom((view, frame) => {
	zoomState = { view, frame };
});

// Another picture (paging, or the host swapping it) starts at fit.
$effect(() => {
	if (!current?.src) return;
	untrack(() => zoom.reset());
});

function step(delta: number) {
	if (index === null || images.length === 0) return;
	const next = (index + delta + images.length) % images.length;
	onNavigate(next);
}

function handleBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) onClose();
}

// The stage fills the window; a click on it beside the picture is a click on the
// backdrop. The click that ends a drag or a pinch closes nothing.
function handleStageClick(event: MouseEvent) {
	if (zoom.consumeGesture()) return;
	const target = event.target as HTMLElement;
	if (
		target === event.currentTarget ||
		target.dataset.lightboxFigure !== undefined
	) {
		onClose();
	}
}

// The arrow keys page through the pictures and + / - / 0 zoom, but only while
// this is the layer on top. Escape and Tab are the focus trap's (below). With
// Ctrl or Cmd, + and - are the browser's own page zoom.
const PAGING_KEYS: Record<string, () => void> = {
	ArrowRight: () => step(1),
	ArrowLeft: () => step(-1),
};
const ZOOM_KEYS: Record<string, () => void> = {
	"+": () => zoom.zoomIn(),
	"=": () => zoom.zoomIn(),
	"-": () => zoom.zoomOut(),
	_: () => zoom.zoomOut(),
	"0": () => zoom.fit(),
};

function handleKeydown(event: KeyboardEvent) {
	if (!isOpen || !isTopmostDialog(dialogId)) return;
	const withModifier = event.ctrlKey || event.metaKey || event.altKey;
	const action =
		PAGING_KEYS[event.key] ?? (withModifier ? undefined : ZOOM_KEYS[event.key]);
	if (!action) return;
	event.preventDefault();
	action();
}

const dialogId = Symbol("image-lightbox");
let dialogRef = $state<HTMLDivElement | null>(null);

// On the shared stack only while it is open. The component can stay mounted
// with no picture (a host that renders it always), and then it must not count
// as an open dialog.
$effect(() => {
	if (!isOpen) return;
	registerDialog(dialogId);
	return () => deregisterDialog(dialogId);
});

// Tab/Shift+Tab wrapping and the pull-back of stray focus are the shared
// utility's (src/lib/utils/focus-trap.ts). The dialog itself takes the first
// focus (a picture has no control worth landing on), and neither that focus nor
// its return to the opener may scroll the page behind it.
const lightboxFocusTrap = focusTrap({
	isTopmost: () => isTopmostDialog(dialogId),
	onEscape: (event) => {
		event.preventDefault();
		onClose();
	},
	focus: { target: () => dialogRef },
	restoreFocusOnCleanup: true,
	preventScroll: true,
});

// Lock background scroll while the overlay is open, restoring the prior
// value on close/unmount (mirrors DialogShell).
$effect(() => {
	if (!isOpen) return;
	const previous = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	return () => {
		document.body.style.overflow = previous;
	};
});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen && current}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		use:portal
		bind:this={dialogRef}
		{@attach lightboxFocusTrap}
		class="image-lightbox"
		data-testid="image-lightbox"
		role="dialog"
		aria-modal="true"
		aria-label={$t('imageLightbox.label')}
		tabindex="-1"
		in:backdropFade|global={{ duration: MOTION_DURATION.emphasis, easing: MOTION_EASE.emphasis }}
		out:backdropFade|global={{ duration: MOTION_DURATION.standard, easing: MOTION_EASE.in }}
		onclick={handleBackdropClick}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="image-lightbox-stage"
			data-testid="image-lightbox-stage"
			{@attach zoom.attach}
			onclick={handleStageClick}
		>
			<figure
				class="image-lightbox-figure"
				class:is-loaded={loaded}
				data-lightbox-figure
				in:figureScale|global={{ duration: MOTION_DURATION.emphasis, easing: MOTION_EASE.emphasis, start: 0.96 }}
				out:figureScale|global={{ duration: MOTION_DURATION.standard, easing: MOTION_EASE.in, start: 0.96 }}
			>
				<img
					class="image-lightbox-image"
					class:is-zoomed={zoomed}
					class:is-loaded={loaded}
					class:has-size={sized}
					style:--picture-ratio={sized && current.width && current.height ? current.width / current.height : undefined}
					style:--picture-width={sized ? `${current.width}px` : undefined}
					class:image-checkerboard={current.checkerboard}
					src={current.src}
					alt={current.alt}
					width={current.width}
					height={current.height}
					decoding="async"
					draggable="false"
					data-zoom-target
					data-testid="image-lightbox-image"
					onload={() => current && pictureLoaded(current.src)}
					onerror={() => {
						if (current) failedSrc = current.src;
					}}
				/>
			</figure>
			{#if failed}
				<p class="image-lightbox-error" role="status" data-testid="image-lightbox-error">
					{$t('imageLightbox.loadFailed')}
				</p>
			{/if}
		</div>

		{#if current.alt.trim()}
			<p class="image-lightbox-caption">{current.alt}</p>
		{/if}

		<button
			type="button"
			class="image-lightbox-close"
			aria-label={$t('imageLightbox.close')}
			onclick={onClose}
		>
			<X size={20} strokeWidth={2.1} aria-hidden="true" />
		</button>

		<div class="image-lightbox-zoom" data-testid="image-lightbox-zoom">
			<button
				type="button"
				class="image-lightbox-zoom-button"
				aria-label={$t('imageLightbox.zoomOut')}
				title={$t('imageLightbox.zoomOut')}
				data-testid="image-lightbox-zoom-out"
				onclick={() => zoom.zoomOut()}
			>
				<ZoomOut size={18} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="image-lightbox-zoom-button image-lightbox-zoom-level"
				aria-label={$t('imageLightbox.fit', { percent })}
				title={$t('imageLightbox.fit', { percent })}
				data-testid="image-lightbox-zoom-level"
				onclick={() => zoom.fit()}
			>
				{percent}%
			</button>
			<button
				type="button"
				class="image-lightbox-zoom-button"
				aria-label={$t('imageLightbox.zoomIn')}
				title={$t('imageLightbox.zoomIn')}
				data-testid="image-lightbox-zoom-in"
				onclick={() => zoom.zoomIn()}
			>
				<ZoomIn size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>

		{#if images.length > 1}
			<button
				type="button"
				class="image-lightbox-nav image-lightbox-prev"
				aria-label={$t('imageLightbox.previous')}
				onclick={(event) => {
					event.stopPropagation();
					step(-1);
				}}
			>
				<ChevronLeft size={24} strokeWidth={2.1} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="image-lightbox-nav image-lightbox-next"
				aria-label={$t('imageLightbox.next')}
				onclick={(event) => {
					event.stopPropagation();
					step(1);
				}}
			>
				<ChevronRight size={24} strokeWidth={2.1} aria-hidden="true" />
			</button>
			<div class="image-lightbox-counter" data-testid="image-lightbox-counter">
				{counterLabel}
			</div>
		{/if}
	</div>
{/if}

<style>
	.image-lightbox {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: color-mix(in srgb, #000 82%, transparent 18%);
		backdrop-filter: blur(6px);
	}

	/* The dialog takes the first focus itself; a ring around the whole window
	   would say nothing, and every control inside has its own focus style. */
	.image-lightbox:focus {
		outline: none;
	}

	/* The stage is the whole window: the picture is centred in it, fitted inside
	   the padding (room for the controls), and a zoomed picture may pan to the
	   window's edges. `touch-action: none` is set by the zoom on this element
	   alone. A click on it beside the picture closes the viewer. */
	.image-lightbox-stage {
		--viewer-max-width: calc(100vw - 2.5rem);
		--viewer-max-height: calc(100dvh - 7.5rem);
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 3.75rem 1.25rem;
		overflow: hidden;
	}

	/* While the full-size file is on its way, its reserved box shows as a quiet
	   tint; the picture fades in over it once loaded (opacity only). */
	.image-lightbox-figure {
		position: relative;
		margin: 0;
		min-width: 0;
		line-height: 0;
	}

	.image-lightbox-figure::before {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, #fff 8%, transparent 92%);
		pointer-events: none;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.image-lightbox-figure.is-loaded::before {
		opacity: 0;
	}

	/* Fit: as large as the padded stage allows, never past the picture's own
	   size (max-* never upscales). Zoom is a transform over this box. */
	.image-lightbox-image {
		display: block;
		width: auto;
		height: auto;
		max-width: var(--viewer-max-width);
		max-height: var(--viewer-max-height);
		border-radius: var(--radius-md);
		position: relative;
		opacity: 0;
		transition: opacity var(--duration-standard) var(--ease-out);
		box-shadow: var(--shadow-lg);
		transform-origin: center;
		will-change: transform;
		cursor: zoom-in;
		user-select: none;
		-webkit-user-drag: none;
	}

	.image-lightbox-image.is-loaded {
		opacity: 1;
	}

	/* A picture whose size is known holds its fitted box before it loads (the
	   attributes alone do not, under width/height: auto): its own width, never
	   past the stage, never taller than it. */
	.image-lightbox-image.has-size {
		/* A file whose shape differs from the one stated is fitted inside the box,
		   never stretched to it (round 2, N2). */
		object-fit: contain;
		width: min(
			var(--picture-width),
			var(--viewer-max-width),
			calc(var(--viewer-max-height) * var(--picture-ratio))
		);
		aspect-ratio: var(--picture-ratio);
	}

	.image-lightbox-image.is-zoomed {
		cursor: grab;
	}

	.image-lightbox-image.is-zoomed:active {
		cursor: grabbing;
	}

	/* A see-through picture's checkerboard reads at the viewer's size. */
	.image-lightbox-image:global(.image-checkerboard) {
		background-size: 24px 24px;
	}

	/* A picture that could not be read: one calm line over the stage's middle. */
	.image-lightbox-error {
		position: absolute;
		top: 50%;
		left: 50%;
		margin: 0;
		max-width: min(80vw, 24rem);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, #000 55%, transparent 45%);
		color: #fff;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		text-align: center;
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.image-lightbox-caption {
		position: absolute;
		bottom: 1rem;
		left: 50%;
		margin: 0;
		max-width: min(70vw, 40rem);
		transform: translateX(-50%);
		text-align: center;
		font-family: var(--font-sans);
		font-size: 0.8rem;
		line-height: 1.4;
		color: color-mix(in srgb, #fff 82%, transparent 18%);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		pointer-events: none;
	}

	.image-lightbox-close,
	.image-lightbox-nav,
	.image-lightbox-zoom-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, #fff 14%, transparent 86%);
		color: #fff;
		cursor: pointer;
		transition: transform var(--duration-micro) var(--ease-out);
	}

	.image-lightbox-close,
	.image-lightbox-nav {
		position: absolute;
	}

	.image-lightbox-close:hover,
	.image-lightbox-nav:hover,
	.image-lightbox-zoom-button:hover,
	.image-lightbox-close:focus-visible,
	.image-lightbox-nav:focus-visible,
	.image-lightbox-zoom-button:focus-visible {
		background: color-mix(in srgb, #fff 26%, transparent 74%);
		outline: none;
	}

	.image-lightbox-close:focus-visible,
	.image-lightbox-nav:focus-visible,
	.image-lightbox-zoom-button:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.image-lightbox-close {
		top: 1rem;
		right: 1rem;
		width: 2.75rem;
		height: 2.75rem;
	}

	/* The zoom controls: top left, opposite Close, one pill. */
	.image-lightbox-zoom {
		position: absolute;
		top: 1rem;
		left: 1rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, #000 45%, transparent 55%);
	}

	.image-lightbox-zoom-button {
		min-width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		background: transparent;
		font-family: var(--font-sans);
		font-size: 0.76rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.image-lightbox-zoom-level {
		min-width: 3.5rem;
	}

	.image-lightbox-nav {
		top: 50%;
		width: 2.75rem;
		height: 2.75rem;
		transform: translateY(-50%);
	}

	.image-lightbox-nav:hover {
		transform: translateY(-50%) scale(1.06);
	}

	.image-lightbox-prev {
		left: 1.25rem;
	}

	.image-lightbox-next {
		right: 1.25rem;
	}

	.image-lightbox-counter {
		position: absolute;
		top: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, #000 45%, transparent 55%);
		padding: 0.3rem 0.9rem;
		font-family: var(--font-sans);
		font-size: 0.76rem;
		font-weight: 600;
		color: #fff;
	}

	@media (max-width: 640px) {
		/* On a phone the zoom pill and Close take the top row: the counter goes
		   under the picture, above its caption (review minor 4). */
		.image-lightbox-counter {
			top: auto;
			bottom: 3rem;
		}

		.image-lightbox-stage {
			padding: 3.75rem 0.75rem;
		}

		.image-lightbox-stage {
			--viewer-max-width: calc(100vw - 1.5rem);
		}

		.image-lightbox-nav {
			width: 2.75rem;
			height: 2.75rem;
		}
	}

	/* 44 px targets where the finger is the pointer (MOTION-PARITY 8). */
	@media (hover: none) and (pointer: coarse) {
		.image-lightbox-zoom-button {
			min-width: 2.75rem;
			height: 2.75rem;
		}
	}
</style>
