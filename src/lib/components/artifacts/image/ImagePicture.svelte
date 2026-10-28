<script lang="ts">
// One picture of the Image kind, in a box that already has its size (plan 2b
// T2, MOTION-PARITY 4): the box takes the picture's aspect ratio from the
// numbers the server knows before the PNG arrives, so nothing moves when it
// lands. The picture fades in over `--duration-standard` once decoded; a
// transparent one is drawn over the checkerboard tokens. Before / After keeps
// both pictures stacked in the same box (opacity only). Before is fetched
// ahead of the first press, once After is shown (the switch answers at once,
// the picture flips when Before has loaded: the box never empties).
//
// `variant: "thumb"` loads only the 320 px thumbnail (strips, chips, "Made
// from", History's rail); `"full"` lets the browser choose between the
// thumbnail and the full picture by the box's width (`srcset`, F20), which is
// what the chat card's main picture uses; `"original"` loads only the full
// picture (the panel's main view, MOTION-PARITY 4: only the panel loads full).
import { untrack } from "svelte";
import { imageFileUrl } from "$lib/client/api/images";
import { thumbWidth } from "$lib/shared/artifacts/image-body";
import "./checkerboard.css";

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
	variant?: "full" | "thumb" | "original";
	/** `variant: "full"` only: how wide the box is drawn, for `srcset`. */
	sizes?: string;
} = $props();

const thumbUrl = (id: string) =>
	imageFileUrl(id, { variant: "thumb", conversationId });

function sourceOf(id: string) {
	if (variant === "thumb") return { src: thumbUrl(id), srcset: undefined };
	const full = imageFileUrl(id, { conversationId });
	if (variant === "original") return { src: full, srcset: undefined };
	return {
		src: full,
		srcset: `${thumbUrl(id)} ${thumbWidth(width, height)}w, ${full} ${width}w`,
	};
}

let before = $derived(beforeFileId ? sourceOf(beforeFileId) : null);
let loaded = $state<Record<string, boolean>>({});

/**
 * The Before picture is fetched once After is shown, when the browser is idle
 * (or at once on a press), then kept: the first press then has it ready.
 */
let beforeWanted = $state(false);
$effect(() => {
	if (!beforeFileId || beforeWanted) return;
	if (showing === "before") {
		beforeWanted = true;
		return;
	}
	if (!loaded[fileId]) return;
	const want = () => {
		beforeWanted = true;
	};
	if (typeof requestIdleCallback === "function") {
		const handle = requestIdleCallback(want, { timeout: 1000 });
		return () => cancelIdleCallback(handle);
	}
	const timer = setTimeout(want, 0);
	return () => clearTimeout(timer);
});
/** Before is shown once it has loaded; until then After stays. */
let showBefore = $derived(
	showing === "before" &&
		before !== null &&
		beforeFileId !== null &&
		loaded[beforeFileId] === true,
);

/**
 * The After pictures on screen, oldest first. A new picture (another take
 * chosen, a take landing) is laid over the one it replaces and fades in; the
 * one under it goes once the new one is fully shown, so the box never shows
 * its empty background between two pictures.
 */
let layers = $state<string[]>(untrack(() => [fileId]));
$effect(() => {
	const id = fileId;
	const current = untrack(() => layers);
	if (current.at(-1) !== id) {
		layers = [...current.filter((layer) => layer !== id), id];
	}
});

function settle(id: string): void {
	const index = layers.indexOf(id);
	if (index > 0) layers = layers.slice(index);
}

/**
 * A picture is shown once it has loaded. The handlers are the element's own
 * (`onload`), attached when Svelte creates it, so a load that finishes at once
 * (a picture already in the cache) is never missed, and nothing here is an
 * effect that could re-run on its own write. The motion check found both: an
 * attachment that looped on a cached picture, and a new picture whose
 * attachment never ran, left invisible under the one it replaced.
 */
function markLoaded(id: string): void {
	// A picture laid over another (a new take, a new version) is shown a frame
	// after it loads: one already in the cache loads in the very frame it is made,
	// and marking it then would skip its fade and cut to it.
	if (layers.length > 1 && layers.at(-1) === id) {
		requestAnimationFrame(() => {
			loaded = { ...loaded, [id]: true };
		});
		return;
	}
	loaded = { ...loaded, [id]: true };
}

/** The picture under a new one goes once the new one has faded in. */
function markShown(id: string, event: TransitionEvent): void {
	if (event.propertyName === "opacity" && loaded[id]) settle(id);
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
			onload={() => markLoaded(id)}
			ontransitionend={(event) => markShown(id, event)}
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
				onload={() => markLoaded(beforeFileId)}
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
	}

	/* An opaque picture waits on the surface; a see-through one on the shared
	   checkerboard (`checkerboard.css`). */
	.image-picture:not(.image-checkerboard) {
		background: var(--surface-elevated);
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

	.image-picture-img.is-hidden {
		opacity: 0;
	}
</style>
