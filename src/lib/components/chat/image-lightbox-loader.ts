/**
 * The full-screen viewer (`ImageLightbox.svelte`) loads on demand, the first
 * time a picture is enlarged: it carries the zoom and pan and is never part of
 * the chat page's first paint (`npm run check:image-viewer-chunks`). Every host
 * (a message's pictures, the Image card and panel) goes through this one
 * loader, so the chunk is fetched once.
 */
import type ImageLightbox from "./ImageLightbox.svelte";

export type ImageLightboxComponent = typeof ImageLightbox;

let pending: Promise<ImageLightboxComponent> | null = null;

export function loadImageLightbox(): Promise<ImageLightboxComponent> {
	pending ??= import("./ImageLightbox.svelte").then(
		(module) => module.default,
		(error: unknown) => {
			// A failed fetch (a deploy swapped the chunks) may be tried again.
			pending = null;
			throw error;
		},
	);
	return pending;
}
