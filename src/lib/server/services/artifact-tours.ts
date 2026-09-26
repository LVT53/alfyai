/**
 * First-open tours (Feature 2 · Artifacts, Slice 6): resolves the tour a
 * kind should show right now — a published `artifact_tour` campaign
 * snapshot when one exists, the code-owned default
 * (`$lib/server/artifact-tour-defaults`) otherwise — and reports whether
 * this user has already seen that exact content.
 *
 * This is a thin reader on top of `announcement-campaigns.ts`: it reuses
 * `getCampaignById` for snapshot assembly rather than re-implementing
 * snapshot mapping, and it never trusts the campaign tables enough to let a
 * read failure reach the panel as an error (see `getArtifactTour`).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
	ARTIFACT_TOUR_CONTENT_VERSION,
	ARTIFACT_TOUR_DEFAULTS,
} from "$lib/server/artifact-tour-defaults";
import { db as defaultDb } from "$lib/server/db";
import {
	announcementCampaigns,
	artifactTourStates,
} from "$lib/server/db/schema";
import type {
	ArtifactTourSlideContent,
	ArtifactTourType,
	LocalizedText,
	ResolvedArtifactTour,
} from "$lib/shared/artifacts/tours";
import {
	type CampaignServiceOptions,
	getCampaignById,
} from "./announcement-campaigns";

type ArtifactToursDb = typeof defaultDb;

function database(options: CampaignServiceOptions = {}): ArtifactToursDb {
	return options.db ?? defaultDb;
}

export type ArtifactTourLookup = {
	tour: ResolvedArtifactTour;
	seen: boolean;
	lastSlide: number;
};

function defaultTour(artifactType: ArtifactTourType): ResolvedArtifactTour {
	const content = ARTIFACT_TOUR_DEFAULTS[artifactType];
	return {
		artifactType,
		contentKey: `default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
		source: "default",
		slides: content.slides,
		summary: content.summary,
	};
}

/**
 * The current live-or-retired `artifact_tour` campaign for this kind, if one
 * was ever published. Ordered by `revision` (which only increases per
 * (type, releaseVersion), see `announcement-campaigns.ts`'s `nextRevision`),
 * so the top row is always the latest publish-or-archive action for this
 * kind — a draft created after an archive does not resurrect the tour until
 * IT is published.
 */
async function currentCampaignForKind(
	db: ArtifactToursDb,
	artifactType: ArtifactTourType,
) {
	return db
		.select()
		.from(announcementCampaigns)
		.where(
			and(
				eq(announcementCampaigns.type, "artifact_tour"),
				eq(announcementCampaigns.releaseVersion, artifactType),
				inArray(announcementCampaigns.status, ["published", "archived"]),
			),
		)
		.orderBy(desc(announcementCampaigns.revision))
		.get();
}

function toSlideContent(slide: {
	title: LocalizedText;
	body: LocalizedText;
}): ArtifactTourSlideContent {
	return { title: slide.title, body: slide.body };
}

/**
 * Maps a published snapshot's slides into the panel shape, or `null` if they
 * are not shaped like a tour (exactly one `summary` slide plus three
 * `standard` slides). T5's publish validation refuses to publish anything
 * else, but this reader never assumes that — an unreadable/malformed
 * snapshot is treated the same as a campaign read failure: fall back to the
 * default rather than show a broken card.
 */
function resolvePublishedTour(
	artifactType: ArtifactTourType,
	snapshot: {
		id: string;
		slides: Array<{
			layoutType: string;
			sortOrder: number;
			title: LocalizedText;
			body: LocalizedText;
		}>;
	},
): ResolvedArtifactTour | null {
	const ordered = [...snapshot.slides].sort(
		(a, b) => a.sortOrder - b.sortOrder,
	);
	const summarySlide = ordered.find((slide) => slide.layoutType === "summary");
	const standardSlides = ordered.filter(
		(slide) => slide.layoutType === "standard",
	);
	if (!summarySlide || standardSlides.length !== 3) return null;
	return {
		artifactType,
		contentKey: `snapshot:${snapshot.id}`,
		source: "published",
		// The summary slide's TITLE is the empty state's one-line text; its
		// body is the tour's own smaller second line (slice-6 spec, "The
		// shipped copy").
		summary: summarySlide.title,
		slides: standardSlides.map(toSlideContent),
	};
}

/**
 * Resolves the tour for `params.artifactType` and this user's seen state
 * against it. Returns `null` only when the kind's tour has been
 * DELIBERATELY retired (its latest campaign is archived, and archiving must
 * not silently resurrect the default — decisions.md ruling 4) or when the
 * kind is not a real tour type at all; every other path — including a
 * broken campaign table — resolves to a tour, because the four shipped
 * kinds always have a code default.
 */
export async function getArtifactTour(params: {
	userId: string;
	artifactType: ArtifactTourType;
	options?: CampaignServiceOptions;
}): Promise<ArtifactTourLookup | null> {
	const hasDefault = params.artifactType in ARTIFACT_TOUR_DEFAULTS;
	if (!hasDefault) return null;

	const db = database(params.options);
	let tour: ResolvedArtifactTour = defaultTour(params.artifactType);

	try {
		const campaign = await currentCampaignForKind(db, params.artifactType);
		if (campaign) {
			if (campaign.status === "archived") {
				// A deliberate retirement: the kind has no tour at all right now,
				// and the code default must not silently reappear behind it.
				return null;
			}
			const full = await getCampaignById(campaign.id, { db });
			const resolved = full?.snapshot
				? resolvePublishedTour(params.artifactType, full.snapshot)
				: null;
			if (resolved) tour = resolved;
		}
	} catch (error) {
		console.warn(
			"[ARTIFACT_TOURS] Campaign read failed; showing the default tour instead:",
			error,
		);
	}

	const state = db
		.select()
		.from(artifactTourStates)
		.where(
			and(
				eq(artifactTourStates.userId, params.userId),
				eq(artifactTourStates.artifactType, params.artifactType),
				eq(artifactTourStates.contentKey, tour.contentKey),
			),
		)
		.get();

	return {
		tour,
		seen: Boolean(state),
		lastSlide: state?.lastSlide ?? 0,
	};
}
