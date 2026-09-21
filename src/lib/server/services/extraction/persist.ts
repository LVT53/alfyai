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

import { stat } from "node:fs/promises";
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
import {
	readMineruParseManifest,
	setMineruParseBundleNormalizedArtifactId,
	writeMineruParseBundle,
} from "$lib/server/services/mineru/bundle";
import { resolveMineruConfig } from "$lib/server/services/mineru/config";
import type {
	MineruOutlineEntry,
	StructuredExtractionResult,
} from "$lib/server/services/mineru/result";
import { queueArtifactSemanticEmbeddingRefresh } from "$lib/server/services/semantic-embedding-refresh";
import { syncArtifactChunks } from "$lib/server/services/task-state/chunk-sync";

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

	// The bundle is written BEFORE the row, and deliberately cannot fail the
	// job: the text is the thing the user asked for, and a document that is
	// readable but has no figures on disk is a far better outcome than a
	// failed extraction that retries three times and ends up with neither.
	const bundle = structured
		? await syncParseBundle({
				userId: params.userId,
				sourceArtifactId: params.sourceArtifactId,
				structured,
			})
		: null;

	const tokenEstimate = estimateDocumentTokenCount(params.text);
	// Structured parses carry their own outline, which already falls back to
	// `extractDocumentOutline` internally for the formats that have no title
	// blocks (CSV) and for producers that type their headings as bold body
	// text. The direct-text route has no blocks at all, so it stays on the
	// heuristics exactly as before.
	const outline = structured
		? normalizeStructuredOutline(structured.result.outline)
		: extractDocumentOutline(params.text);
	const pageCount = structured ? structured.result.pageCount : params.pageCount;

	const comfortMetadataPatch: Record<string, unknown> = {
		tokenEstimate,
		...(structured ? clearedStructuredMetadata() : {}),
		...(pageCount !== undefined ? { pageCount } : {}),
		...(outline.length > 0 ? { outline } : {}),
		...(structured ? structuredMetadata(structured.result, bundle) : {}),
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
			})
		: await createNewNormalizedArtifact({ params, metadata });

	await updateArtifactMetadata({
		artifactId: params.sourceArtifactId,
		userId: params.userId,
		patch: comfortMetadataPatch,
	});

	if (bundle?.manifest) {
		// The manifest is written before the normalized artifact exists, so the
		// id it should carry is only knowable here. A false return means the
		// bundle vanished between the two writes (a concurrent delete), which is
		// not worth failing a completed extraction over.
		await setMineruParseBundleNormalizedArtifactId(
			params.userId,
			params.sourceArtifactId,
			artifact.id,
		).catch(() => false);
	}

	return artifact;
}

// ── the structured hand-off ────────────────────────────────────────────────

/**
 * What `ExtractDocumentResult.structured` is allowed to be.
 *
 * The spec's contract (§3) names one object: a `StructuredExtractionResult`.
 * That object carries no zip path, so an extractor that returns it bare has
 * necessarily written the parse bundle itself — it is the only party that ever
 * holds the downloaded `result.zip`. An extractor that would rather hand the
 * zip over instead wraps the same object in `{ result, zipPathAbsolute }`, and
 * this module writes the bundle. Both shapes are accepted, and an absent or
 * unrecognised payload is simply "no structured data": the direct-text route
 * and the generated-file readback go down that path and must keep working.
 */
interface StructuredExtractionHandoff {
	result: StructuredExtractionResult;
	/** The downloaded result zip, when the extractor left it for us to read. */
	zipPathAbsolute: string | null;
}

function isStructuredExtractionResult(
	value: unknown,
): value is StructuredExtractionResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<StructuredExtractionResult>;
	return (
		typeof candidate.parserVersion === "string" &&
		typeof candidate.markdown === "string" &&
		typeof candidate.pageCount === "number" &&
		typeof candidate.pageCountKind === "string" &&
		Array.isArray(candidate.pages) &&
		Array.isArray(candidate.blocks) &&
		Array.isArray(candidate.figures) &&
		Array.isArray(candidate.outline) &&
		typeof candidate.stats === "object" &&
		candidate.stats !== null
	);
}

export function narrowStructuredExtraction(
	value: unknown,
): StructuredExtractionHandoff | null {
	if (isStructuredExtractionResult(value)) {
		return { result: value, zipPathAbsolute: null };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const envelope = value as { result?: unknown; zipPathAbsolute?: unknown };
	if (!isStructuredExtractionResult(envelope.result)) return null;
	return {
		result: envelope.result,
		zipPathAbsolute:
			typeof envelope.zipPathAbsolute === "string" && envelope.zipPathAbsolute
				? envelope.zipPathAbsolute
				: null,
	};
}

interface ParseBundleOutcome {
	manifest: MineruParseBundleManifest | null;
	/** A one-line reason, recorded on the artifact rather than thrown. */
	error: string | null;
}

/**
 * Brings the on-disk bundle up to date with this parse, without ever throwing.
 *
 * Three cases, in order: the extractor handed over a zip that is still there
 * (we write, replacing any previous bundle atomically); the extractor already
 * wrote the bundle (we read its manifest for the metadata below); there is no
 * bundle at all (metadata simply omits the bundle keys).
 */
async function syncParseBundle(input: {
	userId: string;
	sourceArtifactId: string;
	structured: StructuredExtractionHandoff;
}): Promise<ParseBundleOutcome> {
	const { structured } = input;

	if (structured.zipPathAbsolute) {
		const readable = await stat(structured.zipPathAbsolute)
			.then((stats) => stats.isFile())
			.catch(() => false);
		if (readable) {
			try {
				const manifest = await writeMineruParseBundle({
					userId: input.userId,
					sourceArtifactId: input.sourceArtifactId,
					zipPathAbsolute: structured.zipPathAbsolute,
					result: structured.result,
					maxBytes: resolveMineruConfig().bundleMaxBytes,
				});
				return { manifest, error: null };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				console.warn("[EXTRACTION] Parse bundle write failed", {
					sourceArtifactId: input.sourceArtifactId,
					error: message,
				});
				return { manifest: null, error: message.slice(0, 300) };
			}
		}
	}

	// No zip to read: either the extractor wrote the bundle itself, or there is
	// nothing on disk. `readMineruParseManifest` answers both without throwing.
	const manifest = await readMineruParseManifest(
		input.userId,
		input.sourceArtifactId,
	).catch(() => null);
	return { manifest, error: null };
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
	"extractionBundleError",
] as const;

function clearedStructuredMetadata(): Record<string, undefined> {
	const cleared: Record<string, undefined> = {};
	for (const key of STRUCTURED_METADATA_KEYS) cleared[key] = undefined;
	return cleared;
}

function structuredMetadata(
	result: StructuredExtractionResult,
	bundle: ParseBundleOutcome | null,
): Record<string, unknown> {
	const unknownTypes = result.stats.unknownTypes ?? {};
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
		...(bundle?.manifest
			? {
					extractionBundleBytes: bundle.manifest.totalBytes,
					extractionImagesOmitted: bundle.manifest.imagesOmitted,
				}
			: {}),
		...(bundle?.error ? { extractionBundleError: bundle.error } : {}),
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
