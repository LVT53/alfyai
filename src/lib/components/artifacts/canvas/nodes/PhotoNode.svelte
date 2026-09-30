<script lang="ts">
/**
 * A photo block's content: a small grid of thumbnails from the reader's own photo
 * library, exactly what the chat's photo search showed. A thumbnail is one of the
 * app's own proxies (`/api/connections/immich/thumbnail/…`) and NOTHING else ever
 * reaches an `<img>` here: an address is drawn only if `isPhotoProxyPath` says it is
 * the proxy's own shape, checked again at draw time on top of the check the board
 * makes when it stores the block, because a picture is a request the browser makes
 * on its own and this is the one block a model can write an address into.
 *
 * A click on a thumbnail opens the chat's own lightbox (`ImageLightbox`, a full view
 * portalled to the page, not a gallery inside the block) at that photo, and closing it
 * puts focus back on the thumbnail that opened it. A thumbnail that will not load
 * (the library is unreachable, the photo was deleted) is a quiet empty tile, not a
 * broken-image icon; nothing else about the block changes.
 *
 * The shell around this (header, anchors, resize corners) is `LazyNode`'s, and this
 * module never imports it (see `lazy-nodes.ts`).
 */
import { ImageOff } from "@lucide/svelte";
import { tick } from "svelte";
import ImageLightbox from "$lib/components/chat/ImageLightbox.svelte";
import { t } from "$lib/i18n";
import { isPhotoProxyPath } from "$lib/shared/artifacts/block-urls";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";

type PhotoData = Extract<CanvasBlockData, { kind: "photo" }>;

/** How many thumbnails the block draws; the rest are a count on the last one and are all in the lightbox. */
const THUMBNAILS_SHOWN = 6;

let { data }: { data: PhotoData } = $props();

/** The photos this block may draw: an address that is not the app's own proxy is not one, whatever the stored data says. */
let photos = $derived(
	data.items.filter((item) => isPhotoProxyPath(item.imageUrl)),
);
let shown = $derived(photos.slice(0, THUMBNAILS_SHOWN));
let hidden = $derived(photos.length - shown.length);

/** Ids of the photos whose thumbnail would not load. */
let unavailable = $state.raw<ReadonlySet<string>>(new Set());
/** What the lightbox pages through: the photos that loaded. */
let viewable = $derived(photos.filter((item) => !unavailable.has(item.id)));
let lightboxImages = $derived(
	viewable.map((item) => ({
		src: item.imageUrl,
		alt:
			item.alt ??
			$t("artifacts.canvas.photo.alt", {
				number: photos.findIndex((photo) => photo.id === item.id) + 1,
			}),
	})),
);

let lightboxIndex = $state<number | null>(null);
let opener: HTMLElement | null = null;

function markUnavailable(id: string): void {
	unavailable = new Set(unavailable).add(id);
}

async function open(id: string, trigger: HTMLElement): Promise<void> {
	const index = viewable.findIndex((item) => item.id === id);
	if (index === -1) return;
	opener = trigger;
	lightboxIndex = index;
	// Focus goes into the view that opened over the page (its own dialog element
	// takes it), so the keys that page through photos are not also heard by the
	// board the block sits on.
	await tick();
	document
		.querySelector<HTMLElement>('[data-testid="image-lightbox"]')
		?.focus();
}

async function close(): Promise<void> {
	lightboxIndex = null;
	await tick();
	opener?.focus();
	opener = null;
}
</script>

<div class="photo" data-testid="canvas-photo">
	{#if photos.length === 0}
		<p class="photo__empty">{$t("artifacts.canvas.photo.empty")}</p>
	{:else}
		<ul class="photo__grid">
			{#each shown as item, index (item.id)}
				<li class="photo__cell">
					{#if unavailable.has(item.id)}
						<span
							class="photo__thumb photo__thumb--missing"
							role="img"
							aria-label={$t("artifacts.canvas.photo.unavailable")}
							title={$t("artifacts.canvas.photo.unavailable")}
							data-testid="canvas-photo-missing"
						>
							<ImageOff size={18} strokeWidth={1.75} aria-hidden="true" />
						</span>
					{:else}
						<button
							type="button"
							class="photo__thumb"
							data-testid="canvas-photo-thumb"
							aria-label={$t("artifacts.canvas.photo.open", {
								number: index + 1,
								total: photos.length,
							})}
							onclick={(event) => void open(item.id, event.currentTarget)}
						>
							<img
								src={item.imageUrl}
								alt=""
								loading="lazy"
								decoding="async"
								draggable="false"
								referrerpolicy="no-referrer"
								onerror={() => markUnavailable(item.id)}
							/>
							{#if hidden > 0 && index === shown.length - 1}
								<span class="photo__more" aria-hidden="true">+{hidden}</span>
							{/if}
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<ImageLightbox
	images={lightboxImages}
	index={lightboxIndex}
	onClose={() => void close()}
	onNavigate={(next) => (lightboxIndex = next)}
/>

<style>
	.photo {
		box-sizing: border-box;
		padding: 8px 10px 10px;
	}

	.photo__grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.photo__cell {
		min-width: 0;
	}

	.photo__thumb {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		width: 100%;
		aspect-ratio: 1;
		overflow: hidden;
		padding: 0;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--surface-elevated);
		color: var(--text-muted);
		cursor: pointer;
	}

	.photo__thumb:hover {
		border-color: var(--border-default);
	}

	.photo__thumb:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.photo__thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		/* The native picture drag would start before the board's own drag could. */
		-webkit-user-drag: none;
		user-select: none;
	}

	.photo__thumb--missing {
		cursor: default;
	}

	/* The count of photos not drawn: a pill in the corner of the last one, in the page's own colours so it reads on any photo. */
	.photo__more {
		position: absolute;
		right: 4px;
		bottom: 4px;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-default);
		color: var(--text-primary);
		font-size: var(--text-xs);
		font-weight: 700;
		line-height: 1.5;
	}

	.photo__empty {
		margin: 0;
		padding: 6px 2px;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	@media (max-width: 767px), (pointer: coarse) {
		.photo__thumb {
			min-height: 44px;
		}
	}
</style>
