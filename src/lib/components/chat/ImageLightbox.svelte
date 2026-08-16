<script lang="ts">
// Full-view overlay for an image embedded in an assistant message. Ported
// from Sweetie's gallery MediaLightbox (feat(gallery): media gallery +
// lightbox) and adapted to plain image URLs instead of gallery asset ids:
// prev/next navigation across the images in one message, a counter, and
// close via the button, a click on the backdrop, or Escape. A pure,
// index-driven component — MarkdownRenderer owns which image is "open" and
// hands this the src/alt list + the active index.
//
// The overlay is portaled to <body> (use:portal) so its position: fixed
// fills the real viewport rather than being trapped by a transformed chat
// message ancestor.
import { ChevronLeft, ChevronRight, X } from "@lucide/svelte";
import { fade, scale } from "svelte/transition";
import { portal } from "$lib/actions/portal";
import { t } from "$lib/i18n";

let {
	images,
	index,
	onClose,
	onNavigate,
}: {
	images: { src: string; alt: string }[];
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

function step(delta: number) {
	if (index === null || images.length === 0) return;
	const next = (index + delta + images.length) % images.length;
	onNavigate(next);
}

function handleBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) onClose();
}

function handleKeydown(event: KeyboardEvent) {
	if (!isOpen) return;
	if (event.key === "Escape") {
		event.preventDefault();
		onClose();
	} else if (event.key === "ArrowRight") {
		event.preventDefault();
		step(1);
	} else if (event.key === "ArrowLeft") {
		event.preventDefault();
		step(-1);
	}
}

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
		class="image-lightbox"
		data-testid="image-lightbox"
		role="dialog"
		aria-modal="true"
		aria-label={$t('imageLightbox.label')}
		tabindex="-1"
		transition:fade={{ duration: 150 }}
		onclick={handleBackdropClick}
	>
		<button
			type="button"
			class="image-lightbox-close"
			aria-label={$t('imageLightbox.close')}
			onclick={onClose}
		>
			<X size={20} strokeWidth={2.1} aria-hidden="true" />
		</button>

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
		{/if}

		<figure class="image-lightbox-figure" transition:scale={{ duration: 150, start: 0.96 }}>
			<img class="image-lightbox-image" src={current.src} alt={current.alt} />
			{#if current.alt.trim()}
				<figcaption class="image-lightbox-caption">{current.alt}</figcaption>
			{/if}
		</figure>

		{#if images.length > 1}
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
		{/if}

		{#if images.length > 1}
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
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3.5rem 1.25rem;
		background: color-mix(in srgb, #000 82%, transparent 18%);
		backdrop-filter: blur(6px);
	}

	.image-lightbox-figure {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin: 0;
		max-width: min(92vw, 64rem);
		min-width: 0;
	}

	.image-lightbox-image {
		max-width: 100%;
		max-height: 80vh;
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		object-fit: contain;
	}

	.image-lightbox-caption {
		max-width: min(88vw, 52rem);
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
	}

	.image-lightbox-close,
	.image-lightbox-nav {
		position: absolute;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, #fff 14%, transparent 86%);
		color: #fff;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.image-lightbox-close:hover,
	.image-lightbox-nav:hover,
	.image-lightbox-close:focus-visible,
	.image-lightbox-nav:focus-visible {
		background: color-mix(in srgb, #fff 26%, transparent 74%);
		outline: none;
	}

	.image-lightbox-close {
		top: 1.25rem;
		right: 1.25rem;
		width: 2.5rem;
		height: 2.5rem;
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
		bottom: 1.25rem;
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
		.image-lightbox {
			padding: 3rem 0.75rem;
		}

		.image-lightbox-nav {
			width: 2.35rem;
			height: 2.35rem;
		}
	}
</style>
