/**
 * Browser calls for the first-open tours (Feature 2 · Artifacts, Slice 6) —
 * the only place the panel reaches the tour routes from. The admin's seeding of
 * the tour drafts is not here: this module rides in the chat, which has no use
 * for it (`campaigns.ts` has `seedArtifactTours`, with the other admin calls).
 * Follows `campaigns.ts`: an injectable `fetchImpl`, `requestJson` with a
 * plain fallback message, no store.
 *
 * Failures are `ApiError`s carrying the HTTP status, and nothing here
 * special-cases one: the panel's own catch reads `.status` — a 409 on the
 * seen write means "an admin published while you were reading, so fetch the
 * tour again and show the new copy from its first slide"; a 401 is the
 * session-expiry handling `http.ts` already does; anything else means no
 * card and the artifact still renders.
 */
import type {
	ArtifactTourResponse,
	ArtifactTourSeenRequest,
	ArtifactTourSeenResponse,
	ShippedArtifactTourType,
} from "$lib/shared/artifacts/tours";
import { type FetchLike, requestJson } from "./http";

const jsonHeaders = { "Content-Type": "application/json" };

/**
 * The kind's tour as it is right now, and whether THIS user has already seen
 * that exact content (and the slide they left it on). Only the kinds whose tour
 * ships (`SHIPPED_ARTIFACT_TOUR_TYPES`) can be asked for: the type says so, and
 * the route answers any other segment with a 404. A shipped kind always has a
 * tour (an archived one falls back to the code copy, ruling 71).
 *
 * `ok` is the wire shape's success marker (ruling 49), not part of what a
 * caller wants, so it is read here and left behind — as `fetchArtifact` does.
 */
export async function getArtifactTour(
	artifactType: ShippedArtifactTourType,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactTourResponse> {
	const response = await requestJson<ArtifactTourResponse & { ok: true }>(
		`/api/artifact-tours/${encodeURIComponent(artifactType)}`,
		undefined,
		"Failed to load the introduction",
		fetchImpl,
	);
	return {
		tour: response.tour,
		seen: response.seen,
		lastSlide: response.lastSlide,
	};
}

/**
 * Records that the user finished or dismissed the tour they were shown.
 * `payload.contentKey` is the `tour.contentKey` that `getArtifactTour`
 * returned, unchanged. Idempotent on the server (`alreadyRecorded`), so a
 * retry or a second tab is harmless, and the panel may fire and forget; a
 * 409 (`ApiError.status`) means the copy moved on under the user.
 *
 * Replaying a tour from the panel's menu writes nothing: do not call this.
 */
export async function markArtifactTourSeen(
	artifactType: ShippedArtifactTourType,
	payload: ArtifactTourSeenRequest,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactTourSeenResponse> {
	return requestJson<ArtifactTourSeenResponse>(
		`/api/artifact-tours/${encodeURIComponent(artifactType)}/seen`,
		{
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({
				contentKey: payload.contentKey,
				status: payload.status,
				lastSlide: payload.lastSlide,
			}),
		},
		"Failed to record the introduction",
		fetchImpl,
	);
}
