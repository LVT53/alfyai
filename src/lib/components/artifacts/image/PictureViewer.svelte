<script lang="ts">
// The Image kind's way into the full-screen viewer (plan 2b Task 22): the card
// and the panel hand it the picture to enlarge and it shows the app's one
// viewer (`chat/ImageLightbox.svelte`, loaded on first use through
// `image-lightbox-loader.ts`, never in the chat's first paint) on the FULL-SIZE
// file, read in the chat's scope, see-through pictures on the checkerboard.
// Nothing is drawn on it: the viewer is for looking (no marks).
import { imageFileUrl } from "$lib/client/api/images";
import {
	type ImageLightboxComponent,
	loadImageLightbox,
} from "$lib/components/chat/image-lightbox-loader";

let {
	picture,
	title,
	conversationId = null,
	onClose,
}: {
	/** The picture to show, or null while the viewer is shut. */
	picture: {
		fileId: string;
		/** Its shape when known (the box is reserved from it); a Before of another shape leaves it out. */
		width?: number;
		height?: number;
		hasAlpha: boolean;
	} | null;
	title: string;
	conversationId?: string | null;
	onClose: () => void;
} = $props();

let Viewer = $state.raw<ImageLightboxComponent | null>(null);

$effect(() => {
	if (!picture || Viewer) return;
	loadImageLightbox().then(
		(component) => {
			Viewer = component;
		},
		// The viewer could not load (a deploy swapped the chunks): nothing opens.
		() => onClose(),
	);
});

/**
 * The viewer stays mounted once loaded and is opened and shut by its index, so it
 * keeps the picture it showed while it closes (its own outro, then nothing).
 */
let kept: NonNullable<typeof picture> | null = null;
let images = $derived.by(() => {
	if (picture) kept = picture;
	return kept
		? [
				{
					src: imageFileUrl(kept.fileId, { conversationId }),
					alt: title,
					width: kept.width,
					height: kept.height,
					checkerboard: kept.hasAlpha,
				},
			]
		: [];
});
</script>

{#if Viewer}
	<Viewer {images} index={picture ? 0 : null} {onClose} onNavigate={() => {}} />
{/if}
