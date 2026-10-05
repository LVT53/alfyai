/**
 * First-open tours (Feature 2 · Artifacts, Slice 6): a three-slide card shown
 * the first time a user opens an artifact of a kind. Client-safe, no runtime
 * imports — the panel and the admin pane are browser code, same reasoning as
 * `kinds.ts` beside this file. What is here is the vocabulary the browser and
 * the server must agree on: which kinds have a tour, and the wire shapes of
 * the two tour routes.
 */
import type { ArtifactKind } from "./kinds";

/**
 * Every kind a tour's COPY can exist for. Ruling 8: File gets no tour,
 * because `produce_file` already exists and File is not a new kind — a tour
 * would explain something the user already knows. `Exclude` rather than a
 * hand-written union: adding a kind to `ArtifactKind` widens this
 * automatically, and `ARTIFACT_TOUR_DEFAULTS`
 * (`$lib/server/artifact-tour-defaults`) then fails to compile until the new
 * kind has shipped copy — a missing tour is loud, a silently-untoured kind is
 * not.
 *
 * Having copy is not shipping: see `SHIPPED_ARTIFACT_TOUR_TYPES`.
 */
export type ArtifactTourType = Exclude<ArtifactKind, "file">;

/**
 * The kinds whose tour ships — the ONE list (ruling 69: Slides is shelved, so
 * three tours ship until it comes back). The tour routes, the resolver, the
 * admin seeding and the account archive's labels all read this list, so a kind
 * that is not on it is not served (a 404, like any unknown path segment), not
 * seeded as a draft and not shown. Its default copy may stay in
 * `ARTIFACT_TOUR_DEFAULTS` for the day it ships; being in that table reaches
 * nobody.
 *
 * Bringing Slides back is one entry here, in the same commit as Slides
 * itself, and nothing else: the table already has its copy.
 */
export const SHIPPED_ARTIFACT_TOUR_TYPES = [
	"document",
	"app",
	"canvas",
] as const satisfies readonly ArtifactTourType[];

export type ShippedArtifactTourType =
	(typeof SHIPPED_ARTIFACT_TOUR_TYPES)[number];

/**
 * Narrows an untyped path segment, body field or open item's kind to a
 * shipped tour kind. A membership test on the list, never a property lookup
 * on an object: `"toString"` and `"__proto__"` are keys of every object and
 * must not read as kinds.
 */
export function isShippedArtifactTourType(
	value: unknown,
): value is ShippedArtifactTourType {
	return (
		typeof value === "string" &&
		(SHIPPED_ARTIFACT_TOUR_TYPES as readonly string[]).includes(value)
	);
}

/** A tour is three slides: the user asked three questions, and so does it. */
export const ARTIFACT_TOUR_SLIDE_COUNT = 3;

export type LocalizedText = { en: string; hu: string };

export type ArtifactTourSlideContent = {
	title: LocalizedText;
	body: LocalizedText;
};

export type ResolvedArtifactTour = {
	artifactType: ShippedArtifactTourType;
	/** `snapshot:<id>` for a published campaign, `default:<version>` for the code copy. */
	contentKey: string;
	source: "published" | "default";
	/** Always three, in order. A published tour with any other count is not publishable. */
	slides: ArtifactTourSlideContent[];
	/** The kind's empty-state line, from the summary slide (or the code default). */
	summary: LocalizedText;
};

export type ArtifactTourState = { seen: boolean; lastSlide: number };

/**
 * `GET /api/artifact-tours/[type]` without the success marker the route also
 * carries (`ok: true`, ruling 49 — the browser module reads it and leaves it
 * behind, as `fetchArtifact` does). `tour` is `null` when the kind's tour was
 * retired by archiving its campaign: a 200, never an error.
 */
export type ArtifactTourResponse = ArtifactTourState & {
	tour: ResolvedArtifactTour | null;
};

export type ArtifactTourSeenStatus = "completed" | "dismissed";

/** The body of `POST /api/artifact-tours/[type]/seen`. */
export type ArtifactTourSeenRequest = {
	/** The `contentKey` of the tour the user was shown. */
	contentKey: string;
	status: ArtifactTourSeenStatus;
	/** 0-based, `0 .. ARTIFACT_TOUR_SLIDE_COUNT - 1`: where the user was. */
	lastSlide: number;
};

/** The answer of `POST /api/artifact-tours/[type]/seen`, as the success shape of the family. */
export type ArtifactTourSeenResponse = {
	ok: true;
	/** A row for this user, kind and content already existed: nothing was written. */
	alreadyRecorded: boolean;
};
