<script lang="ts">
// One picture of the Image kind, in a box that already has its size (plan 2b
// T2, MOTION-PARITY 4): the box takes the picture's aspect ratio from the
// numbers the server knows before the PNG arrives, so nothing moves when it
// lands. The picture fades in over `--duration-standard` once decoded; a
// transparent one is drawn over the checkerboard tokens. Before / After keeps
// both pictures stacked in the same box and crossfades them (opacity only),
// so a flip never waits for a load it has already made.
//
// `variant: "thumb"` loads only the 320 px thumbnail (strips, chips, "Made
// from", History's rail); `"full"` lets the browser choose between the
// thumbnail and the full picture by the box's width (`srcset`, F20), which is
// what the chat card's main picture and the panel use.
import { untrack } from "svelte";
import { imageFileUrl } from "$lib/client/api/images";
import { thumbWidth } from "$lib/shared/artifacts/image-body";

let {
	fileId,
	width,
	height,
	hasAlpha = false,
	alt,
	conversationId = null,
	beforeFileId = null,
	showing = "after",
	variant = "full",
	sizes = "(max-width: 767px) 92vw, 560px",
}: {
	fileId: string;
	width: number;
	height: number;
	hasAlpha?: boolean;
	alt: string;
	conversationId?: string | null;
	/** The picture this one was made from, for Before / After. */
	beforeFileId?: string | null;
	showing?: "after" | "before";
	variant?: "full" | "thumb";
	/** `variant: "full"` only: how wide the box is drawn, for `srcset`. */
	sizes?: string;
} = $props();

const thumbUrl = (id: string) =>
	imageFileUrl(id, { variant: "thumb", conversationId });

function sourceOf(id: string) {
	if (variant === "thumb") return { src: thumbUrl(id), srcset: undefined };
	const full = imageFileUrl(id, { conversationId });
	return {
		src: full,
		srcset: `${thumbUrl(id)} ${thumbWidth(width, height)}w, ${full} ${width}w`,
	};
}

let before = $derived(beforeFileId ? sourceOf(beforeFileId) : null);
/** The Before picture is fetched once it is first asked for, then kept. */
let beforeWanted = $state(false);
$effect(() => {
	if (showing === "before" && beforeFileId) beforeWanted = true;
});
let showBefore = $derived(showing === "before" && before !== null);

let loaded = $state<Record<string, boolean>>({});

/**
 * The After pictures on screen, oldest first. A new picture (another take
 * chosen, a take landing) is laid over the one it replaces and fades in; the
 * one under it goes once the new one is fully shown, so the box never shows
 * its empty background between two pictures.
 */
let layers = $state<string[]>([]);
$effect.pre(() => {
	const id = fileId;
	if (layers.at(-1) !== id) layers = [...layers.filter((l) => l !== id), id];
});

function settle(id: string): void {
	const index = layers.indexOf(id);
	if (index > 0) layers = layers.slice(index);
}

/** Marks a picture shown once it has decoded, also when it was already cached. */
function fadeInOnLoad(id: string) {
	return (img: HTMLImageElement) => {
		const done = () => {
			loaded = { ...loaded, [id]: true };
		};
		const shown = (event: TransitionEvent) => {
			if (event.propertyName === "opacity" && loaded[id]) settle(id);
		};
		// Untracked: an attachment is an effect, and reading `loaded` or `layers`
		// here would make it re-run on its own write (a picture already in the
		// cache is complete at once).
		untrack(() => {
			if (img.complete && img.naturalWidth > 0) {
				done();
				settle(id);
			}
		});
		img.addEventListener("load", done);
		img.addEventListener("transitionend", shown);
		return () => {
			img.removeEventListener("load", done);
			img.removeEventListener("transitionend", shown);
		};
	};
}
</script>

<span
	class="image-picture"
	class:image-checkerboard={hasAlpha}
	class:image-picture-thumb={variant === 'thumb'}
	style:aspect-ratio="{width} / {height}"
	data-testid="image-picture"
	data-showing={showBefore ? 'before' : 'after'}
>
	{#each layers as id (id)}
		{@const source = sourceOf(id)}
		{@const current = id === fileId}
		<img
			class="image-picture-img"
			class:is-loaded={loaded[id]}
			class:is-hidden={showBefore}
			src={source.src}
			srcset={source.srcset}
			sizes={source.srcset ? sizes : undefined}
			{width}
			{height}
			alt={current && !showBefore ? alt : ''}
			aria-hidden={current && !showBefore ? undefined : 'true'}
			decoding="async"
			draggable="false"
			data-testid={current ? 'image-picture-after' : 'image-picture-leaving'}
			{@attach fadeInOnLoad(id)}
		/>
	{/each}
	{#if before && beforeFileId && beforeWanted}
		{#key beforeFileId}
			<img
				class="image-picture-img image-picture-before"
				class:is-loaded={loaded[beforeFileId]}
				class:is-hidden={!showBefore}
				src={before.src}
				srcset={before.srcset}
				sizes={before.srcset ? sizes : undefined}
				{width}
				{height}
				alt={showBefore ? alt : ''}
				aria-hidden={showBefore ? undefined : 'true'}
				decoding="async"
				draggable="false"
				data-testid="image-picture-before"
				{@attach fadeInOnLoad(beforeFileId)}
			/>
		{/key}
	{/if}
</span>

<style>
	/* The box is the picture's own shape before any byte arrives; its parent
	   decides how wide it is drawn. */
	.image-picture {
		position: relative;
		display: block;
		width: 100%;
		overflow: hidden;
		border-radius: inherit;
		background: var(--surface-elevated);
	}

	/* What is see-through shows as a checkerboard, in both themes (F8). */
	.image-checkerboard {
		background-color: var(--checker-a);
		background-image: conic-gradient(
			var(--checker-b) 25%,
			var(--checker-a) 0 50%,
			var(--checker-b) 0 75%,
			var(--checker-a) 0
		);
		background-size: 16px 16px;
	}

	.image-picture-thumb.image-checkerboard {
		background-size: 8px 8px;
	}

	.image-picture-img {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		opacity: 0;
		transition: opacity var(--duration-standard) var(--ease-out);
		user-select: none;
	}

	.image-picture-img.is-loaded {
		opacity: 1;
	}

	.image-picture-img.is-loaded.is-hidden,
	.image-picture-img.is-hidden {
		opacity: 0;
	}
</style>
