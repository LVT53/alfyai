import { get, type Writable, writable } from "svelte/store";
import type { SpotlightId } from "$lib/app-places";

/**
 * How long a Show me request waits for its control to appear. The page it
 * navigates to has to load first, so it cannot be instant; but a request whose
 * control never shows up (it moved, or the person went elsewhere) must not ring
 * something on a later visit.
 */
export const SPOTLIGHT_REQUEST_TTL_MS = 6000;

export type SpotlightRequest = { spotlight: SpotlightId; expiresAt: number };

/**
 * The feature guide's Show me, in memory: the control it asks to have rung,
 * until that control takes the request. Never in the URL and never in storage,
 * so a reload or Back finds nothing and rings nothing.
 *
 * Same shape as `searchModalOpenRequested` in `ui.ts`: a writable that one
 * owner drains. Here the owner is whichever control carries the id (the
 * `spotlightTarget` action, `src/lib/actions/spotlight.ts`), and the request
 * lapses.
 *
 * Only the browser asks. The store is module state, so it must never be set
 * while a page renders on the server.
 */
export const spotlightRequest: Writable<SpotlightRequest | null> =
	writable(null);

/** Ask for a control to be rung. A newer request replaces an older one. */
export function requestSpotlight(
	spotlight: SpotlightId,
	now = Date.now(),
): void {
	spotlightRequest.set({
		spotlight,
		expiresAt: now + SPOTLIGHT_REQUEST_TTL_MS,
	});
}

/**
 * The control a request is waiting for, or `null` when there is none or it
 * has lapsed. A request is live while `now` is before its `expiresAt`.
 * Reads only; `takeSpotlight` is what answers one.
 */
export function pendingSpotlight(
	request: SpotlightRequest | null,
	now = Date.now(),
): SpotlightId | null {
	return request !== null && now < request.expiresAt ? request.spotlight : null;
}

/**
 * Answer the request if it is live and for this control: true at most once per
 * request, and the request is gone afterwards. Anything else leaves it where
 * it is, so the control it is for can still take it (a lapsed request stays
 * until the next one replaces it, and nothing takes it).
 *
 * The decision reads the store itself and not a value a subscriber was handed:
 * with two controls answering to one id, the second is told of the request
 * after the first has taken it.
 */
export function takeSpotlight(
	spotlight: SpotlightId,
	now = Date.now(),
): boolean {
	if (pendingSpotlight(get(spotlightRequest), now) !== spotlight) return false;
	spotlightRequest.set(null);
	return true;
}
