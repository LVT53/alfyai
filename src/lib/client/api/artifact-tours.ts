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
 *
 * **One answer per kind per page load.** What the server said about a kind is
 * kept here, as the promise, so a reader who opens a dozen Documents is asked
 * once, two opens in a row share a request still on the wire, and the answer an
 * item needs is in hand when it opens. A failed read is not kept; a reader who
 * finishes or skips a tour is taken as having seen it at once; a refused or
 * failed write, and a replay, go back to the server. A `fetchImpl` a caller
 * hands in (a test's) is never kept. Logging in and out are client-side
 * navigations, so the page outlives a reader: the panel says whose answers
 * these are (`keepArtifactToursFor`) and a different reader starts clean.
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
 * What this page load has been told about each kind's tour (see the header).
 * The promise, not the value: a second ask while the first is on the wire
 * shares it, which is also what lets a caller ask before it knows it needs to.
 */
const kept = new Map<ShippedArtifactTourType, Promise<ArtifactTourResponse>>();
/** Whose answers `kept` holds: undefined until someone is named. */
let keptFor: string | null | undefined;

/** Names the reader the panel is showing; what was kept for another one (or for a host that names no one) is dropped. */
export function keepArtifactToursFor(userId: string | null | undefined): void {
	const reader = userId ?? null;
	if (reader === keptFor) return;
	keptFor = reader;
	kept.clear();
}

/** One round trip to the route. `ok` is the wire shape's success marker (ruling 49), not part of what a caller wants, so it is read here and left behind — as `fetchArtifact` does. */
async function ask(
	artifactType: ShippedArtifactTourType,
	fetchImpl: FetchLike,
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
 * The kind's tour as it is right now, and whether THIS user has already seen
 * that exact content (and the slide they left it on). Only the kinds whose tour
 * ships (`SHIPPED_ARTIFACT_TOUR_TYPES`) can be asked for: the type says so, and
 * the route answers any other segment with a 404. A shipped kind always has a
 * tour (an archived one falls back to the code copy, ruling 71).
 *
 * Answered from what this page load already knows when it can be.
 */
export function getArtifactTour(
	artifactType: ShippedArtifactTourType,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactTourResponse> {
	if (fetchImpl !== fetch) return ask(artifactType, fetchImpl);
	let answer = kept.get(artifactType);
	if (!answer) {
		const asked = ask(artifactType, fetchImpl);
		answer = asked;
		kept.set(artifactType, asked);
		// A failure is not a fact about the kind: the next ask goes to the server.
		asked.catch(() => {
			if (kept.get(artifactType) === asked) kept.delete(artifactType);
		});
	}
	return answer;
}

/** The kind's tour from the server again, past what this page load kept: a replay shows the copy as it is now, and what comes back is what is kept. */
export function refreshArtifactTour(
	artifactType: ShippedArtifactTourType,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactTourResponse> {
	kept.delete(artifactType);
	return getArtifactTour(artifactType, fetchImpl);
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
	// Seen from the moment the reader presses the button: the next item of the
	// kind, opened before the write has landed, must not show the card again.
	const before = fetchImpl === fetch ? kept.get(artifactType) : undefined;
	const marked = before?.then((answer) =>
		answer.tour.contentKey === payload.contentKey
			? { ...answer, seen: true, lastSlide: payload.lastSlide }
			: answer,
	);
	if (marked) {
		kept.set(artifactType, marked);
		marked.catch(() => {});
	}
	try {
		return await requestJson<ArtifactTourSeenResponse>(
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
	} catch (error) {
		// Refused (the copy moved on) or not written: what was kept is no longer
		// the server's word, so the next ask is the server's.
		if (kept.get(artifactType) === marked) kept.delete(artifactType);
		throw error;
	}
}
