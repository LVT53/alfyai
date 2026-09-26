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
	createCampaignDraft,
	getCampaignById,
	updateCampaignDraft,
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

/** Admin-facing draft name per kind. Never "Artifact" (ADR-0066); the kind's
 *  own ratified name is enough context in the campaign rail. */
const TOUR_DRAFT_NAMES: Record<ArtifactTourType, string> = {
	document: "Document tour",
	app: "App tour",
	canvas: "Canvas tour",
	slides: "Slides tour",
};

/**
 * The seed's summary-slide body is a placeholder, not shipped copy: the
 * summary slide's TITLE carries the real one-line summary
 * (`ARTIFACT_TOUR_DEFAULTS[kind].summary`, the same text the code default and
 * the empty state show), but a campaign slide's smaller second-line body has
 * no shipped equivalent to seed — the same reason `seedFirstRunOnboardingTemplate`
 * seeds "Replace this draft copy with admin-authored campaign content." for
 * its own non-critical slide.
 */
const TOUR_SUMMARY_BODY_PLACEHOLDER = {
	en: "Add a short second line here, shown under the artwork.",
	hu: "Adj hozzá egy rövid második sort, ami a kép alatt jelenik meg.",
};

/**
 * Seeds one `artifact_tour` draft per kind — document, app, canvas, slides —
 * each with the shipped default copy pre-filled (Task T2's
 * `ARTIFACT_TOUR_DEFAULTS`) so an admin reviews and publishes real content
 * rather than starting from a blank campaign. `releaseVersion` is set to the
 * kind, which `defaultVersionFor` uses as the campaign version for
 * `artifact_tour`, giving four distinct identities
 * (`artifact_tour:<kind>:r1`) instead of four revisions of one version
 * string — see slice-6.md "The identity rule for four drafts".
 *
 * Idempotent per kind, like `seedFirstRunOnboardingTemplate`: a kind that
 * already has a campaign row (draft, published or archived) is left alone
 * and counted as `existing`, never duplicated or overwritten.
 */
export async function seedArtifactTourDrafts(
	createdByUserId: string,
	options: CampaignServiceOptions = {},
): Promise<{ created: number; existing: number }> {
	const db = database(options);
	let created = 0;
	let existing = 0;

	for (const kind of Object.keys(
		ARTIFACT_TOUR_DEFAULTS,
	) as ArtifactTourType[]) {
		const existingRow = db
			.select({ id: announcementCampaigns.id })
			.from(announcementCampaigns)
			.where(
				and(
					eq(announcementCampaigns.type, "artifact_tour"),
					eq(announcementCampaigns.releaseVersion, kind),
				),
			)
			.get();
		if (existingRow) {
			existing += 1;
			continue;
		}

		const defaults = ARTIFACT_TOUR_DEFAULTS[kind];
		const campaign = await createCampaignDraft(
			{
				type: "artifact_tour",
				name: TOUR_DRAFT_NAMES[kind],
				releaseVersion: kind,
				createdByUserId,
			},
			{ db },
		);
		await updateCampaignDraft(
			campaign.id,
			{
				slides: [
					{
						layoutType: "summary",
						sortOrder: 1,
						title: defaults.summary,
						body: TOUR_SUMMARY_BODY_PLACEHOLDER,
					},
					...defaults.slides.map((slide, index) => ({
						layoutType: "standard",
						sortOrder: index + 2,
						title: slide.title,
						body: slide.body,
					})),
				],
			},
			{ db },
		);
		created += 1;
	}

	return { created, existing };
}
