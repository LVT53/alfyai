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
		width: number;
		height: number;
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

let images = $derived(
	picture
		? [
				{
					src: imageFileUrl(picture.fileId, { conversationId }),
					alt: title,
					width: picture.width,
					height: picture.height,
					checkerboard: picture.hasAlpha,
				},
			]
		: [],
);
</script>

{#if Viewer && picture}
	<Viewer {images} index={0} {onClose} onNavigate={() => {}} />
{/if}
