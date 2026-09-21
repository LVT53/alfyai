// The `indexing` phase: everything `createNormalizedArtifact` used to do AFTER
// extraction, with the extraction call removed.
//
// It is a separate phase in the ledger rather than a tail on the parse because
// it is genuinely slow and genuinely different: `createArtifact` chunks the
// text, inserts every chunk row and queues an embedding refresh, which for a
// multi-megabyte markdown is thousands of writes. A UI that says "parsing"
// through all of it is lying about where the time is going.
//
// Runs OUTSIDE any ledger transaction. The job is moved to `indexing` first,
// this runs, and only then does the job go `succeeded` — so a crash in the
// middle leaves a job whose heartbeat stops, which stale recovery requeues.

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import {
	estimateDocumentTokenCount,
	extractDocumentOutline,
	MAX_OUTLINE_ENTRIES,
} from "$lib/server/services/knowledge/outline";
import {
	createArtifact,
	createArtifactLink,
	getNormalizedArtifactForSource,
	guessSummary,
	mapArtifact,
	updateArtifactMetadata,
} from "$lib/server/services/knowledge/store/core";
import type {
	Artifact,
	DocumentOutlineEntry,
} from "$lib/server/services/knowledge/types";
import type { MineruParseBundleManifest } from "$lib/server/services/mineru/bundle";
import { setMineruParseBundleNormalizedArtifactId } from "$lib/server/services/mineru/bundle";
import type {
	ChunkPlanEntry,
	MineruOutlineEntry,
	StructuredExtractionResult,
} from "$lib/server/services/mineru/result";
import { planStructuredChunks } from "$lib/server/services/mineru/result";
import { queueArtifactSemanticEmbeddingRefresh } from "$lib/server/services/semantic-embedding-refresh";
import {
	CHUNK_CHAR_OVERLAP,
	CHUNK_CHAR_TARGET,
	syncArtifactChunks,
} from "$lib/server/services/task-state/chunk-sync";

export interface CreateNormalizedArtifactFromExtractionParams {
	userId: string;
	conversationId?: string | null;
	sourceArtifactId: string;
	sourceName: string;
	text: string;
	normalizedName: string;
	mimeType: string;
	pageCount?: number;
	/**
	 * Backend-specific structured payload, opaque to the ledger and the worker.
	 * `narrowStructuredExtraction` is the only thing that reads it, and it
	 * accepts exactly two shapes — see that function.
	 */
	structured?: unknown;
}

/**
 * Text in, normalized artifact out.
 *
 * "Long-document comfort" (owner-approved mockup, 2026-09-06) is computed once
 * here and stored on BOTH artifacts: the normalized one carries the full text,
 * but the source artifact is the one shown to the user as an attachment chip,
 * so the token estimate and outline have to live there too.
 */
export async function createNormalizedArtifactFromExtraction(
	params: CreateNormalizedArtifactFromExtractionParams,
): Promise<Artifact> {
	const structured = narrowStructuredExtraction(params.structured);
	const tokenEstimate = estimateDocumentTokenCount(params.text);
	// Structured parses carry their own outline, which already falls back to
	// `extractDocumentOutline` internally for the formats that have no title
	// blocks (CSV) and for producers that type their headings as bold body
	// text. The direct-text route has no blocks at all, so it stays on the
	// heuristics exactly as before.
	const outline = structured
		? normalizeStructuredOutline(structured.outline)
		: extractDocumentOutline(params.text);
	const pageCount = structured ? structured.pageCount : params.pageCount;

	// The blocks are the atoms a structure-aware chunker packs, and this is the
	// only place that holds both them and the artifact they belong to. The plan
	// is passed down rather than the blocks: `chunk-sync.ts` keeps its current
	// dependency set that way, and never has to read the bundle off disk.
	const chunkPlan = structured ? buildChunkPlan(structured) : null;

	const comfortMetadataPatch: Record<string, unknown> = {
		tokenEstimate,
		...(structured ? clearedStructuredMetadata() : {}),
		...(pageCount !== undefined ? { pageCount } : {}),
		...(outline.length > 0 ? { outline } : {}),
		...(structured ? structuredMetadata(structured) : {}),
	};

	const metadata = {
		sourceArtifactId: params.sourceArtifactId,
		normalizedFrom: params.sourceName,
		...comfortMetadataPatch,
	};

	// A source document may only ever have ONE normalized artifact.
	//
	// A second extraction of the same source is not hypothetical: a worker that
	// dies between the artifact insert and `completeExtractionAttempt` leaves an
	// `indexing` job that stale recovery requeues, and a cancel that lands while
	// the chunk inserts are running does the same thing in a second. Creating a
	// fresh artifact on that second pass is worse than a duplicate row —
	// `getNormalizedArtifactForSource` orders by the link's `created_at` and
	// takes the FIRST, so the prompt pipeline would keep reading the OLD text
	// while the ledger's `normalized_artifact_id` pointed at the new one, and
	// both artifacts' chunks would answer the same retrieval query.
	//
	// Rewriting the existing artifact in place keeps the id (so every
	// `derived_from` link, working-set item and evidence link stays valid) and
	// makes a re-extraction idempotent.
	const existing = await getNormalizedArtifactForSource(
		params.userId,
		params.sourceArtifactId,
	);
	const artifact = existing
		? await rewriteNormalizedArtifact({
				existingId: existing.id,
				userId: params.userId,
				normalizedName: params.normalizedName,
				mimeType: params.mimeType,
				text: params.text,
				sourceName: params.sourceName,
				metadata,
				chunkPlan,
			})
		: await createNewNormalizedArtifact({ params, metadata, chunkPlan });

	await updateArtifactMetadata({
		artifactId: params.sourceArtifactId,
		userId: params.userId,
		patch: comfortMetadataPatch,
	});

	if (structured?.bundle) {
		// The extractor writes the bundle while it still holds the downloaded
		// zip — a per-attempt temp directory that is gone by the time this runs —
		// and leaves `normalizedArtifactId` null because the artifact did not
		// exist yet. This is the one moment that id is knowable. A false return
		// means the bundle vanished between the two writes (a concurrent
		// delete), which is not worth failing a completed extraction over.
		await setMineruParseBundleNormalizedArtifactId(
			params.userId,
			params.sourceArtifactId,
			artifact.id,
		).catch(() => false);
	}

	return artifact;
}

/**
 * The structure-aware chunk plan, or null when there is nothing to plan from.
 *
 * A plan is advisory: `syncArtifactChunks` still applies the small-file bypass
 * and the structure-chunking flag on top of it, and falls back to the
 * character chunker when either says no. So a failure to build one is not a
 * failure to extract — it costs page citations, not the document.
 */
function buildChunkPlan(
	structured: StructuredExtractionHandoff,
): ChunkPlanEntry[] | null {
	if (structured.blocks.length === 0) return null;
	try {
		// The sizes come from the chunker itself rather than being restated
		// here: a plan built to a different target would silently produce rows
		// of a different size than every other document's.
		const plan = planStructuredChunks({
			blocks: structured.blocks,
			charTarget: CHUNK_CHAR_TARGET,
			charOverlap: CHUNK_CHAR_OVERLAP,
		});
		return plan.length > 0 ? plan : null;
	} catch (error) {
		console.warn("[EXTRACTION] Structured chunk plan failed; using the text", {
			error: error instanceof Error ? error.message : error,
		});
		return null;
	}
}

// ── the structured hand-off ────────────────────────────────────────────────

/**
 * What `ExtractDocumentResult.structured` is: a `StructuredExtractionResult`
 * spread flat, plus the parse bundle's manifest.
 *
 * The extractor writes the bundle, not this module — it is the only party that
 * ever holds the downloaded `result.zip`, which lives in a per-attempt temp
 * directory that is removed the moment `extract()` returns. It leaves
 * `manifest.normalizedArtifactId` null because the artifact does not exist
 * yet, and sets `bundle` to null when it had no `userId`/`sourceArtifactId` to
 * write under or when the write failed. A null bundle is not an error: the
 * text is what the user asked for, and a readable document with no figures on
 * disk beats a failed extraction that retries three times and ends with
 * neither.
 *
 * Narrowed structurally, and only here. `contracts.ts` types the field as
 * `unknown` so the ledger never learns a backend's vocabulary, and an import
 * guard keeps this module off `extractors/**` — so the shape is checked, not
 * assumed, and an unrecognised payload is simply "no structured data". The
 * direct-text route and the generated-file readback both go down that path.
 */
interface StructuredExtractionHandoff extends StructuredExtractionResult {
	bundle?: MineruParseBundleManifest | null;
}

export function narrowStructuredExtraction(
	value: unknown,
): StructuredExtractionHandoff | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<StructuredExtractionHandoff>;
	const looksParsed =
		typeof candidate.parserVersion === "string" &&
		typeof candidate.markdown === "string" &&
		typeof candidate.pageCount === "number" &&
		typeof candidate.pageCountKind === "string" &&
		Array.isArray(candidate.pages) &&
		Array.isArray(candidate.blocks) &&
		Array.isArray(candidate.figures) &&
		Array.isArray(candidate.outline) &&
		typeof candidate.stats === "object" &&
		candidate.stats !== null;
	return looksParsed ? (value as StructuredExtractionHandoff) : null;
}

// ── metadata ───────────────────────────────────────────────────────────────

/**
 * Every key a structured parse owns. Listed once, and written as `undefined`
 * before the real values are spread on top, so a re-extraction cannot leave a
 * previous parse's tier, figure count or unknown-block census sitting on a row
 * that no longer has one: `updateArtifactMetadata` merges the patch and then
 * `JSON.stringify` drops the undefined members, which is a removal.
 */
const STRUCTURED_METADATA_KEYS = [
	"pageCount",
	"pageCountKind",
	"outline",
	"extractionProducer",
	"extractionProducerVersion",
	"extractionServerParserVersion",
	"extractionParserVersion",
	"extractionTier",
	"extractionJobTier",
	"extractionParseMode",
	"extractionBundleBytes",
	"extractionFigureCount",
	"extractionImagesOmitted",
	"extractionUnknownBlockTypes",
	"extractionBundleMissing",
] as const;

function clearedStructuredMetadata(): Record<string, undefined> {
	const cleared: Record<string, undefined> = {};
	for (const key of STRUCTURED_METADATA_KEYS) cleared[key] = undefined;
	return cleared;
}

function structuredMetadata(
	result: StructuredExtractionHandoff,
): Record<string, unknown> {
	const unknownTypes = result.stats.unknownTypes ?? {};
	const bundle = result.bundle ?? null;
	return {
		pageCountKind: result.pageCountKind,
		// The legacy marker (D12): a row without it predates this extractor and
		// is identified by that absence, never by a backfill.
		extractionProducer: "mineru",
		extractionProducerVersion: result.producerVersion ?? undefined,
		extractionServerParserVersion: result.serverParserVersion ?? undefined,
		extractionParserVersion: result.parserVersion,
		// `extensions.mineru.tier`, not the job's tier: a `basic` job runs
		// Office/HTML/CSV/EPUB at `flash`, and showing the job's answer would
		// tell an admin their tier setting did something it did not do.
		extractionTier: result.effectiveTier ?? undefined,
		extractionJobTier: result.jobTier ?? undefined,
		extractionParseMode: result.parseMode ?? undefined,
		extractionFigureCount: result.figures.length,
		...(bundle
			? {
					extractionBundleBytes: bundle.totalBytes,
					extractionImagesOmitted: bundle.imagesOmitted,
				}
			: // Recorded rather than inferred from the absence of the two keys
				// above: "this document parsed but has no bundle on disk" is the
				// difference between a missing figure and a missing feature, and
				// it is the row an operator looks at to tell them apart.
				{ extractionBundleMissing: true }),
		...(Object.keys(unknownTypes).length > 0
			? { extractionUnknownBlockTypes: unknownTypes }
			: {}),
	};
}

/**
 * Block-derived outline entries, trimmed to what storage promises: the same
 * `MAX_OUTLINE_ENTRIES` cap the heuristic producer honours, and a `page` only
 * when it is a real 1-based page number.
 */
function normalizeStructuredOutline(
	entries: readonly MineruOutlineEntry[],
): DocumentOutlineEntry[] {
	return entries.slice(0, MAX_OUTLINE_ENTRIES).map((entry) => ({
		level: entry.level,
		title: entry.title,
		offset: entry.offset,
		preview: entry.preview,
		...(typeof entry.page === "number" &&
		Number.isInteger(entry.page) &&
		entry.page > 0
			? { page: entry.page }
			: {}),
	}));
}

async function createNewNormalizedArtifact(input: {
	params: CreateNormalizedArtifactFromExtractionParams;
	metadata: Record<string, unknown>;
	chunkPlan: ChunkPlanEntry[] | null;
}): Promise<Artifact> {
	const { params, metadata } = input;
	const artifact = await createArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		type: "normalized_document",
		name: params.normalizedName,
		mimeType: params.mimeType,
		extension: "txt",
		sizeBytes: Buffer.byteLength(params.text, "utf8"),
		storagePath: null,
		contentText: params.text,
		summary: guessSummary(params.text, params.sourceName),
		metadata,
		// Spread rather than written inline so this compiles against the
		// `createArtifact` that does not know the parameter yet; it is forwarded
		// verbatim to `syncArtifactChunks` by the one that does.
		...(input.chunkPlan ? { chunkPlan: input.chunkPlan } : {}),
	});

	try {
		await createArtifactLink({
			userId: params.userId,
			artifactId: artifact.id,
			relatedArtifactId: params.sourceArtifactId,
			conversationId: params.conversationId,
			linkType: "derived_from",
		});
	} catch (error) {
		// The link is what makes a normalized artifact findable: without it
		// `getNormalizedArtifactForSource` will never see this row again, so the
		// next attempt would mint a second one and the first would sit in the
		// library forever, unreachable and unowned. The commonest way to get
		// here is the source artifact being deleted while its extraction was
		// still running, in which case the link's foreign key refuses. Drop the
		// row and let the ledger see the failure — the same bargain
		// `createArtifact` strikes when chunking fails.
		await db
			.delete(artifacts)
			.where(eq(artifacts.id, artifact.id))
			.catch(() => undefined);
		throw error;
	}

	return artifact;
}

/**
 * The re-extraction path. Same work `createArtifact` does — row, chunks,
 * embedding refresh — against an id that already exists, and no second
 * `derived_from` link, because the one that made this artifact findable is
 * still there.
 */
async function rewriteNormalizedArtifact(input: {
	existingId: string;
	userId: string;
	normalizedName: string;
	mimeType: string;
	text: string;
	sourceName: string;
	metadata: Record<string, unknown>;
	chunkPlan: ChunkPlanEntry[] | null;
}): Promise<Artifact> {
	const [updated] = await db
		.update(artifacts)
		.set({
			name: input.normalizedName,
			mimeType: input.mimeType,
			sizeBytes: Buffer.byteLength(input.text, "utf8"),
			contentText: input.text,
			summary: guessSummary(input.text, input.sourceName),
			metadataJson: JSON.stringify(input.metadata),
			updatedAt: new Date(),
		})
		.where(eq(artifacts.id, input.existingId))
		.returning();

	if (!updated) {
		throw new Error(
			`Normalized artifact ${input.existingId} disappeared during re-extraction`,
		);
	}

	let mapped = mapArtifact(updated);
	const sync = await syncArtifactChunks({
		artifactId: mapped.id,
		userId: mapped.userId,
		conversationId: mapped.conversationId,
		contentText: mapped.contentText,
		// Re-extraction re-derives every chunk row, so the new parse's pages
		// replace the old parse's rather than being migrated onto them.
		...(input.chunkPlan ? { chunkPlan: input.chunkPlan } : {}),
	});
	if (sync.truncated) {
		// Same bookkeeping `createArtifact` does on the insert path, so a
		// re-extraction cannot quietly drop the flag a first extraction set.
		const patch = {
			chunksTruncated: true,
			chunkCount: sync.chunkCount,
			chunkCountBeforeTruncation: sync.totalChunks,
		};
		await updateArtifactMetadata({
			artifactId: mapped.id,
			userId: mapped.userId,
			patch,
		});
		mapped = { ...mapped, metadata: { ...mapped.metadata, ...patch } };
	}
	queueArtifactSemanticEmbeddingRefresh(mapped);

	return mapped;
}

/**
 * @deprecated Use `createNormalizedArtifactFromExtraction`. Kept for one
 * release so a caller written against the earlier name still compiles.
 */
export const createNormalizedArtifactFromText =
	createNormalizedArtifactFromExtraction;

export type PersistExtractionResultDependency =
	typeof createNormalizedArtifactFromExtraction;
