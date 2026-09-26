/**
 * First-open tours (Feature 2 · Artifacts, Slice 6): a three-slide card shown
 * the first time a user opens an artifact of a kind. Client-safe, type-only,
 * no runtime imports — the panel and the admin pane are browser code, same
 * reasoning as `kinds.ts` beside this file.
 */
import type { ArtifactKind } from "./kinds";

/**
 * Ruling 8: File gets no tour, because `produce_file` already exists and File
 * is not a new kind — a tour would explain something the user already knows.
 * `Exclude` rather than a hand-written four-literal union: adding a kind to
 * `ArtifactKind` widens this automatically, and `ARTIFACT_TOUR_DEFAULTS`
 * (`$lib/server/artifact-tour-defaults`) then fails to compile until the new
 * kind has shipped copy — a missing tour is loud, a silently-untoured kind is
 * not.
 */
export type ArtifactTourType = Exclude<ArtifactKind, "file">;

export type LocalizedText = { en: string; hu: string };

export type ArtifactTourSlideContent = {
	title: LocalizedText;
	body: LocalizedText;
};

export type ResolvedArtifactTour = {
	artifactType: ArtifactTourType;
	/** `snapshot:<id>` for a published campaign, `default:<version>` for the code copy. */
	contentKey: string;
	source: "published" | "default";
	/** Always three, in order. A published tour with any other count is not publishable. */
	slides: ArtifactTourSlideContent[];
	/** The kind's empty-state line, from the summary slide (or the code default). */
	summary: LocalizedText;
};

export type ArtifactTourState = { seen: boolean; lastSlide: number };
