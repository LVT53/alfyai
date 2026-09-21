// "Re-extract at a higher quality tier".
//
// Keyed on the artifact, exactly like Retry and Cancel, so the client never
// has to know whether a ledger row exists: a document that predates the ledger
// is answered by the read model with a synthesised row and materialised here
// before it is requeued.
//
// Every unownable case answers 404 with one code. "Not yours", "no such
// artifact" and "not an extractable document" must be indistinguishable from
// outside, or the endpoint becomes an oracle for which artifact ids exist in
// another account. The refusals that are NOT about ownership — the tier is not
// offered, a job is already running, the attempt ceiling is reached — say so,
// because by then the caller has already proved the document is theirs.
//
// The tier is validated against the server's own `/v1/tiers` BEFORE any job is
// written. A tier MinerU does not serve is a 400 `invalid_request` from the
// backend three seconds into an attempt, i.e. a failed job and a wasted
// attempt for a mistake that was knowable up front.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getExtractionJobById,
	getExtractionJobForArtifact,
	materializeLegacyExtractionJob,
	wakeExtractionWorker,
} from "$lib/server/services/extraction";
import { requeueExtractionJobForReextraction } from "$lib/server/services/extraction/reextract";
import { getArtifactForUser } from "$lib/server/services/knowledge/store/core";
import { getMineruCapabilities } from "$lib/server/services/mineru/capabilities";
import {
	MINERU_TIER_IDS,
	type MineruTierId,
	mineruTierRank,
} from "$lib/server/services/mineru/config";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import type { RequestHandler } from "./$types";

/**
 * The one answer every ownership failure gives. Same code as the Retry route's,
 * because a client that can tell the two apart can tell the two apart for
 * somebody else's artifact id too.
 */
function notFound() {
	return json(
		{
			error: "Extraction job not found or not re-extractable",
			code: "extraction_job_not_found",
		},
		{ status: 404 },
	);
}

function isMineruTierId(value: unknown): value is MineruTierId {
	return (
		typeof value === "string" &&
		(MINERU_TIER_IDS as readonly string[]).includes(value)
	);
}

/**
 * The document must be one the MinerU route owns. A direct-text upload has no
 * tiers to choose between, and a generated output has no source bytes at all.
 * A legacy row reports `mineru` by construction (read-model), which is what
 * keeps D12's "the only path back for an old document" promise working.
 */
function isReextractable(job: DocumentExtractionJobDTO): boolean {
	return job.intakeRoute === "mineru" && Boolean(job.sourceArtifactId);
}

async function resolveJob(userId: string, artifactId: string) {
	const job = await getExtractionJobForArtifact({ userId, artifactId });
	return job && isReextractable(job) ? job : null;
}

/**
 * The tier this document's text was actually produced at — `extractionTier`,
 * the per-file `extensions.mineru.tier`, NOT the job's, which lies for
 * Office/HTML inside a `standard` job.
 *
 * `persist.ts` writes it onto the source artifact as well as the normalized
 * one, which is the row this route already owns by id. A document parsed
 * before Phase 4 has no such key and comes back null: `mineruTierRank` ranks
 * that below every real tier, so every offer is an upgrade for it.
 */
async function currentEffectiveTier(
	userId: string,
	artifactId: string,
): Promise<string | null> {
	const artifact = await getArtifactForUser(userId, artifactId);
	const tier = artifact?.metadata?.extractionTier;
	return typeof tier === "string" && tier ? tier : null;
}

/** The tiers this server actually serves, or a 503-shaped refusal. */
async function readTiers(): Promise<
	| { ok: true; tiers: readonly MineruTierId[] }
	| { ok: false; response: Response }
> {
	try {
		const capabilities = await getMineruCapabilities();
		return { ok: true, tiers: capabilities.tiers };
	} catch (error) {
		// The taxonomy code doubles as the client's i18n key
		// (`knowledge.extraction.error.<code>`), so an unreachable backend reads
		// as "the service is unavailable" rather than as a client mistake.
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code: unknown }).code)
				: "unavailable";
		return {
			ok: false,
			response: json({ error: "MinerU is unavailable", code }, { status: 503 }),
		};
	}
}

/**
 * The tier menu for one document: what the server offers, and where this
 * document already is. Fetched when the menu opens rather than with the page,
 * so a library of fifty rows costs zero capability probes until someone asks.
 */
export const GET: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = event.locals.user;
	const artifactId = event.params.artifactId?.trim();
	if (!artifactId) return notFound();

	const job = await resolveJob(user.id, artifactId);
	if (!job) return notFound();

	const tiers = await readTiers();
	if (!tiers.ok) return tiers.response;

	// Only UPGRADES are offered. The "don't go backwards" rule used to live in
	// the component alone, which made the menu a suggestion rather than a rule;
	// POST now refuses a lower or equal tier outright, so a menu that still
	// listed one would be offering a 400. `currentTier` rides along so the UI
	// can say where the document already is without a second request.
	const currentTier = await currentEffectiveTier(user.id, artifactId);
	const currentRank = mineruTierRank(currentTier);

	return json({
		tiers: tiers.tiers.filter((tier) => mineruTierRank(tier) > currentRank),
		currentTier,
	});
};

export const POST: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = event.locals.user;
	const artifactId = event.params.artifactId?.trim();
	if (!artifactId) return notFound();

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		body = null;
	}
	const requestedTier =
		body && typeof body === "object" && !Array.isArray(body)
			? (body as { tier?: unknown }).tier
			: undefined;
	// Not sent by any UI, on purpose. An operator re-reading a document at the
	// same tier after changing `MINERU_OCR_MODE`, or after a MinerU upgrade,
	// has a real reason to; a user clicking a menu item never does.
	const force =
		body && typeof body === "object" && !Array.isArray(body)
			? (body as { force?: unknown }).force === true
			: false;

	const job = await resolveJob(user.id, artifactId);
	if (!job) return notFound();

	// Ownership first, then the request. A malformed body from a stranger must
	// still look like an unknown artifact.
	if (!isMineruTierId(requestedTier)) {
		return json(
			{
				error: "Unknown extraction tier",
				code: "tier_unavailable",
			},
			{ status: 400 },
		);
	}

	const tiers = await readTiers();
	if (!tiers.ok) return tiers.response;
	if (!tiers.tiers.includes(requestedTier)) {
		return json(
			{
				error: `Tier '${requestedTier}' is not available on this server`,
				code: "tier_unavailable",
				tiers: tiers.tiers,
			},
			{ status: 400 },
		);
	}

	// A re-extraction REPLACES the text, the chunks and the bundle. Asking for
	// a tier at or below the one the document already carries therefore throws
	// away a better parse for a worse one — silently, because the job succeeds.
	// The component disabled those menu items, but a client is not a guard: the
	// server is the only place this can be enforced, and it is enforced BEFORE
	// any job row is touched so a refused request costs nothing.
	const currentTier = await currentEffectiveTier(user.id, artifactId);
	if (!force && mineruTierRank(requestedTier) <= mineruTierRank(currentTier)) {
		return json(
			{
				error: `Tier '${requestedTier}' is not higher than the current '${currentTier ?? "unknown"}'`,
				code: "tier_not_higher",
				currentTier,
			},
			{ status: 400 },
		);
	}

	let jobId = job.id;
	if (job.legacy) {
		const materialized = await materializeLegacyExtractionJob({
			userId: user.id,
			sourceArtifactId: artifactId,
			fileName: job.fileName,
		});
		if (!materialized) return notFound();
		jobId = materialized.id;
	}

	// The tier reaches the extractor as a validated ledger hint, never as the
	// request body: `hints` is durable, survives the enqueue → claim → attempt
	// round trip, and is the only input `decideTier` accepts as an override.
	const requeued = await requeueExtractionJobForReextraction({
		userId: user.id,
		jobId,
		hints: { tier: requestedTier },
	});

	if (!requeued.ok) {
		if (requeued.reason === "active") {
			return json(
				{
					error: "This document is already being processed",
					code: "extraction_job_active",
				},
				{ status: 409 },
			);
		}
		if (requeued.reason === "attempt_ceiling") {
			return json(
				{
					error: "This document has used all of its extraction attempts",
					code: "max_attempts",
				},
				{ status: 409 },
			);
		}
		return notFound();
	}

	wakeExtractionWorker();

	const dto = await getExtractionJobById({ userId: user.id, jobId });
	if (!dto) return notFound();

	return json({ job: dto });
};
