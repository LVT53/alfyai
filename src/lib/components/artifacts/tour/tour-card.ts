/**
 * The tour card's one lazy door (Feature 2 · Artifacts, Slice 6; FX-2, ruling 77).
 *
 * The card and its three drawings are one chunk the chat shell never carries: it
 * is imported here, with `import()`, only when a tour is about to show. The panel
 * brings the chunk in as soon as it knows the reader owes a tour (`loadTourCard`),
 * and asks `loadedTourCard` in the flush that opens an item: a card that is already
 * in hand is in the page in the item's first frame, which an `await import()` cannot
 * promise (it settles a frame or more later), and that is what keeps the card from
 * moving, or covering, what the reader had just seen.
 */
export type ArtifactTourCard =
	typeof import("./ArtifactTour.svelte")["default"];

let loaded: ArtifactTourCard | null = null;

/** The card if something has already loaded it, else `null`: never waits, never starts a load. */
export function loadedTourCard(): ArtifactTourCard | null {
	return loaded;
}

/** Brings the card in (once) and returns it. */
export async function loadTourCard(): Promise<ArtifactTourCard> {
	if (!loaded) loaded = (await import("./ArtifactTour.svelte")).default;
	return loaded;
}
