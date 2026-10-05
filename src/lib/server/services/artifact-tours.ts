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
 *
 * Which kinds have a tour at all is `SHIPPED_ARTIFACT_TOUR_TYPES`
 * (`$lib/shared/artifacts/tours`, ruling 69): the resolver, the seen write and
 * the admin seeding below all read that one list, and no function here
 * answers for a kind that is not on it.
 *
 * Nothing in this module reads an artifact, a conversation or a chat file —
 * the seen state names a user, a kind and a content key and no more
 * (ruling 33), and `tests/cross-cutting/incognito-artifact-containment.test.ts`
 * pins that it stays so.
 */
import { randomUUID } from "node:crypto";
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
import {
	ARTIFACT_TOUR_SLIDE_COUNT,
	type ArtifactTourSeenRequest,
	type ArtifactTourSlideContent,
	isShippedArtifactTourType,
	type LocalizedText,
	type ResolvedArtifactTour,
	SHIPPED_ARTIFACT_TOUR_TYPES,
	type ShippedArtifactTourType,
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

function defaultTour(
	artifactType: ShippedArtifactTourType,
): ResolvedArtifactTour {
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
	artifactType: ShippedArtifactTourType,
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
	artifactType: ShippedArtifactTourType,
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
 * The tour that is current for a kind right now, independent of any user: a
 * published campaign's snapshot when one exists, the code default otherwise,
 * and `null` only when the kind's tour has been DELIBERATELY retired (its
 * latest campaign is archived, and archiving must not silently resurrect the
 * default — decisions.md ruling 4). A broken campaign table resolves to the
 * default, never to an error: the shipped kinds always have code copy.
 *
 * One function for the read and the write, so the key the panel was shown and
 * the key the seen write is compared with can never come from two places.
 */
async function resolveCurrentTour(
	db: ArtifactToursDb,
	artifactType: ShippedArtifactTourType,
): Promise<ResolvedArtifactTour | null> {
	let tour: ResolvedArtifactTour = defaultTour(artifactType);

	try {
		const campaign = await currentCampaignForKind(db, artifactType);
		if (campaign) {
			if (campaign.status === "archived") {
				// A deliberate retirement: the kind has no tour at all right now,
				// and the code default must not silently reappear behind it.
				return null;
			}
			const full = await getCampaignById(campaign.id, { db });
			const resolved = full?.snapshot
				? resolvePublishedTour(artifactType, full.snapshot)
				: null;
			if (resolved) tour = resolved;
		}
	} catch (error) {
		console.warn(
			"[ARTIFACT_TOURS] Campaign read failed; showing the default tour instead:",
			error,
		);
	}
	return tour;
}

/**
 * Resolves the tour for `params.artifactType` and this user's seen state
 * against it. Returns `null` when the kind's tour has been deliberately
 * retired (see `resolveCurrentTour`) or when the kind is not one whose tour
 * ships (ruling 69: not Slides, never File, and nothing a hand-typed path
 * segment can name); every other path — including a broken campaign table —
 * resolves to a tour.
 */
export async function getArtifactTour(params: {
	userId: string;
	artifactType: ShippedArtifactTourType;
	options?: CampaignServiceOptions;
}): Promise<ArtifactTourLookup | null> {
	// The shipped list, not a lookup in an object literal: `in` would also
	// match inherited `Object.prototype` keys such as `toString`.
	if (!isShippedArtifactTourType(params.artifactType)) return null;

	const db = database(params.options);
	const tour = await resolveCurrentTour(db, params.artifactType);
	if (!tour) return null;

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

export type ParsedArtifactTourSeenBody =
	| { ok: true; value: ArtifactTourSeenRequest }
	| { ok: false; fieldErrors: Record<string, "invalid"> };

/**
 * Reads the body of `POST /api/artifact-tours/[type]/seen`. Hand-validated
 * like the rest of the family's routes, and it keeps only the three fields it
 * asks for: whatever else a client sends (a conversation id, an artifact id)
 * is dropped here, before anything could reach a row (ruling 33).
 */
export function parseArtifactTourSeenBody(
	payload: unknown,
): ParsedArtifactTourSeenBody {
	const body =
		payload !== null && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	const fieldErrors: Record<string, "invalid"> = {};

	const contentKey =
		typeof body.contentKey === "string" && body.contentKey.length > 0
			? body.contentKey
			: null;
	if (contentKey === null) fieldErrors.contentKey = "invalid";

	const status =
		body.status === "completed" || body.status === "dismissed"
			? body.status
			: null;
	if (status === null) fieldErrors.status = "invalid";

	const lastSlide =
		typeof body.lastSlide === "number" &&
		Number.isInteger(body.lastSlide) &&
		body.lastSlide >= 0 &&
		body.lastSlide < ARTIFACT_TOUR_SLIDE_COUNT
			? body.lastSlide
			: null;
	if (lastSlide === null) fieldErrors.lastSlide = "invalid";

	if (contentKey === null || status === null || lastSlide === null) {
		return { ok: false, fieldErrors };
	}
	return { ok: true, value: { contentKey, status, lastSlide } };
}

export type MarkArtifactTourSeenResult =
	| { ok: true; alreadyRecorded: boolean }
	| { ok: false; reason: "unknown_type" }
	/**
	 * The user was shown something other than the tour that is current now (an
	 * admin published while they were reading). `contentKey` is the current
	 * key, or `null` when the kind's tour has been retired and there is none.
	 */
	| { ok: false; reason: "content_changed"; contentKey: string | null };

/**
 * Records that this user finished or dismissed this kind's tour — once. The
 * write is insert-if-absent on the unique `(user, kind, content)` index, so a
 * retry or a second tab says `alreadyRecorded` and writes nothing, and the
 * first answer stands (a dismissal is not turned into a completion later; the
 * panel's replay writes no state at all).
 *
 * `contentKey` is trusted for exactly one thing: being compared with the tour
 * that resolves now. A mismatch is a `content_changed` refusal, never a
 * write against copy the user did not read. The row's `slide_count` is the
 * resolved tour's, not the client's.
 *
 * The row holds a user, a kind, a content key, a status and a slide index —
 * no conversation, no artifact, no copy (ruling 33) — and this is the only
 * thing a tour writes: no campaign event, no analytics, nothing in a log.
 */
export async function markArtifactTourSeen(
	params: {
		userId: string;
		artifactType: ShippedArtifactTourType;
		options?: CampaignServiceOptions;
	} & ArtifactTourSeenRequest,
): Promise<MarkArtifactTourSeenResult> {
	if (!isShippedArtifactTourType(params.artifactType)) {
		return { ok: false, reason: "unknown_type" };
	}
	const db = database(params.options);
	const tour = await resolveCurrentTour(db, params.artifactType);
	if (!tour || tour.contentKey !== params.contentKey) {
		return {
			ok: false,
			reason: "content_changed",
			contentKey: tour?.contentKey ?? null,
		};
	}

	const now = new Date();
	const written = db
		.insert(artifactTourStates)
		.values({
			id: randomUUID(),
			userId: params.userId,
			artifactType: params.artifactType,
			contentKey: tour.contentKey,
			status: params.status,
			slideCount: tour.slides.length,
			lastSlide: params.lastSlide,
			completedAt: params.status === "completed" ? now : null,
			dismissedAt: params.status === "dismissed" ? now : null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.run();
	return { ok: true, alreadyRecorded: written.changes === 0 };
}

/** Admin-facing draft name per kind. Never "Artifact" (ADR-0066); the kind's
 *  own ratified name is enough context in the campaign rail. */
const TOUR_DRAFT_NAMES: Record<ShippedArtifactTourType, string> = {
	document: "Document tour",
	app: "App tour",
	canvas: "Canvas tour",
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
 * Seeds one `artifact_tour` draft per shipped kind — document, app, canvas
 * (`SHIPPED_ARTIFACT_TOUR_TYPES`, ruling 69: no Slides draft while Slides is
 * shelved) — each with the shipped default copy pre-filled (Task T2's
 * `ARTIFACT_TOUR_DEFAULTS`) so an admin reviews and publishes real content
 * rather than starting from a blank campaign. `releaseVersion` is set to the
 * kind, which `defaultVersionFor` uses as the campaign version for
 * `artifact_tour`, giving four distinct identities
 * (`artifact_tour:<kind>:r1`) instead of four revisions of one version
 * string — see slice-6.md "The identity rule for four drafts" (three
 * since ruling 69).
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

	for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
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
